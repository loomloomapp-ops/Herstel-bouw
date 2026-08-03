<?php
/* ==========================================================================
   Schema validation.

   Everything the browser sends is rebuilt field by field here — unknown keys
   are dropped, types are coerced, and anything the front-end would choke on
   is rejected with a human-readable message. data/*.json feeds the live
   site directly, so this is the only thing standing between a typo in the
   panel and a broken page.
   ========================================================================== */
declare(strict_types=1);

if (!defined('HB_ADMIN')) {
    exit;
}

/* Filter chips on projects.html are still static markup, so a project may
   only use one of these categories — anything else would render a card that
   no filter can reach. */
const HB_CATEGORIES = ['badkamers', 'uitbreidingen', 'gevelrenovatie', 'verbouwing', 'kozijnen'];

/* Gallery layout classes understood by css/style.css. */
const HB_GALLERY_CLS = ['g-wide', 'g-tall', 'g-half'];

const HB_MAX_TEXT = 4000;

final class HbValidationError extends RuntimeException
{
}

function hb_fail_field(string $message): void
{
    throw new HbValidationError($message);
}

/* ---------- primitives ---------- */
function hb_str($v, int $max = 300): string
{
    if (is_numeric($v)) {
        $v = (string)$v;
    }
    if (!is_string($v)) {
        return '';
    }
    /* Normalise newlines, strip control characters, collapse trailing space. */
    $v = str_replace(["\r\n", "\r"], "\n", $v);
    $v = preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u', '', $v) ?? '';
    return mb_substr(trim($v), 0, $max);
}

/* A { nl, en } pair. EN falls back to NL so a half-translated entry still
   renders instead of showing an empty slot to English visitors. */
function hb_lang_pair($v, string $label, bool $required = true, int $max = HB_MAX_TEXT): array
{
    $nl = hb_str(is_array($v) ? ($v['nl'] ?? '') : $v, $max);
    $en = hb_str(is_array($v) ? ($v['en'] ?? '') : '', $max);
    if ($required && $nl === '') {
        hb_fail_field("Поле «{$label}» (NL) не може бути порожнім.");
    }
    if ($en === '') {
        $en = $nl;
    }
    return ['nl' => $nl, 'en' => $en];
}

/* Image paths must stay inside the site's images/ folder. */
function hb_image_path($v, string $label, bool $required = true): string
{
    $p = hb_str($v, 300);
    $p = ltrim(str_replace('\\', '/', $p), '/');
    if ($p === '') {
        if ($required) {
            hb_fail_field("Не вибрано зображення для «{$label}».");
        }
        return '';
    }
    if (str_contains($p, '..') || !str_starts_with($p, 'images/')) {
        hb_fail_field("Шлях до зображення «{$label}» має починатися з images/ (отримано: {$p}).");
    }
    if (!preg_match('/\.(jpe?g|png|webp|gif|avif|svg)$/i', $p)) {
        hb_fail_field("Файл «{$p}» не схожий на зображення.");
    }
    return $p;
}

function hb_slug($v, string $label): string
{
    $s = strtolower(hb_str($v, 80));
    $s = preg_replace('/[^a-z0-9]+/', '-', $s) ?? '';
    $s = trim($s, '-');
    if ($s === '') {
        hb_fail_field("Поле «{$label}» (ідентифікатор) не може бути порожнім.");
    }
    return $s;
}

/* ---------- services ---------- */
function hb_sanitize_services($input): array
{
    if (!is_array($input)) {
        hb_fail_field('Очікувався список послуг.');
    }
    if (count($input) > 60) {
        hb_fail_field('Забагато послуг (максимум 60).');
    }

    $out = [];
    $seen = [];
    foreach (array_values($input) as $i => $raw) {
        if (!is_array($raw)) {
            continue;
        }
        $n = $i + 1;
        $title = hb_lang_pair($raw['title'] ?? '', "Послуга №{$n} — назва", true, 300);

        $id = hb_str($raw['id'] ?? '', 80);
        $id = $id !== '' ? hb_slug($id, "Послуга №{$n}") : hb_slug($title['nl'], "Послуга №{$n}");
        while (isset($seen[$id])) {           // ids must be unique for the UI
            $id .= '-2';
        }
        $seen[$id] = true;

        $href = hb_str($raw['href'] ?? '#contact', 300);
        if ($href === '') {
            $href = '#contact';
        }
        if (preg_match('/^\s*javascript:/i', $href)) {
            hb_fail_field("Посилання послуги №{$n} має недопустимий формат.");
        }

        $out[] = [
            'id'    => $id,
            'title' => $title,
            'desc'  => hb_lang_pair($raw['desc'] ?? '', "Послуга №{$n} — опис", true, 600),
            'image' => hb_image_path($raw['image'] ?? '', "Послуга №{$n}"),
            'href'  => $href,
        ];
    }
    if (!$out) {
        hb_fail_field('Список послуг не може бути порожнім.');
    }
    return $out;
}

