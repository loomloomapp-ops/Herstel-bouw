<?php
/* ==========================================================================
   Authentication: single-password login, CSRF tokens, brute-force throttle.
   There are no user accounts — one site, one owner, one password.
   ========================================================================== */
declare(strict_types=1);

if (!defined('HB_ADMIN')) {
    exit;
}

const HB_MAX_ATTEMPTS = 6;      // failures before the IP is locked out
const HB_LOCK_SECONDS = 900;    // 15 minutes
const HB_IDLE_SECONDS = 28800;  // 8 hours of inactivity ends the session

function hb_is_configured(): bool
{
    return hb_config() !== null;
}

function hb_is_logged_in(): bool
{
    hb_session_start();
    if (empty($_SESSION['hb_auth'])) {
        return false;
    }
    $last = (int)($_SESSION['hb_seen'] ?? 0);
    if ($last && (time() - $last) > HB_IDLE_SECONDS) {
        hb_logout();
        return false;
    }
    $_SESSION['hb_seen'] = time();
    return true;
}

function hb_login(string $password): bool
{
    hb_session_start();
    $cfg = hb_config();
    if ($cfg === null) {
        return false;
    }
    if (!password_verify($password, $cfg['hash'])) {
        hb_note_failure();
        return false;
    }
    hb_clear_failures();
    session_regenerate_id(true);
    $_SESSION['hb_auth'] = true;
    $_SESSION['hb_seen'] = time();
    $_SESSION['hb_csrf'] = bin2hex(random_bytes(32));
    return true;
}

function hb_logout(): void
{
    hb_session_start();
    $_SESSION = [];
    if (ini_get('session.use_cookies')) {
        $p = session_get_cookie_params();
        setcookie(session_name(), '', time() - 42000, $p['path'], $p['domain'], $p['secure'], $p['httponly']);
    }
    session_destroy();
}

/* ---------- CSRF ---------- */
function hb_csrf_token(): string
{
    hb_session_start();
    if (empty($_SESSION['hb_csrf'])) {
        $_SESSION['hb_csrf'] = bin2hex(random_bytes(32));
    }
    return $_SESSION['hb_csrf'];
}

function hb_csrf_check(?string $token): bool
{
    hb_session_start();
    $known = $_SESSION['hb_csrf'] ?? '';
    return $known !== '' && is_string($token) && hash_equals($known, $token);
}

/* ---------- throttle ----------
   Failures are counted per client IP in a private file. Shared hosting has
   no memory cache, and a JSON file is plenty for a single-user panel. */
function hb_client_ip(): string
{
    $ip = $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
    return substr(preg_replace('/[^0-9a-fA-F:.]/', '', $ip), 0, 45) ?: '0.0.0.0';
}

function hb_throttle_path(): string
{
    hb_ensure_dir(HB_STORAGE);
    return HB_STORAGE . '/throttle.php';
}

function hb_throttle_write(array $data): void
{
    hb_store_write(hb_throttle_path(), $data);
}

function hb_throttle_read(): array
{
    $data = hb_store_read(hb_throttle_path());
    $now  = time();
    /* Drop stale entries so the file cannot grow without bound. */
    foreach ($data as $ip => $row) {
        if (($row['at'] ?? 0) + HB_LOCK_SECONDS < $now) {
            unset($data[$ip]);
        }
    }
    return $data;
}

/* Seconds remaining before this client may try again (0 = not locked). */
function hb_lockout_remaining(): int
{
    $data = hb_throttle_read();
    $row  = $data[hb_client_ip()] ?? null;
    if (!$row || ($row['n'] ?? 0) < HB_MAX_ATTEMPTS) {
        return 0;
    }
    $left = ($row['at'] + HB_LOCK_SECONDS) - time();
    return $left > 0 ? $left : 0;
}

function hb_note_failure(): void
{
    $data = hb_throttle_read();
    $ip   = hb_client_ip();
    $row  = $data[$ip] ?? ['n' => 0, 'at' => 0];
    $row['n'] = (int)$row['n'] + 1;
    $row['at'] = time();
    $data[$ip] = $row;
    hb_throttle_write($data);
}

function hb_clear_failures(): void
{
    $data = hb_throttle_read();
    unset($data[hb_client_ip()]);
    hb_throttle_write($data);
}

/* Attempts left before lockout — shown on the login screen as a warning. */
function hb_attempts_left(): int
{
    $data = hb_throttle_read();
    $row  = $data[hb_client_ip()] ?? null;
    $used = $row['n'] ?? 0;
    return max(0, HB_MAX_ATTEMPTS - (int)$used);
}
