<?php
/* ==========================================================================
   Admin entry point: first-run setup -> login -> panel.
   ========================================================================== */
declare(strict_types=1);

define('HB_ADMIN', true);
require __DIR__ . '/lib/bootstrap.php';
require __DIR__ . '/lib/auth.php';

header('X-Frame-Options: DENY');
header('Referrer-Policy: same-origin');
header('X-Content-Type-Options: nosniff');

hb_session_start();

$notice = '';
$error  = '';
$stage  = hb_is_configured() ? (hb_is_logged_in() ? 'panel' : 'login') : 'setup';

/* ---------------------------------------------------------------- actions */
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
    $do = $_POST['do'] ?? '';

    if (!hb_csrf_check($_POST['csrf'] ?? null)) {
        $error = 'Сторінка застаріла. Спробуйте ще раз.';
    } elseif ($do === 'setup' && !hb_is_configured()) {
        $pw  = (string)($_POST['password'] ?? '');
        $pw2 = (string)($_POST['password2'] ?? '');
        if (mb_strlen($pw) < 10) {
            $error = 'Пароль має бути щонайменше 10 символів.';
        } elseif ($pw !== $pw2) {
            $error = 'Паролі не збігаються.';
        } elseif (!hb_config_write(password_hash($pw, PASSWORD_DEFAULT))) {
            $error = 'Не вдалося зберегти config.php — перевірте права на теку admin/.';
        } else {
            hb_login($pw);
            header('Location: index.php');
            exit;
        }
        $stage = 'setup';
    } elseif ($do === 'login') {
        $wait = hb_lockout_remaining();
        if ($wait > 0) {
            $error = 'Забагато невдалих спроб. Спробуйте через ' . ceil($wait / 60) . ' хв.';
        } elseif (hb_login((string)($_POST['password'] ?? ''))) {
            header('Location: index.php');
            exit;
        } else {
            $left  = hb_attempts_left();
            $error = 'Невірний пароль.' . ($left > 0 && $left <= 3 ? " Залишилось спроб: {$left}." : '');
        }
        $stage = 'login';
    } elseif ($do === 'logout') {
        hb_logout();
        header('Location: index.php');
        exit;
    }
}

if ($stage === 'panel' && !hb_is_logged_in()) {
    $stage = 'login';
}
$csrf = hb_csrf_token();
?>
<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Herstel &amp; Bouw — панель керування</title>
<link rel="icon" href="../images/logo-mark.png">
<link rel="stylesheet" href="assets/admin.css?v=2">
</head>
<body class="stage-<?= htmlspecialchars($stage, ENT_QUOTES) ?>">

<?php if ($stage === 'setup' || $stage === 'login'): ?>
  <!-- ============================ GATE ============================ -->
  <main class="gate">
    <form class="gate-card" method="post" autocomplete="off">
      <input type="hidden" name="csrf" value="<?= htmlspecialchars($csrf, ENT_QUOTES) ?>">
      <div class="gate-brand">
        <img src="../images/logo-mark.png" alt="">
        <div>
          <strong>Herstel &amp; Bouw</strong>
          <span>панель керування</span>
        </div>
      </div>

      <?php if ($stage === 'setup'): ?>
        <input type="hidden" name="do" value="setup">
        <h1>Перший запуск</h1>
        <p class="gate-lead">Придумайте пароль для входу в адмінку. Він збережеться у вигляді хешу в <code>admin/config.php</code>.</p>
        <div class="gate-warn">Зробіть це одразу після заливки сайту на хостинг — доки пароль не встановлено, форму бачить будь-хто.</div>
        <label class="field">
          <span>Пароль <em>(мінімум 10 символів)</em></span>
          <input type="password" name="password" required minlength="10" autofocus>
        </label>
        <label class="field">
          <span>Повторіть пароль</span>
          <input type="password" name="password2" required minlength="10">
        </label>
        <button class="btn btn-primary" type="submit">Створити пароль і увійти</button>
      <?php else: ?>
        <input type="hidden" name="do" value="login">
        <h1>Вхід</h1>
        <p class="gate-lead">Введіть пароль, щоб редагувати послуги та проєкти.</p>
        <label class="field">
          <span>Пароль</span>
          <input type="password" name="password" required autofocus>
        </label>
        <button class="btn btn-primary" type="submit">Увійти</button>
      <?php endif; ?>

      <?php if ($error): ?><p class="gate-error"><?= htmlspecialchars($error, ENT_QUOTES) ?></p><?php endif; ?>
      <?php if ($notice): ?><p class="gate-ok"><?= htmlspecialchars($notice, ENT_QUOTES) ?></p><?php endif; ?>

      <a class="gate-back" href="../index.html">← Повернутися на сайт</a>
    </form>
  </main>

