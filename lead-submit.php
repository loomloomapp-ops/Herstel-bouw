<?php
/* ==========================================================================
   Public endpoint: a visitor submits a quote request (contact form or the
   calculator quiz).

   The lead is mailed to the owner's inbox and, as a safety net, appended to
   a private store so nothing is lost if a message is ever rejected by the
   receiving mail server. Nothing written here is served publicly.
   ========================================================================== */
declare(strict_types=1);

define('HB_ADMIN', true);                 // unlocks the shared library
require __DIR__ . '/admin/lib/bootstrap.php';

header('X-Content-Type-Options: nosniff');

/* Where leads are delivered, and who they are sent as. The From address must
   stay on this domain — a Gmail sender would be rejected as a forgery. */
const HB_LEAD_TO        = 'herstelenbouw@gmail.com';
const HB_LEAD_FROM      = 'noreply@herstelenbouw.nl';
const HB_LEAD_FROM_NAME = 'Herstel & Bouw';

/* One submission per minute and 10 per day from the same address; a bot that
   gets past the honeypot still cannot flood the inbox. */
const HB_LEAD_MIN_GAP = 60;
const HB_LEAD_PER_DAY = 10;

define('HB_LEAD_STORE',    HB_STORAGE . '/leads.php');
define('HB_LEAD_RATE',     HB_STORAGE . '/lead-rate.php');
define('HB_LEAD_FILES',    HB_STORAGE . '/leads');
const HB_LEAD_KEEP = 300;                 // leads retained in the private store

/* The vacancy form may carry a CV. It is attached to the message and kept in
   the private folder, so an applicant is not lost if the mail is rejected. */
const HB_CV_MAX   = 8388608;              // 8 MB
const HB_CV_TYPES = [
    'application/pdf' => 'pdf',
    'application/msword' => 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document' => 'docx',
    'application/rtf' => 'rtf',
    'text/rtf' => 'rtf',
];

/* Service fields the visitor never fills in — kept out of the message body. */
const HB_LEAD_SKIP = ['_honey', '_subject', '_template', '_next', '_captcha', 'lang'];

function lead_out(bool $ok, string $message, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    /* `success` mirrors the shape the front-end already reads. */
    echo json_encode(
        ['ok' => $ok, 'success' => $ok, 'message' => $message],
        JSON_UNESCAPED_UNICODE
    );
    exit;
}

function lead_ip(): string
{
    $ip = $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
    return substr(preg_replace('/[^0-9a-fA-F:.]/', '', $ip), 0, 45) ?: '0.0.0.0';
}

/* Serialises the read-modify-write so two visitors submitting at the same
   moment cannot overwrite each other's entry. */
function lead_with_lock(callable $fn)
{
    hb_ensure_dir(HB_STORAGE);
    $fh = @fopen(HB_STORAGE . '/leads.lock', 'c');
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

/* Header injection guard: a newline in a subject or address would let a
   submitter append headers of their own. */
function lead_header_safe(string $v): string
{
    return trim(str_replace(["\r", "\n", "\0"], ' ', $v));
}

function lead_is_email(string $v): bool
{
    return (bool)filter_var($v, FILTER_VALIDATE_EMAIL);
}

/* RFC 2047 for non-ASCII header text (the company name carries an ampersand
   today, but subjects arrive in Dutch and may not stay ASCII). */
function lead_encode_header(string $v): string
{
    $v = lead_header_safe($v);
    return preg_match('/[^\x20-\x7E]/', $v) === 1
        ? '=?UTF-8?B?' . base64_encode($v) . '?='
        : $v;
}

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
    lead_out(false, 'Method not allowed.', 405);
}

/* Accept both a classic form post (what the site sends) and JSON. */
$body = $_POST;
if (!$body) {
    $raw  = file_get_contents('php://input') ?: '';
    $json = json_decode($raw, true);
    if (is_array($json)) {
        $body = $json;
    }
}

