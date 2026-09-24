"use strict";

/* ---------- AIGC layer shared by 画廊 and 咒语库 ----------
   Badges on gallery pictures (带参数 / N 人求过 / 作者回了), the quick
   filters for them, and the detail view's "who asked" and "related" sections. */

const AIGC_BADGE_BATCH = 1500;
const AIGC_QUICK_FILTERS = [
  { token: "has:params", label: "原图带参数", title: "图片文件里带着生成参数（模型、seed、steps…）" },
  { token: "has:request", label: "有人求过", title: "群里有人求过这张图的咒语或原图" },
  { token: "has:answer", label: "作者回了", title: "有人回复了咒语、原图或文件" },
];
const AIGC_GALLERY_FILTERS = [
  { value: "all", label: "全部" },
  { value: "params", label: "原图带参数" },
  { value: "asked", label: "有人求过" },
  { value: "answered", label: "作者回了" },
];

const aigcState = { badges: new Map(), loading: false, related: null, relatedFor: null };

/* ---------- gallery badges ---------- */

const aigcHashOf = (item) => (item.contentKeySource === "hash" && /^[a-f0-9]{32}$/u.test(item.contentKey ?? "") ? item.contentKey : null);

// Looks up every gallery picture the library has not been asked about yet.
const loadGalleryBadges = async (items) => {
  const hashes = [...new Set(items.map(aigcHashOf).filter((hash) => hash !== null && !aigcState.badges.has(hash)))];
  if (hashes.length === 0 || aigcState.loading) {
    return false;
  }
  aigcState.loading = true;
  try {
    for (let start = 0; start < hashes.length; start += AIGC_BADGE_BATCH) {
      const batch = hashes.slice(start, start + AIGC_BADGE_BATCH);
      const found = await api("/api/knowledge/badges", { method: "POST", body: JSON.stringify({ hashes: batch }) });
      for (const hash of batch) {
        aigcState.badges.set(hash, found[hash] ?? null);
      }
    }
    return true;
  } catch {
    // Badges are an extra; the gallery works without them.
    return false;
  } finally {
    aigcState.loading = false;
  }
};

const aigcBadgeOf = (item) => {
  const hash = aigcHashOf(item);
  return hash === null ? null : aigcState.badges.get(hash) ?? null;
};

const aigcMatchesFilter = (item, filter) => {
  if (filter === "all" || filter === undefined) {
    return true;
  }
  const badge = aigcBadgeOf(item);
  if (badge === null) {
    return false;
  }
  return filter === "params" ? badge.params : filter === "asked" ? badge.asks > 0 : badge.answers > 0;
};

const aigcBadgeRow = (item) => {
  const badge = aigcBadgeOf(item);
  if (badge === null) {
    return null;
  }
  return el("span", { class: "aigc-badges" },
    badge.params ? el("span", { class: "aigc-badge params", title: "原图带生成参数" }, generatorLabel(badge.generator)) : null,
    badge.asks > 0 ? el("span", { class: "aigc-badge asked", title: "群里有人求过这张图" }, `${badge.asks} 人求`) : null,
    badge.answers > 0 ? el("span", { class: "aigc-badge answered", title: "有人回复了咒语或原图" }, "已回") : null);
};

// Opens the 咒语库 detail for a picture seen anywhere else (gallery, brief).
const openKnowledgeDetailByHash = async (hash) => {
  const full = await api(`/api/knowledge/image?hash=${encodeURIComponent(hash)}`);
  showView("knowledge");
  ensureKnowledgeLoaded();
  replaceKnowledgeTab({ detail: full, detailLoading: false });
  renderKnowledgeView();
  loadKnowledgeRelated(hash);
};

/* ---------- 咒语库 quick filters ---------- */

const knowledgeQueryTokens = () => app.knowledgeTab.query.split(/\s+/u).filter((token) => token.length > 0);

const toggleKnowledgeToken = (token) => {
  const tokens = knowledgeQueryTokens();
  const next = tokens.includes(token) ? tokens.filter((item) => item !== token) : [...tokens, token];
  replaceKnowledgeTab({ query: next.join(" ") });
  loadKnowledgeResults();
};

const knowledgeQuickFilters = () => {
  const tokens = knowledgeQueryTokens();
  return el("div", { class: "aigc-filter" },
    el("span", { class: "aigc-filter-label" }, "快速筛选"),
    AIGC_QUICK_FILTERS.map((filter) => el("button", {
      class: tokens.includes(filter.token) ? "btn small active" : "btn small",
      "aria-pressed": String(tokens.includes(filter.token)),
      title: filter.title,
      onclick: () => toggleKnowledgeToken(filter.token),
    }, filter.label)));
};

/* ---------- detail: who asked, and related pictures ---------- */

const loadKnowledgeRelated = async (hash) => {
  aigcState.relatedFor = hash;
  aigcState.related = null;
  try {
    const related = await api(`/api/knowledge/related?hash=${encodeURIComponent(hash)}`);
    if (aigcState.relatedFor === hash && app.knowledgeTab.detail?.hash === hash) {
      aigcState.related = related;
      renderKnowledgeView();
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
      }, el("img", { src: knowledgeThumbUrl(entry.hash), alt: "", loading: "lazy", decoding: "async" })))));

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
