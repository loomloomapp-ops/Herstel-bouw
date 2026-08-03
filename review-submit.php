<?php
/* ==========================================================================
   Public endpoint: a visitor submits a review.

   Everything that arrives here lands in the private store with status
   "pending" and is invisible on the site until the owner approves it in
   the admin panel. Nothing written here is ever served directly.
   ========================================================================== */
declare(strict_types=1);

define('HB_ADMIN', true);                 // unlocks the shared library
require __DIR__ . '/admin/lib/bootstrap.php';
require __DIR__ . '/admin/lib/schema.php';

header('X-Content-Type-Options: nosniff');

/* One submission per minute and 5 per day from the same address; a bot that
   gets past the honeypot still cannot flood the moderation queue. */
const HB_RV_MIN_GAP  = 60;
const HB_RV_PER_DAY  = 5;
const HB_RV_MAX_OPEN = 300;               // pending reviews before we stop accepting

function rv_out(bool $ok, string $message, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode(['ok' => $ok, 'message' => $message], JSON_UNESCAPED_UNICODE);
    exit;
}

function rv_ip(): string
{
    $ip = $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
    return substr(preg_replace('/[^0-9a-fA-F:.]/', '', $ip), 0, 45) ?: '0.0.0.0';
}

/* Serialises the read-modify-write so two visitors submitting at the same
   moment cannot overwrite each other. */
function rv_with_lock(callable $fn)
{
    hb_ensure_dir(HB_STORAGE);
    $fh = @fopen(HB_STORAGE . '/reviews.lock', 'c');
    if ($fh === false) {
        return $fn();                     // degraded, but better than refusing
    }
    @flock($fh, LOCK_EX);
    try {
        return $fn();
    } finally {
        @flock($fh, LOCK_UN);
        @fclose($fh);
    }
}

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
    rv_out(false, 'Method not allowed.', 405);
}

/* Accept both JSON and a classic form post. */
$raw  = file_get_contents('php://input') ?: '';
$body = json_decode($raw, true);
if (!is_array($body)) {
    $body = $_POST;
}

$lang = (($body['lang'] ?? 'nl') === 'en') ? 'en' : 'nl';
$T = [
    'nl' => [
        'thanks'  => 'Bedankt! Uw beoordeling is verstuurd en wordt na controle geplaatst.',
        'name'    => 'Vul uw naam in.',
        'text'    => 'Schrijf uw beoordeling (minimaal 20 tekens).',
        'long'    => 'Uw beoordeling is te lang (maximaal 2000 tekens).',
        'rating'  => 'Kies een beoordeling van 1 tot 5 sterren.',
        'email'   => 'Dit e-mailadres lijkt niet te kloppen.',
        'links'   => 'Links zijn niet toegestaan in een beoordeling.',
        'soon'    => 'U heeft zojuist een beoordeling verstuurd. Probeer het over een minuut opnieuw.',
        'limit'   => 'U heeft vandaag het maximum aantal beoordelingen verstuurd.',
        'busy'    => 'Er kunnen op dit moment geen beoordelingen worden ontvangen. Probeer het later opnieuw.',
        'fail'    => 'Er ging iets mis bij het opslaan. Probeer het later opnieuw.',
    ],
    'en' => [
        'thanks'  => 'Thank you! Your review has been sent and will appear after review.',
        'name'    => 'Please enter your name.',
        'text'    => 'Please write your review (at least 20 characters).',
        'long'    => 'Your review is too long (2000 characters maximum).',
        'rating'  => 'Please choose a rating from 1 to 5 stars.',
        'email'   => 'That e-mail address does not look right.',
        'links'   => 'Links are not allowed in a review.',
        'soon'    => 'You just submitted a review. Please try again in a minute.',
        'limit'   => 'You have reached the maximum number of reviews for today.',
        'busy'    => 'Reviews cannot be accepted right now. Please try again later.',
        'fail'    => 'Something went wrong while saving. Please try again later.',
    ],
][$lang];

