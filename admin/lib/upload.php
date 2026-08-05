<?php
/* ==========================================================================
   Image upload for the admin panel.

   Everything a browser sends about a file — its name, its extension, its
   declared MIME type — is attacker-controlled. Only the bytes decide what a
   file is, so the type comes from getimagesize() and the stored extension is
   derived from that, never from the upload.

   The destination directory is fixed server-side (images/projects/), so no
   crafted name can walk out of the images tree.
   ========================================================================== */
declare(strict_types=1);

if (!defined('HB_ADMIN')) {
    exit;   /* included only */
}

const HB_UPLOAD_SUBDIR = 'projects';
const HB_UPLOAD_MAX    = 20971520;   // 20 MB per file
const HB_UPLOAD_EDGE   = 2560;       // longest side kept, in pixels
const HB_UPLOAD_PIXELS = 60000000;   // decompression-bomb ceiling

/* Detected MIME → the extension we store it under. Anything not listed is
   refused, which rules out SVG (it can carry script) along with the rest. */
const HB_UPLOAD_TYPES = [
    'image/jpeg' => 'jpg',
    'image/png'  => 'png',
    'image/webp' => 'webp',
];

/* ---------- names ---------- */

/* Latin letters survive as themselves, Cyrillic is transliterated, and
   everything else becomes a hyphen — so "Кухня після.jpg" lands as
   "kuhnya-pislya.jpg" rather than a meaningless hash. */
function hb_upload_slug(string $name): string
{
    $name = preg_replace('/\.[a-z0-9]{1,5}$/i', '', trim($name)) ?? '';

    $map = [
        'а'=>'a','б'=>'b','в'=>'v','г'=>'h','ґ'=>'g','д'=>'d','е'=>'e','є'=>'ye',
        'ж'=>'zh','з'=>'z','и'=>'y','і'=>'i','ї'=>'yi','й'=>'y','к'=>'k','л'=>'l',
        'м'=>'m','н'=>'n','о'=>'o','п'=>'p','р'=>'r','с'=>'s','т'=>'t','у'=>'u',
        'ф'=>'f','х'=>'h','ц'=>'ts','ч'=>'ch','ш'=>'sh','щ'=>'shch','ь'=>'','ю'=>'yu',
        'я'=>'ya','ы'=>'y','э'=>'e','ё'=>'e','ъ'=>'',
        'á'=>'a','à'=>'a','ä'=>'a','â'=>'a','é'=>'e','è'=>'e','ë'=>'e','ê'=>'e',
        'í'=>'i','ï'=>'i','î'=>'i','ó'=>'o','ö'=>'o','ô'=>'o','ú'=>'u','ü'=>'u',
        'û'=>'u','ç'=>'c','ñ'=>'n','ß'=>'ss',
    ];
    $name = strtr(mb_strtolower($name, 'UTF-8'), $map);

    $name = preg_replace('/[^a-z0-9]+/', '-', $name) ?? '';
    $name = trim($name, '-');
    return substr($name, 0, 60);
}

/* Never overwrites: a second "keuken.jpg" becomes "keuken-2.jpg". */
function hb_upload_unique(string $dir, string $base, string $ext): string
{
    $candidate = $base . '.' . $ext;
    $n = 1;
    while (file_exists($dir . '/' . $candidate)) {
        $n++;
        $candidate = $base . '-' . $n . '.' . $ext;
        if ($n > 999) {
            $candidate = $base . '-' . bin2hex(random_bytes(4)) . '.' . $ext;
            break;
        }
    }
    return $candidate;
}

/* ---------- errors ---------- */
function hb_upload_error(int $code): string
{
    switch ($code) {
        case UPLOAD_ERR_INI_SIZE:
        case UPLOAD_ERR_FORM_SIZE:
            return 'Файл завеликий для сервера.';
        case UPLOAD_ERR_PARTIAL:
            return 'Файл передався не повністю. Спробуйте ще раз.';
        case UPLOAD_ERR_NO_FILE:
            return 'Файл не вибрано.';
        case UPLOAD_ERR_NO_TMP_DIR:
        case UPLOAD_ERR_CANT_WRITE:
            return 'Сервер не зміг записати тимчасовий файл.';
        case UPLOAD_ERR_EXTENSION:
            return 'Завантаження зупинило розширення PHP.';
        default:
            return 'Не вдалося завантажити файл.';
    }
}

/* ---------- resizing ---------- */
function hb_upload_gd(string $ext): bool
{
    $need = ['jpg' => 'imagecreatefromjpeg', 'png' => 'imagecreatefrompng', 'webp' => 'imagecreatefromwebp'];
    return isset($need[$ext]) && function_exists($need[$ext]) && function_exists('imagecopyresampled');
}

function hb_upload_load(string $src, string $ext)
{
    switch ($ext) {
        case 'jpg':  return @imagecreatefromjpeg($src);
        case 'png':  return @imagecreatefrompng($src);
        case 'webp': return @imagecreatefromwebp($src);
    }
    return false;
}

/* GD drops the EXIF block when it re-encodes, so a phone photo that relied on
   an orientation flag would come out lying on its side. Bake the rotation
   into the pixels before that happens. */
