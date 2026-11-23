"use strict";

/* ---------- 语言 / 語言 ----------
   The interface is written in Simplified Chinese. 繁體中文 shows the same
   interface with every piece of text converted on its way to the screen
   (lang_convert.js, with the OpenCC tables), so no page had to change.
   Chat messages themselves stay as they were written.

   Loaded in <head>: when 繁體 is chosen the converter is in place before the
   first thing is drawn, so nothing flashes in the other script. */

const LANG_KEY = "cc-lang";
const LANG_CHOICES = [["zh-Hans", "简体中文"], ["zh-Hant", "繁體中文"]];

const langChoice = () => {
  try {
    return localStorage.getItem(LANG_KEY) === "zh-Hant" ? "zh-Hant" : "zh-Hans";
  } catch {
    return "zh-Hans";
  }
};

// The page is drawn again from the start in the other language.
const setLangChoice = (choice) => {
  try {
    localStorage.setItem(LANG_KEY, choice === "zh-Hant" ? "zh-Hant" : "zh-Hans");
  } catch {
    // A private window that refuses storage keeps the language it has.
    return;
  }
  location.reload();
};

if (langChoice() === "zh-Hant" && typeof document !== "undefined" && typeof document.write === "function" && document.readyState === "loading") {
  // Both before anything else runs: the tables, then the converter that uses them.
  document.write('<script src="/opencc-cn2t.js"></script><script src="/lang_convert.js"></script>');
}

// The 语言 box in the rail's foot.
if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
  document.addEventListener("DOMContentLoaded", () => {
    const select = document.getElementById("lang-select");
    if (select === null) {
      return;
    }
    select.value = langChoice();
    select.addEventListener("change", () => setLangChoice(select.value));
  });
}
