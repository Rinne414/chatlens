"use strict";

/* ---------- 设置 → Obsidian 笔记库 (computer only) ----------
   Picks the vault (from the ones Obsidian knows, or any folder), the folder
   and script of the notes, auto sync and the AI part, runs 立即同步, shows
   what the last sync did in plain words, and queues 整理旧消息. */

const NOTES_POLL_MS = 2000;
const notesState = { data: null, error: null, notice: null, busy: false, draft: null, pollTimer: null };

const notesNotice = (text, tone) => {
  notesState.notice = text === null ? null : { text, tone };
};

const loadNotesStatus = async () => {
  try {
    notesState.data = await api("/api/notes");
    notesState.error = null;
  } catch (error) {
    notesState.error = error.message;
  }
};

const rerenderNotesCard = () => {
  const card = $("#notes-card");
  if (card !== null) {
    card.replaceWith(renderNotesCard());
  }
};

const stopNotesPoll = () => {
  clearInterval(notesState.pollTimer);
  notesState.pollTimer = null;
};

const startNotesPoll = () => {
  stopNotesPoll();
  notesState.pollTimer = setInterval(async () => {
    await loadNotesStatus();
    if (notesState.data?.running !== true) {
      stopNotesPoll();
      const run = notesState.data?.lastRun;
      if (run?.status === "failed") {
        notesNotice(`同步失败：${run.error}`, "risk");
      } else if (run?.status === "done" && run.result?.skipped === "busy") {
        notesNotice("后台正在写笔记，稍后再点一次。", "warn");
      } else if (run?.status === "done" && run.result?.skipped === "topics-pending") {
        notesNotice(`AI 还没把东西分完主题（${run.result.placed.toLocaleString()} / ${run.result.total.toLocaleString()}），笔记先没改；后台刷新会接着分，分好后自动写。`, "warn");
      } else if (run?.status === "done") {
        notesNotice("已同步。", "ok");
      }
    }
    rerenderNotesCard();
  }, NOTES_POLL_MS);
};

VIEW_LEAVE_HOOKS.push(stopNotesPoll);

const notesPost = async (path, body) => api(path, { method: "POST", body: JSON.stringify(body ?? {}) });

const notesAction = async (work) => {
  notesState.busy = true;
  notesNotice(null);
  rerenderNotesCard();
  try {
    await work();
  } catch (error) {
    notesNotice(error.message, "risk");
  }
  notesState.busy = false;
  await loadNotesStatus();
  rerenderNotesCard();
};

const syncNotesNow = () => notesAction(async () => {
  await notesPost("/api/notes/sync");
  startNotesPoll();
});

const saveNotesDraft = (patch, { thenSync = false } = {}) => notesAction(async () => {
  const result = await notesPost("/api/notes/settings", patch);
  notesState.draft = null;
  notesNotice(result.looksLikeVault ? "已保存。" : "已保存。这个文件夹里没有 .obsidian，可能还不是 Obsidian 笔记库；用 Obsidian「打开文件夹作为库」打开它就行。", result.looksLikeVault ? "ok" : "warn");
  if (thenSync) {
    await notesPost("/api/notes/sync");
    startNotesPoll();
  }
});

const restoreDeletedNotes = () => notesAction(async () => {
  const result = await notesPost("/api/notes/restore-deleted");
  notesNotice(`${result.restored} 则笔记会在下次同步时重新生成。`, "ok");
});

const queueOldMessages = (unsummarized) => {
  if (!window.confirm(`让 AI 整理 ${unsummarized.toLocaleString()} 条还没整理过的消息？\n在后台慢慢做，不挡新消息；用的是本页设置的 AI 服务，按每日上限和预算走。进度和花费在「AI 用量」里看。`)) {
    return;
  }
  notesAction(async () => {
    const result = await notesPost("/api/notes/backfill");
    notesNotice(result.chunks > 0
      ? `已排进后台：${result.chunks} 段、${result.messages.toLocaleString()} 条消息。整理好的会在之后的同步里出现在笔记里。`
      : "没有需要整理的消息（最近几分钟的新消息会由后台自己整理）。", "ok");
  });
};

/* ---------- pieces ---------- */

const notesTime = (unix) => (Number.isFinite(unix) ? unixToHkt(unix).slice(5, 16) : "");

