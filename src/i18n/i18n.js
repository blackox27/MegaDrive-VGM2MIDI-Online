/* Offline DOM adapter for legacy Portuguese messages. Catalogs contain text only.
 * Original nodes stay in place: changing language never restarts playback or resets controls.
 */
(function (root) {
  "use strict";
  const catalogs = root.VGMLocales || { en: {} },
    english = catalogs.en;
  const keys = Object.keys(english)
    .filter((k) => k && english[k] !== k)
    .sort((a, b) => b.length - a.length);
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(keys.map(escape).join("|"), "g");
  const originals = new WeakMap(),
    attributes = new WeakMap(),
    cache = new Map();
  let language = "pt-BR",
    protection = null,
    observer = null;
  function protect(names) {
    const values = [...new Set(names.filter(Boolean))].sort(
      (a, b) => b.length - a.length,
    );
    protection = values.length
      ? new RegExp(values.map(escape).join("|"), "g")
      : null;
    cache.clear();
  }
  function text(input) {
    const value = String(input ?? "");
    if (language !== "en") return value;
    if (cache.has(value)) return cache.get(value);
    const saved = [];
    let source = value;
    if (protection)
      source = source.replace(protection, (name) => {
        const token = "\uE000" + saved.length + "\uE001";
        saved.push(name);
        return token;
      });
    source = source.replace(/\s+/g, " ");
    const exact = source.trim(),
      gm = source.match(/^(\s*\d{3}\s*·\s*)(.+?)(\s*)$/);
    if (Object.hasOwn(english, exact))
      source = source.replace(exact, () => english[exact]);
    else if (gm && Object.hasOwn(english, gm[2]))
      source = gm[1] + english[gm[2]] + gm[3];
    else source = source.replace(expression, (key) => english[key]);
    source = source.replace(/\uE000(\d+)\uE001/g, (_, i) => saved[+i]);
    if (cache.size >= 1024) cache.clear();
    cache.set(value, source);
    return source;
  }
  function skipped(el) {
    return (
      !el ||
      !!el.closest(
        'script,style,noscript,[data-i18n-skip="true"],[data-doc-lang]',
      )
    );
  }
  function localizeText(node) {
    if (skipped(node.parentElement)) return;
    const old = originals.get(node),
      source =
        old && node.nodeValue === old.output ? old.source : node.nodeValue,
      output = text(source);
    originals.set(node, { source, output });
    if (output !== node.nodeValue) node.nodeValue = output;
  }
  function localizeAttributes(el) {
    if (skipped(el)) return;
    const records = attributes.get(el) || {};
    for (const name of ["aria-label", "title", "placeholder"])
      if (el.hasAttribute(name)) {
        const value = el.getAttribute(name),
          old = records[name],
          source = old && value === old.output ? old.source : value,
          output = text(source);
        records[name] = { source, output };
        if (output !== value) el.setAttribute(name, output);
      }
    attributes.set(el, records);
  }
  function apply(node = document.body) {
    if (!node) return;
    if (node.nodeType === 3) {
      localizeText(node);
      return;
    }
    if (node.nodeType !== 1 || skipped(node)) return;
    localizeAttributes(node);
    const walker = document.createTreeWalker(
      node,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    );
    let item;
    while ((item = walker.nextNode())) {
      if (item.nodeType === 3) localizeText(item);
      else localizeAttributes(item);
    }
  }
  function setLanguage(value, persist = true) {
    language = value === "en" ? "en" : "pt-BR";
    cache.clear();
    document.documentElement.lang = language;
    const selector = document.getElementById("language");
    if (selector) selector.value = language;
    for (const el of document.querySelectorAll("[data-doc-lang]"))
      el.hidden = el.dataset.docLang !== language;
    apply();
    if (persist)
      try {
        localStorage.setItem("vgm2mid.language", language);
      } catch {}
    root.dispatchEvent(
      new CustomEvent("vgm-language", { detail: { language } }),
    );
    return language;
  }
  function init() {
    let stored;
    try {
      stored = localStorage.getItem("vgm2mid.language");
    } catch {}
    setLanguage(stored, false);
    document
      .getElementById("language")
      .addEventListener("change", (e) => setLanguage(e.target.value));
    observer = new MutationObserver((records) => {
      const roots = new Set();
      for (const r of records) {
        if (r.type === "childList") {
          for (const node of r.addedNodes) roots.add(node);
        } else roots.add(r.target);
      }
      for (const node of roots) if (node.isConnected) apply(node);
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["title", "aria-label", "placeholder"],
    });
  }
  root.I18n = {
    get locale() {
      return language;
    },
    text,
    protect,
    apply,
    setLanguage,
    init,
  };
})(globalThis);
