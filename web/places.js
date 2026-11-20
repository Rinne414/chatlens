"use strict";

/* ---------- places: a sentence that names another page takes you there ----------
   Several pages work on the same thing (originals are kept from 备份, 画廊 and
   the chat; they are seen and removed in 画廊; their size is in 存储; the rules
   are in 设置). A sentence saying "看 画廊「留存的原图」" with nothing to press
   left the user to find the way. linked(text) turns every place it names into
   a link; pages only write the sentence. */

const openSettingsPlace = async (find) => {
  await openSettingsView();
  find()?.scrollIntoView({ behavior: "smooth", block: "start" });
};

const settingsCardOf = (selector) => () => document.querySelector(selector)?.closest(".card") ?? document.querySelector(selector);

const openGalleryRemoved = () => {
  showView("media");
  loadGallerySaveTarget();
  applyGalleryFilter(galleryScopePatch("removed"));
};

const openGalleryMultiSelect = () => {
  openView("media");
  replaceGallery({ selecting: true, lastPicked: null });
  renderMediaView();
};

// Longer names first: 「留存的原图」 alone is also part of 画廊 →「留存的原图」.
const PLACES = [
  [/画廊 ?→ ?「取消留存的」|「取消留存的」/u, () => openGalleryRemoved()],
  [/画廊 ?→? ?「留存的原图」|「留存的原图」/u, () => openGalleryKept()],
  [/「画廊 → 多选」/u, () => openGalleryMultiSelect()],
  [/「设置 → 群图片」|设置 ?→ ?「群图片」/u, () => openSettingsPlace(settingsCardOf("#picture-keep-groups"))],
  [/「设置 → 后台与通知」|设置 ?→ ?「后台与通知」/u, () => openSettingsPlace(settingsCardOf("#settings-background"))],
  [/「设置 → 版本与更新」|设置 ?→ ?「版本与更新」/u, () => openSettingsPlace(settingsCardOf("#update-card"))],
  [/「设置 → 快捷方式」|设置 ?→ ?「快捷方式」/u, () => openSettingsPlace(settingsCardOf("#settings-shortcuts"))],
  [/「存储」页|存储页/u, () => openView("storage")],
  [/备份页/u, () => openView("backup")],
  [/「回顾」/u, () => openView("review")],
  [/咒语库里/u, () => openView("knowledge")],
];

const PLACE_PATTERN = new RegExp(PLACES.map(([pattern]) => `(?:${pattern.source})`).join("|"), "gu");

const placeLink = (name) => {
  const open = PLACES.find(([pattern]) => new RegExp(`^(?:${pattern.source})$`, "u").test(name))[1];
  return el("button", { class: "linklike place-link", type: "button", title: `去 ${name.replace(/里$/u, "")}`, onclick: (event) => {
    // Inside a <label> or a clickable tile the link must not also trigger that.
    event.preventDefault();
    event.stopPropagation();
    open();
  } }, name);
};

// The text as nodes: plain parts as they are, each named place as a link.
const linked = (text) => {
  const nodes = [];
  let from = 0;
  for (const match of String(text).matchAll(PLACE_PATTERN)) {
    if (match.index > from) {
      nodes.push(text.slice(from, match.index));
    }
    nodes.push(placeLink(match[0]));
    from = match.index + match[0].length;
  }
  if (from < text.length) {
    nodes.push(text.slice(from));
  }
  return nodes;
};

/* ---------- folders: where something is kept comes with a way to open it ---------- */

const openFolderButton = (label, open, title = "") => el("button", {
  class: "btn small desktop-action",
  type: "button",
  title,
  onclick: () => open().catch((error) => notifyError(error)),
}, label);

const openKeptFolderButton = () => openFolderButton(
  "打开留存文件夹",
  () => api("/api/storage/open", { method: "POST", body: JSON.stringify({ category: "knowledge-media" }) })
    .catch(() => { throw new Error("还没有留存过原图，所以还没有这个文件夹。"); }),
  "里面按图片编号的前两位分成小文件夹，文件名就是编号；找图还是在画廊「留存的原图」里方便");

// The folder 「另存到文件夹」 writes to, when the user chose one.
const openSaveFolderButton = () => openFolderButton(
  "打开这个文件夹",
  () => api("/api/pictures/export/open", { method: "POST", body: JSON.stringify({ folder: "save-dir" }) }));

const openBackupFolderButton = () => openFolderButton(
  "打开备份文件夹",
  () => api("/api/backup/open-folder", { method: "POST", body: "{}" }));

/* ---------- long text, short first ----------
   Explaining everything made some pages walls of text. shortText(text, keep)
   shows the first sentence(s); the rest waits behind 「展开说明」. Places named
   in either part are still links. */

const SENTENCE_END = /(?<=。)/u;

const shortText = (text, keep = 1) => {
  const sentences = String(text).split(SENTENCE_END).filter((sentence) => sentence !== "");
  if (sentences.length <= keep) {
    return linked(text);
  }
  return [
    linked(sentences.slice(0, keep).join("")),
    el("details", { class: "more-text" },
      el("summary", {}, "展开说明"),
      el("span", {}, linked(sentences.slice(keep).join("")))),
  ];
};

/* ---------- a long page's own contents ----------
   One button per card, read from the cards' headings: nothing to keep in step
   when a card is added. */

const pageIndex = (rootSelector, label) => {
  const headings = [...document.querySelectorAll(`${rootSelector} > .card > h2, ${rootSelector} > .card > div > h2`)]
    .filter((heading) => heading.textContent.trim() !== "");
  if (headings.length < 4) {
    return null;
  }
  return el("nav", { class: "page-index", "aria-label": label },
    el("span", { class: "page-index-label" }, label),
    headings.map((heading) => el("button", {
      class: "page-index-item",
      type: "button",
      onclick: () => heading.closest(".card").scrollIntoView({ behavior: "smooth", block: "start" }),
    }, heading.textContent.trim().replace(/（.*$/u, ""))));
};