// obsidian://open opens the note in Obsidian (the browser asks once).
const obsidianUrl = (filePath) => `obsidian://open?path=${encodeURIComponent(filePath)}`;

const STOP_REASONS = {
  paused: "AI 已暂停",
  "call-limit": "到了今天的 AI 调用上限",
  "money-budget": "到了今天的预算",
  "notes-run-cap": "每次刷新只做一部分，下次刷新继续",
  "notes-time": "每次刷新最多整理 8 分钟，免得耽误收新消息，下次刷新继续",
  "notes-budget-share": "今天的 AI 调用已用到七成，剩下的留给简报，明天继续",
  "provider-down": "AI 服务暂时连不上，下次刷新再试",
};

// While 立即同步 or a refresh has the AI placing things into topics; a mark
// older than this was left by a run that was stopped.
const PROGRESS_FRESH_SECONDS = 15 * 60;
const progressText = (progress) => (progress?.stage === "topics" && progress.todo > 0
  && Date.now() / 1000 - progress.at < PROGRESS_FRESH_SECONDS
  ? `AI 正在分主题 ${progress.done.toLocaleString()} / ${progress.todo.toLocaleString()}…`
  : null);

// The last sync found the topics not placed yet (and nothing synced since).
const waitingOf = (status) => {
  const sync = status?.sync ?? null;
  return status?.waiting && (sync === null || status.waiting.at >= sync.at) ? status.waiting : null;
};

const lastSyncLines = (status) => {
  const sync = status?.sync;
  if (!sync) {
    return [el("p", { class: "card-sub notes-line" }, "还没同步过。")];
  }
  const changed = sync.written > 0 ? `改了 ${sync.written.toLocaleString()} 个文件` : "没有变化";
  const what = sync.topics === undefined ? `${sync.things.toLocaleString()} 个东西` : `${sync.topics.toLocaleString()} 个主题`;
  return [
    el("p", { class: "notes-line" },
      `${notesTime(sync.at)} 同步：${what} · ${sync.days} 天日报 · ${sync.groups} 个群 · ${changed}`),
    sync.retired > 0
      ? el("p", { class: "card-sub notes-line" }, `${sync.retired.toLocaleString()} 则旧笔记（你没改过的）移到了库里的 .trash 文件夹，也就是 Obsidian 的回收站；要找回就从那里搬回来。`)
      : null,
    sync.failed > 0
      ? el("div", { class: "notice risk" }, `${sync.failed} 个文件没写成，下次同步会再试：${(sync.errors ?? []).join("；")}`)
      : null,
    sync.kept > 0 ? el("p", { class: "card-sub notes-line" }, `${sync.kept} 个文件是你自己的或你改过结构（删掉了「我的笔记」标题、改了表格视图），没有覆盖。`) : null,
    sync.ignored > 0 ? el("p", { class: "card-sub notes-line" }, `${sync.ignored} 则标了 ignore: true，不再更新。`) : null,
    sync.deleted > 0
      ? el("p", { class: "card-sub notes-line" }, `你删掉的 ${sync.deleted} 则笔记不会再生成。`,
        el("button", { class: "btn small", type: "button", disabled: notesState.busy, onclick: restoreDeletedNotes }, "重新生成它们"))
      : null,
  ];
};

const aiLines = (data) => {
  const ai = data.status?.ai;
  const settings = data.settings;
  if (!settings.consensus) {
    return [el("p", { class: "card-sub notes-line" }, "AI 整理已关闭：不分主题（很多群都在讲的东西各自一则），别名只按写法合并，没有「群里的共识」。")];
  }
  if (!data.aiReady) {
    return [el("p", { class: "card-sub notes-line" }, "还没有配置 AI 服务：笔记不分主题，也没有「群里的共识」，要等配置好之后才会有。")];
  }
  const consensus = ai?.consensus;
  const topics = ai?.topics;
  const stopped = consensus?.stoppedBy ?? topics?.stoppedBy ?? ai?.aliases?.stoppedBy;
  const lead = data.consensusCount > 0
    ? `已有 ${data.consensusCount.toLocaleString()} 个主题写好了「群里的共识」`
    : "「群里的共识」还没写过，会在之后的后台刷新里写（每次最多 12 个）";
  const progress = progressText(data.status?.aiProgress);
  return [
    progress && !data.running && waitingOf(data.status) === null ? el("p", { class: "notes-line" }, `${progress}（后台刷新在分，分好后自动写笔记）`) : null,
    topics?.pending > 0
      ? el("p", { class: "notes-line" }, `还有 ${(topics.todo - topics.done).toLocaleString()} 个新东西没分进主题，下次后台刷新接着分。`)
      : null,
    el("p", { class: "notes-line" },
      lead,
      consensus?.pending > 0 ? `，还有 ${consensus.pending} 个在排队` : "",
      stopped ? `（${STOP_REASONS[stopped] ?? stopped}）` : "",
      consensus?.failed > 0 ? `；上次有 ${consensus.failed} 个没写成：${consensus.error ?? ""}` : "",
      "。"),
  ];
};

