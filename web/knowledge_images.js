"use strict";

/* ---------- 咒语库: the images surface ----------
   Top: the search box, and what is being filtered as removable chips (each
   chip is exactly one search term, see kb_tokens.js). Left: facets with
   counts -- scope, quick flags, source, model, LoRA, group, sender -- so the
   library can be narrowed by clicking instead of typing. Right: the picture
   wall in grid / waterfall / card mode. */

const KB_WALL_KEY = "knowledge";
const KB_WALL_MODE_KEY = "cc-kb-wall-mode";
const KB_WALL_SIZE_KEY = "cc-kb-wall-size";
const KB_WALL_MODES = ["grid", "masonry", "cards"];
const KB_CARD_HEIGHT = 440;
const KB_CARD_WIDTH = 300;
const KB_TILE_DEFAULT = 190;
const KB_TILE_MIN = 110;
const KB_TILE_MAX = 380;
const KB_FACET_PREVIEW = 8;
const KB_MOBILE_WIDTH = 900;

const KB_FLAG_FACETS = [
  { token: "has:params", key: "params", label: "原图带参数", title: "图片文件里带着生成参数（模型、seed、steps…）" },
  { token: "has:request", key: "request", label: "有人求过", title: "群里有人求过这张图的咒语或原图" },
  { token: "has:answer", key: "answer", label: "作者回了", title: "有人回复了咒语、原图或文件" },
  { token: "has:file", key: "file", label: "有本地原图", title: "电脑上有原图文件" },
];

const GENERATOR_TONES = { comfyui: "comfyui", nai: "nai", webui: "webui", forge: "webui", reforge: "webui", stripped: "asked" };

// The old density setting (detail / compact) maps onto the new modes once.
const kbWallMode = () => {
  const stored = wallReadPref(KB_WALL_MODE_KEY, "");
  if (KB_WALL_MODES.includes(stored)) {
    return stored;
  }
  return wallReadPref("cc-knowledge-density", "detail") === "compact" ? "grid" : "cards";
};

const kbWallSize = () => {
  const size = Number(wallReadPref(KB_WALL_SIZE_KEY, KB_TILE_DEFAULT));
  return Number.isFinite(size) ? Math.min(KB_TILE_MAX, Math.max(KB_TILE_MIN, size)) : KB_TILE_DEFAULT;
};

const facetGeneratorLabel = (generator) => window.KbTokens.KB_GENERATOR_LABELS[generator] ?? generatorLabel(generator);

// "v\mix\noob chibiVpred.safetensors" -> "noob chibiVpred": the folder and
// extension are noise in a narrow sidebar; the full name stays in the tooltip.
const shortModelName = (name) =>
  String(name ?? "").split(/[\\/]/u).pop().replace(/\.(safetensors|ckpt|pt|pth|bin|gguf)$/iu, "");

/* ---------- loading ---------- */

const knowledgeFacetKey = () => new URLSearchParams({
  q: app.knowledgeTab.query,
  scope: app.knowledgeTab.libraryScope,
  generator: app.knowledgeTab.generator,
  groupId: app.knowledgeTab.groupId,
  sender: app.knowledgeTab.sender,
}).toString();

const loadKnowledgeFacets = async () => {
  const key = knowledgeFacetKey();
  if (app.knowledgeTab.facetsKey === key && app.knowledgeTab.facets !== null) {
    return;
  }
  replaceKnowledgeTab({ facetsKey: key });
  try {
    const facets = await api(`/api/knowledge/facets?${key}`);
    if (app.knowledgeTab.facetsKey !== key) {
      return;
    }
    replaceKnowledgeTab({ facets });
  } catch {
    // The sidebar is an aid; the results work without it.
    replaceKnowledgeTab({ facets: { available: false } });
  }
  renderKnowledgeFacets();
};

// Every filter change goes through here, so the results, the counts and the
// chips always describe the same filter.
const applyKnowledgeFilter = (patch) => {
  replaceKnowledgeTab({ ...patch, detail: null });
  renderKnowledgeDetailLayer();
  loadKnowledgeResults();
};

const toggleKnowledgeToken = (token) =>
  applyKnowledgeFilter({ query: window.KbTokens.toggleToken(app.knowledgeTab.query, token) });

