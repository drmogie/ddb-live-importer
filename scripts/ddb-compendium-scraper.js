/**
 * D&D Beyond Live Importer -- Compendium Builder, browser side.
 *
 * `ddbScrape` runs INSIDE the user's logged-in D&D Beyond tab (pasted into the
 * browser console). It never runs in Foundry. It has to be fully
 * self-contained, because it is turned into text with Function.toString().
 *
 * How it works (confirmed against the live site on 2026-10-07):
 *  - D&D Beyond list pages (/monsters, /spells, /magic-items, /equipment,
 *    /feats) are plain server-built HTML and accept ?filter-source=<id>&page=<n>.
 *  - The source ids come from the filter-source dropdown on /monsters.
 *  - /classes ignores the source filter, so class cards are matched by the
 *    book name printed on each card.
 *  - Content the user does NOT own redirects to the D&D Beyond shop, so the
 *    fetch fails. That is used as the owned-only check: those pages are skipped.
 *  - No token is read or saved. The tab's own login does the work.
 *
 * Output: a JSON file download, format "ddb-books-v1".
 */

/* eslint-disable no-undef */
async function ddbScrape(cfg) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const norm = s => String(s || "").toLowerCase().replace(/[‘’']/g, "'").replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();
  const stripYear = s => norm(s).replace(/\b(2014|2024)\b/g, "").replace(/\s+/g, " ").trim();
  const parse = html => new DOMParser().parseFromString(html, "text/html");
  const text = el => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");

  // ---- little status box so the user can see progress -----------------------
  const box = document.createElement("div");
  box.style.cssText = "position:fixed;z-index:999999;right:12px;bottom:12px;max-width:340px;padding:10px 14px;background:#1b1b1b;color:#fff;font:14px/1.4 sans-serif;border:2px solid #c53131;border-radius:6px;";
  document.body.appendChild(box);
  const say = msg => { box.textContent = "DDB Compendium Builder: " + msg; console.log("[DDBLI]", msg); };
  window.__ddbStop = false;

  const getDoc = async url => {
    try {
      const r = await fetch(url, { credentials: "include" });
      if (!r.ok) return null;
      if (r.redirected && !r.url.startsWith(location.origin)) return null; // sent to the shop = not owned
      return parse(await r.text());
    } catch (e) {
      return null; // cross-site redirect to the shop makes fetch throw
    }
  };

  // ---- cleaning helpers ------------------------------------------------------
  const cleanHtml = (el, outer) => {
    if (!el) return "";
    const c = el.cloneNode(true);
    c.querySelectorAll("script,style,img,svg,noscript,iframe,button").forEach(n => n.remove());
    c.querySelectorAll("a").forEach(a => a.replaceWith(...a.childNodes));
    [c, ...c.querySelectorAll("*")].forEach(n => [...n.attributes].forEach(a => n.removeAttribute(a.name)));
    return (outer ? c.outerHTML : c.innerHTML).replace(/\s+/g, " ").trim();
  };
  const pairs = root => {
    const o = {};
    (root ? root.querySelectorAll(".ddb-statblock-item") : []).forEach(it => {
      const l = text(it.querySelector(".ddb-statblock-item-label")).replace(/:$/, "");
      const v = text(it.querySelector(".ddb-statblock-item-value"));
      if (l) o[l] = v;
    });
    return o;
  };

  // ---- one extractor per content type ---------------------------------------
  const extractMonster = doc => {
    const sb = doc.querySelector(".mon-stat-block");
    if (!sb) return null;
    const attrs = {};
    sb.querySelectorAll(".mon-stat-block__attribute").forEach(a => {
      const label = text(a.querySelector(".mon-stat-block__attribute-label"));
      const v = text(a.querySelector(".mon-stat-block__attribute-data-value")) || text(a.querySelector(".mon-stat-block__attribute-value"));
      const x = text(a.querySelector(".mon-stat-block__attribute-data-extra"));
      if (label) attrs[label] = (v + " " + x).trim();
    });
    const abilities = {};
    sb.querySelectorAll(".ability-block__stat").forEach(a => {
      const k = text(a.querySelector(".ability-block__heading")).toLowerCase();
      const s = parseInt(text(a.querySelector(".ability-block__score")), 10);
      if (k) abilities[k] = s;
    });
    const tidbits = {};
    sb.querySelectorAll(".mon-stat-block__tidbit").forEach(t => {
      const label = text(t.querySelector(".mon-stat-block__tidbit-label"));
      const v = text(t.querySelector(".mon-stat-block__tidbit-data"));
      if (label) tidbits[label] = v;
    });
    const blocks = [];
    sb.querySelectorAll(".mon-stat-block__description-block").forEach(b => {
      const content = b.querySelector(".mon-stat-block__description-block-content");
      const paras = content ? [...content.children].map(n => cleanHtml(n, true)).filter(Boolean) : [];
      blocks.push({ heading: text(b.querySelector(".mon-stat-block__description-block-heading")), paras });
    });
    return {
      name: text(sb.querySelector(".mon-stat-block__name")),
      meta: text(sb.querySelector(".mon-stat-block__meta")),
      attrs, abilities, tidbits, blocks
    };
  };

  const extractSpell = doc => {
    const main = doc.querySelector(".primary-content") || doc.body;
    const more = main.querySelector(".more-info-content");
    return {
      name: text(doc.querySelector("h1")),
      pairs: pairs(main),
      tags: [...main.querySelectorAll(".tags .tag")].map(text),
      materials: text(main.querySelector(".components-blurb")),
      head: text(main).slice(0, 400),
      html: cleanHtml(more)
    };
  };

  const extractItem = doc => {
    const main = doc.querySelector(".primary-content") || doc.body;
    const more = main.querySelector(".more-info-content") || main.querySelector(".details-container-content");
    return {
      name: text(doc.querySelector("h1")),
      pairs: pairs(main),
      tags: [...main.querySelectorAll(".tags .tag")].map(text),
      head: text(main).slice(0, 500),
      html: cleanHtml(more)
    };
  };

  const extractFeat = doc => {
    const main = doc.querySelector(".primary-content") || doc.body;
    const more = main.querySelector(".more-info-content") || main.querySelector(".details-container-content") || main;
    return {
      name: text(doc.querySelector("h1")),
      head: text(main).slice(0, 400),
      html: cleanHtml(more)
    };
  };

  const extractClass = doc => {
    const main = doc.querySelector(".primary-content") || doc.body;
    const sections = [];
    let cur = { heading: "", level: 0, paras: [] };
    main.querySelectorAll("h2,h3,h4,p,ul,ol,table").forEach(n => {
      if (n.parentElement && n.parentElement.closest("table,ul,ol,p")) return;
      if (/^H[234]$/.test(n.tagName)) {
        if (cur.heading || cur.paras.length) sections.push(cur);
        cur = { heading: text(n), level: +n.tagName[1], paras: [] };
      } else {
        const h = cleanHtml(n, true);
        if (h) cur.paras.push(h);
      }
    });
    if (cur.heading || cur.paras.length) sections.push(cur);
    return { name: text(doc.querySelector("h1")), head: text(main).slice(0, 600), sections };
  };

  // ---- list page helpers -----------------------------------------------------
  const anchorsOf = (doc, section) => {
    const rx = new RegExp("^/" + section + "/\\d+-[^/]+$");
    const seen = new Map();
    doc.querySelectorAll("a").forEach(a => {
      const href = (a.getAttribute("href") || "").split("?")[0];
      if (!rx.test(href) || seen.has(href)) return;
      const card = a.closest(".info,.listing-card,li,.row");
      const src = text(card && (card.querySelector(".source") || card.querySelector(".listing-card__source")));
      const name = text(a) || href.split("-").slice(1).join(" ");
      seen.set(href, { href, name, source: src, cls: card ? card.className : "" });
    });
    return [...seen.values()];
  };

  const TYPES = {
    monsters: { sections: ["monsters"], extract: extractMonster },
    spells: { sections: ["spells"], extract: extractSpell },
    items: { sections: ["magic-items", "equipment"], extract: extractItem },
    feats: { sections: ["feats"], extract: extractFeat },
    classes: { sections: ["classes"], extract: extractClass }
  };

  // ---- 1. which books? -------------------------------------------------------
  const srcDoc = document.querySelector('select[name="filter-source"]') ? document : await getDoc("/monsters");
  const options = srcDoc ? [...srcDoc.querySelectorAll('select[name="filter-source"] option')].map(o => ({ id: o.value, name: o.textContent.trim() })).filter(o => o.id) : [];
  if (!options.length) { say("Could not read the book list. Open dndbeyond.com/monsters and run again."); return; }

  let titles = (cfg.titles && cfg.titles.length) ? cfg.titles : null;
  if (!titles) {
    titles = [...document.querySelectorAll("h2,h3,h4,[class*='title'],[class*='Title']")]
      .filter(e => e.offsetParent && e.innerText.trim() && e.innerText.length < 80).map(e => e.innerText.trim());
  }
  const want = new Set(titles.map(norm));
  const books = options.filter(o => want.has(norm(o.name)));
  const matched = new Set(books.map(b => norm(b.name)));
  const unmatched = [...want].filter(t => !matched.has(t));
  if (!books.length) { say("No owned books matched. Open your Library, click OWNED, and run again."); return; }
  console.log("[DDBLI] books:", books.map(b => b.name), "| not matched (fine if not a book):", unmatched);

  // ---- 2. read everything ----------------------------------------------------
  const out = { format: "ddb-books-v1", created: new Date().toISOString(), books: [] };
  const delay = cfg.delayMs || 350;
  let done = 0, skipped = 0;

  for (const book of books) {
    const rec = { id: book.id, name: book.name, monsters: [], spells: [], items: [], feats: [], classes: [] };
    for (const type of cfg.types) {
      const def = TYPES[type];
      if (!def) continue;
      for (const section of def.sections) {
        // gather the list of links for this book
        let links = [];
        if (section === "classes") {
          const doc = await getDoc("/classes");
          const bn = stripYear(book.name), is24 = /2024/.test(book.name), is14 = /2014/.test(book.name);
          links = doc ? anchorsOf(doc, "classes").filter(l => {
            if (stripYear(l.source) !== bn) return false;
            if (is24) return /2024/.test(l.cls);
            if (is14) return !/2024/.test(l.cls);
            return true;
          }) : [];
        } else {
          const seen = new Set();
          for (let page = 1; page < 400 && !window.__ddbStop; page++) {
            const doc = await getDoc("/" + section + "?filter-source=" + book.id + "&page=" + page);
            if (!doc) break;
            const found = anchorsOf(doc, section).filter(l => !seen.has(l.href));
            if (!found.length) break;
            found.forEach(l => { seen.add(l.href); links.push(l); });
            say(book.name + ": listing " + section + " (" + links.length + ")");
            await sleep(delay);
          }
        }
        // read each page
        let n = 0;
        for (const l of links) {
          if (window.__ddbStop) break;
          n++;
          say(book.name + ": " + section + " " + n + "/" + links.length);
          const doc = await getDoc(l.href);
          if (!doc) { skipped++; await sleep(delay); continue; }
          let data = null;
          try { data = def.extract(doc); } catch (e) { console.warn("[DDBLI] could not read", l.href, e); }
          if (data) {
            data.id = (l.href.match(/\/(\d+)-/) || [])[1] || "";
            data.url = l.href;
            data.kind = section;
            data.listName = l.name;
            rec[type].push(data);
            done++;
          }
          await sleep(delay);
        }
      }
    }
    out.books.push(rec);
    if (window.__ddbStop) break;
  }

  // ---- 3. hand the file to the user ---------------------------------------------
  window.__ddbResult = out;
  const blob = new Blob([JSON.stringify(out)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "ddb-books-" + new Date().toISOString().slice(0, 10) + ".json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  say("Done. " + done + " entries from " + out.books.length + " books (" + skipped + " skipped). A file was downloaded. You can close this box by reloading the page.");
}

/** Every type the scraper can read. */
export const SCRAPE_TYPES = ["monsters", "spells", "items", "feats", "classes"];

/**
 * Build the text the GM pastes into the D&D Beyond tab's console.
 * @param {{types?:string[], titles?:string[], delayMs?:number}} opts
 */
export function buildScrapeScript(opts = {}) {
  const cfg = {
    types: (opts.types?.length ? opts.types : SCRAPE_TYPES).filter(t => SCRAPE_TYPES.includes(t)),
    titles: (opts.titles ?? []).map(t => String(t).trim()).filter(Boolean),
    delayMs: Number.isFinite(opts.delayMs) ? opts.delayMs : 350
  };
  return `(${ddbScrape.toString()})(${JSON.stringify(cfg)});`;
}
