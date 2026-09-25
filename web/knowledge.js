"use strict";

/* ---------- knowledge base (prompt / model / lora library) ---------- */

const KNOWLEDGE_SURFACES = new Set(["images", "requests", "coverage"]);
const KNOWLEDGE_PAGE_SIZE = 60;
const PROMPT_CLAMP_CHARS = 320;
const LAST_VISIT_KEY = "cc-knowledge-last-visit";

const GENERATOR_LABELS = {
  webui: "A1111",
  forge: "Forge",
  reforge: "reForge",
  comfyui: "ComfyUI",
  nai: "NovelAI",
  stripped: "未检测到生成参数",
  unknown: "未知",
};

// Only "high" and "medium" targets are stated as fact; below that the UI says so.
const CONFIDENCE_LABELS = {
  high: { text: "引用确认", tone: "ok" },
  medium: { text: "作者相符", tone: "ok" },
  low: { text: "推测，可能不准", tone: "warn" },
  none: { text: "未能定位图片", tone: "muted" },
};

const INTENT_LABELS = { prompt: "要咒语", original: "要原图" };

// Each reason is phrased as "what happened + what you can do", because the
// unhelpful version of this message ("可能是你自己生成或私聊收到的") made a
// coverage gap look like an unknowable property of the image.
const REASON_TEXT = {
  attributed: null,
  evicted: "QQ 缓存中的原图现在已不存在，参数还留着",
  unavailable: "电脑上没有原图：电脑 QQ 只在你点开大图时才下载原图",
  "outside-coverage": "这张图的时间不在已总结的范围内 —— 补跑那段时间就能对上发图人",
  "not-in-messages": "那段时间已扫过部分群，消息里没出现这张图（可能是还没扫的群、私聊、收藏，或你自己生成）",
};

const replaceKnowledgeTab = (patch) => {
  app.knowledgeTab = { ...app.knowledgeTab, ...patch };
};

// Cards request QQ's reduced copy; the detail view asks for the original. Serving
// originals to the grid cost ~14 MB of decoded bitmap per card.
const knowledgeFileUrl = (hash) => `/knowledge-file?hash=${encodeURIComponent(hash)}`;
const knowledgeThumbUrl = (hash) => `/knowledge-file?hash=${encodeURIComponent(hash)}&thumb=1`;

const SORT_LABELS = {
  recent: "最近的在前",
  oldest: "最早的在前",
  asked: "被求咒语最多",
  loras: "LoRA 最多",
  largest: "文件最大",
  promptLength: "咒语最长",
};

// Documented syntax, kept in sync with the parser by a test.
const SYNTAX_HELP = [
  ["1girl solo", "自由文字（咒语 / 模型 / LoRA）"],
  ["tag:1girl", "必须含这个标签"],
  ["-tag:nsfw", "排除这个标签"],
  ['prompt:"long hair"', "含空格的值加引号"],
  ["model:anima", "指定模型（可只写一部分）"],
  ["lora:darklight", "指定 LoRA"],
  ["sender:Caesar", "只看某人发的图"],
  ["generator:nai", "webui / forge / comfyui / nai"],
  ["steps>=30", "数字比较：steps / cfg / width / height"],
  ["steps:20..40", "数字范围"],
  ["aspect:portrait", "square / landscape / portrait"],
  ["date:2026-07-01..2026-07-31", "按图片时间"],
  ["has:answer", "已有文字或媒体回复"],
  ["has:prompt", "图上有咒语"],
  ["has:sender", "对得上发图人"],
  ["no:file", "本地没有可用原图"],
];

// Times must match the rest of the app, which renders everything in fixed
// Asia/Hong_Kong regardless of the machine's zone (see unixToHkt in app.js).
// Using browser-local time here would disagree with the reports and media pages.
const formatUnix = (unixSeconds) => {
  if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) {
    return "";
  }
  return unixToHkt(unixSeconds).slice(0, 16);
};

const generatorLabel = (generator) => GENERATOR_LABELS[generator] ?? generator;

/* ---------- data loading ---------- */

const loadKnowledgeOverview = async () => {
  try {
    replaceKnowledgeTab({ overview: await api("/api/knowledge/overview") });
  } catch (error) {
    // Recorded AND rendered by the caller: a silent failure here used to leave
    // the whole page blank with no explanation.
    replaceKnowledgeTab({ error: `读取咒语库信息失败：${error.message}` });
  }
};