const loadMoreKnowledge = () => {
  const tab = app.knowledgeTab;
  if (tab.loading || tab.loadingMore || tab.results === null || tab.results.items.length >= tab.results.total) {
    return;
  }
  loadKnowledgeResults({ append: true });
};

/* ---------- search bar + condition chips ---------- */

const knowledgeGroupLabel = (groupId) =>
  app.knowledgeTab.facets?.groups?.find((row) => row.value === groupId)?.label
  || app.knowledgeTab.overview?.groups?.find((row) => row.groupId === groupId)?.groupName
  || groupId;

const knowledgeChips = () => {
  const tab = app.knowledgeTab;
  const { tokenizeQuery, tokenLabel, removeToken } = window.KbTokens;
  return [
    ...tokenizeQuery(tab.query).map((token) => ({
      ...tokenLabel(token),
      remove: () => applyKnowledgeFilter({ query: removeToken(tab.query, token) }),
    })),
    tab.generator === "" ? null : { text: `来源：${facetGeneratorLabel(tab.generator)}`, tone: "include", remove: () => applyKnowledgeFilter({ generator: "" }) },
    tab.groupId === "" ? null : { text: `群：${knowledgeGroupLabel(tab.groupId)}`, tone: "include", remove: () => applyKnowledgeFilter({ groupId: "" }) },
    tab.sender === "" ? null : { text: `发图人：${tab.sender}`, tone: "include", remove: () => applyKnowledgeFilter({ sender: "" }) },
  ].filter((chip) => chip !== null);
};

const knowledgeConditions = () => {
  const chips = knowledgeChips();
  const warnings = app.knowledgeTab.results?.parsed?.warnings ?? [];
  if (chips.length === 0 && warnings.length === 0) {
    return null;
  }
  return el("div", { class: "kb-conditions", "data-testid": "kb-conditions" },
    el("span", { class: "kb-conditions-label" }, "条件"),
    chips.map((chip) => el("span", { class: `kb-cond ${chip.tone}` },
      chip.text,
      el("button", { class: "kb-cond-x", type: "button", title: "去掉这个条件", "aria-label": `去掉 ${chip.text}`, onclick: chip.remove }, "×"))),
    warnings.map((warning) => el("span", { class: "kb-cond warn", title: warning.reason }, `⚠ ${warning.raw}：${warning.reason}`)),
    chips.length > 1
      ? el("button", {
        class: "kb-linkish kb-cond-clear",
        type: "button",
        onclick: () => applyKnowledgeFilter({ query: "", generator: "", groupId: "", sender: "" }),
      }, "清除全部")
      : null);
};

const knowledgeSearchBar = () => {
  const input = el("input", {
    type: "search",
    class: "kb-search",
    placeholder: "搜咒语、模型、LoRA，或用 tag: model: lora: sender: steps>=30 …",
    value: app.knowledgeTab.query,
    "aria-label": "搜索咒语库",
    "data-testid": "kb-search",
  });
  const submit = () => applyKnowledgeFilter({ query: input.value.trim() });
  // Search on Enter rather than per keystroke: each query hits FTS plus counts.
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      submit();
    }
  });
  return el("div", { class: "kb-searchbar" },
    input,
    el("button", { class: "btn", type: "button", onclick: submit }, "搜索"),
    el("button", {
      class: app.knowledgeTab.showHelp ? "btn small active" : "btn small",
      type: "button",
      title: "搜索语法",
      onclick: () => {
        replaceKnowledgeTab({ showHelp: !app.knowledgeTab.showHelp });
        renderKnowledgeView();
      },
    }, "语法"),
    el("button", {
      class: app.knowledgeTab.showExport ? "btn small active" : "btn small",
      type: "button",
      title: "导出当前筛选结果",
      onclick: () => {
        const showExport = !app.knowledgeTab.showExport;
        replaceKnowledgeTab({ showExport });
        if (showExport) {
          loadExportPreview();
        } else {
          renderKnowledgeView();
        }
      },
    }, "导出"));
};

/* ---------- facet sidebar ---------- */

const facetRow = ({ label, count, active, onClick, title = label }) =>
  el("button", {
    class: active ? "kb-facet-row active" : "kb-facet-row",
    type: "button",
    title,
    "aria-pressed": String(active),
    onclick: onClick,
  },
  el("span", { class: "kb-facet-label" }, label),
  count === null ? null : el("span", { class: "kb-facet-count" }, briefNumber(count)));

