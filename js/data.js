/* ==========================================================================
   Content loader — replaces the old hard-coded js/projects.js.

   Services and projects now live in data/*.json, which the admin panel
   (admin/) rewrites. This file fetches them once and exposes:

     window.HB_PROJECTS  — array, same shape main.js always expected
     window.HB_SERVICES  — array, new; drives the "Onze diensten" list
     window.HB_PARTNERS  — array; drives the partner cards below the reviews
     window.HB_DATA_READY — promise main.js awaits before its first render

   The promise never rejects: if a file is missing or malformed the site
   still boots with an empty section instead of a blank page.
   ========================================================================== */
(function () {
  "use strict";

  window.HB_PROJECTS = [];
  window.HB_SERVICES = [];
  window.HB_REVIEWS  = [];
  window.HB_PARTNERS = [];

  /* Pages sit at the site root, so a relative path works for all of them.
     Cache-busted per deploy-day so editors see their changes without a
     hard refresh, while normal visitors still hit the browser cache. */
  function load(name) {
    return fetch("data/" + name + ".json", { cache: "no-cache" })
      .then(function (r) {
        if (!r.ok) throw new Error(name + ": HTTP " + r.status);
        return r.json();
      })
      .then(function (json) {
        return Array.isArray(json) ? json : [];
      })
      .catch(function (err) {
        if (window.console) console.error("[HB] content load failed —", err);
        return [];
      });
  }

  window.HB_DATA_READY = Promise.all([
    load("projects"), load("services"), load("reviews"), load("partners")
  ]).then(function (res) {
    window.HB_PROJECTS = res[0];
    window.HB_SERVICES = res[1];
    window.HB_REVIEWS  = res[2];
    window.HB_PARTNERS = res[3];
  });
})();