// requestId guards against an earlier, slower search overwriting a later one.
// `append` adds a page instead of replacing, which is how the library beyond the
// first 60 images is reachable at all. A new search keeps the old results on
// screen (dimmed) until the new ones arrive, instead of blanking the page.
const loadKnowledgeResults = async ({ append = false } = {}) => {
  const requestId = app.knowledgeTab.requestId + 1;
  const offset = append ? (app.knowledgeTab.results?.items.length ?? 0) : 0;
  replaceKnowledgeTab({
    requestId,
    loading: true,
    loadingMore: append,
    error: null,
  });
  if (append) {
    updateKnowledgeResultTexts();
  } else {
    renderKnowledgeView();
    loadKnowledgeFacets();
  }

  const params = new URLSearchParams({
    q: knowledgeSearchQuery(),
    generator: app.knowledgeTab.generator,
    groupId: app.knowledgeTab.groupId,
    sender: app.knowledgeTab.sender,
    sort: app.knowledgeTab.sort,
    limit: String(KNOWLEDGE_PAGE_SIZE),
    offset: String(offset),
  });
  try {
    const page = await api(`/api/knowledge/search?${params.toString()}`);
    if (app.knowledgeTab.requestId !== requestId) {
      return;
    }
    const previous = append ? (app.knowledgeTab.results?.items ?? []) : [];
    // Dedupe on append: a harvest running concurrently can shift the window and
    // re-serve a row, which would otherwise render twice.
    const seen = new Set(previous.map((item) => item.hash));
    const merged = [...previous, ...page.items.filter((item) => !seen.has(item.hash))];
    replaceKnowledgeTab({
      results: { ...page, items: merged },
      loading: false,
      loadingMore: false,
    });
    if (append && app.view === "knowledge" && wallSetEntries(KB_WALL_KEY, knowledgeWallEntries())) {
      updateKnowledgeResultTexts();
      return;
    }
  } catch (error) {
    if (app.knowledgeTab.requestId !== requestId) {
      return;
    }
    replaceKnowledgeTab({ loading: false, loadingMore: false, error: error.message });
  }
  if (!append) {
    // A new result set starts at its top, not wherever the old one was scrolled.
    window.scrollTo({ top: 0 });
  }
  renderKnowledgeView();
};

const loadKnowledgeRequests = async () => {
  replaceKnowledgeTab({ loading: true, error: null });
  try {
    const requests = await api("/api/knowledge/requests?limit=200");
    replaceKnowledgeTab({ requests, loading: false });
  } catch (error) {
    replaceKnowledgeTab({ loading: false, error: error.message });
  }
  renderKnowledgeView();
};

// The watermark is stored only when the page is actually opened, so "new" means
// "since you last looked at this page" rather than "since the app started".
const readLastVisit = () => {
  const stored = Number.parseInt(localStorage.getItem(LAST_VISIT_KEY) ?? "0", 10);
  return Number.isFinite(stored) && stored > 0 ? stored : 0;
};

const loadKnowledgeCoverage = async () => {
  replaceKnowledgeTab({ loading: true, error: null });
  try {
    const coverage = await api(`/api/knowledge/coverage?since=${readLastVisit()}`);
    replaceKnowledgeTab({ coverage, loading: false });
    if (coverage.watermark > 0) {
      localStorage.setItem(LAST_VISIT_KEY, String(coverage.watermark));
    }
  } catch (error) {
    replaceKnowledgeTab({ loading: false, error: error.message });
  }
  renderKnowledgeView();
};

const ensureKnowledgeLoaded = async () => {
  // Paint FIRST, then fetch. Awaiting before the first render left the page
  // completely blank while loading, and permanently blank if a request failed --
  // there was no frame in which the error could be shown.
  renderKnowledgeView();

  // The overview (numbers at the top) is the slowest request and the server
  // answers one at a time, so it goes after the surface's own data and only
  // its own strip is redrawn when it arrives.
  if (app.knowledgeTab.surface === "images" && app.knowledgeTab.results === null) {
    await loadKnowledgeResults();
  } else if (app.knowledgeTab.surface === "requests" && app.knowledgeTab.requests === null) {
    await loadKnowledgeRequests();
  } else if (app.knowledgeTab.surface === "coverage" && app.knowledgeTab.coverage === null) {
    await loadKnowledgeCoverage();
  } else {
    renderKnowledgeView();
  }
  if (app.knowledgeTab.overview === null) {
    loadKnowledgeOverview().then(() => (app.knowledgeTab.error === null ? renderKnowledgeHeader() : renderKnowledgeView()));
  }
};

/* ---------- shared bits ---------- */

const copyToClipboard = async (text, label) => {
  try {
    await navigator.clipboard.writeText(text);
    alert(`${label}已复制`);
  } catch {
    alert("复制失败，请手动选取文本。");
  }
};

const promptBlock = (text, label, { truncated = false, clamp = true } = {}) => {
  if (typeof text !== "string" || text.trim().length === 0) {
    return null;
  }
  // Cards clamp so a 60-card grid stays scannable. The overlay passes
  // clamp:false: the card already said "点图看完整", so slicing again would
  // show the same 320 characters the user just left.
  const shouldClamp = clamp && (truncated || text.length > PROMPT_CLAMP_CHARS);
  const shown = shouldClamp && text.length > PROMPT_CLAMP_CHARS
    ? `${text.slice(0, PROMPT_CLAMP_CHARS)}…`
    : text;
  return el("div", { class: "kb-prompt" },
    el("div", { class: "kb-prompt-head" },
      el("span", { class: "kb-prompt-label" }, label),
      // A clamped card cannot offer a correct copy, so it says where to get one
      // rather than silently copying a partial prompt.
      truncated
        ? el("span", { class: "kb-meta" }, "点图看完整")
        : el("button", {
          class: "btn small",
          onclick: () => copyToClipboard(text, label),
        }, "复制")),
    el("p", { class: shouldClamp ? "kb-prompt-text clamped" : "kb-prompt-text" }, shown));
};

const confidenceBadge = (confidence) => {
  const meta = CONFIDENCE_LABELS[confidence] ?? CONFIDENCE_LABELS.none;
  return el("span", { class: `kb-badge ${meta.tone}` }, meta.text);
};

const unavailableImageText = (fileMissing) => fileMissing
  ? "缓存原图已不存在"
  : "本地没有原图副本";

const requestIsAnswered = (row) => row.answerKind === "text" || row.answerKind === "media";