/* ---------- projects ---------- */
function hb_string_list($v, int $max = 24): array
{
    if (is_string($v)) {
        $v = preg_split('/\n+/', $v) ?: [];
    }
    if (!is_array($v)) {
        return [];
    }
    $out = [];
    foreach ($v as $item) {
        $s = hb_str($item, 160);
        if ($s !== '') {
            $out[] = $s;
        }
    }
    return array_slice($out, 0, $max);
}

function hb_sanitize_projects($input): array
{
    if (!is_array($input)) {
        hb_fail_field('Очікувався список проєктів.');
    }
    if (count($input) > 200) {
        hb_fail_field('Забагато проєктів (максимум 200).');
    }

    $out  = [];
    $seen = [];
    foreach (array_values($input) as $i => $raw) {
        if (!is_array($raw)) {
            continue;
        }
        $n     = $i + 1;
        $title = hb_lang_pair($raw['title'] ?? '', "Проєкт №{$n} — заголовок", true, 300);

        $id = hb_str($raw['id'] ?? '', 80);
        $id = $id !== '' ? hb_slug($id, "Проєкт №{$n}") : hb_slug($title['nl'], "Проєкт №{$n}");
        if (isset($seen[$id])) {
            hb_fail_field("Дублікат ідентифікатора «{$id}» — він використовується в адресі сторінки й має бути унікальним.");
        }
        $seen[$id] = true;

        $cat = hb_str($raw['cat'] ?? '', 40);
        if (!in_array($cat, HB_CATEGORIES, true)) {
            hb_fail_field("Проєкт «{$id}»: категорія «{$cat}» невідома. Дозволені: " . implode(', ', HB_CATEGORIES) . '.');
        }

        /* services: parallel NL/EN lists — the front-end indexes them by
           language, so a length mismatch would silently drop bullet points. */
        $svcNl = hb_string_list($raw['services']['nl'] ?? []);
        $svcEn = hb_string_list($raw['services']['en'] ?? []);
        if (!$svcEn) {
            $svcEn = $svcNl;
        }
        if (count($svcNl) !== count($svcEn)) {
            hb_fail_field("Проєкт «{$id}»: кількість пунктів «Werkzaamheden» у NL (" . count($svcNl) . ") і EN (" . count($svcEn) . ") має збігатися.");
        }

        $gallery = [];
        foreach (array_values($raw['gallery'] ?? []) as $gi => $g) {
            if (!is_array($g)) {
                continue;
            }
            $src = hb_image_path($g['src'] ?? '', "Проєкт «{$id}», фото №" . ($gi + 1));
            $cls = hb_str($g['cls'] ?? '', 20);
            if (!in_array($cls, HB_GALLERY_CLS, true)) {
                $cls = 'g-half';
            }
            $gallery[] = [
                'src' => $src,
                'cap' => hb_lang_pair($g['cap'] ?? '', "Проєкт «{$id}», підпис до фото №" . ($gi + 1), false, 300),
                'cls' => $cls,
            ];
            if (count($gallery) >= 40) {
                break;
            }
        }

        $meta = is_array($raw['meta'] ?? null) ? $raw['meta'] : [];
        $year = hb_str($meta['year'] ?? '', 10);
        if ($year !== '' && !preg_match('/^\d{4}$/', $year)) {
            hb_fail_field("Проєкт «{$id}»: рік має бути з чотирьох цифр (отримано «{$year}»).");
        }

        $out[] = [
            'id'        => $id,
            'cat'       => $cat,
            'catLabel'  => hb_lang_pair($raw['catLabel'] ?? '', "Проєкт «{$id}» — підпис категорії", true, 120),
            'title'     => $title,
            'location'  => hb_str($raw['location'] ?? '', 120),
            'cover'     => hb_image_path($raw['cover'] ?? '', "Проєкт «{$id}» — обкладинка"),
            'short'     => hb_lang_pair($raw['short'] ?? '', "Проєкт «{$id}» — короткий опис", true),
            'intro'     => hb_lang_pair($raw['intro'] ?? '', "Проєкт «{$id}» — вступ", false),
            'challenge' => hb_lang_pair($raw['challenge'] ?? '', "Проєкт «{$id}» — виклик", false),
            'result'    => hb_lang_pair($raw['result'] ?? '', "Проєкт «{$id}» — результат", false),
            'services'  => ['nl' => $svcNl, 'en' => $svcEn],
            'meta'      => [
                'duration' => hb_lang_pair($meta['duration'] ?? '', "Проєкт «{$id}» — тривалість", false, 60),
                'year'     => $year,
                'type'     => hb_lang_pair($meta['type'] ?? '', "Проєкт «{$id}» — тип", false, 120),
                'budget'   => hb_str($meta['budget'] ?? '', 60),
            ],
            'gallery'   => $gallery,
        ];
    }
    if (!$out) {
        hb_fail_field('Список проєктів не може бути порожнім.');
    }
    return $out;
}