<?php else: ?>
  <!-- ============================ PANEL ============================ -->
  <header class="topbar">
    <div class="topbar-brand">
      <img src="../images/logo-mark.png" alt="">
      <span>Панель керування</span>
    </div>

    <nav class="tabs" role="tablist">
      <button class="tab is-active" data-tab="services" role="tab">Послуги<span class="tab-count" data-count="services">—</span></button>
      <button class="tab" data-tab="projects" role="tab">Проєкти<span class="tab-count" data-count="projects">—</span></button>
      <button class="tab" data-tab="reviews" role="tab">Відгуки<span class="tab-count" data-count="reviews">—</span></button>
    </nav>

    <div class="topbar-actions">
      <span class="save-state" id="save-state">Завантаження…</span>
      <button class="btn btn-ghost" id="btn-revert" title="Повернутись до збереженої версії" disabled>Скасувати зміни</button>
      <button class="btn btn-ghost" id="btn-history" title="Резервні копії">Історія</button>
      <a class="btn btn-ghost" href="../index.html" target="_blank" rel="noopener">Сайт ↗</a>
      <button class="btn btn-primary" id="btn-save" disabled>Зберегти</button>
      <form method="post" class="logout-form">
        <input type="hidden" name="csrf" value="<?= htmlspecialchars($csrf, ENT_QUOTES) ?>">
        <input type="hidden" name="do" value="logout">
        <button class="btn btn-ghost" type="submit" title="Вийти">Вийти</button>
      </form>
    </div>
  </header>

  <main class="workspace">
    <aside class="sidebar">
      <div class="sidebar-head">
        <input type="search" id="filter" placeholder="Пошук…" autocomplete="off">
        <button class="btn btn-add" id="btn-add" title="Додати новий запис">+ Додати</button>
      </div>

      <div class="status-bar" id="status-bar" hidden>
        <button class="chip is-active" data-status="all">Усі</button>
        <button class="chip" data-status="pending">Очікують<span class="chip-n" id="n-pending">0</span></button>
        <button class="chip" data-status="approved">На сайті</button>
        <button class="chip" data-status="rejected">Відхилені</button>
      </div>
      <ol class="item-list" id="item-list"></ol>
      <p class="sidebar-hint" id="sidebar-hint">Перетягніть запис, щоб змінити порядок на сайті.</p>
    </aside>

    <section class="editor" id="editor"></section>
  </main>

  <div class="toast-host" id="toasts"></div>

  <div class="modal" id="modal" hidden>
    <div class="modal-backdrop" data-close></div>
    <div class="modal-card" role="dialog" aria-modal="true">
      <header class="modal-head">
        <h2 id="modal-title">—</h2>
        <button class="modal-x" data-close aria-label="Закрити">×</button>
      </header>
      <div class="modal-body" id="modal-body"></div>
    </div>
  </div>

  <script>window.HB_CSRF = <?= json_encode($csrf) ?>;</script>
  <script src="assets/admin.js?v=2"></script>
<?php endif; ?>

</body>
</html>
