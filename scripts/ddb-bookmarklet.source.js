/**
 * ddb-bookmarklet.source.js
 * ---------------------------------------------------------------------------
 * Human-readable source for the "DDB Import" bookmarklet.
 * The module generates the minified javascript: link from this same logic
 * (see BOOKMARKLET_SOURCE in ddb-live-importer.js) — this file exists so the
 * script can be read, reviewed, and edited without unminifying a bookmark
 * URL.
 *
 * What it does, and nothing else:
 *   1. Reads the character id out of the current D&D Beyond URL.
 *   2. Calls D&D Beyond's own character API, using your existing login
 *      (same request the character sheet page itself makes when it loads).
 *   3. Copies the JSON result to your clipboard.
 * It never sends your data anywhere except your own clipboard.
 * ---------------------------------------------------------------------------
 */
(function () {
  var m = location.pathname.match(/\/characters\/(\d+)/);
  if (!m) {
    alert("DDB Import: open a character's sheet page first, then click this bookmark.");
    return;
  }
  var id = m[1];

  fetch("https://character-service.dndbeyond.com/character/v5/character/" + id, {
    credentials: "include"
  })
    .then(function (r) {
      if (!r.ok) throw new Error("D&D Beyond returned " + r.status);
      return r.json();
    })
    .then(function (json) {
      var text = JSON.stringify(json);
      return navigator.clipboard.writeText(text).then(function () {
        return json;
      });
    })
    .then(function (json) {
      var name = (json && json.data && json.data.name) || "Character";
      alert('DDB Import: copied ' + name + '. Switch to Foundry and click "Paste Character Data."');
    })
    .catch(function (err) {
      alert("DDB Import failed: " + err.message);
    });
})();