$lang = (($body['lang'] ?? 'nl') === 'en') ? 'en' : 'nl';
$T = [
    'nl' => [
        'thanks'  => 'Bedankt. Uw aanvraag is verstuurd.',
        'fields'  => 'Vul uw naam en uw telefoonnummer of e-mailadres in.',
        'email'   => 'Dit e-mailadres lijkt niet te kloppen.',
        'soon'    => 'U heeft zojuist een aanvraag verstuurd. Probeer het over een minuut opnieuw.',
        'limit'   => 'U heeft vandaag het maximum aantal aanvragen verstuurd. Bel of WhatsApp ons.',
        'fail'    => 'Er ging iets mis bij het versturen. Bel of WhatsApp ons.',
    ],
    'en' => [
        'thanks'  => 'Thank you. Your request has been sent.',
        'fields'  => 'Please enter your name and a phone number or e-mail address.',
        'email'   => 'This e-mail address does not look right.',
        'soon'    => 'You have just sent a request. Please try again in a minute.',
        'limit'   => 'You have reached today\'s maximum number of requests. Please call or WhatsApp us.',
        'fail'    => 'Something went wrong while sending. Please call or WhatsApp us.',
    ],
][$lang];

/* Honeypot: filled in only by a bot, and answered with the success message so
   it never learns that it was caught. */
if (trim((string)($body['_honey'] ?? '')) !== '') {
    lead_out(true, $T['thanks']);
}

/* ---------- collect the submitted fields ---------- */
$fields = [];
foreach ($body as $key => $value) {
    $key = trim((string)$key);
    if ($key === '' || in_array($key, HB_LEAD_SKIP, true)) {
        continue;
    }
    if (is_array($value)) {
        $value = implode(', ', array_map('strval', $value));
    }
    $value = trim((string)$value);
    if ($value === '') {
        continue;                         // an unanswered quiz step adds nothing
    }
    /* PHP turns the space in a field name into an underscore ("Type
       werkzaamheden" arrives as "Type_werkzaamheden"). Undo that, or the
       message reads like a variable dump. No form field uses an underscore
       of its own. */
    $label = str_replace('_', ' ', $key);
    $fields[substr($label, 0, 80)] = mb_substr($value, 0, 3000);
}

$name  = $fields['Naam']     ?? ($fields['Name'] ?? '');
$phone = $fields['Telefoon'] ?? ($fields['Phone'] ?? '');
$email = $fields['E-mail']   ?? ($fields['Email'] ?? '');

if ($name === '' || ($phone === '' && $email === '')) {
    lead_out(false, $T['fields'], 422);
}
if ($email !== '' && !lead_is_email($email)) {
    lead_out(false, $T['email'], 422);
}

/* ---------- optional CV upload (vacancy form) ----------
   Rejected uploads never block the lead itself: the message still goes out,
   with a note explaining why the document was dropped. */
$attachment = null;
$cvNote     = '';
$cv         = $_FILES['CV'] ?? null;