const backlogLine = (data) => {
  const { unsummarized, messages } = data.coverage;
  if (unsummarized <= 0) {
    return null;
  }
  return el("p", { class: "notes-line" },
    `还有 ${unsummarized.toLocaleString()} 条消息（共 ${messages.toLocaleString()} 条）没让 AI 整理过，里面提到的东西还不在笔记里。`,
    data.queuedChunks > 0 ? `后台正在整理，还有 ${data.queuedChunks.toLocaleString()} 段在排队。` : "");
};

// Shown next to 立即同步 while there is something to queue.
const backlogButton = (data) => (data.coverage.unsummarized > 0 && data.queuedChunks === 0
  ? el("button", { class: "btn small", type: "button", disabled: notesState.busy || !data.aiReady, onclick: () => queueOldMessages(data.coverage.unsummarized) }, "整理旧消息")
  : null);

/* ---------- the form ---------- */

const draftOf = (data) => notesState.draft ?? {
  vaultPath: data.settings.vaultPath || data.vaults.find((vault) => vault.exists)?.path || "",
  folder: data.settings.folder,
  language: data.settings.language,
  autoSync: data.settings.autoSync,
  consensus: data.settings.consensus,
};

const setNotesDraft = (patch) => {
  notesState.draft = { ...draftOf(notesState.data), ...patch };
};

const vaultChoices = (data, draft) => (data.vaults.length === 0
  ? el("p", { class: "card-sub notes-line" }, "这台电脑上没找到 Obsidian 的笔记库（装了 Obsidian 的话先打开它一次）。也可以直接在下面填一个文件夹，之后在 Obsidian 里「打开文件夹作为库」。")
  : el("div", { class: "notes-vaults" }, data.vaults.map((vault) => el("label", { class: "notes-vault" },
    el("input", {
      type: "radio",
      name: "notes-vault",
      checked: draft.vaultPath === vault.path,
      disabled: !vault.exists,
      onchange: () => {
        setNotesDraft({ vaultPath: vault.path });
        rerenderNotesCard();
      },
    }),
    el("span", {}, el("strong", {}, vault.name), el("small", {}, vault.exists ? vault.path : `${vault.path}（文件夹已经不在了）`))))));

const notesForm = (data, { configured }) => {
  const draft = draftOf(data);
  const field = (label, control) => el("label", { class: "notes-field" }, el("span", {}, label), control);
  return el("div", { class: "notes-form" },
    field("笔记库文件夹", el("input", { type: "text", value: draft.vaultPath, placeholder: "例如 D:\\Notes\\Obsidian", oninput: (event) => setNotesDraft({ vaultPath: event.target.value }) })),
    field("写进哪个文件夹", el("input", { type: "text", value: draft.folder, oninput: (event) => setNotesDraft({ folder: event.target.value }) })),
    field("笔记文字", el("select", { onchange: (event) => setNotesDraft({ language: event.target.value }) },
      el("option", { value: "zh-Hans", selected: draft.language === "zh-Hans" }, "简体（和群里一样）"),
      el("option", { value: "zh-Hant", selected: draft.language === "zh-Hant" }, "繁体（AI 写的句子转繁体，名字照原样）"))),
    backgroundToggle("每次后台刷新后自动同步", "只改有变化的笔记", draft.autoSync, (checked) => setNotesDraft({ autoSync: checked })),
    backgroundToggle("用 AI 分主题、合并别名、写「群里的共识」", "第一次分主题约 20 次调用，之后新东西每次几次；3 个以上的群在讲的主题各写一次共识，每周最多更新一次。和简报用同一个 AI、同一个每日上限和预算", draft.consensus, (checked) => setNotesDraft({ consensus: checked })),
    el("div", { class: "row", style: "margin-top:10px" },
      configured
        ? el("button", { class: "btn small primary", type: "button", disabled: notesState.busy, onclick: () => saveNotesDraft({ ...draftOf(notesState.data), enabled: true }) }, "保存")
        : el("button", { class: "btn small primary", type: "button", disabled: notesState.busy, onclick: () => saveNotesDraft({ ...draftOf(notesState.data), enabled: true }, { thenSync: true }) }, notesState.busy ? "处理中…" : "开始写笔记"),
      configured
        ? el("button", { class: "btn small", type: "button", disabled: notesState.busy, onclick: () => saveNotesDraft({ enabled: false }) }, "停止写笔记")
        : null),
    configured ? el("p", { class: "card-sub notes-line" }, "停止后，已经写好的笔记留在库里，不会删除。") : null);
};