const requestAnswer = (row) => {
  if (row.answerKind === "text") {
    return promptBlock(row.answerText, `${row.answerBy} 的咒语回复`);
  }
  if (row.answerKind !== "media") {
    return null;
  }
  const media = row.answerMedia ?? [];
  return el("div", { class: "kb-answer" },
    el("span", { class: "kb-prompt-label" }, `${row.answerBy} 回复了 ${media.length} 个图片或文件`),
    el("div", { class: "kb-answer-media" }, media.map((item) => {
      const label = item.fileName || item.hash || (item.kind === "image" ? "图片" : "文件");
      if (item.kind === "image" && item.hash !== null && item.hasFile) {
        return el("a", {
          class: "kb-answer-image",
          href: knowledgeFileUrl(item.hash),
          target: "_blank",
          rel: "noreferrer",
          title: label,
        }, el("img", { src: knowledgeThumbUrl(item.hash), alt: label, loading: "lazy", decoding: "async" }));
      }
      if (item.kind === "image" && PICTURE_MD5.test(String(item.hash ?? ""))) {
        return el("a", {
          class: "kb-answer-image",
          href: pictureUrl(item.hash, "preview"),
          target: "_blank",
          rel: "noreferrer",
          title: label,
        }, el("img", { src: pictureUrl(item.hash, "thumb"), alt: label, loading: "lazy", decoding: "async" }));
      }
      return el("div", { class: "kb-answer-file", title: label },
        el("span", {}, item.kind === "image" ? "图片" : "文件"),
        el("strong", {}, label),
        item.kind === "image" ? el("small", {}, "本地没有可预览副本") : null);
    })));
};

// List responses carry a clamped prompt to keep large result sets small, so the
// detail view fetches the full record. The clamped copy is shown immediately so
// the panel never appears empty while the request is in flight.
const openDetail = async (item) => {
  replaceKnowledgeTab({ detail: item, detailLoading: true });
  renderKnowledgeDetailLayer();
  try {
    const full = await api(`/api/knowledge/image?hash=${encodeURIComponent(item.hash)}`);
    // Ignore a late response for an image the user has already navigated away from.
    if (app.knowledgeTab.detail?.hash !== item.hash) {
      return;
    }
    replaceKnowledgeTab({ detail: full, detailLoading: false });
  } catch {
    // The clamped version is still useful; just stop showing a spinner.
    replaceKnowledgeTab({ detailLoading: false });
  }
  renderKnowledgeDetailLayer();
  loadKnowledgeRelated(item.hash);
};

/* ---------- images surface ---------- */

const syntaxHelpPanel = () => {
  if (!app.knowledgeTab.showHelp) {
    return null;
  }
  return el("div", { class: "kb-help" },
    SYNTAX_HELP.map(([syntax, meaning]) =>
      el("div", { class: "kb-help-row" },
        el("code", {
          class: "kb-help-syntax",
          title: "点击填入搜索框",
          onclick: () => {
            replaceKnowledgeTab({ query: syntax });
            loadKnowledgeResults();
          },
        }, syntax),
        el("span", { class: "kb-meta" }, meaning))));
};

// The request body shared by preview and export, so the estimate can never
// describe a different set from what actually gets written.
const exportRequestBody = () => {
  const selectedOnly = app.knowledgeTab.exportScope === "selected";
  return {
    query: knowledgeSearchQuery(),
    generator: app.knowledgeTab.generator,
    groupId: app.knowledgeTab.groupId,
    sender: app.knowledgeTab.sender,
    sort: app.knowledgeTab.sort,
    mode: app.knowledgeTab.exportMode,
    hashes: selectedOnly ? [...app.knowledgeTab.selected] : null,
    label: app.knowledgeTab.exportLabel.trim(),
    includeImages: app.knowledgeTab.exportImages,
    includeSidecars: app.knowledgeTab.exportSidecars,
    includeIndex: app.knowledgeTab.exportIndex,
    verifyHash: app.knowledgeTab.exportVerify,
  };
};

const loadExportPreview = async () => {
  const body = exportRequestBody();
  const params = new URLSearchParams({
    q: body.query,
    generator: body.generator,
    groupId: body.groupId,
    sender: body.sender,
    sort: body.sort,
    mode: body.mode,
  });
  if (body.hashes !== null) {
    params.set("hashes", body.hashes.join(","));
  }
  try {
    replaceKnowledgeTab({ exportPreview: await api(`/api/knowledge/export-preview?${params.toString()}`) });
  } catch (error) {
    replaceKnowledgeTab({ error: error.message });
  }
  renderKnowledgeView();
};

const runExport = async () => {
  replaceKnowledgeTab({ exporting: true, exportResult: null });
  renderKnowledgeView();
  try {
    const result = await api("/api/knowledge/export", {
      method: "POST",
      body: JSON.stringify(exportRequestBody()),
    });
    replaceKnowledgeTab({ exporting: false, exportResult: result, exportPreview: null });
  } catch (error) {
    replaceKnowledgeTab({ exporting: false, error: error.message });
  }
  renderKnowledgeView();
};