if (is_array($cv) && (int)($cv['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_NO_FILE) {
    $err  = (int)$cv['error'];
    $tmp  = (string)($cv['tmp_name'] ?? '');
    $size = (int)($cv['size'] ?? 0);

    if ($err !== UPLOAD_ERR_OK || !is_uploaded_file($tmp)) {
        $cvNote = $err === UPLOAD_ERR_INI_SIZE || $err === UPLOAD_ERR_FORM_SIZE
            ? 'CV te groot — niet meegestuurd.'
            : 'CV kon niet worden ontvangen.';
    } elseif ($size <= 0 || $size > HB_CV_MAX) {
        $cvNote = 'CV te groot (max ' . (int)(HB_CV_MAX / 1048576) . ' MB) — niet meegestuurd.';
    } else {
        /* Trust the file's own signature, not the browser-supplied type. */
        $mime = '';
        if (function_exists('finfo_open')) {
            $fi = finfo_open(FILEINFO_MIME_TYPE);
            if ($fi) {
                $mime = (string)finfo_file($fi, $tmp);
                finfo_close($fi);
            }
        }
        /* Older .doc files are reported as a generic OLE container. */
        if ($mime === 'application/vnd.ms-office' || $mime === 'application/x-ole-storage') {
            $mime = 'application/msword';
        }
        /* A .docx is a zip; accept it only when the name agrees. */
        $origExt = strtolower((string)pathinfo((string)($cv['name'] ?? ''), PATHINFO_EXTENSION));
        if ($mime === 'application/zip' && $origExt === 'docx') {
            $mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        }

        if (!isset(HB_CV_TYPES[$mime])) {
            $cvNote = 'CV geweigerd (alleen PDF of Word) — niet meegestuurd.';
        } else {
            $ext  = HB_CV_TYPES[$mime];
            $data = (string)@file_get_contents($tmp);
            if ($data === '') {
                $cvNote = 'CV kon niet worden gelezen.';
            } else {
                /* Filename is rebuilt from the applicant's name: whatever the
                   browser sent is never used as a path component. */
                $slug = preg_replace('/[^a-z0-9]+/', '-', strtolower(
                    iconv('UTF-8', 'ASCII//TRANSLIT', $name) ?: 'sollicitant'
                ));
                $slug = trim((string)$slug, '-') ?: 'sollicitant';
                $attachment = [
                    'name' => 'CV-' . substr($slug, 0, 40) . '.' . $ext,
                    'mime' => $mime,
                    'data' => $data,
                ];
            }
        }
    }
}

/* ---------- throttle ---------- */
$ip    = lead_ip();
$now   = time();
$today = gmdate('Y-m-d');

$verdict = lead_with_lock(static function () use ($ip, $now, $today) {
    $rate = hb_store_read(HB_LEAD_RATE);

    /* Drop yesterday's counters so the file cannot grow without bound. */
    foreach ($rate as $k => $row) {
        if (($row['day'] ?? '') !== $today) {
            unset($rate[$k]);
        }
    }

    $row = $rate[$ip] ?? ['day' => $today, 'count' => 0, 'last' => 0];
    if (($row['day'] ?? '') !== $today) {
        $row = ['day' => $today, 'count' => 0, 'last' => 0];
    }
    if ($now - (int)$row['last'] < HB_LEAD_MIN_GAP) {
        return 'soon';
    }
    if ((int)$row['count'] >= HB_LEAD_PER_DAY) {
        return 'limit';
    }

    $row['count'] = (int)$row['count'] + 1;
    $row['last']  = $now;
    $rate[$ip]    = $row;
    hb_store_write(HB_LEAD_RATE, $rate);
    return 'ok';
});

if ($verdict !== 'ok') {
    lead_out(false, $T[$verdict], 429);
}

/* ---------- build the message ---------- */
$subject = lead_header_safe((string)($body['_subject'] ?? ''));
if ($subject === '') {
    $subject = 'Herstel & Bouw — Nieuwe aanvraag';
}
$subject = mb_substr($subject, 0, 160) . ' — ' . $name;

$stamp = (new DateTimeImmutable('now', new DateTimeZone('Europe/Amsterdam')))
    ->format('d-m-Y H:i');
$page  = lead_header_safe((string)($_SERVER['HTTP_REFERER'] ?? ''));

if ($attachment !== null) {
    $fields['CV'] = $attachment['name'] . ' (bijlage)';
} elseif ($cvNote !== '') {
    $fields['CV'] = $cvNote;
}

$meta = [
    'Ontvangen' => $stamp . ' (Amsterdam)',
    'Taal'      => $lang === 'en' ? 'English' : 'Nederlands',
    'Pagina'    => $page !== '' ? mb_substr($page, 0, 300) : '—',
    'IP'        => $ip,
];

/* Plain-text part — the fallback every mail client can render. */
$text = "Nieuwe aanvraag via herstelenbouw.nl\n\n";
foreach ($fields as $k => $v) {
    $text .= $k . ': ' . $v . "\n";
}
$text .= "\n---\n";
foreach ($meta as $k => $v) {
    $text .= $k . ': ' . $v . "\n";
}

/* HTML part — the same data as a table, so a long quiz stays readable. */
$esc  = static fn (string $s): string => htmlspecialchars($s, ENT_QUOTES, 'UTF-8');
$rows = '';
foreach ($fields as $k => $v) {
    $rows .= '<tr>'
        . '<td style="padding:10px 14px;border-bottom:1px solid #eee7dd;color:#6b6259;'
        . 'font:500 13px/1.5 Arial,sans-serif;white-space:nowrap;vertical-align:top">'
        . $esc($k) . '</td>'
        . '<td style="padding:10px 14px;border-bottom:1px solid #eee7dd;color:#1c1a17;'
        . 'font:400 14px/1.6 Arial,sans-serif">'
        . nl2br($esc($v)) . '</td>'
        . '</tr>';
}
$metaRows = '';
foreach ($meta as $k => $v) {
    $metaRows .= '<tr>'
        . '<td style="padding:4px 14px;color:#8a8178;font:400 12px/1.5 Arial,sans-serif;'
        . 'white-space:nowrap;vertical-align:top">' . $esc($k) . '</td>'
        . '<td style="padding:4px 14px;color:#8a8178;font:400 12px/1.5 Arial,sans-serif;'
        . 'word-break:break-all">' . $esc($v) . '</td>'
        . '</tr>';
}

$replyLinks = '';
if ($phone !== '') {
    $tel = preg_replace('/[^0-9+]/', '', $phone);
    $replyLinks .= '<a href="tel:' . $esc((string)$tel) . '" style="display:inline-block;'
        . 'margin:0 8px 8px 0;padding:9px 16px;background:#1c1a17;color:#fff;'
        . 'text-decoration:none;border-radius:6px;font:500 13px Arial,sans-serif">Bellen</a>';
}
if ($email !== '') {
    $replyLinks .= '<a href="mailto:' . $esc($email) . '" style="display:inline-block;'
        . 'margin:0 8px 8px 0;padding:9px 16px;background:#fff;color:#1c1a17;'
        . 'text-decoration:none;border:1px solid #d9d0c4;border-radius:6px;'
        . 'font:500 13px Arial,sans-serif">E-mail beantwoorden</a>';
}

$html = '<!doctype html><html lang="nl"><body style="margin:0;padding:24px;background:#fbf9f6">'
    . '<table role="presentation" cellpadding="0" cellspacing="0" style="max-width:640px;'
    . 'margin:0 auto;width:100%;background:#fff;border:1px solid #eee7dd;border-radius:10px">'
    . '<tr><td style="padding:18px 14px 8px">'
    . '<div style="color:#8a8178;font:500 11px/1.4 Arial,sans-serif;letter-spacing:.08em;'
    . 'text-transform:uppercase">herstelenbouw.nl</div>'
    . '<div style="color:#1c1a17;font:700 19px/1.4 Arial,sans-serif;margin-top:4px">'
    . $esc($subject) . '</div></td></tr>'
    . '<tr><td style="padding:8px 0 0"><table role="presentation" cellpadding="0" '
    . 'cellspacing="0" style="width:100%">' . $rows . '</table></td></tr>'
    . ($replyLinks !== '' ? '<tr><td style="padding:16px 14px 4px">' . $replyLinks . '</td></tr>' : '')
    . '<tr><td style="padding:8px 0 16px"><table role="presentation" cellpadding="0" '
    . 'cellspacing="0" style="width:100%">' . $metaRows . '</table></td></tr>'
    . '</table></body></html>';

/* Body: text and HTML as alternatives, wrapped in a mixed part only when a
   document rides along. */
$altBoundary = 'hbalt' . bin2hex(random_bytes(10));
$alt = "--{$altBoundary}\r\n"
    . "Content-Type: text/plain; charset=UTF-8\r\n"
    . "Content-Transfer-Encoding: 8bit\r\n\r\n"
    . $text . "\r\n"
    . "--{$altBoundary}\r\n"
    . "Content-Type: text/html; charset=UTF-8\r\n"
    . "Content-Transfer-Encoding: 8bit\r\n\r\n"
    . $html . "\r\n"
    . "--{$altBoundary}--\r\n";

if ($attachment !== null) {
    $mixBoundary = 'hbmix' . bin2hex(random_bytes(10));
    $message = "--{$mixBoundary}\r\n"
        . "Content-Type: multipart/alternative; boundary=\"{$altBoundary}\"\r\n\r\n"
        . $alt . "\r\n"
        . "--{$mixBoundary}\r\n"
        . 'Content-Type: ' . $attachment['mime'] . '; name="' . $attachment['name'] . "\"\r\n"
        . "Content-Transfer-Encoding: base64\r\n"
        . 'Content-Disposition: attachment; filename="' . $attachment['name'] . "\"\r\n\r\n"
        . chunk_split(base64_encode($attachment['data']), 76, "\r\n")
        . "--{$mixBoundary}--\r\n";
    $contentType = 'multipart/mixed; boundary="' . $mixBoundary . '"';
} else {
    $message     = $alt;
    $contentType = 'multipart/alternative; boundary="' . $altBoundary . '"';
}

$headers = [
    'MIME-Version: 1.0',
    'Content-Type: ' . $contentType,
    'From: ' . lead_encode_header(HB_LEAD_FROM_NAME) . ' <' . HB_LEAD_FROM . '>',
    'X-Mailer: herstelenbouw.nl',
    'Auto-Submitted: auto-generated',
];
/* Replying in the mail client should reach the visitor, not the no-reply box. */
$headers[] = $email !== ''
    ? 'Reply-To: ' . lead_encode_header($name) . ' <' . $email . '>'
    : 'Reply-To: ' . HB_LEAD_FROM;

$sent = @mail(
    HB_LEAD_TO,
    lead_encode_header($subject),
    $message,
    implode("\r\n", $headers),
    '-f' . HB_LEAD_FROM              // envelope sender, so bounces are routable
);

/* ---------- keep a private copy ----------
   The inbox is the delivery channel; this is the audit trail. It is written
   whether or not the message left the server, so a silently dropped mail can
   still be recovered from the admin storage folder. */
$leadId = bin2hex(random_bytes(6));

/* The document itself is kept beside the record. The folder inherits the
   storage .htaccess, and the name carries the lead id, so a CV can be found
   from the archive without trusting anything the browser sent. */
$storedFile = '';
if ($attachment !== null) {
    hb_ensure_dir(HB_LEAD_FILES);
    if (!is_file(HB_LEAD_FILES . '/.htaccess')) {
        @file_put_contents(
            HB_LEAD_FILES . '/.htaccess',
            "# Private lead attachments — never served over HTTP.\n"
            . "<IfModule mod_authz_core.c>\n  Require all denied\n</IfModule>\n"
            . "<IfModule !mod_authz_core.c>\n  Order allow,deny\n  Deny from all\n</IfModule>\n"
        );
    }
    $storedFile = $leadId . '-' . $attachment['name'];
    if (@file_put_contents(HB_LEAD_FILES . '/' . $storedFile, $attachment['data']) === false) {
        $storedFile = '';
    } else {
        @chmod(HB_LEAD_FILES . '/' . $storedFile, 0600);
    }
}

lead_with_lock(static function () use ($fields, $meta, $sent, $subject, $now, $leadId, $storedFile) {
    $leads   = hb_store_read(HB_LEAD_STORE);
    $leads[] = [
        'id'      => $leadId,
        'at'      => gmdate('c', $now),
        'subject' => $subject,
        'mailed'  => $sent,
        'file'    => $storedFile,
        'fields'  => $fields,
        'meta'    => $meta,
    ];
    if (count($leads) > HB_LEAD_KEEP) {
        $dropped = array_slice($leads, 0, count($leads) - HB_LEAD_KEEP);
        $leads   = array_slice($leads, -HB_LEAD_KEEP);
        /* An expired record must not leave its CV behind on disk. */
        foreach ($dropped as $old) {
            if (!empty($old['file'])) {
                @unlink(HB_LEAD_FILES . '/' . basename((string)$old['file']));
            }
        }
    }
    hb_store_write(HB_LEAD_STORE, $leads);
});

if (!$sent) {
    lead_out(false, $T['fail'], 502);
}

lead_out(true, $T['thanks']);
