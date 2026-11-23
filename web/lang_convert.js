"use strict";

/* ---------- 繁體中文: text is converted as it reaches the page ----------
   Loaded only when 繁體 is chosen (lang.js), after the OpenCC tables. Every
   text node and every title / placeholder / aria-label that enters the
   document is converted from Simplified to Traditional, before it is painted.

   Left as written: chat messages (a message is what its sender typed), what
   the reader types, and anything marked data-verbatim. */

(() => {
  if (typeof OpenCC === "undefined" || typeof MutationObserver === "undefined") {
    return;
  }
  const convert = OpenCC.Converter({ from: "cn", to: "tw" });
  const LANG_ATTRIBUTES = ["title", "placeholder", "aria-label"];
  // A message row in an open chat, and anything a page marks itself.
  const LANG_VERBATIM = ".chat-scroll [data-rowid], [data-verbatim]";
  const LANG_SKIP_TAGS = new Set(["SCRIPT", "STYLE", "TEXTAREA", "NOSCRIPT"]);
  const HAS_HAN = /[㐀-鿿]/u;

  // The same labels come round all the time.
  const cache = new Map();
  const CACHE_ENTRIES = 5000;
  const toTraditional = (text) => {
    if (!HAS_HAN.test(text)) {
      return text;
    }
    const known = cache.get(text);
    if (known !== undefined) {
      return known;
    }
    const converted = convert(text);
    if (text.length <= 200) {
      if (cache.size >= CACHE_ENTRIES) {
        cache.clear();
      }
      cache.set(text, converted);
    }
    return converted;
  };

  const isVerbatim = (element) => element === null || LANG_SKIP_TAGS.has(element.tagName) || element.closest(LANG_VERBATIM) !== null;

  const convertText = (node) => {
    if (isVerbatim(node.parentElement)) {
      return;
    }
    const converted = toTraditional(node.data);
    if (converted !== node.data) {
      node.data = converted;
    }
  };

  const convertAttributes = (element) => {
    for (const name of LANG_ATTRIBUTES) {
      const value = element.getAttribute(name);
      if (value !== null) {
        const converted = toTraditional(value);
        if (converted !== value) {
          element.setAttribute(name, converted);
        }
      }
    }
  };

  const convertTree = (root) => {
    if (root.nodeType === Node.TEXT_NODE) {
      convertText(root);
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE || isVerbatim(root)) {
      return;
    }
    convertAttributes(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      // A verbatim element is passed over with everything inside it.
      acceptNode: (node) => (node.nodeType === Node.ELEMENT_NODE && (LANG_SKIP_TAGS.has(node.tagName) || node.matches(LANG_VERBATIM))
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT),
    });
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (node.nodeType === Node.TEXT_NODE) {
        convertText(node);
      } else {
        convertAttributes(node);
      }
    }
  };

  // Runs before the browser paints what was just added. Its own changes come
  // back here once more and are found already converted.
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "childList") {
        record.addedNodes.forEach(convertTree);
      } else if (record.type === "characterData") {
        convertText(record.target);
      } else if (record.target.nodeType === Node.ELEMENT_NODE && !isVerbatim(record.target)) {
        convertAttributes(record.target);
      }
    }
  }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: LANG_ATTRIBUTES });

  document.documentElement.lang = "zh-Hant";
  // What the page already holds (the title, anything parsed before this ran).
  convertTree(document.documentElement);
})();