/* Honeypot: a field hidden from humans. Anything that fills it is a bot —
   answer with the success message so it does not learn it was caught. */
if (trim((string)($body['website'] ?? '')) !== '') {
    rv_out(true, $T['thanks']);
}

$name     = hb_str($body['name'] ?? '', 120);
$location = hb_str($body['location'] ?? '', 120);
$service  = hb_str($body['service'] ?? '', 160);
$text     = hb_str($body['text'] ?? '', 2400);
$email    = hb_str($body['email'] ?? '', 160);
$rating   = (int)($body['rating'] ?? 0);

if ($name === '' || mb_strlen($name) < 2) {
    rv_out(false, $T['name'], 422);
}
if (mb_strlen($text) < 20) {
    rv_out(false, $T['text'], 422);
}
if (mb_strlen($text) > 2000) {
    rv_out(false, $T['long'], 422);
}
if ($rating < 1 || $rating > 5) {
    rv_out(false, $T['rating'], 422);
}
if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) {
    rv_out(false, $T['email'], 422);
}
/* Review spam is overwhelmingly link-bearing; genuine customers rarely
   paste URLs into a testimonial. */
if (preg_match('~(https?://|www\.|\[url|<a\s)~i', $name . ' ' . $text . ' ' . $location . ' ' . $service)) {
    rv_out(false, $T['links'], 422);
}

$result = rv_with_lock(function () use ($name, $location, $service, $text, $email, $rating, $lang, $T) {

    /* ---- rate limit ---- */
    $ratePath = HB_STORAGE . '/review-rate.php';
    $rate = hb_store_read($ratePath);
    $ip   = rv_ip();
    $now  = time();

    $mine = array_values(array_filter($rate[$ip] ?? [], fn($ts) => $now - (int)$ts < 86400));
    if ($mine && ($now - (int)end($mine)) < HB_RV_MIN_GAP) {
        return ['ok' => false, 'msg' => $T['soon'], 'code' => 429];
    }
    if (count($mine) >= HB_RV_PER_DAY) {
        return ['ok' => false, 'msg' => $T['limit'], 'code' => 429];
    }

    /* ---- append ---- */
    $all = hb_store_read(HB_REVIEWS_STORE);
    $open = 0;
    foreach ($all as $r) {
        if (($r['status'] ?? '') === 'pending') {
            $open++;
        }
    }
    if ($open >= HB_RV_MAX_OPEN) {
        return ['ok' => false, 'msg' => $T['busy'], 'code' => 503];
    }

    $other = $lang === 'nl' ? 'en' : 'nl';
    $entry = [
        'id'       => 'r-' . substr(bin2hex(random_bytes(6)), 0, 10),
        'name'     => $name,
        'location' => $location,
        /* The visitor writes one language; the other side mirrors it until
           the owner supplies a translation in the panel. */
        'service'  => [$lang => ($service !== '' ? $service : '—'), $other => ($service !== '' ? $service : '—')],
        'text'     => [$lang => $text, $other => $text],
        'rating'   => $rating,
        'status'   => 'pending',
        'created'  => gmdate('c'),
        'source'   => 'form',
        'email'    => $email,
    ];
    array_unshift($all, $entry);

    if (!hb_store_write(HB_REVIEWS_STORE, $all)) {
        return ['ok' => false, 'msg' => $T['fail'], 'code' => 500];
    }

    $mine[] = $now;
    $rate[$ip] = $mine;
    foreach ($rate as $k => $stamps) {      // prune other addresses too
        $keep = array_values(array_filter($stamps, fn($ts) => $now - (int)$ts < 86400));
        if ($keep) { $rate[$k] = $keep; } else { unset($rate[$k]); }
    }
    hb_store_write($ratePath, $rate);

    return ['ok' => true, 'msg' => $T['thanks'], 'code' => 200];
});

rv_out($result['ok'], $result['msg'], $result['code']);