const toggleFacetExpanded = (id) => {
  const expanded = new Set(app.knowledgeTab.expandedFacets);
  if (expanded.has(id)) {
    expanded.delete(id);
  } else {
    expanded.add(id);
  }
  replaceKnowledgeTab({ expandedFacets: expanded });
  renderKnowledgeFacets();
};

const FACET_FILTER_MIN = 20;

// A sidebar section shared by 咒语库 and 画廊: the first few rows, "显示全部"
// for the complete list, and a filter box once that list is long. Filtering
// hides rows in place, so typing never loses focus to a re-render.
const facetBlock = ({ id, title, rows, expanded, onToggle, hint = "" }) => {
  if (rows.length === 0) {
    return null;
  }
  const list = el("div", { class: expanded && rows.length > FACET_FILTER_MIN ? "kb-facet-list long" : "kb-facet-list" },
    expanded ? rows : rows.slice(0, KB_FACET_PREVIEW));
  const filter = expanded && rows.length > FACET_FILTER_MIN
    ? el("input", {
      type: "search",
      class: "kb-facet-filter",
      placeholder: `在 ${briefNumber(rows.length)} 项里找…`,
      "aria-label": `筛选${title}`,
      oninput: (event) => {
        const needle = event.target.value.trim().toLowerCase();
        for (const row of list.children) {
          row.hidden = needle !== "" && !row.textContent.toLowerCase().includes(needle);
        }
      },
    })
    : null;
  return el("section", { class: "kb-facet", id: `kb-facet-${id}` },
    el("h3", { title: hint }, title),
    filter,
    list,
    rows.length > KB_FACET_PREVIEW
      ? el("button", { class: "kb-facet-more", type: "button", onclick: onToggle },
        expanded ? "收起" : `显示全部 ${briefNumber(rows.length)} 项`)
      : null);
};

const facetSection = (id, title, rows, hint = "") => facetBlock({
  id,
  title,
  rows,
  hint,
  expanded: app.knowledgeTab.expandedFacets.has(id),
  onToggle: () => toggleFacetExpanded(id),
});

const tokenFacetRows = (rows, field) => {
  const { tokenizeQuery, quoteValue } = window.KbTokens;
  const tokens = tokenizeQuery(app.knowledgeTab.query);
  return rows.map((row) => {
    const token = `${field}:${quoteValue(row.value)}`;
    return facetRow({
      label: shortModelName(row.value),
      title: row.value,
      count: row.count,
      active: tokens.includes(token),
      onClick: () => toggleKnowledgeToken(token),
    });
  });
};

const selectFacetRows = (rows, key, labelOf) => rows.map((row) => facetRow({
  label: labelOf(row),
  count: row.count,
  active: app.knowledgeTab[key] === row.value,
  onClick: () => applyKnowledgeFilter({ [key]: app.knowledgeTab[key] === row.value ? "" : row.value }),
}));

const knowledgeFacetSections = () => {
  const facets = app.knowledgeTab.facets;
  if (facets === null) {
    return [el("p", { class: "kb-meta" }, "正在统计…")];
  }
  if (facets.available === false) {
    return [el("p", { class: "kb-meta" }, "暂时没有统计。")];
  }
  const tokens = window.KbTokens.tokenizeQuery(app.knowledgeTab.query);
  return [
    facetSection("scope", "范围", LIBRARY_SCOPES.map((scope) => facetRow({
      label: scope.label,
      count: facets.scopes?.[scope.value] ?? null,
      active: app.knowledgeTab.libraryScope === scope.value,
      onClick: () => {
        wallWritePref(SCOPE_KEY, scope.value);
        applyKnowledgeFilter({ libraryScope: scope.value });
      },
    }))),
    facetSection("flags", "快速筛选", KB_FLAG_FACETS.map((flag) => facetRow({
      label: flag.label,
      title: flag.title,
      count: facets.flags?.[flag.key] ?? null,
      active: tokens.includes(flag.token),
      onClick: () => toggleKnowledgeToken(flag.token),
    }))),
    facetSection("generator", "来源", selectFacetRows(facets.generators ?? [], "generator", (row) => facetGeneratorLabel(row.value))),
    facetSection("model", "模型", tokenFacetRows(facets.checkpoints ?? [], "model"), "当前结果里最常用"),
    facetSection("lora", "LoRA", tokenFacetRows(facets.loras ?? [], "lora"), "当前结果里最常用"),
    facetSection("group", "群", selectFacetRows(facets.groups ?? [], "groupId", (row) => row.label || row.value)),
    facetSection("sender", "发图人", selectFacetRows(facets.senders ?? [], "sender", (row) => row.value)),
  ];
};