/* ---------- reviews ---------- */
const HB_REVIEW_STATUSES = ['pending', 'approved', 'rejected'];

/* A visitor writes in one language only, so unlike editorial copy either
   side may be the empty one — the filled side is mirrored across. */
function hb_lang_pair_loose($v, string $label, int $max = HB_MAX_TEXT): array
{
    $nl = hb_str(is_array($v) ? ($v['nl'] ?? '') : $v, $max);
    $en = hb_str(is_array($v) ? ($v['en'] ?? '') : '', $max);
    if ($nl === '' && $en === '') {
        hb_fail_field("Поле «{$label}» не може бути порожнім.");
    }
    if ($nl === '') { $nl = $en; }
    if ($en === '') { $en = $nl; }
    return ['nl' => $nl, 'en' => $en];
}

function hb_sanitize_reviews($input): array
{
    if (!is_array($input)) {
        hb_fail_field('Очікувався список відгуків.');
    }
    if (count($input) > 2000) {
        hb_fail_field('Забагато відгуків.');
    }

    $out  = [];
    $seen = [];
    foreach (array_values($input) as $i => $raw) {
        if (!is_array($raw)) {
            continue;
        }
        $n    = $i + 1;
        $name = hb_str($raw['name'] ?? '', 120);
        if ($name === '') {
            hb_fail_field("Відгук №{$n}: ім'я не може бути порожнім.");
        }

        $status = hb_str($raw['status'] ?? 'pending', 20);
        if (!in_array($status, HB_REVIEW_STATUSES, true)) {
            $status = 'pending';
        }

        $rating = (int)($raw['rating'] ?? 5);
        if ($rating < 1 || $rating > 5) {
            hb_fail_field("Відгук №{$n}: оцінка має бути від 1 до 5.");
        }

        $id = hb_str($raw['id'] ?? '', 60);
        if ($id === '' || isset($seen[$id])) {
            $id = 'r-' . substr(bin2hex(random_bytes(6)), 0, 10);
        }
        $seen[$id] = true;

        $out[] = [
            'id'       => $id,
            'name'     => $name,
            'location' => hb_str($raw['location'] ?? '', 120),
            'service'  => hb_lang_pair_loose($raw['service'] ?? '—', "Відгук №{$n} — тип робіт", 160),
            'text'     => hb_lang_pair_loose($raw['text'] ?? '', "Відгук №{$n} — текст", 2000),
            'rating'   => $rating,
            'status'   => $status,
            'created'  => hb_str($raw['created'] ?? '', 40) ?: gmdate('c'),
            'source'   => in_array($raw['source'] ?? '', ['seed', 'form', 'admin'], true) ? $raw['source'] : 'admin',
            /* Never rendered on the site — kept so the owner can reply. */
            'email'    => hb_str($raw['email'] ?? '', 160),
        ];
    }
    return $out;
}

/* Projects the private store down to what the site is allowed to see:
   approved entries only, and without the submitter's e-mail. */
function hb_reviews_public(array $all): array
{
    $pub = [];
    foreach ($all as $r) {
        if (($r['status'] ?? '') !== 'approved') {
            continue;
        }
        $pub[] = [
            'id'       => $r['id'],
            'name'     => $r['name'],
            'location' => $r['location'],
            'service'  => $r['service'],
            'text'     => $r['text'],
            'rating'   => $r['rating'],
            'created'  => $r['created'],
        ];
    }
    return $pub;
}

function hb_sanitize(string $key, $payload): array
{
    if ($key === 'services') {
        return hb_sanitize_services($payload);
    }
    if ($key === 'reviews') {
        return hb_sanitize_reviews($payload);
    }
    return hb_sanitize_projects($payload);
}
