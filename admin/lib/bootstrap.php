<?php
/* ==========================================================================
   Shared bootstrap: paths, session, small helpers.
   Included by admin/index.php and admin/api.php — never requested directly.
   ========================================================================== */
declare(strict_types=1);

if (!defined('HB_ADMIN')) {
    exit;   /* included only */
}

define('HB_DIR',      __DIR__ . '/..');              // admin/
define('HB_ROOT',     dirname(__DIR__, 1) . '/..');  // site root
define('HB_DATA',     realpath(__DIR__ . '/../..') . '/data');
define('HB_IMAGES',   realpath(__DIR__ . '/../..') . '/images');
define('HB_STORAGE',  __DIR__ . '/../storage');      // private: throttle state
define('HB_CONFIG',   __DIR__ . '/../config.php');
define('HB_BACKUPS',  HB_DATA . '/.backups');

/* Editable content files. Keys are what the API accepts as ?file=. */
const HB_FILES = [
    'services' => 'services.json',
    'projects' => 'projects.json',
];

/* Reviews are moderated, so they live in two places:
   - the private store below holds every submission, including pending and
     rejected ones plus the reporter's e-mail;
   - data/reviews.json is derived from it and contains only approved
     reviews with the fields the site actually renders. */
define('HB_REVIEWS_STORE',  HB_STORAGE . '/reviews.php');
define('HB_REVIEWS_PUBLIC', HB_DATA . '/reviews.json');

/* ---------- session ---------- */
function hb_session_start(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        return;
    }
    session_set_cookie_params([
        'lifetime' => 0,
        'path'     => '/',
        'httponly' => true,
        'samesite' => 'Lax',
        'secure'   => hb_is_https(),
    ]);
    session_name('hb_admin');
    session_start();
}

function hb_is_https(): bool
{
    if (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') {
        return true;
    }
    /* Hostinger terminates TLS at the proxy. */
    return (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
}

/* ---------- filesystem ---------- */
function hb_ensure_dir(string $dir): void
{
    if (!is_dir($dir)) {
        @mkdir($dir, 0755, true);
    }
}

/* Writes a file atomically: a temp file in the same directory is renamed
   over the target, so a crashed or concurrent request can never leave the
   live site reading a half-written JSON file. */
function hb_write_atomic(string $path, string $contents): bool
{
    $dir = dirname($path);
    hb_ensure_dir($dir);
    $tmp = @tempnam($dir, '.hbtmp');
    if ($tmp === false) {
        return false;
    }
    if (@file_put_contents($tmp, $contents, LOCK_EX) === false) {
        @unlink($tmp);
        return false;
    }
    @chmod($tmp, 0644);
    if (!@rename($tmp, $path)) {
        @unlink($tmp);
        return false;
    }
    return true;
}

/* Review backups must not land in data/.backups/ as .json: that directory
   serves .json publicly, which would expose pending reviews and submitter
   e-mail addresses. They go to the private storage folder instead, keeping
   the `<?php exit;` guard. */
function hb_backup_dir(string $key): string
{
    return $key === 'reviews' ? HB_STORAGE . '/backups' : HB_BACKUPS;
}

function hb_backup_ext(string $key): string
{
    return $key === 'reviews' ? 'php' : 'json';
}

/* Keeps the last N copies of a content file so a bad edit is recoverable. */
function hb_backup(string $key, string $path, int $keep = 25): void
{
    if (!is_file($path)) {
        return;
    }
    $dir = hb_backup_dir($key);
    $ext = hb_backup_ext($key);
    hb_ensure_dir($dir);
    $stamp = date('Ymd-His');
    @copy($path, $dir . "/{$key}-{$stamp}.{$ext}");

    $old = glob($dir . "/{$key}-*.{$ext}") ?: [];
    if (count($old) > $keep) {
        sort($old);
        foreach (array_slice($old, 0, count($old) - $keep) as $f) {
            @unlink($f);
        }
    }
}

/* ---------- json io ---------- */
function hb_json_out($payload, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function hb_json_fail(string $message, int $status = 400, array $extra = []): void
{
    hb_json_out(array_merge(['ok' => false, 'error' => $message], $extra), $status);
}

function hb_encode_pretty($data): string
{
    return json_encode(
        $data,
        JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES
    ) . "\n";
}

/* ---------- guarded stores ----------
   Files holding data that must never be served (visitor e-mails, pending
   reviews, failed-login counters) are written as .php behind a leading
   `exit`. Even a server that ignores .htaccess then returns an empty body
   instead of the contents. */
const HB_GUARD = "<?php exit; ?>\n";

function hb_store_read(string $path): array
{
    if (!is_file($path)) {
        return [];
    }
    $raw = (string)@file_get_contents($path);
    if (str_starts_with($raw, '<?php')) {
        $nl  = strpos($raw, "\n");
        $raw = $nl === false ? '' : substr($raw, $nl + 1);
    }
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

function hb_store_write(string $path, array $data): bool
{
    $guard = str_ends_with($path, '.php') ? HB_GUARD : '';
    return hb_write_atomic($path, $guard . hb_encode_pretty($data));
}

function hb_read_json(string $path)
{
    if (!is_file($path)) {
        return [];
    }
    $raw = @file_get_contents($path);
    if ($raw === false || trim($raw) === '') {
        return [];
    }
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

/* ---------- config ---------- */
function hb_config(): ?array
{
    if (!is_file(HB_CONFIG)) {
        return null;
    }
    $cfg = require HB_CONFIG;
    return is_array($cfg) && !empty($cfg['hash']) ? $cfg : null;
}

function hb_config_write(string $hash): bool
{
    $body = "<?php\n"
        . "/* Generated by the Herstel & Bouw admin setup. Do not edit by hand.\n"
        . "   To reset the password, delete this file and reload /admin/. */\n"
        . "return " . var_export(['hash' => $hash, 'created' => gmdate('c')], true) . ";\n";
    return hb_write_atomic(HB_CONFIG, $body);
}
