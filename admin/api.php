<?php
/* ==========================================================================
   JSON API for the admin panel. Every route requires a live session; every
   mutating route requires a matching CSRF token.

     GET  ?action=load&file=services|projects
     GET  ?action=images
     GET  ?action=backups&file=…
     POST  action=save     { file, items }
     POST  action=restore  { file, stamp }
     POST  action=upload   multipart: csrf, file, name
     POST  action=logout
   ========================================================================== */
declare(strict_types=1);

define('HB_ADMIN', true);
require __DIR__ . '/lib/bootstrap.php';
require __DIR__ . '/lib/auth.php';
require __DIR__ . '/lib/schema.php';
require __DIR__ . '/lib/upload.php';

header('X-Frame-Options: DENY');
header('Referrer-Policy: same-origin');

if (!hb_is_logged_in()) {
    hb_json_fail('Сесія завершилася. Увійдіть заново.', 401, ['relogin' => true]);
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$body   = [];
if ($method === 'POST') {
    /* Uploads arrive as multipart, everything else as a JSON body. */
    $isMultipart = stripos((string)($_SERVER['CONTENT_TYPE'] ?? ''), 'multipart/form-data') === 0;

    if ($isMultipart) {
        /* A body over post_max_size is discarded by PHP before it gets here,
           leaving both superglobals empty — report that instead of blaming
           the CSRF token the browser did send. */
        if (!$_POST && !$_FILES && (int)($_SERVER['CONTENT_LENGTH'] ?? 0) > 0) {
            hb_json_fail('Файл завеликий для сервера. Спробуйте менший.', 413);
        }
        $body = $_POST;
    } else {
        $raw  = file_get_contents('php://input') ?: '';
        $body = json_decode($raw, true);
        if (!is_array($body)) {
            hb_json_fail('Некоректний запит.');
        }
    }

    if (!hb_csrf_check($body['csrf'] ?? null)) {
        hb_json_fail('Токен безпеки застарів. Оновіть сторінку.', 403, ['relogin' => true]);
    }
}

$action = $_GET['action'] ?? ($body['action'] ?? '');

/* Resolve the ?file= parameter to a real path. */
function hb_resolve_file(?string $key): array
{
    if ($key === 'reviews') {
        return ['reviews', HB_REVIEWS_STORE];
    }
    if (!is_string($key) || !isset(HB_FILES[$key])) {
        hb_json_fail('Невідомий набір даних.');
    }
    return [$key, HB_DATA . '/' . HB_FILES[$key]];
}

/* Reviews are stored privately and republished; everything else is a
   single public file. */
function hb_persist(string $key, string $path, array $clean): bool
{
    if ($key !== 'reviews') {
        return hb_write_atomic($path, hb_encode_pretty($clean));
    }
    return hb_store_write($path, $clean)
        && hb_write_atomic(HB_REVIEWS_PUBLIC, hb_encode_pretty(hb_reviews_public($clean)));
}

function hb_load_items(string $key, string $path): array
{
    return $key === 'reviews' ? hb_store_read($path) : hb_read_json($path);
}

switch ($action) {

    /* ---------------------------------------------------------------- load */
    case 'load': {
        [$key, $path] = hb_resolve_file($_GET['file'] ?? null);
        hb_json_out([
            'ok'    => true,
            'file'  => $key,
            'items' => hb_load_items($key, $path),
            'mtime' => is_file($path) ? filemtime($path) : 0,
            'csrf'  => hb_csrf_token(),
        ]);
    }

    /* --------------------------------------------------------------- save */
    case 'save': {
        [$key, $path] = hb_resolve_file($body['file'] ?? null);

        try {
            $clean = hb_sanitize($key, $body['items'] ?? null);
        } catch (HbValidationError $e) {
            hb_json_fail($e->getMessage(), 422);
        }

        /* Optimistic lock: refuse to clobber a change made in another tab
           or by a second editor since this page loaded. */
        $known = (int)($body['mtime'] ?? 0);
        $now   = is_file($path) ? filemtime($path) : 0;
        if ($known > 0 && $now > 0 && $known !== $now && empty($body['force'])) {
            hb_json_fail(
                'Файл змінився в іншій вкладці або в іншого редактора. Оновіть сторінку, щоб не перезаписати чужі правки.',
                409,
                ['conflict' => true]
            );
        }

        hb_backup($key, $path);
        if (!hb_persist($key, $path, $clean)) {
            hb_json_fail('Не вдалося записати файл. Перевірте права на теку data/ (потрібно 755).', 500);
        }
        clearstatcache(true, $path);

        hb_json_out([
            'ok'    => true,
            'items' => $clean,
            'mtime' => filemtime($path),
            'count' => count($clean),
        ]);
    }

    /* ------------------------------------------------------------- images */
    case 'images': {
        $root  = realpath(HB_IMAGES);
        $found = [];
        if ($root !== false) {
            $it = new RecursiveIteratorIterator(
                new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS)
            );
            foreach ($it as $f) {
                if (!$f->isFile()) {
                    continue;
                }
                if (!preg_match('/\.(jpe?g|png|webp|gif|avif|svg)$/i', $f->getFilename())) {
                    continue;
                }
                $rel = str_replace('\\', '/', substr($f->getPathname(), strlen($root) + 1));
                $found[] = [
                    'path' => 'images/' . $rel,
                    'name' => $f->getFilename(),
                    'size' => $f->getSize(),
                ];
            }
        }
        usort($found, fn($a, $b) => strcmp($a['path'], $b['path']));
        hb_json_out(['ok' => true, 'images' => $found]);
    }

    /* ------------------------------------------------------------- upload */
    case 'upload': {
        if ($method !== 'POST') {
            hb_json_fail('Завантаження приймається лише через POST.', 405);
        }
        $file = $_FILES['file'] ?? null;
        if (!is_array($file)) {
            hb_json_fail('Файл не надіслано.');
        }
        /* One file per request: the panel sends them one after another so a
           single bad photo cannot fail the whole batch. */
        if (is_array($file['name'] ?? null)) {
            hb_json_fail('Надсилайте по одному файлу за раз.');
        }
        try {
            $image = hb_upload_store($file, (string)($body['name'] ?? ''));
        } catch (HbValidationError $e) {
            hb_json_fail($e->getMessage(), 422);
        }
        hb_json_out(['ok' => true, 'image' => $image]);
    }

    /* ------------------------------------------------------------ backups */
    case 'backups': {
        [$key] = hb_resolve_file($_GET['file'] ?? null);
        $list = [];
        $pat  = hb_backup_dir($key) . "/{$key}-*." . hb_backup_ext($key);
        foreach (glob($pat) ?: [] as $f) {
            if (preg_match('/-(\d{8}-\d{6})\.(?:json|php)$/', $f, $m)) {
                $list[] = ['stamp' => $m[1], 'size' => filesize($f)];
            }
        }
        usort($list, fn($a, $b) => strcmp($b['stamp'], $a['stamp']));
        hb_json_out(['ok' => true, 'backups' => array_slice($list, 0, 25)]);
    }

    /* ------------------------------------------------------------ restore */
    case 'restore': {
        [$key, $path] = hb_resolve_file($body['file'] ?? null);
        $stamp = (string)($body['stamp'] ?? '');
        if (!preg_match('/^\d{8}-\d{6}$/', $stamp)) {
            hb_json_fail('Некоректна мітка резервної копії.');
        }
        $src = hb_backup_dir($key) . "/{$key}-{$stamp}." . hb_backup_ext($key);
        if (!is_file($src)) {
            hb_json_fail('Резервну копію не знайдено.', 404);
        }
        try {
            $clean = hb_sanitize($key, hb_store_read($src));
        } catch (HbValidationError $e) {
            hb_json_fail('Резервна копія пошкоджена: ' . $e->getMessage(), 422);
        }
        hb_backup($key, $path);                 // the current state is itself backed up first
        if (!hb_persist($key, $path, $clean)) {
            hb_json_fail('Не вдалося відновити файл.', 500);
        }
        clearstatcache(true, $path);
        hb_json_out(['ok' => true, 'items' => $clean, 'mtime' => filemtime($path)]);
    }

    /* ------------------------------------------------------------- logout */
    case 'logout': {
        hb_logout();
        hb_json_out(['ok' => true]);
    }
}

hb_json_fail('Невідома дія.', 404);
