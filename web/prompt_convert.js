"use strict";

/* ---------- 咒语: one way of writing emphasis into the other ----------
   NovelAI writes weight as  1.2::tag, tag::  (and the older {tag} / [tag]);
   WebUI and ComfyUI write  (tag, tag:1.2).  The words are the same; only the
   emphasis marks differ, so a prompt copied from one does not work in the
   other until they are rewritten. Text only, nothing is added or dropped
   except <lora:...> tags, which NovelAI cannot use. */

const PROMPT_BRACE_STEP = 1.05;
const PROMPT_PAREN_STEP = 1.1;

const promptWeight = (value) => String(Math.round(value * 100) / 100);

// Tidies what is left after a rewrite: doubled commas, spaces before commas.
const promptTidy = (text) => text
  .replace(/[ \t]+,/gu, ",")
  .replace(/,(?:\s*,)+/gu, ",")
  .replace(/[ \t]{2,}/gu, " ")
  .replace(/^\s*,\s*|\s*,\s*$/gu, "")
  .trim();

// WebUI / ComfyUI -> NovelAI.  (a:1.2) -> 1.2::a::   (a) -> 1.1::a::   [a] -> 0.91::a::
const promptToNai = (source) => {
  let text = String(source ?? "").replace(/<[^<>]*>/gu, "").replace(/\bBREAK\b/gu, ",");
  // literal parentheses in a tag are escaped in WebUI and plain in NovelAI: set them aside
  text = text.replace(/\\\(/gu, "\u0001").replace(/\\\)/gu, "\u0002");
  const innermost = /\(([^()[\]]*?)(?::\s*(-?\d*\.?\d+)\s*)?\)|\[([^()[\]]*)\]/u;
  for (let guard = 0; guard < 500 && innermost.test(text); guard += 1) {
    text = text.replace(innermost, (whole, inParens, weight, inBrackets) => {
      const inner = (inParens ?? inBrackets ?? "").trim();
      if (inner === "") {
        return "";
      }
      const factor = inBrackets !== undefined ? 1 / PROMPT_PAREN_STEP : weight === undefined ? PROMPT_PAREN_STEP : Number(weight);
      // emphasis inside emphasis multiplies: 1.1::1.2::a:::: is not NovelAI, so the inner one is folded in
      const nested = /^(-?\d*\.?\d+)::(.*)::$/su.exec(inner);
      return nested === null ? `${promptWeight(factor)}::${inner}::` : `${promptWeight(factor * Number(nested[1]))}::${nested[2]}::`;
    });
  }
  return promptTidy(text.replace(/\u0001/gu, "(").replace(/\u0002/gu, ")"));
};

// NovelAI -> WebUI / ComfyUI.  1.2::a, b:: -> (a, b:1.2)   {a} -> (a:1.05)   [a] -> (a:0.95)
const promptToSd = (source) => {
  let text = String(source ?? "");
  // plain parentheses are part of a tag in NovelAI and emphasis in WebUI: escape them
  text = text.replace(/\\?([()])/gu, "\\$1");
  text = text.replace(/(-?\d*\.?\d+)::([\s\S]*?)::/gu, (whole, weight, inner) => (inner.trim() === "" ? "" : `(${inner.trim()}:${promptWeight(Number(weight))})`));
  const braces = /(\{+)([^{}[\]]*)(\}+)|(\[+)([^{}[\]]*)(\]+)/u;
  for (let guard = 0; guard < 500 && braces.test(text); guard += 1) {
    text = text.replace(braces, (whole, open, inBraces, close, openSquare, inSquare, closeSquare) => {
      const inner = (inBraces ?? inSquare ?? "").trim();
      if (inner === "") {
        return "";
      }
      const depth = open !== undefined ? Math.min(open.length, close.length) : -Math.min(openSquare.length, closeSquare.length);
      return `(${inner}:${promptWeight(PROMPT_BRACE_STEP ** depth)})`;
    });
  }
  return promptTidy(text);
};

// Which way a prompt is written, from its own marks: "nai" | "sd" | null (no emphasis at all).
const promptStyleOf = (text, generator = "") => {
  const source = String(text ?? "");
  if (/\d::[\s\S]*?::|\{[^{}]+\}/u.test(source)) {
    return "nai";
  }
  if (/(^|[^\\])\([^()]*\)|<lora:/iu.test(source)) {
    return "sd";
  }
  return generator === "nai" ? "nai" : generator === "" ? null : "sd";
};