// Rendered on its own so counts arriving never rebuild the wall.
const renderKnowledgeFacets = () => {
  const node = document.getElementById("kb-facets-body");
  if (node !== null) {
    setChildren(node, knowledgeFacetSections());
  }
};

const knowledgeFacetPanel = () =>
  el("details", { class: "kb-facets", open: window.innerWidth > KB_MOBILE_WIDTH },
    el("summary", {}, "筛选"),
    el("div", { id: "kb-facets-body", class: "kb-facets-body" }, knowledgeFacetSections()));

/* ---------- tiles and cards ---------- */

const knowledgeThumbSrc = (item) => {
  if (item.hasFile) {
    return knowledgeThumbUrl(item.hash);
  }
  return PICTURE_MD5.test(String(item.hash ?? "")) ? pictureUrl(item.hash, "thumb") : null;
};

// A cache thumbnail QQ has since evicted falls back to Tencent's copy once.
const knowledgeThumbError = (item) => (image) => {
  if (image.dataset.fallback !== "1" && item.hasFile && PICTURE_MD5.test(String(item.hash ?? ""))) {
    image.dataset.fallback = "1";
    image.src = pictureUrl(item.hash, "thumb");
    return;
  }
  image.closest(".wall-tile, .kb-card2-media")?.classList.add("broken");
};

const knowledgeBadges = (item) => {
  const asks = item.promptRequests?.length ?? 0;
  return [
    { text: item.isPlaceholder ? "咒语来自回复" : generatorLabel(item.generator), tone: GENERATOR_TONES[item.generator] ?? "ai" },
    item.loras.length > 0 ? { text: `LoRA ×${item.loras.length}`, title: item.loras.map((lora) => lora.name).join("\n") } : null,
    asks > 0 ? { text: `${asks} 人求`, tone: "asked", title: "群里有人求过这张图" } : null,
  ].filter((badge) => badge !== null);
};

const knowledgeWhere = (item) => {
  const seen = item.sightings[0];
  if (seen === undefined) {
    return formatUnix(item.fileMtime).slice(0, 10);
  }
  return `${seen.speaker} · ${seen.groupName || seen.groupId} · ${formatUnix(seen.sentAt).slice(5, 10)}`;
};

const knowledgeSelectionBox = (item) => {
  const picked = app.knowledgeTab.selected.has(item.hash);
  return el("label", {
    class: picked ? "wall-pick picked" : "wall-pick",
    title: "选中以便只导出这些",
    onclick: (event) => event.stopPropagation(),
  },
  el("input", {
    type: "checkbox",
    checked: picked,
    "aria-label": "选中这张图",
    onchange: (event) => {
      // A Set is mutated in place: rebuilding a 7,000-entry set per click is waste.
      if (event.target.checked) {
        app.knowledgeTab.selected.add(item.hash);
      } else {
        app.knowledgeTab.selected.delete(item.hash);
      }
      event.target.closest(".wall-pick")?.classList.toggle("picked", event.target.checked);
      renderKnowledgeSelectionNote();
    },
  }));
};

const knowledgeMissingTile = (item) =>
  el("div", { class: "wall-tile missing" },
    el("button", { class: "wall-open", type: "button", onclick: () => openDetail(item) }, unavailableImageText(item.fileMissing)));

const knowledgeTile = (item) => {
  const src = knowledgeThumbSrc(item);
  if (src === null) {
    return knowledgeMissingTile(item);
  }
  return wallTile({
    src,
    alt: item.prompt.slice(0, 60) || item.hash,
    onOpen: () => openDetail(item),
    badges: knowledgeBadges(item),
    corner: el("div", { class: "wall-corner" }, knowledgeSelectionBox(item)),
    caption: { title: shortModelName(item.checkpoint) || generatorLabel(item.generator), sub: knowledgeWhere(item) },
    onError: knowledgeThumbError(item),
  });
};