const exportPanel = () => {
  if (!app.knowledgeTab.showExport) {
    return null;
  }
  const preview = app.knowledgeTab.exportPreview;
  const result = app.knowledgeTab.exportResult;
  const selectedCount = app.knowledgeTab.selected.size;
  const scope = app.knowledgeTab.exportScope;

  const scopeRadio = (value, label, hint) =>
    el("label", { class: "kb-inline-label", title: hint },
      el("input", {
        type: "radio",
        name: "kb-export-scope",
        checked: scope === value,
        disabled: value === "selected" && selectedCount === 0,
        onchange: () => {
          replaceKnowledgeTab({ exportScope: value, exportPreview: null });
          loadExportPreview();
        },
      }),
      label);

  const checkbox = (key, label, hint) =>
    el("label", { class: "kb-inline-label", title: hint ?? "" },
      el("input", {
        type: "checkbox",
        checked: app.knowledgeTab[key],
        onchange: (event) => {
          replaceKnowledgeTab({ [key]: event.target.checked });
          renderKnowledgeView();
        },
      }),
      label);

  return el("div", { class: "kb-export" },
    el("div", { class: "kb-export-section" },
      el("span", { class: "kb-prompt-label" }, "导出范围"),
      el("div", { class: "kb-control-row" },
        scopeRadio("filtered", "当前筛选的全部", "包括还没滚动到的那些"),
        scopeRadio("selected", selectedCount > 0 ? `已勾选的 ${selectedCount} 张` : "已勾选的（先勾选图片）", "在图片右上角勾选"))),

    el("div", { class: "kb-export-section" },
      el("span", { class: "kb-prompt-label" }, "已导出过的图片"),
      el("div", { class: "kb-control-row" },
        el("label", { class: "kb-inline-label" },
          el("input", {
            type: "radio",
            name: "kb-export-mode",
            checked: app.knowledgeTab.exportMode === "new",
            onchange: () => {
              replaceKnowledgeTab({ exportMode: "new", exportPreview: null });
              loadExportPreview();
            },
          }),
          "跳过"),
        el("label", { class: "kb-inline-label" },
          el("input", {
            type: "radio",
            name: "kb-export-mode",
            checked: app.knowledgeTab.exportMode === "all",
            onchange: () => {
              replaceKnowledgeTab({ exportMode: "all", exportPreview: null });
              loadExportPreview();
            },
          }),
          "也重新导出"))),

    el("div", { class: "kb-export-section" },
      el("span", { class: "kb-prompt-label" }, "导出内容"),
      el("div", { class: "kb-control-row" },
        checkbox("exportImages", "图片文件"),
        checkbox("exportSidecars", "同名 .txt 咒语", "kohya / sd-scripts 等训练工具通用"),
        checkbox("exportIndex", "index.jsonl + index.csv"),
        checkbox("exportVerify", "校验图片内容", "比对 md5，防止缓存槽被复用导致图文不符；会慢一些"))),

    el("div", { class: "kb-export-section" },
      el("span", { class: "kb-prompt-label" }, "文件夹名（可留空）"),
      el("div", { class: "kb-control-row" },
        el("input", {
          type: "text",
          class: "kb-search",
          placeholder: "例如 anima-portrait",
          value: app.knowledgeTab.exportLabel,
          oninput: (event) => replaceKnowledgeTab({ exportLabel: event.target.value }),
        })),
      el("p", { class: "kb-meta" },
        "会导出到 ",
        el("code", { class: "kb-help-syntax" }, "reports\\prompt-export-<名字>-<时间>\\"),
        " —— 导出完成后会显示完整路径。")),

    preview === null || preview === undefined
      ? null
      : el("p", { class: "kb-meta" },
        `本次范围 ${preview.matched} 张：会导出 ${preview.fresh} 张`,
        preview.already > 0 ? `，跳过 ${preview.already} 张（之前导过）` : "",
        `。累计已导出 ${preview.ledgerSize} 张。`),

    el("div", { class: "kb-control-row" },
      el("button", {
        class: "btn primary",
        disabled: app.knowledgeTab.exporting || (scope === "selected" && selectedCount === 0),
        onclick: runExport,
      }, app.knowledgeTab.exporting ? "导出中…" : "开始导出"),
      el("button", { class: "btn small", onclick: loadExportPreview }, "重新估算"),
      el("button", {
        class: "btn small",
        title: "清空导出记录后，所有图片会被视为没导过",
        onclick: async () => {
          if (!confirm("清空导出记录？之后所有图片都会被当成没导过。")) {
            return;
          }
          try {
            await api("/api/knowledge/forget-exports", { method: "POST", body: JSON.stringify({}) });
            replaceKnowledgeTab({ exportPreview: null, exportResult: null });
            loadExportPreview();
          } catch (error) {
            replaceKnowledgeTab({ error: error.message });
            renderKnowledgeView();
          }
        },
      }, "清空导出记录")),

    result === null || result === undefined
      ? null
      : el("div", { class: "kb-export-result" },
        el("p", { class: "kb-meta" },
          `导出完成：${result.exported} 张`,
          result.skipped > 0 ? `，跳过 ${result.skipped} 张（之前导过）` : "",
          result.missingFile > 0 ? `，${result.missingFile} 张没有可导出的本地原图` : "",
          result.failed > 0 ? `，${result.failed} 张失败` : "",
          "。"),
        // The real path, and an honest statement about whether it opened.
        el("p", { class: "kb-meta" },
          el("strong", {}, "位置："),
          el("code", { class: "kb-help-syntax", title: "点击复制", onclick: () => copyToClipboard(result.outputDir, "路径") }, result.outputDir)),
        result.folderOpened
          ? el("p", { class: "kb-meta" }, "已在文件资源管理器中打开。")
          : el("p", { class: "kb-meta" },
            result.openError === null || result.openError === undefined
              ? "（没有自动打开文件夹，可复制上面的路径。）"
              : `没能自动打开文件夹：${result.openError}`),
        result.notes.length === 0
          ? null
          : el("details", {},
            el("summary", { class: "kb-meta" }, `${result.notes.length} 条说明`),
            el("ul", { class: "kb-sightings" }, result.notes.map((note) => el("li", {}, note))))));
};