function hb_upload_orient($im, string $src, string $ext)
{
    if ($ext !== 'jpg' || !function_exists('exif_read_data') || !function_exists('imagerotate')) {
        return $im;
    }
    $exif = @exif_read_data($src);
    switch ((int)($exif['Orientation'] ?? 1)) {
        case 3: $r = @imagerotate($im, 180, 0); break;
        case 6: $r = @imagerotate($im, -90, 0); break;
        case 8: $r = @imagerotate($im, 90, 0);  break;
        default: return $im;
    }
    return $r === false ? $im : $r;
}

function hb_upload_save($im, string $dest, string $ext): bool
{
    switch ($ext) {
        case 'jpg':  return function_exists('imagejpeg') && @imagejpeg($im, $dest, 86);
        case 'png':  return function_exists('imagepng')  && @imagepng($im, $dest, 6);
        case 'webp': return function_exists('imagewebp') && @imagewebp($im, $dest, 86);
    }
    return false;
}

/* Returns true when the resized copy was written to $dest. */
function hb_upload_resize(string $src, string $dest, string $ext): bool
{
    $im = hb_upload_load($src, $ext);
    if ($im === false) {
        return false;
    }
    $im = hb_upload_orient($im, $src, $ext);

    $w = imagesx($im);
    $h = imagesy($im);
    $scale = HB_UPLOAD_EDGE / max($w, $h);
    if ($scale >= 1) {                       // orientation may have shrunk the long edge
        return false;
    }
    $nw = max(1, (int)round($w * $scale));
    $nh = max(1, (int)round($h * $scale));

    $out = @imagecreatetruecolor($nw, $nh);
    if ($out === false) {
        return false;
    }
    if ($ext !== 'jpg') {                    // keep transparency intact
        imagealphablending($out, false);
        imagesavealpha($out, true);
        $clear = imagecolorallocatealpha($out, 0, 0, 0, 127);
        imagefill($out, 0, 0, $clear);
    }
    imagecopyresampled($out, $im, 0, 0, 0, 0, $nw, $nh, $w, $h);

    /* No imagedestroy(): a GDImage has been garbage-collected since PHP 8.0
       and the call is deprecated in 8.5, where it would emit a notice into
       the JSON response. */
    $ok = hb_upload_save($out, $dest, $ext);
    if (!$ok) {
        @unlink($dest);
    }
    return $ok;
}

/* ---------- entry point ----------
   Throws HbValidationError with a message meant for the editor to read. */
function hb_upload_store(array $file, string $wanted = ''): array
{
    $code = (int)($file['error'] ?? UPLOAD_ERR_NO_FILE);
    if ($code !== UPLOAD_ERR_OK) {
        throw new HbValidationError(hb_upload_error($code));
    }

    $tmp = (string)($file['tmp_name'] ?? '');
    if ($tmp === '' || !is_uploaded_file($tmp)) {
        throw new HbValidationError('Файл не дійшов до сервера.');
    }

    $size = (int)($file['size'] ?? 0);
    if ($size <= 0) {
        throw new HbValidationError('Файл порожній.');
    }
    if ($size > HB_UPLOAD_MAX) {
        throw new HbValidationError('Файл завеликий — максимум ' . (int)(HB_UPLOAD_MAX / 1048576) . ' МБ.');
    }

    $info = @getimagesize($tmp);
    if (!is_array($info) || empty($info['mime'])) {
        throw new HbValidationError('Це не зображення або файл пошкоджений.');
    }
    $mime = strtolower((string)$info['mime']);
    if (!isset(HB_UPLOAD_TYPES[$mime])) {
        throw new HbValidationError('Підтримуються тільки JPG, PNG і WebP.');
    }
    $ext = HB_UPLOAD_TYPES[$mime];

    $w = (int)($info[0] ?? 0);
    $h = (int)($info[1] ?? 0);
    if ($w < 1 || $h < 1) {
        throw new HbValidationError('Не вдалося прочитати розміри зображення.');
    }
    if ($w * $h > HB_UPLOAD_PIXELS) {
        throw new HbValidationError('Зображення надто велике за кількістю пікселів.');
    }

    $base = hb_upload_slug($wanted !== '' ? $wanted : (string)($file['name'] ?? ''));
    if ($base === '') {
        $base = 'foto';
    }

    $dir = HB_IMAGES . '/' . HB_UPLOAD_SUBDIR;
    hb_ensure_dir($dir);
    if (!is_dir($dir) || !is_writable($dir)) {
        throw new HbValidationError('Тека images/' . HB_UPLOAD_SUBDIR . '/ недоступна для запису (потрібні права 755).');
    }

    $name = hb_upload_unique($dir, $base, $ext);
    $dest = $dir . '/' . $name;

    /* Oversized photos straight off a phone are shrunk; anything already
       within budget is stored byte-for-byte as it arrived. */
    $resized = false;
    if (max($w, $h) > HB_UPLOAD_EDGE && hb_upload_gd($ext)) {
        $resized = hb_upload_resize($tmp, $dest, $ext);
    }
    if (!$resized && !@move_uploaded_file($tmp, $dest)) {
        throw new HbValidationError('Не вдалося зберегти файл у images/' . HB_UPLOAD_SUBDIR . '/.');
    }
    @chmod($dest, 0644);
    clearstatcache(true, $dest);

    $final = @getimagesize($dest) ?: [$w, $h];

    return [
        'path'    => 'images/' . HB_UPLOAD_SUBDIR . '/' . $name,
        'name'    => $name,
        'size'    => (int)filesize($dest),
        'width'   => (int)($final[0] ?? $w),
        'height'  => (int)($final[1] ?? $h),
        'resized' => $resized,
    ];
}