const copyKnowledgePrompt = async (item) => {
  if (!item.promptTruncated) {
    copyToClipboard(item.prompt, "咒语");
    return;
  }
  try {
    const full = await api(`/api/knowledge/image?hash=${encodeURIComponent(item.hash)}`);
    copyToClipboard(full.prompt, "咒语");
  } catch (error) {
    alert(error.message);
  }
};

const knowledgeParamLine = (item) => {
  const params = item.params ?? {};
  return [
    params.steps === undefined ? null : `${params.steps} 步`,
    params.cfgScale === undefined ? null : `CFG ${params.cfgScale}`,
    params.sampler === undefined ? null : String(params.sampler),
    item.width > 0 ? `${item.width}×${item.height}` : null,
  ].filter((part) => part !== null).join(" · ");
};

const addKnowledgeToken = (token) => () =>
  applyKnowledgeFilter({ query: window.KbTokens.addToken(app.knowledgeTab.query, token) });

const knowledgeCard = (item) => {
  const src = knowledgeThumbSrc(item);
  const seen = item.sightings[0];
  const params = knowledgeParamLine(item);
  const { quoteValue } = window.KbTokens;
  return el("article", { class: "kb-card2", "data-testid": "kb-card" },
    el("div", { class: "kb-card2-media" },
      src === null
        ? el("button", { class: "wall-open missing", type: "button", onclick: () => openDetail(item) }, unavailableImageText(item.fileMissing))
        : el("button", { class: "wall-open", type: "button", title: "看大图和完整咒语", onclick: () => openDetail(item) },
          el("img", {
            src,
            alt: item.prompt.slice(0, 60) || item.hash,
            loading: "lazy",
            decoding: "async",
            onerror: (event) => knowledgeThumbError(item)(event.target),
          })),
      el("div", { class: "wall-badges" }, knowledgeBadges(item).map((badge) =>
        el("span", { class: `wall-badge ${badge.tone ?? ""}`, title: badge.title ?? "" }, badge.text))),
      el("div", { class: "wall-corner" }, knowledgeSelectionBox(item))),
    el("div", { class: "kb-card2-body" },
      el("div", { class: "kb-card2-head" },
        item.checkpoint === ""
          ? el("span", { class: "kb-meta" }, generatorLabel(item.generator))
          : el("button", {
            class: "kb-linkish kb-card2-model",
            type: "button",
            title: `只看这个模型：${item.checkpoint}`,
            onclick: addKnowledgeToken(`model:${quoteValue(item.checkpoint)}`),
          }, shortModelName(item.checkpoint)),
        item.prompt === "" ? null : el("button", { class: "btn small", type: "button", onclick: () => copyKnowledgePrompt(item) }, "复制咒语")),
      item.prompt === ""
        ? el("p", { class: "kb-card2-prompt muted" }, item.isPlaceholder ? "咒语来自群里的回复，点图查看。" : "没有咒语")
        : el("p", { class: "kb-card2-prompt", title: "点图看完整咒语" }, item.prompt),
      params === "" ? null : el("p", { class: "kb-card2-params" }, params),
      item.loras.length === 0
        ? null
        : el("div", { class: "kb-card2-loras" },
          item.loras.slice(0, 3).map((lora) => el("button", {
            class: "kb-chip clickable",
            type: "button",
            title: `只看用了这个 LoRA 的图${lora.weight === null ? "" : `（权重 ${lora.weight}）`}`,
            onclick: addKnowledgeToken(`lora:${quoteValue(lora.name)}`),
          }, shortModelName(lora.name))),
          item.loras.length > 3 ? el("span", { class: "kb-chip" }, `+${item.loras.length - 3}`) : null),
      el("p", { class: "kb-card2-meta" },
        seen === undefined
          ? REASON_TEXT[item.attributionReason] ?? "没有群消息记录"
          : [
            el("button", {
              class: "kb-linkish",
              type: "button",
              title: "只看这个人发的图",
              onclick: () => applyKnowledgeFilter({ sender: seen.speaker }),
            }, seen.speaker),
            ` · ${seen.groupName || seen.groupId} · ${formatUnix(seen.sentAt).slice(5, 16)}`,
          ])));
};

/* ---------- results ---------- */