const LIBRARY_SCOPES = [
  { value: "prompt", label: "有咒语", query: "has:prompt" },
  { value: "sender", label: "群里发过", query: "has:sender" },
  { value: "all", label: "全部", query: "" },
];
const SCOPE_KEY = "cc-knowledge-scope";

const knowledgeSearchQuery = () => {
  const scope = LIBRARY_SCOPES.find((item) => item.value === app.knowledgeTab.libraryScope) ?? LIBRARY_SCOPES[0];
  return [scope.query, app.knowledgeTab.query].filter((part) => part !== "").join(" ");
};

// Explains the library's shape up front. Without this the user sees thousands of
// cards saying "no group record" and reasonably concludes the feature is broken,
// when the real cause is simply that summaries cover a narrow time range.
const knowledgeCoverageNote = () => {
  const overview = app.knowledgeTab.overview;
  const reasons = overview?.reasons;
  if (reasons === undefined) {
    return null;
  }
  const outside = reasons["outside-coverage"] ?? 0;
  const notInMessages = reasons["not-in-messages"] ?? 0;
  const unavailable = reasons.unavailable ?? 0;
  const evicted = reasons.evicted ?? 0;
  const total = Object.values(reasons).reduce((sum, count) => sum + count, 0);
  if (total === 0 || outside + notInMessages + unavailable + evicted === 0) {
    return null;
  }

  const coverage = overview.coverage;
  const covered = coverage === null || coverage === undefined
    ? "还没有总结过任何时间范围"
    : `已总结 ${formatUnix(coverage.fromUnix).slice(0, 10)} ~ ${formatUnix(coverage.toUnix).slice(0, 10)}`;

  return el("details", { class: "kb-coverage" },
    el("summary", {},
      `${reasons.attributed ?? 0} / ${total} 张能对上发图人`,
      el("span", { class: "kb-meta" }, `　${covered}`)),
    el("div", { class: "kb-coverage-body" },
      outside === 0 ? null : el("p", { class: "kb-meta" },
        `${outside} 张的时间不在已总结范围内。这些图的参数已经存好了，只是还不知道是谁发的；到「运行」页补跑那段时间就会逐步对上。`),
      notInMessages === 0 ? null : el("p", { class: "kb-meta" },
        `${notInMessages} 张所在时间段已扫过部分群，但那些群的消息里没有这张图。工具还没读私聊／收藏，所以不能断定来源。`),
      unavailable === 0 ? null : el("p", { class: "kb-meta" },
        `${unavailable} 张从未记录到本地原图路径，可能没有下载过原图。`),
      evicted === 0 ? null : el("p", { class: "kb-meta" },
        `${evicted} 张曾有本地原图，但对应缓存文件现在已不存在；参数仍然保留。`),
      el("p", { class: "kb-meta" },
        "提示：AI 参数只在原图里。发图的人要勾选「原图」，否则 QQ 会把图压缩、参数就没了；收到的图要在电脑 QQ 里点开看大图，电脑上才有原图可读。")));
};

// Each number is also a way in: clicking it shows what it counts.
const openFacetSection = (id) => {
  replaceKnowledgeTab({ surface: "images", expandedFacets: new Set([...app.knowledgeTab.expandedFacets, id]) });
  ensureKnowledgeLoaded();
  queueMicrotask(() => document.getElementById(`kb-facet-${id}`)?.scrollIntoView({ block: "center", behavior: "smooth" }));
};

const knowledgeStats = () => {
  const counts = app.knowledgeTab.overview?.counts;
  if (counts === undefined) {
    return null;
  }
  const stat = (label, value, hint, onClick) =>
    el(onClick === undefined ? "div" : "button", {
      class: onClick === undefined ? "kb-stat" : "kb-stat clickable",
      type: onClick === undefined ? undefined : "button",
      title: hint ?? "",
      onclick: onClick,
    },
    el("strong", {}, briefNumber(value)),
    el("span", {}, label));
  const showImages = (patch) => () => {
    replaceKnowledgeTab({ surface: "images" });
    applyKnowledgeFilter(patch);
  };

  return el("div", { class: "kb-stats" },
    stat("张图有参数", counts.images, "点击：只看原图带参数的图",
      showImages({ libraryScope: "all", query: window.KbTokens.addToken(app.knowledgeTab.query, "has:params") })),
    stat("个 LoRA", counts.loras, "点击：看当前结果里最常用的 LoRA", () => openFacetSection("lora")),
    stat("个标签", counts.tags, "标签可以用 tag:名字 搜索"),
    stat("张能对上发图人", counts.attributed, "点击：只看知道是谁发的图", showImages({ libraryScope: "sender" })),
    counts.promptRequests > 0
      ? stat("次求图 / 咒语", counts.promptRequests, `其中 ${counts.answeredRequests} 次已有回复。点击查看记录`, () => {
        replaceKnowledgeTab({ surface: "requests" });
        ensureKnowledgeLoaded();
      })
      : null,
    counts.fileMissing > 0
      ? stat("张缓存原图已不存在", counts.fileMissing, "参数还留着，当前没有本地原图。点击只看这些",
        showImages({ libraryScope: "all", query: window.KbTokens.addToken(app.knowledgeTab.query, "no:file") }))
      : null);
};

