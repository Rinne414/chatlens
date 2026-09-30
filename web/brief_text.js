"use strict";

// AI summaries as text people can read: a short lead and paragraphs of two
// sentences instead of one wall (a detailed-level merge writes up to 15
// sentences; a failed merge used to paste whole parts together). Pure, no
// DOM: tested in Node, loaded in the browser as window.BriefText.

// A sentence ends at its punctuation, a line break or the end of the text.
const SENTENCE_PATTERN = /[^。！？!?；;\n]+(?:[。！？!?；;]+|(?=\n)|$)[」』）)"”’]*/gu;
// Rejoined sentences get a space unless the first ends in Chinese
// punctuation: "Hello! How…", a list line "1. 模型更新 2. …", but "中文。下一句".
const NO_SPACE_AFTER = /[。！？；，、：」』）”’\s]$/u;
// A sentence longer than this is cut at its commas into pieces of at least
// BRIEF_PIECE_CHARS, so one run-on sentence cannot be a wall either.
const BRIEF_LONG_SENTENCE = 80;
const BRIEF_PIECE_CHARS = 40;
const BRIEF_LEAD_SENTENCES = 2;
const BRIEF_PARAGRAPH_SENTENCES = 2;

const splitSentences = (text) => (String(text ?? "").match(SENTENCE_PATTERN) ?? [])
  .map((sentence) => sentence.trim())
  .filter((sentence) => sentence.length > 0);

const cutLongSentence = (sentence) => {
  if (sentence.length <= BRIEF_LONG_SENTENCE) {
    return [sentence];
  }
  const pieces = [];
  let current = "";
  for (const part of sentence.match(/[^，,]+[，,]?/gu) ?? [sentence]) {
    current += part;
    if (current.length >= BRIEF_PIECE_CHARS) {
      pieces.push(current);
      current = "";
    }
  }
  if (current !== "") {
    pieces.push(current);
  }
  return pieces;
};

const joinSentences = (sentences) => sentences.reduce((joined, sentence) => (
  joined === "" || NO_SPACE_AFTER.test(joined) || /^\s/u.test(sentence) ? joined + sentence : `${joined} ${sentence}`), "");

// { lead, paragraphs }: the first sentences on their own, the rest in pairs.
const summaryParts = (text) => {
  const pieces = splitSentences(text).flatMap(cutLongSentence);
  const paragraphs = [];
  for (let index = BRIEF_LEAD_SENTENCES; index < pieces.length; index += BRIEF_PARAGRAPH_SENTENCES) {
    paragraphs.push(joinSentences(pieces.slice(index, index + BRIEF_PARAGRAPH_SENTENCES)));
  }
  return { lead: joinSentences(pieces.slice(0, BRIEF_LEAD_SENTENCES)), paragraphs };
};

const briefText = { splitSentences, summaryParts };

if (typeof module !== "undefined" && module.exports !== undefined) {
  module.exports = briefText;
}
if (typeof window !== "undefined") {
  window.BriefText = briefText;
}
