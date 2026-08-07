/* ==========================================================================
   Herstel & Bouw admin panel.

   No build step and no dependencies — same philosophy as the site itself.
   State lives in `state.data[tab]`; every edit mutates it and marks the tab
   dirty. Nothing reaches the server until "Зберегти" is pressed, so an
   accidental keystroke never touches the live site.
   ========================================================================== */
(function () {
  "use strict";

  /* Must match HB_CATEGORIES in admin/lib/schema.php and the filter chips
     hard-coded in projects.html. */
  var CATEGORIES = [
    { value: "badkamers",      nl: "Badkamerrenovatie",  en: "Bathroom renovation" },
    { value: "uitbreidingen",  nl: "Uitbreiding",        en: "Extension" },
    { value: "gevelrenovatie", nl: "Gevelrenovatie",     en: "Facade renovation" },
    { value: "verbouwing",     nl: "Complete verbouwing", en: "Complete renovation" },
    { value: "kozijnen",       nl: "Kozijnen vervangen", en: "Window replacement" }
  ];

  var STATUSES = [
    { value: "pending",  label: "Очікує модерації" },
    { value: "approved", label: "Опубліковано на сайті" },
    { value: "rejected", label: "Відхилено" }
  ];

  var GALLERY_CLS = [
    { value: "g-wide", label: "Широке (на всю ширину)" },
    { value: "g-tall", label: "Високе (вертикальне)" },
    { value: "g-half", label: "Половина ширини" }
  ];

  var state = {
    tab: "services",
    data:   { services: null, projects: null, reviews: null, partners: null },
    mtime:  { services: 0,    projects: 0,     reviews: 0,    partners: 0 },
    dirty:  { services: false, projects: false, reviews: false, partners: false },
    sel:    { services: 0,    projects: 0,     reviews: 0,    partners: 0 },
    filter: "",
    status: "all",          /* reviews tab: moderation filter */
    images: null
  };

  /* ---------------------------------------------------------------- utils */
  function $(sel, ctx) { return (ctx || document).querySelector(sel); }
  function $all(sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k === "html") node.innerHTML = v;
      else if (k.slice(0, 2) === "on") node.addEventListener(k.slice(2), v);
      else if (v === true) node.setAttribute(k, "");
      else node.setAttribute(k, v);
    });
    (children || []).forEach(function (c) {
      if (c == null) return;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return node;
  }

  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  function pair(v) {
    if (v && typeof v === "object") return { nl: v.nl || "", en: v.en || "" };
    return { nl: typeof v === "string" ? v : "", en: "" };
  }

  function slugify(s) {
    var map = { "á":"a","à":"a","ä":"a","â":"a","é":"e","è":"e","ë":"e","ê":"e",
                "í":"i","ï":"i","î":"i","ó":"o","ö":"o","ô":"o","ú":"u","ü":"u","û":"u","ç":"c","ñ":"n" };
    return String(s || "").toLowerCase()
      .replace(/[áàäâéèëêíïîóöôúüûçñ]/g, function (c) { return map[c] || c; })
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70);
  }

  function toast(msg, kind) {
    var host = $("#toasts");
    var t = el("div", { class: "toast" + (kind ? " " + kind : ""), text: msg });
    host.appendChild(t);
    setTimeout(function () {
      t.style.transition = "opacity .25s";
      t.style.opacity = "0";
      setTimeout(function () { t.remove(); }, 260);
    }, kind === "err" ? 7000 : 3200);
  }

  /* ------------------------------------------------------------------ api */
  function api(action, opts) {
    opts = opts || {};
    var url = "api.php?action=" + encodeURIComponent(action);
    var init = { credentials: "same-origin" };

    if (opts.body) {
      init.method = "POST";
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(Object.assign({ action: action, csrf: window.HB_CSRF }, opts.body));
    } else if (opts.query) {
      Object.keys(opts.query).forEach(function (k) {
        url += "&" + k + "=" + encodeURIComponent(opts.query[k]);
      });
    }

    return fetch(url, init).then(function (r) {
      return r.json().catch(function () {
        throw new Error("Сервер повернув несподівану відповідь (HTTP " + r.status + ").");
      }).then(function (json) {
        if (!r.ok || !json.ok) {
          var err = new Error(json.error || "Помилка запиту.");
          err.payload = json;
          throw err;
        }
        return json;
      });
    });
  }

  function handleApiError(err) {
    toast(err.message, "err");
    if (err.payload && err.payload.relogin) {
      setTimeout(function () { location.reload(); }, 2500);
    }
  }

  /* ---------------------------------------------------------------- dirty */
  function markDirty() {
    state.dirty[state.tab] = true;
    paintState();
  }

  function anyDirty() {
    return state.dirty.services || state.dirty.projects || state.dirty.reviews || state.dirty.partners;
  }

  function paintState() {
    var box = $("#save-state");
    var dirty = state.dirty[state.tab];
    box.className = "save-state" + (dirty ? " is-dirty" : "");
    box.textContent = dirty ? "Є незбережені зміни" : "Усе збережено";
    $("#btn-save").disabled = !dirty;
    $("#btn-revert").disabled = !dirty;

    ["services", "projects", "reviews", "partners"].forEach(function (k) {
      var chip = $('[data-count="' + k + '"]');
      if (chip) chip.textContent = state.data[k] ? state.data[k].length : "—";
      var tab = $('.tab[data-tab="' + k + '"]');
      if (tab) tab.classList.toggle("has-dirty", state.dirty[k]);
    });

    /* Pending reviews are the one thing the owner must not miss. */
    var pending = (state.data.reviews || []).filter(function (r) {
      return r.status === "pending";
    }).length;
    var revTab = $('.tab[data-tab="reviews"]');
    if (revTab) revTab.classList.toggle("has-pending", pending > 0);
    var revChip = $('[data-count="reviews"]');
    if (revChip && pending > 0) revChip.textContent = pending + " / " + state.data.reviews.length;
    var nP = $("#n-pending");
    if (nP) nP.textContent = pending;
  }

  /* --------------------------------------------------------------- blanks */
  function blankService() {
    return {
      id: "", _new: true,
      title: { nl: "", en: "" },
      desc:  { nl: "", en: "" },
      image: "images/projects/extension-1.jpg",
      href: "#contact"
    };
  }

  function blankPartner() {
    return {
      id: "", _new: true,
      name: "",
      desc: { nl: "", en: "" },
      image: "",
      url: ""
    };
  }

  function blankProject() {
    return {
      id: "", _new: true,
      cat: CATEGORIES[0].value,
      catLabel: { nl: CATEGORIES[0].nl, en: CATEGORIES[0].en },
      title: { nl: "", en: "" },
      location: "",
      cover: "images/projects/bathroom-1.jpg",
      short: { nl: "", en: "" },
      intro: { nl: "", en: "" },
      challenge: { nl: "", en: "" },
      result: { nl: "", en: "" },
      services: { nl: [], en: [] },
      meta: { duration: { nl: "", en: "" }, year: String(new Date().getFullYear()), type: { nl: "", en: "" }, budget: "" },
      gallery: []
    };
  }

  function blankReview() {
    return {
      id: "", _new: true,
      name: "",
      location: "",
      service: { nl: "", en: "" },
      text: { nl: "", en: "" },
      rating: 5,
      status: "approved",       /* written by the owner — no need to moderate */
      created: new Date().toISOString(),
      source: "admin",
      email: ""
    };
  }

  /* ================================================================ fields */

  /* One labelled control. `get`/`set` read and write straight into state. */
  function textField(label, value, onInput, opts) {
    opts = opts || {};
    var input = opts.multiline
      ? el("textarea", { rows: opts.rows || 3 })
      : el("input", { type: "text" });
    input.value = value == null ? "" : value;
    if (opts.placeholder) input.placeholder = opts.placeholder;
    input.addEventListener("input", function () { onInput(input.value); });

    var span = el("span", {}, []);
    if (opts.lang) span.appendChild(el("i", { class: "lang-tag " + opts.lang, text: opts.lang.toUpperCase() }));
    span.appendChild(document.createTextNode(label));

    var kids = [span, input];
    if (opts.note) kids.push(el("p", { class: "field-note" + (opts.warn ? " warn" : ""), text: opts.note }));
    return el("label", { class: "field" + (opts.span2 ? " span-2" : "") }, kids);
  }

  /* NL + EN side by side — translating without seeing the source is how
     mismatched copy gets shipped. */
  function langPair(label, obj, opts) {
    opts = opts || {};
    return el("div", { class: "lang-row" }, [
      textField(label, obj.nl, function (v) { obj.nl = v; markDirty(); onLangEdit(opts); },
        { lang: "nl", multiline: opts.multiline, rows: opts.rows, placeholder: opts.placeholder }),
      textField(label, obj.en, function (v) { obj.en = v; markDirty(); },
        { lang: "en", multiline: opts.multiline, rows: opts.rows,
          placeholder: opts.enPlaceholder || "Порожньо → буде показано голландський текст" })
    ]);
  }

  function onLangEdit(opts) {
    if (opts && typeof opts.onNl === "function") opts.onNl();
  }

  function selectField(label, value, options, onChange, opts) {
    opts = opts || {};
    var sel = el("select", {});
    options.forEach(function (o) {
      sel.appendChild(el("option", { value: o.value, text: o.label, selected: o.value === value }));
    });
    sel.value = value;
    sel.addEventListener("change", function () { onChange(sel.value); });
    var kids = [el("span", { text: label }), sel];
    if (opts.note) kids.push(el("p", { class: "field-note", text: opts.note }));
    return el("label", { class: "field" }, kids);
  }

  /* Image chooser: preview + "вибрати" opens a grid of everything already
     under images/, plus an upload zone. Either way the field ends up holding
     a path that exists on the server. */
  function imageField(label, current, onPick, note) {
    var img = el("img", { class: "imgpick-preview", src: "../" + (current || ""), alt: "" });
    img.addEventListener("error", function () { img.style.opacity = ".25"; });
    var path = el("code", { class: "imgpick-path", text: current || "— не вибрано —" });

    var btn = el("button", {
      class: "btn btn-ghost btn-sm", type: "button", text: "Вибрати зображення",
      onclick: function () {
        openImagePicker(current, function (picked) {
          current = picked;
          img.src = "../" + picked;
          img.style.opacity = "1";
          path.textContent = picked;
          onPick(picked);
        });
      }
    });

    return el("div", { class: "field" }, [
      el("span", { text: label }),
      el("div", { class: "imgpick" }, [
        img,
        el("div", { class: "imgpick-side" }, [
          path,
          btn,
          note ? el("p", { class: "field-note", text: note }) : null
        ])
      ])
    ]);
  }

  /* ------------------------------------------------------------- uploading */
  var UPLOAD_ACCEPT = "image/jpeg,image/png,image/webp";

  function humanSize(bytes) {
    var b = bytes || 0;
    if (b < 1024) return b + " Б";          // a rejected 23-byte file is not "0 КБ"
    var kb = b / 1024;
    if (kb < 1024) return Math.round(kb) + " КБ";
    return (kb / 1024).toFixed(1).replace(".", ",") + " МБ";
  }

  /* XMLHttpRequest rather than fetch: it reports upload progress, which
     matters when the editor is pushing a 15 MB photo up a phone connection
     and would otherwise be staring at a frozen panel. */
  function apiUpload(file, onProgress) {
    return new Promise(function (resolve, reject) {
      var fd = new FormData();
      fd.append("csrf", window.HB_CSRF);
      fd.append("name", file.name || "");
      fd.append("file", file);

      var xhr = new XMLHttpRequest();
      xhr.open("POST", "api.php?action=upload", true);
      xhr.withCredentials = true;

      if (xhr.upload && onProgress) {
        xhr.upload.onprogress = function (e) {
          if (e.lengthComputable) onProgress(e.loaded / e.total);
        };
      }
      xhr.onload = function () {
        var json = null;
        try { json = JSON.parse(xhr.responseText); } catch (e) { /* left null */ }
        if (!json) {
          return reject(new Error("Сервер повернув несподівану відповідь (HTTP " + xhr.status + ")."));
        }
        if (xhr.status < 200 || xhr.status >= 300 || !json.ok) {
          var err = new Error(json.error || "Не вдалося завантажити файл.");
          err.payload = json;
          return reject(err);
        }
        resolve(json.image);
      };
      xhr.onerror = function () { reject(new Error("Зʼєднання перервалося під час завантаження.")); };
      xhr.send(fd);
    });
  }

  /* --------------------------------------------------------- image picker */
  function openImagePicker(current, onPick) {
    openModal("Зображення — вибрати або завантажити", el("p", { text: "Завантаження…" }));

    var ready = state.images
      ? Promise.resolve()
      : api("images").then(function (res) { state.images = res.images; });

    ready.then(function () {
      var fresh = {};                       // uploaded in this sitting → shown first
      var grid  = el("div", { class: "img-grid" });
      var queue = el("div", { class: "up-queue" });

      function choose(path) { onPick(path); closeModal(); }

      function renderGrid() {
        grid.innerHTML = "";
        if (!state.images.length) {
          grid.appendChild(el("p", { class: "field-note", text: "Тут поки немає зображень — завантажте перше." }));
          return;
        }
        state.images.slice().sort(function (a, b) {
          var fa = fresh[a.path] ? 0 : 1, fb = fresh[b.path] ? 0 : 1;
          return fa !== fb ? fa - fb : a.path.localeCompare(b.path);
        }).forEach(function (im) {
          grid.appendChild(el("button", {
            class: "img-cell" + (im.path === current ? " is-current" : "") + (fresh[im.path] ? " is-new" : ""),
            type: "button",
            title: im.path + " · " + humanSize(im.size),
            onclick: function () { choose(im.path); }
          }, [
            el("img", { src: "../" + im.path, alt: "", loading: "lazy" }),
            el("span", { text: im.path.replace(/^images\//, "") })
          ]));
        });
      }

      /* Files go up one at a time: a single rejected photo then fails on its
         own line instead of taking the rest of the batch down with it. */
      function upload(files) {
        var picked = Array.prototype.slice.call(files || []);
        if (!picked.length) return;

        var done  = [];
        var chain = Promise.resolve();

        picked.forEach(function (file) {
          var bar   = el("i");
          var label = el("span", { class: "up-state", text: "у черзі" });
          var line  = el("div", { class: "up-item" }, [
            el("span", { class: "up-name", text: file.name + " · " + humanSize(file.size) }),
            el("span", { class: "up-bar" }, [bar]),
            label
          ]);
          queue.appendChild(line);

          chain = chain.then(function () {
            label.textContent = "0 %";
            return apiUpload(file, function (p) {
              var pct = Math.round(p * 100);
              bar.style.width = pct + "%";
              label.textContent = pct + " %";
            }).then(function (image) {
              bar.style.width = "100%";
              line.classList.add("is-done");
              label.textContent = image.resized
                ? "готово · зменшено до " + image.width + "×" + image.height
                : "готово";
              fresh[image.path] = true;
              state.images.unshift(image);
              done.push(image);
              renderGrid();
            }).catch(function (err) {
              line.classList.add("is-err");
              label.textContent = err.message;
              if (err.payload && err.payload.relogin) handleApiError(err);
            });
          });
        });

        chain.then(function () {
          if (done.length === 1) {
            toast("Фото завантажено", "ok");
            choose(done[0].path);           // one file → almost certainly the one wanted
          } else if (done.length > 1) {
            toast(done.length + " фото завантажено — виберіть потрібне", "ok");
          }
        });
      }

      var input = el("input", { type: "file", accept: UPLOAD_ACCEPT, multiple: true, class: "up-input" });
      input.addEventListener("change", function () {
        upload(input.files);
        input.value = "";                   // so the same file can be picked twice
      });

      var zone = el("div", { class: "up-zone" }, [
        el("button", {
          class: "btn btn-sm", type: "button", text: "Вибрати фото з комп'ютера",
          onclick: function () { input.click(); }
        }),
        el("p", { class: "up-hint", text: "або перетягніть файли сюди · JPG, PNG, WebP · до 20 МБ" }),
        el("p", { class: "up-hint up-hint-quiet", text: "Великі фото автоматично зменшуються до 2560 px по довшій стороні." }),
        input
      ]);

      ["dragenter", "dragover"].forEach(function (ev) {
        zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add("is-over"); });
      });
      ["dragleave", "dragend", "drop"].forEach(function (ev) {
        zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.remove("is-over"); });
      });
      zone.addEventListener("drop", function (e) {
        if (e.dataTransfer && e.dataTransfer.files) upload(e.dataTransfer.files);
      });

      renderGrid();
      setModalBody(el("div", { class: "up-wrap" }, [zone, queue, grid]));
    }).catch(handleApiError);
  }

  /* ---------------------------------------------------------------- modal */
  function openModal(title, body) {
    $("#modal-title").textContent = title;
    setModalBody(body);
    $("#modal").hidden = false;
  }

  function setModalBody(body) {
    var host = $("#modal-body");
    host.innerHTML = "";
    host.appendChild(body);
  }

  function closeModal() { $("#modal").hidden = true; }

  /* ================================================================ editor */
  function renderEditor() {
    var host = $("#editor");
    var list = state.data[state.tab] || [];
    var item = list[state.sel[state.tab]];

    host.innerHTML = "";
    if (!item) {
      host.appendChild(el("div", { class: "editor-empty" }, [
        el("p", { text: list.length ? "Виберіть запис зліва." : "Записів ще немає." }),
        el("p", { class: "field-note", text: 'Натисніть «+ Додати», щоб створити новий.' })
      ]));
      return;
    }
    var editors = { services: serviceEditor, projects: projectEditor, reviews: reviewEditor, partners: partnerEditor };
    editors[state.tab](host, item);
  }

  function editorHead(title, subtitle, onDelete) {
    return el("div", { class: "editor-head" }, [
      el("div", {}, [el("h2", { text: title }), el("p", { text: subtitle })]),
      el("div", { class: "spacer" }),
      el("button", { class: "btn btn-danger btn-sm", type: "button", text: "Видалити", onclick: onDelete })
    ]);
  }

  function deleteCurrent(what) {
    var list = state.data[state.tab];
    var i = state.sel[state.tab];
    var item = list[i];
    var name = item.name || (item.title && item.title.nl) || item.id || "запис";
    if (!confirm("Видалити «" + name + "»?\n\nЗміна застосується на сайті після натискання «Зберегти».")) return;
    list.splice(i, 1);
    state.sel[state.tab] = Math.max(0, Math.min(i, list.length - 1));
    markDirty();
    renderList();
    renderEditor();
    toast(what + " видалено — не забудьте зберегти.");
  }

  /* ------------------------------------------------------ service editor */
  function serviceEditor(host, s) {
    var idx = state.sel.services;

    host.appendChild(editorHead(
      s.title.nl || "Нова послуга",
      "Позиція " + (idx + 1) + " у списку — номер на сайті рахується автоматично.",
      function () { deleteCurrent("Послугу"); }
    ));

    var card = el("div", { class: "card" }, [
      el("h3", { text: "Текст" }),
      el("p", { class: "card-hint", text: "Ліворуч — голландська (основна мова сайту), праворуч — англійська." })
    ]);
    card.appendChild(langPair("Назва", s.title, {
      onNl: function () { refreshListRow(idx); }
    }));
    card.appendChild(langPair("Опис", s.desc, { multiline: true, rows: 3 }));
    host.appendChild(card);

    var media = el("div", { class: "card" }, [el("h3", { text: "Зображення та посилання" })]);
    media.appendChild(imageField("Мініатюра", s.image, function (p) {
      s.image = p; markDirty(); refreshListRow(idx);
    }, "Показується праворуч у рядку послуги."));
    media.appendChild(textField("Посилання", s.href, function (v) { s.href = v; markDirty(); }, {
      placeholder: "#contact",
      note: "Куди веде клік. Зазвичай #contact — якір на форму заявки."
    }));
    host.appendChild(media);

    host.appendChild(idCard(s, "послуги", function () { refreshListRow(idx); }));
  }

  /* ------------------------------------------------------ partner editor */
  function partnerEditor(host, p) {
    var idx = state.sel.partners;

    host.appendChild(editorHead(
      p.name || "Новий партнер",
      "Позиція " + (idx + 1) + " у блоці «Onze partners» на головній.",
      function () { deleteCurrent("Партнера"); }
    ));

    var card = el("div", { class: "card" }, [
      el("h3", { text: "Партнер" }),
      el("p", { class: "card-hint", text: "Назва компанії однакова обома мовами — її не перекладають. Опис перекладається." })
    ]);
    card.appendChild(textField("Назва", p.name, function (v) {
      p.name = v; markDirty(); refreshListRow(idx);
    }, { placeholder: "Bouwbedrijf De Vries" }));
    card.appendChild(langPair("Опис", p.desc, { multiline: true, rows: 3 }));
    host.appendChild(card);

    var media = el("div", { class: "card" }, [el("h3", { text: "Фото та посилання" })]);
    media.appendChild(imageField("Фото", p.image, function (v) {
      p.image = v; markDirty(); refreshListRow(idx);
    }, "Показується вгорі картки. Найкраще горизонтальне — картка обрізає під 4:3."));
    media.appendChild(textField("Сайт партнера", p.url, function (v) {
      p.url = v; markDirty();
    }, {
      placeholder: "https://example.nl",
      note: "Клік по картці відкриє цю адресу в новій вкладці. Можна лишити порожнім — тоді картка просто не буде посиланням."
    }));
    host.appendChild(media);

    host.appendChild(idCard(p, "партнера", function () { refreshListRow(idx); }));
  }

  /* The id is not user-facing for services, but it is the URL for projects —
     hence the different warning text. */
  function idCard(item, what, onChange) {
    var isProject = state.tab === "projects";
    var card = el("div", { class: "card" }, [
      el("h3", { text: "Ідентифікатор" })
    ]);
    card.appendChild(textField("id", item.id, function (v) {
      item.id = v; markDirty(); onChange();
    }, {
      placeholder: "auto",
      note: isProject
        ? "Використовується в адресі сторінки: project.html?id=" + (item.id || "…") + ". Зміна id зламає всі наявні посилання на цей проєкт."
        : "Технічна назва " + what + ". Порожнє поле — згенерується з назви.",
      warn: isProject
    }));
    return card;
  }

  /* ------------------------------------------------------ project editor */
  function projectEditor(host, p) {
    var idx = state.sel.projects;

    host.appendChild(editorHead(
      p.title.nl || "Новий проєкт",
      "Категорія: " + (catByValue(p.cat) || {}).nl + " · позиція " + (idx + 1),
      function () { deleteCurrent("Проєкт"); }
    ));

    /* -- basics -- */
    var basics = el("div", { class: "card" }, [el("h3", { text: "Основне" })]);
    basics.appendChild(langPair("Заголовок", p.title, {
      onNl: function () {
        refreshListRow(idx);
        if (p._new && !p._idTouched) { p.id = slugify(p.title.nl); }
      }
    }));

    var grid = el("div", { class: "grid" });
    grid.appendChild(selectField("Категорія", p.cat, CATEGORIES.map(function (c) {
      return { value: c.value, label: c.nl + " / " + c.en };
    }), function (v) {
      p.cat = v;
      var c = catByValue(v);
      /* Keep the visible label in step with the filter category unless it
         was deliberately customised. */
      if (c) { p.catLabel = { nl: c.nl, en: c.en }; }
      markDirty();
      renderList();
      renderEditor();
    }, { note: "Визначає, під який фільтр потрапляє проєкт на сторінці «Проєкти»." }));

    grid.appendChild(textField("Місто / регіон", p.location, function (v) {
      p.location = v; markDirty(); refreshListRow(idx);
    }, { placeholder: "Amsterdam" }));
    basics.appendChild(grid);

    basics.appendChild(langPair("Підпис категорії (видно на картці)", p.catLabel));
    host.appendChild(basics);

    /* -- cover -- */
    var cover = el("div", { class: "card" }, [el("h3", { text: "Обкладинка" })]);
    cover.appendChild(imageField("Головне фото", p.cover, function (v) {
      p.cover = v; markDirty(); refreshListRow(idx);
    }, "Використовується на картці проєкту та вгорі його сторінки."));
    host.appendChild(cover);

    /* -- texts -- */
    var texts = el("div", { class: "card" }, [
      el("h3", { text: "Тексти" }),
      el("p", { class: "card-hint", text: "«Короткий опис» — на картці. Решта — на сторінці проєкту." })
    ]);
    texts.appendChild(langPair("Короткий опис (картка)", p.short, { multiline: true, rows: 3 }));
    texts.appendChild(langPair("Вступ", p.intro, { multiline: true, rows: 4 }));
    texts.appendChild(langPair("Виклик / задача", p.challenge, { multiline: true, rows: 4 }));
    texts.appendChild(langPair("Результат", p.result, { multiline: true, rows: 4 }));
    host.appendChild(texts);

    /* -- works list -- */
    host.appendChild(worksCard(p));

    /* -- meta -- */
    var meta = el("div", { class: "card" }, [el("h3", { text: "Характеристики" })]);
    meta.appendChild(langPair("Тривалість", p.meta.duration, { placeholder: "6 weken", enPlaceholder: "6 weeks" }));
    meta.appendChild(langPair("Тип проєкту", p.meta.type, { placeholder: "Badkamerrenovatie" }));
    var m2 = el("div", { class: "grid" });
    m2.appendChild(textField("Рік", p.meta.year, function (v) { p.meta.year = v; markDirty(); }, {
      placeholder: "2025", note: "Чотири цифри."
    }));
    m2.appendChild(textField("Бюджет", p.meta.budget, function (v) { p.meta.budget = v; markDirty(); }, {
      placeholder: "€ 18.400",
      note: "Зберігається, але зараз ніде не виводиться на сайті — поле «про запас»."
    }));
    meta.appendChild(m2);
    host.appendChild(meta);

    /* -- gallery -- */
    host.appendChild(galleryCard(p));

    host.appendChild(idCard(p, "проєкту", function () {
      p._idTouched = true;
      refreshListRow(idx);
    }));
  }

  /* ------------------------------------------------------- review editor */
  function statusLabel(v) {
    var s = STATUSES.filter(function (x) { return x.value === v; })[0];
    return s ? s.label : v;
  }

  function fmtDate(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d)) return iso;
    var p = function (n) { return String(n).padStart(2, "0"); };
    return p(d.getDate()) + "." + p(d.getMonth() + 1) + "." + d.getFullYear() +
           " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function starPicker(r) {
    var host = el("div", { class: "star-pick" });
    function paint() {
      $all("button", host).forEach(function (b, i) {
        b.classList.toggle("is-on", i < r.rating);
      });
    }
    for (var i = 1; i <= 5; i++) {
      (function (n) {
        host.appendChild(el("button", {
          class: "star", type: "button", title: n + " / 5", text: "\u2605",
          onclick: function () { r.rating = n; markDirty(); paint(); refreshListRow(state.sel.reviews); }
        }));
      })(i);
    }
    paint();
    return el("div", { class: "field" }, [el("span", { text: "Оцінка" }), host]);
  }

  function reviewEditor(host, r) {
    var idx = state.sel.reviews;

    /* Moderation is the primary action, so it sits at the top, not buried
       in a form field. */
    var bar = el("div", { class: "mod-bar status-" + r.status }, [
      el("div", {}, [
        el("strong", { text: statusLabel(r.status) }),
        el("p", { class: "field-note", text:
          (r.source === "form" ? "Надіслано з сайту " : r.source === "seed" ? "Початковий відгук · " : "Додано вручну · ") +
          fmtDate(r.created) })
      ]),
      el("div", { class: "spacer" }),
      el("button", {
        class: "btn btn-ok btn-sm", type: "button", text: "✓ Опублікувати",
        disabled: r.status === "approved",
        onclick: function () { setStatus(r, "approved"); }
      }),
      el("button", {
        class: "btn btn-danger btn-sm", type: "button", text: "✕ Відхилити",
        disabled: r.status === "rejected",
        onclick: function () { setStatus(r, "rejected"); }
      })
    ]);
    host.appendChild(bar);

    host.appendChild(editorHead(
      r.name || "Новий відгук",
      r.status === "approved"
        ? "Показується на головній сторінці."
        : "Не показується на сайті, доки не опублікуєте.",
      function () { deleteCurrent("Відгук"); }
    ));

    var who = el("div", { class: "card" }, [el("h3", { text: "Автор" })]);
    var g = el("div", { class: "grid" });
    g.appendChild(textField("Ім'я", r.name, function (v) {
      r.name = v; markDirty(); refreshListRow(idx);
    }));
    g.appendChild(textField("Місто", r.location, function (v) {
      r.location = v; markDirty(); refreshListRow(idx);
    }, { placeholder: "Amsterdam" }));
    who.appendChild(g);
    who.appendChild(starPicker(r));
    if (r.email) {
      who.appendChild(el("div", { class: "field" }, [
        el("span", { text: "E-mail" }),
        el("p", { class: "email-box" }, [
          el("a", { href: "mailto:" + r.email, text: r.email })
        ]),
        el("p", { class: "field-note", text: "Не публікується на сайті. Видно лише тут." })
      ]));
    }
    host.appendChild(who);

    var txt = el("div", { class: "card" }, [
      el("h3", { text: "Відгук" }),
      el("p", { class: "card-hint", text: "Відвідувач пише однією мовою — другу можна перекласти тут. Правки допустимі: виправити друкарську помилку, скоротити." })
    ]);
    txt.appendChild(langPair("Тип робіт", r.service, { placeholder: "Badkamerrenovatie" }));
    txt.appendChild(langPair("Текст", r.text, { multiline: true, rows: 5 }));
    host.appendChild(txt);
  }

  function setStatus(r, status) {
    r.status = status;
    markDirty();
    renderList();
    renderEditor();
    toast(status === "approved"
      ? "Позначено як опубліковане — натисніть «Зберегти», щоб воно з'явилося на сайті."
      : "Позначено як відхилене — натисніть «Зберегти».");
  }

  function catByValue(v) {
    return CATEGORIES.filter(function (c) { return c.value === v; })[0];
  }

  /* Parallel NL/EN bullet lists. Kept as paired rows because the front-end
     indexes both arrays by position — letting them drift apart silently
     drops bullets in one language. */
  function worksCard(p) {
    var card = el("div", { class: "card" }, [
      el("h3", { text: "Werkzaamheden (список робіт)" }),
      el("p", { class: "card-hint", text: "Виводиться списком на сторінці проєкту. Кожен рядок — окремий пункт, обидві мови обов'язкові." })
    ]);
    var rows = el("div", { class: "rows" });

    function redraw() {
      rows.innerHTML = "";
      p.services.nl.forEach(function (_, i) {
        var nl = el("input", { type: "text", value: p.services.nl[i] || "", placeholder: "Badkamerrenovatie" });
        var en = el("input", { type: "text", value: p.services.en[i] || "", placeholder: "Bathroom renovation" });
        nl.addEventListener("input", function () { p.services.nl[i] = nl.value; markDirty(); });
        en.addEventListener("input", function () { p.services.en[i] = en.value; markDirty(); });
        rows.appendChild(el("div", { class: "pair-row" }, [
          nl, en,
          el("button", {
            class: "btn btn-danger btn-sm", type: "button", text: "×", title: "Видалити пункт",
            onclick: function () {
              p.services.nl.splice(i, 1);
              p.services.en.splice(i, 1);
              markDirty(); redraw();
            }
          })
        ]));
      });
      if (!p.services.nl.length) {
        rows.appendChild(el("p", { class: "field-note", text: "Пунктів немає." }));
      }
    }
    redraw();

    card.appendChild(el("div", { class: "lang-row" }, [
      el("div", { class: "field" }, [el("span", {}, [el("i", { class: "lang-tag nl", text: "NL" }), document.createTextNode("Голландською")])]),
      el("div", { class: "field" }, [el("span", {}, [el("i", { class: "lang-tag en", text: "EN" }), document.createTextNode("Англійською")])])
    ]));
    card.appendChild(rows);
    card.appendChild(el("button", {
      class: "btn btn-ghost btn-sm add-row", type: "button", text: "+ Додати пункт",
      onclick: function () {
        p.services.nl.push("");
        p.services.en.push("");
        markDirty(); redraw();
      }
    }));
    return card;
  }

  function galleryCard(p) {
    var card = el("div", { class: "card" }, [
      el("h3", { text: "Галерея" }),
      el("p", { class: "card-hint", text: "Верстка розрахована на 4 фото в порядку: широке → високе → половина → половина. Порядок можна перетягувати." })
    ]);
    var rows = el("div", { class: "rows" });

    function redraw() {
      rows.innerHTML = "";
      p.gallery.forEach(function (g, i) {
        var img = el("img", { src: "../" + g.src, alt: "" });
        img.addEventListener("error", function () { img.style.opacity = ".25"; });

        var mid = el("div", {}, []);
        mid.appendChild(el("div", { class: "lang-row" }, [
          textField("Підпис", g.cap.nl, function (v) { g.cap.nl = v; markDirty(); }, { lang: "nl" }),
          textField("Підпис", g.cap.en, function (v) { g.cap.en = v; markDirty(); }, { lang: "en" })
        ]));
        mid.appendChild(el("button", {
          class: "btn btn-ghost btn-sm", type: "button", text: "Змінити фото",
          onclick: function () {
            openImagePicker(g.src, function (picked) { g.src = picked; markDirty(); redraw(); });
          }
        }));

        var right = el("div", {}, [
          selectField("Розмір", g.cls, GALLERY_CLS.map(function (c) {
            return { value: c.value, label: c.label };
          }), function (v) { g.cls = v; markDirty(); }),
          el("button", {
            class: "btn btn-danger btn-sm", type: "button", text: "Видалити",
            onclick: function () { p.gallery.splice(i, 1); markDirty(); redraw(); }
          })
        ]);

        var row = el("div", { class: "row-item", draggable: "true" }, [
          el("div", { class: "row-head" }, [
            el("span", { class: "item-grip", text: "⠿" }),
            el("span", { class: "row-label", text: "Фото " + (i + 1) })
          ]),
          el("div", { class: "row-grid" }, [img, mid, right])
        ]);
        attachDrag(row, i, p.gallery, redraw);
        rows.appendChild(row);
      });
      if (!p.gallery.length) {
        rows.appendChild(el("p", { class: "field-note", text: "Фотографій ще немає." }));
      }
    }
    redraw();

    card.appendChild(rows);
    card.appendChild(el("button", {
      class: "btn btn-ghost btn-sm add-row", type: "button", text: "+ Додати фото",
      onclick: function () {
        var order = ["g-wide", "g-tall", "g-half", "g-half"];
        p.gallery.push({
          src: p.cover || "images/projects/bathroom-1.jpg",
          cap: { nl: "", en: "" },
          cls: order[p.gallery.length] || "g-half"
        });
        markDirty(); redraw();
      }
    }));
    return card;
  }

  /* --------------------------------------------------------- drag & drop */
  var dragFrom = null;

  function attachDrag(node, index, arr, redraw) {
    node.addEventListener("dragstart", function (e) {
      dragFrom = { index: index, arr: arr, redraw: redraw };
      node.classList.add("is-dragging");
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", String(index)); } catch (_) {}
    });
    node.addEventListener("dragend", function () {
      node.classList.remove("is-dragging");
      dragFrom = null;
    });
    node.addEventListener("dragover", function (e) {
      if (!dragFrom || dragFrom.arr !== arr) return;
      e.preventDefault();
      node.classList.add("is-over");
    });
    node.addEventListener("dragleave", function () { node.classList.remove("is-over"); });
    node.addEventListener("drop", function (e) {
      node.classList.remove("is-over");
      if (!dragFrom || dragFrom.arr !== arr || dragFrom.index === index) return;
      e.preventDefault();
      var moved = arr.splice(dragFrom.index, 1)[0];
      arr.splice(index, 0, moved);
      var wasSelected = (arr === state.data[state.tab]) && (state.sel[state.tab] === dragFrom.index);
      if (wasSelected) state.sel[state.tab] = index;
      markDirty();
      dragFrom.redraw();
      if (arr === state.data[state.tab]) renderEditor();
    });
  }

  /* ================================================================== list */
  function listRowData(item) {
    if (state.tab === "services") {
      return { title: item.title.nl || "(без назви)", sub: item.desc.nl || "—", img: item.image };
    }
    if (state.tab === "partners") {
      return { title: item.name || "(без назви)", sub: item.desc.nl || "—", img: item.image };
    }
    if (state.tab === "reviews") {
      return {
        title: item.name || "(без імені)",
        sub: "★".repeat(item.rating) + " · " + (item.location || "—") + " · " + fmtDate(item.created),
        status: item.status,
        text: (item.text && item.text.nl) || ""
      };
    }
    var c = catByValue(item.cat);
    return {
      title: item.title.nl || "(без назви)",
      sub: ((c && c.nl) || item.cat) + (item.location ? " · " + item.location : ""),
      img: item.cover
    };
  }

  function renderList() {
    var host = $("#item-list");
    var list = state.data[state.tab] || [];
    var q = state.filter.trim().toLowerCase();

    host.innerHTML = "";
    list.forEach(function (item, i) {
      var d = listRowData(item);
      var hay = (d.title + " " + d.sub + " " + (d.text || "") + " " + (item.id || "")).toLowerCase();
      if (q && hay.indexOf(q) === -1) return;
      if (state.tab === "reviews" && state.status !== "all" && item.status !== state.status) return;

      var thumb = state.tab === "reviews"
        ? el("span", { class: "status-pill s-" + item.status, title: statusLabel(item.status) })
        : el("img", { class: "item-thumb", src: "../" + (d.img || ""), alt: "", loading: "lazy" });
      if (state.tab !== "reviews") {
        thumb.addEventListener("error", function () { thumb.style.opacity = ".25"; });
      }

      var row = el("li", {
        class: "item" + (i === state.sel[state.tab] ? " is-active" : ""),
        draggable: "true",
        "data-index": i,
        onclick: function (e) {
          if (e.target.classList.contains("item-grip")) return;
          state.sel[state.tab] = i;
          renderList();
          renderEditor();
          $("#editor").scrollTop = 0;
        }
      }, [
        el("span", { class: "item-grip", text: "⠿" }),
        el("span", { class: "item-num", text: String(i + 1).padStart(2, "0") }),
        thumb,
        el("span", { class: "item-text" }, [
          el("span", { class: "item-title" }, [
            item._new ? el("i", { class: "item-new", text: "НОВЕ " }) : null,
            document.createTextNode(d.title)
          ]),
          el("span", { class: "item-sub", text: d.sub })
        ])
      ]);

      attachDrag(row, i, list, function () { renderList(); });
      host.appendChild(row);
    });

    if (!host.children.length) {
      host.appendChild(el("li", { class: "sidebar-hint", text: q ? "Нічого не знайдено." : "Записів немає." }));
    }
    paintState();
  }

  /* Cheap partial refresh while typing a title — avoids rebuilding the whole
     editor (which would blur the field under the cursor). */
  function refreshListRow(i) {
    var list = state.data[state.tab] || [];
    var item = list[i];
    var node = $('#item-list .item[data-index="' + i + '"]');
    if (!item || !node) return;
    var d = listRowData(item);
    var title = $(".item-title", node);
    var sub = $(".item-sub", node);
    var img = $(".item-thumb", node);
    if (title) title.textContent = d.title;
    if (sub) sub.textContent = d.sub;
    if (img && d.img && img.getAttribute("src") !== "../" + d.img) {
      img.src = "../" + (d.img || "");
      img.style.opacity = "1";
    }
  }

  /* ================================================================= load */
  function loadTab(which, force) {
    if (state.data[which] && !force) {
      renderList(); renderEditor();
      return Promise.resolve();
    }
    return api("load", { query: { file: which } }).then(function (res) {
      state.data[which] = res.items.map(function (it) {
        if (which === "reviews") {
          return {
            id: it.id || "",
            name: it.name || "",
            location: it.location || "",
            service: pair(it.service),
            text: pair(it.text),
            rating: parseInt(it.rating, 10) || 5,
            status: it.status || "pending",
            created: it.created || "",
            source: it.source || "admin",
            email: it.email || ""
          };
        }
        if (which === "services") {
          return { id: it.id || "", title: pair(it.title), desc: pair(it.desc), image: it.image || "", href: it.href || "#contact" };
        }
        if (which === "partners") {
          return { id: it.id || "", name: it.name || "", desc: pair(it.desc), image: it.image || "", url: it.url || "" };
        }
        var m = it.meta || {};
        return {
          id: it.id || "",
          cat: it.cat || CATEGORIES[0].value,
          catLabel: pair(it.catLabel),
          title: pair(it.title),
          location: it.location || "",
          cover: it.cover || "",
          short: pair(it.short),
          intro: pair(it.intro),
          challenge: pair(it.challenge),
          result: pair(it.result),
          services: {
            nl: ((it.services || {}).nl || []).slice(),
            en: ((it.services || {}).en || []).slice()
          },
          meta: {
            duration: pair(m.duration),
            year: m.year || "",
            type: pair(m.type),
            budget: m.budget || ""
          },
          gallery: (it.gallery || []).map(function (g) {
            return { src: g.src || "", cap: pair(g.cap), cls: g.cls || "g-half" };
          })
        };
      });
      state.mtime[which] = res.mtime;
      state.dirty[which] = false;
      if (state.sel[which] >= state.data[which].length) state.sel[which] = 0;
      renderList();
      renderEditor();
    }).catch(handleApiError);
  }

  /* ================================================================= save */
  function stripInternal(items) {
    return items.map(function (it) {
      var copy = clone(it);
      delete copy._new;
      delete copy._idTouched;
      return copy;
    });
  }

  function save(force) {
    var which = state.tab;
    var btn = $("#btn-save");
    btn.disabled = true;
    $("#save-state").textContent = "Збереження…";

    return api("save", {
      body: {
        file: which,
        items: stripInternal(state.data[which]),
        mtime: state.mtime[which],
        force: !!force
      }
    }).then(function (res) {
      state.mtime[which] = res.mtime;
      state.dirty[which] = false;
      /* Adopt the server's cleaned-up version so what is on screen is
         exactly what the site will render (ids generated, EN filled in). */
      var sel = state.sel[which];
      state.data[which] = null;
      return loadTab(which, true).then(function () {
        state.sel[which] = Math.min(sel, (state.data[which] || []).length - 1);
        renderList(); renderEditor();
        var box = $("#save-state");
        box.className = "save-state is-saved";
        box.textContent = "Збережено ✓";
        toast("Збережено. Оновіть сайт, щоб побачити зміни.", "ok");
      });
    }).catch(function (err) {
      $("#save-state").className = "save-state is-error";
      $("#save-state").textContent = "Не збережено";
      btn.disabled = false;

      if (err.payload && err.payload.conflict) {
        if (confirm(err.message + "\n\nПерезаписати чужі зміни своїми?")) {
          return save(true);
        }
        return;
      }
      handleApiError(err);
    });
  }

  /* ============================================================== history */
  function openHistory() {
    var which = state.tab;
    var names = { services: "послуги", projects: "проєкти", reviews: "відгуки", partners: "партнери" };
    openModal("Резервні копії — " + names[which], el("p", { text: "Завантаження…" }));

    api("backups", { query: { file: which } }).then(function (res) {
      var body = el("div", {});
      body.appendChild(el("p", {
        class: "field-note",
        text: "Копія створюється автоматично перед кожним збереженням. Відновлення теж робить копію поточного стану, тож відкат завжди можна скасувати."
      }));

      if (!res.backups.length) {
        body.appendChild(el("p", { text: "Копій ще немає — вони з'являться після першого збереження." }));
        setModalBody(body);
        return;
      }

      var ul = el("ul", { class: "backup-list" });
      res.backups.forEach(function (b) {
        var s = b.stamp; // YYYYMMDD-HHMMSS
        var when = s.slice(6, 8) + "." + s.slice(4, 6) + "." + s.slice(0, 4) +
                   " " + s.slice(9, 11) + ":" + s.slice(11, 13) + ":" + s.slice(13, 15);
        ul.appendChild(el("li", {}, [
          el("span", { class: "backup-when", text: when }),
          el("span", { class: "field-note", text: Math.round(b.size / 102.4) / 10 + " КБ" }),
          el("div", { class: "spacer" }),
          el("button", {
            class: "btn btn-ghost btn-sm", type: "button", text: "Відновити",
            onclick: function () {
              if (!confirm("Відновити версію від " + when + "?\n\nПоточний стан буде збережено як окрема копія.")) return;
              api("restore", { body: { file: which, stamp: b.stamp } }).then(function () {
                closeModal();
                state.data[which] = null;
                state.dirty[which] = false;
                return loadTab(which, true);
              }).then(function () {
                toast("Версію відновлено.", "ok");
              }).catch(handleApiError);
            }
          })
        ]));
      });
      body.appendChild(ul);
      setModalBody(body);
    }).catch(handleApiError);
  }

  /* ================================================================== app */
  function switchTab(which) {
    state.tab = which;
    $all(".tab").forEach(function (t) { t.classList.toggle("is-active", t.getAttribute("data-tab") === which); });
    $("#filter").value = state.filter = "";
    var labels = { services: "+ Послуга", projects: "+ Проєкт", reviews: "+ Відгук", partners: "+ Партнер" };
    $("#btn-add").textContent = labels[which];
    var bar = $("#status-bar");
    if (bar) bar.hidden = which !== "reviews";
    $("#sidebar-hint").textContent = which === "reviews"
      ? "Порядок перетягуванням = порядок відгуків на сайті."
      : "Перетягніть запис, щоб змінити порядок на сайті.";
    loadTab(which);
    paintState();
  }

  function init() {
    $all(".tab").forEach(function (t) {
      t.addEventListener("click", function () { switchTab(t.getAttribute("data-tab")); });
    });

    $("#btn-add").addEventListener("click", function () {
      var list = state.data[state.tab];
      if (!list) return;
      var blanks = { services: blankService, projects: blankProject, reviews: blankReview, partners: blankPartner };
      list.unshift(blanks[state.tab]());
      state.sel[state.tab] = 0;
      markDirty();
      renderList();
      renderEditor();
      $("#editor").scrollTop = 0;
      var first = $("#editor input[type=text], #editor textarea");
      if (first) first.focus();
    });

    $all("#status-bar .chip").forEach(function (c) {
      c.addEventListener("click", function () {
        $all("#status-bar .chip").forEach(function (x) { x.classList.remove("is-active"); });
        c.classList.add("is-active");
        state.status = c.getAttribute("data-status");
        renderList();
      });
    });

    $("#filter").addEventListener("input", function (e) {
      state.filter = e.target.value;
      renderList();
    });

    $("#btn-save").addEventListener("click", function () { save(false); });
    $("#btn-history").addEventListener("click", openHistory);

    $("#btn-revert").addEventListener("click", function () {
      if (!confirm("Скасувати всі незбережені зміни в цьому розділі?")) return;
      state.data[state.tab] = null;
      state.dirty[state.tab] = false;
      loadTab(state.tab, true).then(function () { toast("Зміни скасовано."); });
    });

    $all("[data-close]").forEach(function (n) { n.addEventListener("click", closeModal); });

    /* A file dropped anywhere but the upload zone would otherwise make the
       browser navigate to it, throwing away every unsaved edit on the page. */
    ["dragover", "drop"].forEach(function (ev) {
      document.addEventListener(ev, function (e) {
        if (!e.target.closest || !e.target.closest(".up-zone")) e.preventDefault();
      });
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !$("#modal").hidden) closeModal();
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (state.dirty[state.tab]) save(false);
      }
    });

    window.addEventListener("beforeunload", function (e) {
      if (!anyDirty()) return;
      e.preventDefault();
      e.returnValue = "";
    });

    $("#btn-add").textContent = "+ Послуга";
    loadTab("services");
  }

  document.addEventListener("DOMContentLoaded", init);
})();