const knowledgeWallEntries = () => (app.knowledgeTab.results?.items ?? []).map((item) => ({
  kind: "tile",
  ratio: item.width > 0 && item.height > 0 ? item.height / item.width : 1,
  item,
}));

const knowledgeCountText = () => {
  const tab = app.knowledgeTab;
  if (tab.loading && !tab.loadingMore) {
    return "正在筛选…";
  }
  return tab.results === null ? "" : `共 ${briefNumber(tab.results.total)} 张`;
};

const knowledgeFootText = () => {
  const results = app.knowledgeTab.results;
  if (results === null || results.items.length === 0) {
    return "";
  }
  if (app.knowledgeTab.loadingMore) {
    return "正在加载更多…";
  }
  return results.items.length < results.total ? `继续下滑加载（还有 ${briefNumber(results.total - results.items.length)} 张）` : "已经到底了";
};

const renderKnowledgeSelectionNote = () => {
  const node = document.getElementById("kb-selected");
  if (node !== null) {
    const count = app.knowledgeTab.selected.size;
    node.textContent = count === 0 ? "" : `已选 ${count} 张（可在「导出」里只导出这些）`;
  }
};

// After a page is appended the wall updates in place; only the texts change.
const updateKnowledgeResultTexts = () => {
  const count = document.getElementById("kb-count");
  if (count !== null) {
    count.textContent = knowledgeCountText();
  }
  const foot = document.getElementById("kb-foot");
  if (foot !== null) {
    foot.textContent = knowledgeFootText();
  }
};

const knowledgeResultsHead = () => {
  const mode = kbWallMode();
  return el("div", { class: "kb-results-head" },
    el("strong", { id: "kb-count", class: "kb-count" }, knowledgeCountText()),
    el("span", { id: "kb-selected", class: "kb-meta" }),
    el("span", { class: "kb-results-spacer" }),
    el("label", { class: "kb-sort" }, "排序",
      el("select", {
        class: "kb-select",
        onchange: (event) => applyKnowledgeFilter({ sort: event.target.value }),
      }, Object.entries(SORT_LABELS).map(([value, label]) =>
        el("option", { value, selected: value === app.knowledgeTab.sort }, label)))),
    wallControls({
      mode,
      modes: KB_WALL_MODES,
      size: kbWallSize(),
      min: KB_TILE_MIN,
      max: KB_TILE_MAX,
      onMode: (value) => {
        wallWritePref(KB_WALL_MODE_KEY, value);
        renderKnowledgeView();
      },
      onSize: (value) => {
        wallWritePref(KB_WALL_SIZE_KEY, value);
        renderKnowledgeView();
      },
    }));
};

const knowledgeWall = () => {
  const tab = app.knowledgeTab;
  const results = tab.results;
  if (results === null) {
    return el("div", { class: "wall-empty" }, tab.loading ? "读取中…" : "");
  }
  if (results.available === false) {
    return el("div", { class: "wall-empty" }, "还没有咒语库。后台整理图片时会从 QQ 图片缓存里读出 AI 生成参数并建库。");
  }
  if (results.items.length === 0) {
    return el("div", { class: "wall-empty" }, "没有符合条件的图片。可以在左边换个范围，或去掉上面的条件。");
  }
  const mode = kbWallMode();
  return imageWall({
    key: KB_WALL_KEY,
    entries: knowledgeWallEntries(),
    mode,
    targetSize: mode === "cards" ? KB_CARD_WIDTH : kbWallSize(),
    gap: mode === "cards" ? 14 : 8,
    cardHeight: KB_CARD_HEIGHT,
    renderEntry: (entry) => (mode === "cards" ? knowledgeCard(entry.item) : knowledgeTile(entry.item)),
    onNearEnd: loadMoreKnowledge,
  });
};

const renderKnowledgeImages = () => {
  const tab = app.knowledgeTab;
  queueMicrotask(renderKnowledgeSelectionNote);
  return el("div", { class: "kb-layout" },
    knowledgeFacetPanel(),
    el("div", { class: tab.loading && !tab.loadingMore ? "kb-results is-loading" : "kb-results" },
      knowledgeResultsHead(),
      knowledgeWall(),
      el("div", { id: "kb-foot", class: "wall-foot" }, knowledgeFootText())));
};