/* ---------- requests surface ---------- */

const requestRow = (row) => {
  const targetResolved = row.imageHash !== null;
  const targetMissingText = targetResolved
    ? unavailableImageText(row.imageFileMissing === 1)
    : "未能定位被问的图";
  return el("article", { class: "kb-request", "data-testid": "kb-request" },
    targetResolved && row.imageHasFile === 1
      ? el("img", {
        class: "kb-thumb small",
        src: knowledgeThumbUrl(row.imageHash),
        loading: "lazy",
        decoding: "async",
        alt: "被问的图",
      })
      : el("div", { class: "kb-thumb small missing" },
        el("span", {}, "?"),
        el("small", {}, targetMissingText)),
    el("div", { class: "kb-request-body" },
      el("div", { class: "kb-card-head" },
        el("span", { class: "kb-badge" }, INTENT_LABELS[row.intent] ?? row.intent),
        confidenceBadge(row.confidence),
        el("span", { class: "kb-meta" }, `${row.groupName || row.groupId} · ${formatUnix(row.askSentAt)}`)),
      el("p", { class: "kb-ask" }, `${row.asker}：${row.askText}`),
      requestIsAnswered(row)
        ? requestAnswer(row)
        : el("p", { class: "kb-note muted" }, row.intent === "original"
          ? "还没有人回复原图或文件"
          : "还没有人回复咒语")));
};

const renderRequests = () => {
  const data = app.knowledgeTab.requests;
  if (data === null) {
    return el("div", { class: "empty" }, "读取中…");
  }
  if (data.needsHarvest === true) {
    return el("div", { class: "empty" },
      "这个库还是旧版本建的，跑一次总结就会开始记录群里的「求咒语」。");
  }
  if (data.items.length === 0) {
    return el("div", { class: "empty" },
      "还没有记录到求图或求咒语。工具会在每次总结时自动检测 kkt / kko / kky 和「求tag」「看看原图」这类消息。");
  }
  const answered = data.items.filter(requestIsAnswered).length;
  return el("div", {},
    el("p", { class: "kb-meta" }, `共 ${data.items.length} 次，其中 ${answered} 次已有回复。`),
    el("div", { class: "kb-request-list" }, data.items.map(requestRow)));
};

/* ---------- coverage surface ---------- */

// Answers "what am I missing?" concretely. A bar per month, split into the part
// whose sender is known and the part still unattributed, with whether that month
// was ever summarised -- which is the difference between "nothing to find" and
// "haven't looked yet".
const coverageMonthRow = (row, maxImages) => {
  const attributedShare = row.images === 0 ? 0 : (row.attributed / row.images) * 100;
  const width = maxImages === 0 ? 0 : (row.images / maxImages) * 100;
  return el("div", { class: "kb-cov-row" },
    el("button", {
      class: "kb-cov-month kb-linkish",
      title: "只看这个月的图",
      onclick: () => {
        const from = `${row.month}-01`;
        // Day 31 is accepted for short months too: the comparison is a bound,
        // not a calendar date, so no month-length logic is needed.
        replaceKnowledgeTab({ surface: "images", query: `date:${from}..${row.month}-31` });
        loadKnowledgeResults();
      },
    }, row.month),
    el("div", { class: "kb-cov-bar", style: `width: ${width.toFixed(1)}%` },
      el("div", { class: "kb-cov-fill", style: `width: ${attributedShare.toFixed(1)}%` })),
    el("span", { class: "kb-cov-count" }, String(row.images)),
    row.summarised
      ? el("span", { class: "kb-badge ok" }, `${row.attributed} 已知发图人`)
      : el("span", { class: "kb-badge warn" }, "这段时间没总结过"));
};

