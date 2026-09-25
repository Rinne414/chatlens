"use strict";

/* ---------- AIGC detail extras shared by 咒语库, 画廊 and 简报 ----------
   The detail view's "who asked" and "related" sections, and opening a
   library detail for a picture seen anywhere else. */

const aigcState = { related: null, relatedFor: null };

// Opens the 咒语库 detail for a picture seen anywhere else (gallery, brief).
const openKnowledgeDetailByHash = async (hash) => {
  const full = await api(`/api/knowledge/image?hash=${encodeURIComponent(hash)}`);
  showView("knowledge");
  ensureKnowledgeLoaded();
  replaceKnowledgeTab({ detail: full, detailLoading: false });
  renderKnowledgeDetailLayer();
  loadKnowledgeRelated(hash);
};

/* ---------- detail: who asked, and related pictures ---------- */

const loadKnowledgeRelated = async (hash) => {
  aigcState.relatedFor = hash;
  aigcState.related = null;
  try {
    const related = await api(`/api/knowledge/related?hash=${encodeURIComponent(hash)}`);
    if (aigcState.relatedFor === hash && app.knowledgeTab.detail?.hash === hash) {
      aigcState.related = related;
      renderKnowledgeDetailLayer();
    }
  } catch {
    // Related pictures are optional; the detail stays as it is.
  }
};

const knowledgeAskList = (item) => {
  const asks = item.promptRequests ?? [];
  if (asks.length === 0) {
    return null;
  }
  return el("section", { class: "aigc-asks" },
    el("span", { class: "kb-prompt-label" }, `谁求过这张图（${asks.length}）`),
    el("ul", {}, asks.map((ask) => el("li", {},
      el("div", { class: "aigc-ask-head" },
        el("strong", {}, ask.asker || "有人"),
        el("span", { class: "kb-badge" }, INTENT_LABELS[ask.intent] ?? "求图"),
        confidenceBadge(ask.confidence),
        ask.askSentAt ? el("span", { class: "kb-meta" }, formatUnix(ask.askSentAt)) : null),
      ask.askText ? el("p", { class: "kb-ask" }, ask.askText) : null,
      requestIsAnswered(ask) ? requestAnswer(ask) : el("p", { class: "kb-note muted" }, "还没有人回复")))));
};

const relatedStrip = (title, subtitle, items) =>
  el("section", { class: "aigc-related" },
    el("span", { class: "kb-prompt-label" }, title, subtitle ? el("span", { class: "kb-meta" }, ` ${subtitle}`) : null),
    el("div", { class: "aigc-related-strip" }, items.map((entry) =>
      el("button", {
        class: "aigc-related-item",
        title: "看这张",
        onclick: () => openKnowledgeDetailByHash(entry.hash).catch(() => {}),
      }, el("img", {
        src: knowledgeThumbUrl(entry.hash),
        alt: "",
        loading: "lazy",
        decoding: "async",
        // QQ may have evicted its cache copy; Tencent's thumbnail is the fallback.
        onerror: (event) => {
          if (event.target.dataset.fallback !== "1" && PICTURE_MD5.test(entry.hash)) {
            event.target.dataset.fallback = "1";
            event.target.src = pictureUrl(entry.hash, "thumb");
          }
        },
      })))));

const knowledgeRelated = (item) => {
  const related = aigcState.relatedFor === item.hash ? aigcState.related : null;
  if (related === null) {
    return null;
  }
  const setupLabel = related.setup === null ? "" : [related.setup.checkpoint, related.setup.loras.length > 0 ? `${related.setup.loras.length} 个 LoRA` : ""].filter(Boolean).join(" · ");
  return el("div", { class: "aigc-related-wrap" },
    related.author ? relatedStrip(`${related.author.name} 的其他图`, "", related.author.items) : null,
    related.setup ? relatedStrip("同模型 / LoRA 的图", setupLabel, related.setup.items) : null);
};
