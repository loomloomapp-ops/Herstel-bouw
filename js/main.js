/* ==========================================================================
   Herstel & Bouw — site interactivity
   ========================================================================== */
(function () {
  "use strict";

  /* Where form submissions are delivered. FormSubmit relays to the inbox
     below with no backend. The first submission triggers a one-time
     activation email to herstelenbouw@gmail.com — confirm it once. */
  var FORM_ENDPOINT = "https://formsubmit.co/ajax/herstelenbouw@gmail.com";

  var EN = window.HB_EN || {};
  var nlCache = {};          /* data-i18n key -> original Dutch text */
  var nlPhCache = {};        /* data-i18n-ph key -> original Dutch placeholder */
  var lang = localStorage.getItem("hb_lang") || "nl";

  /* ---------- helpers ---------- */
  function $(s, c) { return (c || document).querySelector(s); }
  function $all(s, c) { return Array.prototype.slice.call((c || document).querySelectorAll(s)); }
  var ARROW = '<span class="btn-ico"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12 12 4M6 4h6v6"/></svg></span>';
  var ARROW_PLAIN = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h10M9 4l4 4-4 4"/></svg>';
  function t(key, fallback) { return lang === "en" ? (EN[key] != null ? EN[key] : fallback) : fallback; }

  /* Content comes from admin-editable JSON, so it is escaped before it is
     ever concatenated into innerHTML — an apostrophe or "<" in a title
     would otherwise break the markup. */
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  /* { nl, en } field -> string for the active language, falling back to NL. */
  function pick(f) {
    if (f == null) return "";
    if (typeof f === "string") return f;
    return f[lang] || f.nl || f.en || "";
  }

  /* ---------- i18n ---------- */
  function cacheStaticText() {
    $all("[data-i18n]").forEach(function (el) {
      var k = el.getAttribute("data-i18n");
      if (!(k in nlCache)) nlCache[k] = el.innerHTML;
    });
    $all("[data-i18n-ph]").forEach(function (el) {
      var k = el.getAttribute("data-i18n-ph");
      if (!(k in nlPhCache)) nlPhCache[k] = el.getAttribute("placeholder") || "";
    });
  }
  function applyLang(next) {
    lang = next;
    localStorage.setItem("hb_lang", lang);
    document.documentElement.setAttribute("lang", lang);
    $all("[data-i18n]").forEach(function (el) {
      var k = el.getAttribute("data-i18n");
      if (lang === "en" && EN[k] != null) el.innerHTML = EN[k];
      else if (nlCache[k] != null) el.innerHTML = nlCache[k];
    });
    $all("[data-i18n-ph]").forEach(function (el) {
      var k = el.getAttribute("data-i18n-ph");
      if (lang === "en" && EN[k] != null) el.setAttribute("placeholder", EN[k]);
      else if (nlPhCache[k] != null) el.setAttribute("placeholder", nlPhCache[k]);
    });
    $all(".lang-switch button").forEach(function (b) {
      b.classList.toggle("is-active", b.getAttribute("data-lang") === lang);
    });
    /* re-render dynamic, data-driven blocks */
    renderDynamic();
    paintHeroCard();
  }

  /* ---------- preloader ----------
     Plays the branded intro for at least PRE_MIN ms, then fades out once the
     page has fully loaded. A hard fallback guarantees it never gets stuck. */
  function initPreloader() {
    var pre = document.getElementById("preloader");
    if (!pre) return;
    var PRE_MIN = 1100;          /* keep the intro visible at least this long */
    var startT = Date.now();
    var hidden = false;

    function remove() {
      if (pre && pre.parentNode) pre.parentNode.removeChild(pre);
    }
    function hide() {
      if (hidden) return;
      hidden = true;
      var wait = Math.max(0, PRE_MIN - (Date.now() - startT));
      setTimeout(function () {
        pre.classList.add("is-done");
        pre.addEventListener("transitionend", function onEnd(e) {
          if (e.target === pre && e.propertyName === "opacity") {
            pre.removeEventListener("transitionend", onEnd);
            remove();
          }
        });
        setTimeout(remove, 1400); /* fallback if transitionend never fires */
      }, wait);
    }

    if (document.readyState === "complete") hide();
    else window.addEventListener("load", hide);
    setTimeout(hide, 6000); /* never trap the page behind the intro */
  }

  /* ---------- navbar + overlay menu ---------- */
  function setMenu(open) {
    document.body.classList.toggle("nav-open", open);
    var toggle = $(".nav-toggle");
    if (toggle) toggle.setAttribute("aria-expanded", open ? "true" : "false");
  }
  function initNav() {
    var toggle = $(".nav-toggle");
    if (toggle) toggle.addEventListener("click", function () { setMenu(!document.body.classList.contains("nav-open")); });
    $all(".nav-overlay a").forEach(function (a) {
      a.addEventListener("click", function () { setMenu(false); });
    });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") setMenu(false); });
    $all(".lang-switch button").forEach(function (b) {
      b.addEventListener("click", function () { applyLang(b.getAttribute("data-lang")); });
    });
    /* mark active link in both the inline menu and the overlay */
    var page = document.body.getAttribute("data-page");
    $all(".nav-overlay-menu a, .nav-links a").forEach(function (a) {
      if (a.getAttribute("data-nav") === page) a.classList.add("is-active");
    });
  }

  /* ---------- scroll reveal ---------- */
  function initReveal() {
    var els = $all(".reveal");
    if (!("IntersectionObserver" in window) || !els.length) { els.forEach(function (e) { e.classList.add("in"); }); return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } });
    }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });
    els.forEach(function (e) { io.observe(e); });
  }

  /* ---------- gallery: continuously auto-spinning 3D photo wall ----------
     The cylinder rotation itself is a pure-CSS infinite linear animation
     (matching Arvista's repeat:-1 spin). Here we only pause it while the
     section is off-screen, so it costs nothing when not visible. */
  function initGallery() {
    var frame = $(".gal-frame");
    if (!frame) return;
    if (!("IntersectionObserver" in window)) return;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        frame.classList.toggle("is-paused", !e.isIntersecting);
      });
    }, { rootMargin: "120px 0px 120px 0px" });
    io.observe(frame);
  }

  /* ---------- hero slider (bg + project card synced) ---------- */
  var heroMeta = [
    { name: { nl: "Complete verbouwing", en: "Complete renovation" }, loc: "Almere" },
    { name: { nl: "Aanbouw met tuinkamer", en: "Garden-room extension" }, loc: "Amsterdam" },
    { name: { nl: "Badkamerrenovatie", en: "Bathroom renovation" }, loc: "Utrecht" },
    { name: { nl: "Gevelrenovatie", en: "Facade renovation" }, loc: "South Holland" }
  ];
  var heroIdx = 0, heroTimer = null;
  function paintHeroCard() {
    var n = $("#hc-name"), s = $("#hc-sub");
    var m = heroMeta[heroIdx]; if (!m) return;
    if (n) n.textContent = m.name[lang] || m.name.nl;
    if (s) s.textContent = m.loc;
  }
  function showHero(i) {
    /* background stays static — only the featured-project card + dots cycle */
    var card = $all(".hero-card-slide"), dots = $all("#hero-dots button");
    if (!card.length) return;
    card[heroIdx] && card[heroIdx].classList.remove("is-active");
    dots[heroIdx] && dots[heroIdx].classList.remove("is-active");
    heroIdx = (i + card.length) % card.length;
    card[heroIdx] && card[heroIdx].classList.add("is-active");
    dots[heroIdx] && dots[heroIdx].classList.add("is-active");
    paintHeroCard();
  }
  function initHeroSlider() {
    var card = $all(".hero-card-slide");
    if (card.length < 2) { paintHeroCard(); return; }
    var next = $("#hero-next");
    function schedule() { clearInterval(heroTimer); heroTimer = setInterval(function () { showHero(heroIdx + 1); }, 5200); }
    if (next) next.addEventListener("click", function () { showHero(heroIdx + 1); schedule(); });
    $all("#hero-dots button").forEach(function (d, di) {
      d.addEventListener("click", function () { showHero(di); schedule(); });
    });
    paintHeroCard();
    schedule();
  }

  /* ---------- FAQ ---------- */
  function initFaq() {
    $all(".faq-item").forEach(function (item) {
      var q = $(".faq-q", item), a = $(".faq-a", item);
      if (!q || !a) return;
      q.addEventListener("click", function () {
        var open = item.classList.toggle("is-open");
        a.style.maxHeight = open ? a.scrollHeight + "px" : 0;
        q.setAttribute("aria-expanded", open ? "true" : "false");
      });
    });
  }

  /* ---------- testimonials ---------- */
  /* Re-runnable: the cards are rebuilt whenever reviews load or the
     language changes, so every call starts from a clean slate. */
  function initTestimonials() {
    var grid = $("#testi-grid"), dotsHost = $("#testi-dots");
    var prevBtn = $("#testi-prev"), nextBtn = $("#testi-next");
    if (!grid || !dotsHost) return;
    var cards = $all(".testi-card", grid);

    dotsHost.innerHTML = "";
    dotsHost.style.display = "";
    if (prevBtn) { prevBtn.style.display = ""; prevBtn.onclick = null; prevBtn.disabled = false; }
    if (nextBtn) { nextBtn.style.display = ""; nextBtn.onclick = null; nextBtn.disabled = false; }

    /* On phones the reviews become a swipeable horizontal slider. */
    if (window.matchMedia("(max-width: 760px)").matches) {
      if (prevBtn) prevBtn.style.display = "none";
      if (nextBtn) nextBtn.style.display = "none";
      initTestiSlider(grid, dotsHost, cards);
      return;
    }

    var perPage = 3;
    var pages = Math.ceil(cards.length / perPage);
    if (pages < 2) {
      if (prevBtn) prevBtn.style.display = "none";
      if (nextBtn) nextBtn.style.display = "none";
      dotsHost.style.display = "none";
      return;
    }
    var cur = 0, dots = [];
    for (var i = 0; i < pages; i++) {
      var d = document.createElement("button");
      d.className = "tp-dot"; d.type = "button"; d.setAttribute("aria-label", "Pagina " + (i + 1));
      (function (idx) { d.addEventListener("click", function () { show(idx); }); })(i);
      dotsHost.appendChild(d); dots.push(d);
    }
    if (prevBtn) prevBtn.onclick = function () { show(cur - 1); };
    if (nextBtn) nextBtn.onclick = function () { show(cur + 1); };
    function show(n) {
      cur = Math.max(0, Math.min(pages - 1, n));
      cards.forEach(function (c, idx) {
        var visible = idx >= cur * perPage && idx < (cur + 1) * perPage;
        if (visible) { c.removeAttribute("hidden"); c.classList.add("in"); }
        else c.setAttribute("hidden", "");
      });
      dots.forEach(function (d, idx) { d.classList.toggle("is-active", idx === cur); });
      if (prevBtn) prevBtn.disabled = cur === 0;
      if (nextBtn) nextBtn.disabled = cur === pages - 1;
    }
    show(0);
  }

  /* mobile reviews slider — scroll-snap track with dot indicators */
  function initTestiSlider(grid, dotsHost, cards) {
    if (!cards.length) { dotsHost.style.display = "none"; return; }
    cards.forEach(function (c) { c.removeAttribute("hidden"); c.classList.add("in"); });
    dotsHost.innerHTML = "";
    var dots = cards.map(function (_, i) {
      var d = document.createElement("button");
      d.className = "tp-dot"; d.type = "button"; d.setAttribute("aria-label", "Beoordeling " + (i + 1));
      d.addEventListener("click", function () { goTo(i); });
      dotsHost.appendChild(d);
      return d;
    });
    function step() { return cards.length > 1 ? (cards[1].offsetLeft - cards[0].offsetLeft) : grid.clientWidth; }
    function curIndex() { return Math.round(grid.scrollLeft / step()); }
    function goTo(i) {
      i = Math.max(0, Math.min(cards.length - 1, i));
      grid.scrollTo({ left: i * step(), behavior: "smooth" });
    }
    function paint() {
      var idx = curIndex();
      dots.forEach(function (d, di) { d.classList.toggle("is-active", di === idx); });
    }
    /* The grid survives re-renders, so the scroll listener is attached
       once — otherwise every language switch would stack another one. */
    if (!grid.__hbScrollBound) {
      grid.__hbScrollBound = true;
      var raf = 0;
      grid.addEventListener("scroll", function () {
        if (raf) return;
        raf = window.requestAnimationFrame(function () { raf = 0; paintDots(); });
      }, { passive: true });
    }
    grid.__hbPaintDots = paint;
    function paintDots() { if (grid.__hbPaintDots) grid.__hbPaintDots(); }
    paint();
  }

  /* ---------- calculator / quiz ---------- */
  function initQuiz() {
    var quiz = $(".quiz");
    if (!quiz) return;
    var steps = $all(".quiz-step", quiz);
    var bars = $all(".quiz-progress .bar", quiz);
    var backBtn = $(".quiz-back", quiz);
    var nextBtn = $(".quiz-next", quiz);
    var cur = 0;
    function show(n) {
      cur = Math.max(0, Math.min(steps.length - 1, n));
      steps.forEach(function (s, idx) { s.classList.toggle("is-active", idx === cur); });
      bars.forEach(function (b, idx) { b.classList.toggle("done", idx <= cur); });
      backBtn.disabled = cur === 0;
      nextBtn.innerHTML = (cur === steps.length - 1)
        ? '<span data-i18n="btn.advice">' + (lang === "en" ? EN["btn.advice"] : "Ontvang advies") + "</span>" + ARROW
        : '<span data-i18n="btn.next">' + (lang === "en" ? EN["btn.next"] : "Volgende") + "</span>" + ARROW;
    }
    $all(".quiz-opt", quiz).forEach(function (opt) {
      opt.addEventListener("click", function () {
        var group = opt.closest(".quiz-options");
        $all(".quiz-opt", group).forEach(function (o) { o.classList.remove("is-selected"); });
        opt.classList.add("is-selected");
        var hidden = group.parentElement.querySelector('input[type="hidden"]');
        if (hidden) hidden.value = opt.getAttribute("data-val") || opt.textContent.trim();
        if (cur < steps.length - 1) setTimeout(function () { show(cur + 1); }, 220);
      });
    });
    backBtn.addEventListener("click", function () { show(cur - 1); });
    nextBtn.addEventListener("click", function () {
      if (cur < steps.length - 1) { show(cur + 1); return; }
      submitForm($(".quiz-form", quiz));
    });
    show(0);
  }

  /* ---------- forms (FormSubmit, no backend) ---------- */
  function submitForm(form) {
    if (!form) return;
    var status = form.querySelector(".form-status") || form.parentElement.querySelector(".form-status");
    var btn = form.querySelector('[type="submit"], .quiz-next');
    if (form.querySelector(".hp") && form.querySelector(".hp").value) return; /* honeypot */
    if (typeof form.reportValidity === "function" && !form.checkValidity()) { form.reportValidity(); return; }
    var data = new FormData(form);
    data.append("_subject", "Herstel & Bouw — " + (form.getAttribute("data-subject") || "Nieuwe aanvraag"));
    data.append("_template", "table");
    if (btn) btn.disabled = true;
    if (status) { status.className = "form-status"; status.textContent = ""; }
    fetch(FORM_ENDPOINT, { method: "POST", body: data, headers: { Accept: "application/json" } })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (res) {
        var ok = res && (res.success === true || res.success === "true");
        if (status) {
          status.classList.add(ok ? "ok" : "err");
          status.textContent = ok ? (lang === "en" ? EN["form.ok"] : nlCache["form.ok"] || "Bedankt. Uw aanvraag is verstuurd.")
                                   : (lang === "en" ? EN["form.err"] : nlCache["form.err"] || "Er ging iets mis. Bel of WhatsApp ons.");
        }
        if (ok) form.reset();
      })
      .catch(function () {
        if (status) { status.classList.add("err"); status.textContent = (lang === "en" ? EN["form.err"] : "Er ging iets mis. Bel of WhatsApp ons op +31 6 29 48 10 14."); }
      })
      .finally(function () { if (btn) btn.disabled = false; });
  }
  function initForms() {
    $all("form[data-form]").forEach(function (form) {
      form.addEventListener("submit", function (e) { e.preventDefault(); submitForm(form); });
    });
  }

  /* ---------- services rendering ----------
     Markup mirrors what used to be inline in index.html, so the existing
     .svc-row styles keep working. Numbers are derived from position, so
     reordering in the admin never leaves a gap. */
  var SVC_ARROW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M8 7h9v9"/></svg>';

  function serviceRow(s, i) {
    var num = String(i + 1);
    if (num.length < 2) num = "0" + num;
    var title = pick(s.title), desc = pick(s.desc);
    return '<a class="svc-row reveal" href="' + esc(s.href || "#contact") + '">' +
      '<span class="svc-overlay" aria-hidden="true"></span>' +
      '<span class="svc-num">' + num + '</span>' +
      '<span class="svc-text"><span class="svc-name">' + esc(title) + '</span>' +
      '<span class="svc-desc">' + esc(desc) + '</span></span>' +
      '<span class="svc-thumb" aria-hidden="true"><img src="' + esc(s.image || "") + '" alt="" loading="lazy" /></span>' +
      '<span class="svc-arrow" aria-hidden="true">' + SVC_ARROW + '</span>' +
    '</a>';
  }

  function renderServices() {
    var host = $("#svc-list");
    if (!host) return;
    host.innerHTML = (window.HB_SERVICES || []).map(serviceRow).join("");
    observeNew(host);
  }

  /* ---------- reviews rendering ----------
     data/reviews.json only ever contains reviews the owner approved in the
     admin panel; pending ones live in a private file the site cannot see. */
  var STAR = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="m12 2 3 6.9 7.5.6-5.7 4.9 1.8 7.3L12 17.8 5.4 21.7l1.8-7.3L1.5 9.5 9 8.9z"/></svg>';

  function initials(name) {
    var parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "?";
    var first = parts[0].charAt(0);
    var last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : "";
    return (first + last).toUpperCase();
  }

  function stars(n) {
    n = Math.max(1, Math.min(5, parseInt(n, 10) || 5));
    var out = "";
    for (var i = 1; i <= 5; i++) {
      out += i <= n ? STAR : '<span class="is-off">' + STAR + "</span>";
    }
    return out;
  }

  function reviewCard(r) {
    var sub = [r.location, pick(r.service)].filter(Boolean).join(" · ");
    return '<article class="testi-card reveal">' +
      '<div class="testi-stars">' + stars(r.rating) + '</div>' +
      '<blockquote>' + esc(pick(r.text)) + '</blockquote>' +
      '<div class="testi-foot"><span class="avatar">' + esc(initials(r.name)) + '</span>' +
      '<span class="who"><strong>' + esc(r.name) + '</strong><span>' + esc(sub) + '</span></span></div>' +
    '</article>';
  }

  function renderReviews() {
    var host = $("#testi-grid");
    if (!host) return;
    var list = window.HB_REVIEWS || [];
    host.innerHTML = list.map(reviewCard).join("");
    observeNew(host);
    initTestimonials();   /* rebuild pagination for the new card set */
  }

  /* ---------- review submission dialog ---------- */
  function initReviewForm() {
    var openBtn = $("#rv-open"), modal = $("#rv-modal"), form = $("#rv-form");
    if (!openBtn || !modal || !form) return;

    var lastFocus = null;

    function openDialog() {
      lastFocus = document.activeElement;
      modal.removeAttribute("hidden");
      document.body.classList.add("rv-open-lock");
      var first = $("input[name=name]", form);
      if (first) first.focus();
    }

    function closeDialog() {
      modal.setAttribute("hidden", "");
      document.body.classList.remove("rv-open-lock");
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }

    openBtn.addEventListener("click", openDialog);
    $all("[data-rv-close]", modal).forEach(function (b) {
      b.addEventListener("click", closeDialog);
    });

    document.addEventListener("keydown", function (e) {
      if (modal.hasAttribute("hidden")) return;
      if (e.key === "Escape") { closeDialog(); return; }
      if (e.key !== "Tab") return;
      /* Keep focus inside the dialog while it is open. */
      var f = $all('a[href], button:not([disabled]), input, textarea, select', modal)
        .filter(function (n) { return n.offsetParent !== null || n === document.activeElement; });
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });

    /* star picker */
    var rating = 5;
    var starHost = $("#rv-stars");
    function paintStars() {
      $all("button", starHost).forEach(function (b, i) {
        b.classList.toggle("is-on", i < rating);
        b.setAttribute("aria-checked", i + 1 === rating ? "true" : "false");
      });
    }
    for (var i = 1; i <= 5; i++) {
      (function (n) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "rv-star";
        b.setAttribute("role", "radio");
        b.setAttribute("aria-label", n + " / 5");
        b.innerHTML = STAR;
        b.addEventListener("click", function () { rating = n; paintStars(); });
        starHost.appendChild(b);
      })(i);
    }
    paintStars();

    /* character counter */
    var area = $("textarea[name=text]", form), counter = $("#rv-count");
    if (area && counter) {
      area.addEventListener("input", function () { counter.textContent = area.value.length; });
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var status = $("#rv-status");
      var btn = $("button[type=submit]", form);
      var data = {
        name: form.name.value,
        location: form.location.value,
        service: form.service.value,
        email: form.email.value,
        text: form.text.value,
        website: form.website.value,     /* honeypot — must stay empty */
        rating: rating,
        lang: lang
      };

      status.className = "rv-status";
      status.textContent = t("rv.sending", "Versturen…");
      if (btn) btn.disabled = true;

      fetch("review-submit.php", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data)
      })
        .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
        .then(function (res) {
          status.classList.add(res.ok ? "ok" : "err");
          status.textContent = res.message ||
            (lang === "en" ? "Something went wrong." : "Er ging iets mis.");
          if (res.ok) {
            form.reset();
            rating = 5; paintStars();
            if (counter) counter.textContent = "0";
            /* leave the thank-you on screen for a moment, then step aside */
            setTimeout(closeDialog, 2600);
          }
        })
        .catch(function () {
          status.classList.add("err");
          status.textContent = lang === "en"
            ? "Could not reach the server. Please try again later."
            : "Kan de server niet bereiken. Probeer het later opnieuw.";
        })
        .finally(function () { if (btn) btn.disabled = false; });
    });
  }

  /* ---------- project rendering ---------- */
  function projectCard(p) {
    var cat = pick(p.catLabel), title = pick(p.title);
    return '<article class="project-card reveal">' +
      '<a class="project-media" href="project.html?id=' + encodeURIComponent(p.id) + '">' +
        '<span class="tag">' + esc(cat) + '</span>' +
        '<img src="' + esc(p.cover) + '" alt="' + esc(title) + '" loading="lazy">' +
      '</a>' +
      '<div class="project-body">' +
        '<div class="meta"><span>' + esc(cat) + '</span><span class="dot"></span><span>' + esc(p.location) + '</span></div>' +
        '<h3>' + esc(title) + '</h3>' +
        '<p>' + esc(pick(p.short)) + '</p>' +
        '<a class="btn btn--dark btn--sm project-cta" href="project.html?id=' + encodeURIComponent(p.id) + '"><span>' + (lang === "en" ? EN["btn.viewProject"] : "Bekijk project") + '</span><span class="btn-ico">' + ARROW_PLAIN + '</span></a>' +
      '</div>' +
    '</article>';
  }

  function renderPortfolio() {
    var host = $("#portfolio-grid");
    if (!host) return;
    var limit = parseInt(host.getAttribute("data-limit"), 10) || 4;
    host.innerHTML = window.HB_PROJECTS.slice(0, limit).map(projectCard).join("");
    observeNew(host);
  }

  function renderProjectsList() {
    var host = $("#projects-list");
    if (!host) return;
    var active = host.getAttribute("data-filter") || "all";
    var items = window.HB_PROJECTS.filter(function (p) { return active === "all" || p.cat === active; });
    host.innerHTML = items.map(projectCard).join("") || '<p class="muted">—</p>';
    observeNew(host);
  }

  function renderSingleProject() {
    var host = $("#single-project");
    if (!host) return;
    var id = new URLSearchParams(location.search).get("id");
    var all = window.HB_PROJECTS || [];
    var p = all.filter(function (x) { return x.id === id; })[0] || all[0];
    if (!p) return;   /* data missing — leave the static fallback markup alone */
    var L = lang;
    var title = pick(p.title);
    var meta_ = p.meta || {};

    $("#sp-title").textContent = title;
    var h1 = $("#sp-title-h1"); if (h1) h1.textContent = title;
    $("#sp-tag").textContent = pick(p.catLabel);
    $("#sp-location").textContent = p.location || "";
    $("#sp-short").textContent = pick(p.short);
    $("#sp-cover").src = p.cover || ""; $("#sp-cover").alt = title;
    $("#sp-intro").textContent = pick(p.intro);
    $("#sp-challenge").textContent = pick(p.challenge);
    var res = $("#sp-result"); if (res) res.textContent = pick(p.result);

    var svcList = (p.services && (p.services[L] || p.services.nl)) || [];
    $("#sp-services").innerHTML = svcList.map(function (s) {
      return '<li>' + esc(s) + '</li>';
    }).join("");

    var meta = [
      ["sp.metaDuration", "Duur", pick(meta_.duration)],
      ["sp.metaType", "Type project", pick(meta_.type)],
      ["sp.metaYear", "Jaar", meta_.year || ""]
    ];
    $("#sp-meta").innerHTML = meta.filter(function (m) { return m[2]; }).map(function (m) {
      return '<div class="proj-meta"><div class="k">' + esc(L === "en" ? EN[m[0]] : m[1]) + '</div><div class="v">' + esc(m[2]) + '</div></div>';
    }).join("");

    $("#sp-gallery").innerHTML = (p.gallery || []).map(function (g) {
      var cap = pick(g.cap);
      return '<figure class="' + esc(g.cls || "g-half") + '"><img src="' + esc(g.src) + '" alt="' + esc(cap) + '" loading="lazy"><figcaption>' + esc(cap) + '</figcaption></figure>';
    }).join("");

    var others = all.filter(function (x) { return x.id !== p.id; }).slice(0, 3);
    $("#sp-other").innerHTML = others.map(projectCard).join("");
    observeNew(host);
    document.title = title + " — Herstel & Bouw";
  }

  function observeNew(scope) {
    $all(".reveal", scope).forEach(function (e) { e.classList.add("in"); });
  }

  function renderDynamic() {
    renderServices();
    renderReviews();
    renderPortfolio();
    renderProjectsList();
    renderSingleProject();
  }

  /* ---------- projects filter clicks ---------- */
  function initFilters() {
    var host = $("#projects-list");
    if (!host) return;
    $all(".filter-chip").forEach(function (chip) {
      chip.addEventListener("click", function () {
        $all(".filter-chip").forEach(function (c) { c.classList.remove("is-active"); });
        chip.classList.add("is-active");
        host.setAttribute("data-filter", chip.getAttribute("data-cat"));
        renderProjectsList();
      });
    });
  }

  /* ---------- year ---------- */
  function initYear() { $all("[data-year]").forEach(function (e) { e.textContent = "2026"; }); }

  /* ---------- boot ---------- */
  function boot() {
    cacheStaticText();
    initNav();
    initHeroSlider();
    initFaq();
    initQuiz();
    initForms();
    initReviewForm();
    initFilters();
    initYear();
    applyLang(lang);   /* also renders dynamic blocks */
    initReveal();
    initGallery();
  }

  document.addEventListener("DOMContentLoaded", function () {
    /* The preloader starts first and hides on window.load, so a slow or
       failed content fetch can never trap the page behind the intro. */
    initPreloader();
    var ready = window.HB_DATA_READY || Promise.resolve();
    ready.then(boot, boot);
  });
})();