const renderCoverage = () => {
  const data = app.knowledgeTab.coverage;
  if (data === null || data === undefined) {
    return el("div", { class: "empty" }, "读取中…");
  }
  if (data.available === false) {
    return el("div", { class: "empty" }, "还没有咒语库。跑一次总结就会开始建库。");
  }
  if (data.months.length === 0) {
    return el("div", { class: "empty" }, "库里还没有图片。");
  }

  const maxImages = Math.max(...data.months.map((row) => row.images));
  const unsummarised = data.months.filter((row) => !row.summarised);
  const recoverable = unsummarised.reduce((sum, row) => sum + row.unattributed, 0);

  return el("div", { class: "kb-coverage-view" },
    el("div", { class: "kb-stats" },
      el("div", { class: "kb-stat" }, el("strong", {}, String(data.totals.images)), el("span", {}, "张图有参数")),
      el("div", { class: "kb-stat" }, el("strong", {}, String(data.totals.attributed)), el("span", {}, "张知道谁发的")),
      data.newSince > 0
        ? el("div", { class: "kb-stat" }, el("strong", {}, String(data.newSince)), el("span", {}, "张上次来之后新增"))
        : null),

    recoverable === 0
      ? null
      : el("p", { class: "kb-note" },
        `有 ${recoverable} 张图所在的月份从没总结过，所以还不知道是谁发的。`,
        "到「运行」页把那段时间补跑一次，这些图就会自动对上发图人 —— 参数已经存好了，不会重复解析。"),

    el("div", { class: "kb-cov-legend" },
      el("span", {}, el("i", { class: "kb-cov-swatch known" }), "已知发图人"),
      el("span", {}, el("i", { class: "kb-cov-swatch unknown" }), "还不知道"),
      el("span", { class: "kb-meta" }, "点月份只看那个月的图")),

    el("div", { class: "kb-cov-list" }, data.months.map((row) => coverageMonthRow(row, maxImages))),

    data.groups.length === 0
      ? null
      : el("div", {},
        el("h3", { class: "kb-cov-heading" }, "有图片归属的群"),
        el("div", { class: "kb-cov-list" },
          data.groups.map((row) =>
            el("div", { class: "kb-cov-group" },
              el("button", {
                class: "kb-linkish",
                title: "只看这个群的图",
                onclick: () => {
                  replaceKnowledgeTab({ surface: "images", groupId: row.groupId, query: "" });
                  loadKnowledgeResults();
                },
              }, row.groupName || row.groupId),
              el("span", { class: "kb-meta" }, `${row.images} 张 · ${formatUnix(row.firstSeen).slice(0, 10)} ~ ${formatUnix(row.lastSeen).slice(0, 10)}`))))),

    data.unattributedGroups.length === 0
      ? null
      : el("div", {},
        el("h3", { class: "kb-cov-heading" }, "有图但一张都没入库的群"),
        el("p", { class: "kb-meta" },
          "这些群的图在电脑上只有预览图或压缩版，读不到 AI 参数。发图时勾选「原图」、在电脑 QQ 里点开看大图，以后的图才有机会入库。"),
        el("div", { class: "kb-cov-list" },
          data.unattributedGroups.map((row) =>
            el("div", { class: "kb-cov-group" },
              el("span", {}, row.groupName),
              el("span", { class: "kb-meta" }, `${row.mediaMessages} 条图片消息`))))));
};

/* ---------- detail overlay ---------- */

// Moves the open detail view to the next/previous image in the current results.
// Declared before the renderer that references it: the calls sit inside click
// handlers so a later declaration would still work, but only by accident.
const stepDetail = (delta) => {
  const items = app.knowledgeTab.results?.items ?? [];
  const current = app.knowledgeTab.detail;
  if (current === null || items.length === 0) {
    return;
  }
  const index = items.findIndex((item) => item.hash === current.hash);
  if (index === -1) {
    return;
  }
  const next = items[index + delta];
  if (next === undefined) {
    return;
  }
  // Goes through openDetail so the neighbour's full prompt is fetched too.
  openDetail(next);
};

const detailRow = (label, value) =>
  value === undefined || value === null || value === "" ? null : el("div", { class: "kb-detail-row" },
    el("span", { class: "kb-detail-label" }, label),
    el("span", { class: "kb-detail-value" }, String(value)));

const renderKnowledgeDetail = () => {
  const item = app.knowledgeTab.detail;
  if (item === null) {
    return null;
  }
  const params = item.params ?? {};
  const close = () => {
    replaceKnowledgeTab({ detail: null });
    renderKnowledgeDetailLayer();
  };

  const items = app.knowledgeTab.results?.items ?? [];
  const index = items.findIndex((entry) => entry.hash === item.hash);
  const position = index === -1 ? "" : `${index + 1} / ${items.length}`;

  return el("div", {
    class: "kb-overlay",
    onclick: (event) => {
      if (event.target.classList.contains("kb-overlay")) {
        close();
      }
    },
  },
  el("div", { class: "kb-overlay-panel" },
    el("div", { class: "kb-overlay-head" },
      el("strong", {}, generatorLabel(item.generator)),
      el("div", { class: "kb-overlay-nav" },
        position === "" ? null : el("span", { class: "kb-meta" }, position),
        el("button", {
          class: "btn small",
          title: "上一张（←）",
          disabled: index <= 0,
          onclick: () => stepDetail(-1),
        }, "←"),
        el("button", {
          class: "btn small",
          title: "下一张（→）",
          disabled: index === -1 || index >= items.length - 1,
          onclick: () => stepDetail(1),
        }, "→"),
        el("button", { class: "btn small", onclick: close }, "关闭"))),
    el("div", { class: "kb-overlay-body" },
      el("div", { class: "kb-overlay-media" },
        item.hasFile
          ? el("a", { href: knowledgeFileUrl(item.hash), target: "_blank", rel: "noreferrer", title: "在新窗口看原图（原始文件，参数完整）" },
            el("img", { class: "kb-overlay-image", src: knowledgeFileUrl(item.hash), alt: "原图" }))
          : PICTURE_MD5.test(String(item.hash ?? ""))
            ? el("img", {
              class: "kb-overlay-image",
              src: pictureUrl(item.hash, "preview"),
              alt: "预览",
              title: "腾讯上的预览。点右边可以取原图或下载工作流。",
            })
            : el("div", { class: "kb-thumb missing" }, el("span", {}, unavailableImageText(item.fileMissing)))),
      el("div", { class: "kb-overlay-info" }, knowledgeDetailInfo(item, params)))));
};