/* ---------- the card ---------- */

const notesBody = (data) => {
  const configured = data.settings.enabled && data.settings.vaultPath !== "";
  if (!configured) {
    return [vaultChoices(data, draftOf(data)), notesForm(data, { configured: false })];
  }
  const { status } = data;
  const sync = status?.sync ?? null;
  const failed = status?.syncError && (sync === null || status.syncError.at >= sync.at) ? status.syncError : null;
  const waiting = waitingOf(status);
  const progress = progressText(status?.aiProgress);
  return [
    el("p", { class: "notes-line" }, "写到：", el("code", {}, sync?.folder ?? `${data.settings.vaultPath} → ${data.settings.folder}`)),
    ...lastSyncLines(status),
    waiting ? el("div", { class: "notice warn" }, progress
      ? `${progress}分好之前笔记先不改，分好后自动写。`
      : `AI 还没把东西分完主题（${waiting.placed.toLocaleString()} / ${waiting.total.toLocaleString()}），分好之前笔记先不改。第一次点「立即同步」要二三十分钟一次分完；只靠后台刷新的话每次分 8 分钟，要一两个小时。`) : null,
    failed ? el("div", { class: "notice risk" }, `上次同步失败（${notesTime(failed.at)}）：${failed.message}`) : null,
    ...aiLines(data),
    backlogLine(data),
    el("div", { class: "row notes-actions", style: "margin-top:12px" },
      el("button", { class: "btn small primary", type: "button", disabled: notesState.busy || data.running, onclick: syncNotesNow }, data.running ? (progress ?? "正在同步…") : "立即同步"),
      sync?.overview ? el("a", { class: "btn small", href: obsidianUrl(sync.overview) }, "在 Obsidian 打开") : null,
      backlogButton(data)),
    el("details", { class: "notes-more" },
      el("summary", {}, "换笔记库、文字、自动同步、AI"),
      vaultChoices(data, draftOf(data)),
      notesForm(data, { configured: true })),
    el("p", { class: "card-sub notes-line" }, "如果这个库用 Obsidian Sync、iCloud、OneDrive 或 Git 同步，群聊内容也会跟着上传到那里。"),
  ];
};

const renderNotesCard = () => {
  const data = notesState.data;
  const notice = notesState.notice;
  return el("div", { class: "card", id: "notes-card", "data-testid": "notes-card" },
    el("h2", {}, "Obsidian 笔记库"),
    el("p", { class: "card-sub" },
      "把群里整理出来的东西按主题写成 Obsidian 笔记：一个主题一则，例如一个模型连同它的版本、LoRA、插件和教程（几个群都在讲的，AI 会整理「群里的共识」）；每天一则日报，每个群一则。只提过一两次的东西不单独成一则，在日报和它的主题里。只写进库里的一个文件夹，不动你别的笔记；「我的笔记」下面你写的字永远保留。"),
    notice !== null ? el("div", { class: `notice ${notice.tone}` }, notice.text) : null,
    notesState.error !== null ? el("div", { class: "notice risk" }, `读取失败：${notesState.error}`) : null,
    ...(data === null ? [el("p", { class: "card-sub" }, "正在读取…")] : notesBody(data)));
};