const knowledgeDetailInfo = (item, params) => [
  promptBlock(item.prompt, "咒语", { clamp: false }),
  promptBlock(item.negativePrompt, "负面咒语", { clamp: false }),
  el("div", { class: "kb-detail-grid" },
    detailRow("模型", item.checkpoint),
    detailRow("模型 hash", item.modelHash),
    detailRow("尺寸", item.width > 0 ? `${item.width}×${item.height}` : ""),
    detailRow("steps", params.steps),
    detailRow("CFG", params.cfgScale),
    detailRow("采样器", params.sampler),
    detailRow("调度", params.scheduler),
    detailRow("seed", params.seed),
    detailRow("重绘幅度", params.denoisingStrength),
    detailRow("md5", item.hash)),
  item.loras.length === 0
    ? null
    : el("div", { class: "kb-loras" },
      el("span", { class: "kb-prompt-label" }, `LoRA ×${item.loras.length}`),
      el("div", { class: "kb-chip-row" },
        item.loras.map((lora) =>
          el("span", { class: "kb-chip" }, lora.weight === null ? lora.name : `${lora.name} @${lora.weight}`)))),
  item.sightings.length === 0
    ? null
    : el("div", {},
      el("span", { class: "kb-prompt-label" }, "群里出现过"),
      el("ul", { class: "kb-sightings" },
        item.sightings.map((seen) =>
          el("li", {}, `${formatUnix(seen.sentAt)} · ${seen.groupName || seen.groupId} · ${seen.speaker}`)))),
  knowledgePictureActions(item),
  knowledgeAskList(item),
  knowledgeRelated(item),
];

const knowledgePictureActions = (item) => {
  if (!PICTURE_MD5.test(String(item.hash ?? ""))) {
    return null;
  }
  return el("div", { class: "row" },
    el("button", {
      class: "btn small",
      onclick: () => openPictureViewer({
        md5: item.hash,
        width: item.width,
        height: item.height,
        size: item.fileSize,
        probe: item.hasWorkflow ? "ai" : "",
        kept: item.hasFile,
      }),
    }, "打开图片"),
    item.hasWorkflow
      ? el("button", {
        class: "btn small",
        onclick: () => downloadPictureWorkflow(item.hash).catch((error) => alert(error.message)),
      }, "下载工作流")
      : null,
    item.hasFile
      ? null
      : el("button", {
        class: "btn small",
        onclick: async () => {
          try {
            alert((await keepOnePicture(item.hash)).text);
          } catch (error) {
            alert(error.message);
          }
        },
      }, "保存原图"));
};

/* ---------- view ---------- */

const knowledgeSurfaceTabs = () => {
  const tab = (name, label) =>
    el("button", {
      class: app.knowledgeTab.surface === name ? "btn small active" : "btn small",
      onclick: () => {
        replaceKnowledgeTab({ surface: name });
        ensureKnowledgeLoaded();
      },
    }, label);
  return el("div", { class: "kb-tabs" },
    tab("images", "图库"),
    tab("requests", "求图 / 咒语记录"),
    tab("coverage", "覆盖情况"));
};

const knowledgeHeader = () => {
  const surface = app.knowledgeTab.surface;
  return [
    surface === "coverage" ? null : knowledgeStats(),
    surface === "images" ? knowledgeCoverageNote() : null,
  ];
};

// Redraws only the stats strip, so the wall below is not rebuilt.
const renderKnowledgeHeader = () => {
  const node = document.getElementById("kb-header");
  if (node !== null && app.view === "knowledge") {
    setChildren(node, knowledgeHeader());
  }
};

const renderKnowledgeView = () => {
  const surface = app.knowledgeTab.surface;
  const body = surface === "images"
    ? renderKnowledgeImages()
    : surface === "requests" ? renderRequests() : renderCoverage();
  setChildren($("#view-knowledge"),
    el("section", { class: "panel kb-page" },
      knowledgeSurfaceTabs(),
      el("div", { id: "kb-header", class: "kb-header" }, knowledgeHeader()),
      surface === "images" ? knowledgeSearchBar() : null,
      surface === "images" ? knowledgeConditions() : null,
      surface === "images" ? syntaxHelpPanel() : null,
      surface === "images" ? exportPanel() : null,
      app.knowledgeTab.error === null
        ? null
        : el("p", { class: "kb-note warn" }, app.knowledgeTab.error),
      body));
};

// The detail overlay lives outside the view, so opening, stepping through and
// closing it never rebuilds the picture wall underneath.
const renderKnowledgeDetailLayer = () => {
  document.getElementById("kb-detail-layer")?.remove();
  const overlay = renderKnowledgeDetail();
  if (overlay === null) {
    return;
  }
  overlay.id = "kb-detail-layer";
  overlay.classList.add("view-layer");
  document.body.append(overlay);
};

VIEW_RELOADERS.knowledge = () => {
  replaceKnowledgeTab({ overview: null, results: null, facets: null, facetsKey: "", requests: null, coverage: null });
  ensureKnowledgeLoaded();
};
VIEW_LEAVE_HOOKS.push(() => replaceKnowledgeTab({ detail: null }));

if (!KNOWLEDGE_SURFACES.has(app.knowledgeTab.surface)) {
  replaceKnowledgeTab({ surface: "images" });
}

document.addEventListener("keydown", (event) => {
  if (app.view !== "knowledge") {
    return;
  }
  // Never hijack keys while the user is typing in the search box.
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    return;
  }
  if (event.key === "Escape" && app.knowledgeTab.detail !== null) {
    replaceKnowledgeTab({ detail: null });
    renderKnowledgeDetailLayer();
    return;
  }
  if (app.knowledgeTab.detail !== null && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
    event.preventDefault();
    stepDetail(event.key === "ArrowRight" ? 1 : -1);
  }
});
