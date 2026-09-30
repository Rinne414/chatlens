"use strict";

/* ---------- back and forward ----------
   Every page is a history entry, and so is every screen a page shows inside
   itself (a group or the list of groups, a chat or the inbox, a day or a
   search in 回顾) and every picture opened over a page. The browser's or the
   mouse's back button, and 「← 返回」 at the top, step back through exactly
   what the reader saw; the entry being left remembers how far down it was.

   An entry: { view, step, overlay, scrollY, depth, prev }
   step     what the page shows inside itself, in the page's own shape;
   overlay  the picture open over the page ({ kind, key }): back closes it;
   depth    how many entries this tab can go back inside the console;
   prev     the entry before it ({ view, step, overlay }), so a page's own
            「← 简报」 can go back to where the reader was instead of opening
            the page anew. */

// view -> (step, overlay) => void: shows that screen of the page again.
const VIEW_STEP_RESTORERS = {};

// shown: the entry the page shows now, as entryBrief() gives it.
// overlays: what is open over the page, bottom first ({ overlay, close }): a
// picture can open over a detail (咒语库 → 打开图片), and back closes one at a time.
const viewHistory = { restoring: false, started: false, overlays: [], shown: null };

const sameStep = (left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

const entryBrief = (entry) => (entry ? { view: entry.view, step: entry.step ?? null, overlay: entry.overlay ?? null } : null);

const currentEntry = () => {
  try {
    return typeof history.state?.view === "string" ? history.state : null;
  } catch {
    return null;
  }
};

const renderViewBack = () => {
  const button = $("#view-back");
  if (button === null) {
    return;
  }
  const entry = currentEntry();
  button.hidden = !(Number(entry?.depth) > 0);
  const target = entry?.prev ?? null;
  button.title = target === null ? "" : `回到：${VIEW_TITLES[target.view] ?? target.view}`;
};

const writeEntry = (method, entry) => {
  try {
    history[method](entry, "");
  } catch {
    // History is a convenience; a page that cannot use it still works.
  }
  viewHistory.shown = entryBrief(currentEntry());
  renderViewBack();
};

const pushEntry = (current, next) => {
  writeEntry("replaceState", { ...current, scrollY: window.scrollY });
  writeEntry("pushState", { scrollY: 0, ...next, depth: (Number(current.depth) || 0) + 1, prev: entryBrief(current) });
};

// Called by showView before the page changes.
const recordViewHistory = (name) => {
  if (viewHistory.restoring) {
    return;
  }
  const current = currentEntry();
  if (!viewHistory.started || current === null) {
    // First page of this load. After a reload the entry keeps its depth, so
    // back still reaches the pages before it.
    viewHistory.started = true;
    writeEntry("replaceState", { view: name, scrollY: 0, depth: Number(current?.depth) || 0, prev: current?.prev ?? null });
    return;
  }
  if (app.view === name) {
    return;
  }
  viewHistory.overlays = [];
  pushEntry(current, { view: name });
};

// The page now shows another screen inside itself. The first screen a page
// opens with only labels the page's entry; a later change is an entry of its
// own, unless `replace` (the same screen, redrawn for another reason).
const markViewStep = (step, { replace = false } = {}) => {
  const current = currentEntry();
  if (viewHistory.restoring || current === null || current.view !== app.view || sameStep(current.step, step)) {
    return;
  }
  if (current.step === undefined || current.step === null || replace) {
    writeEntry("replaceState", { ...current, step });
    return;
  }
  pushEntry(current, { view: app.view, step });
};

const overlayBelowTop = () => viewHistory.overlays.at(-2)?.overlay ?? null;

// A picture opened over the page, or over another kind of overlay. Stepping
// to the next picture of the same kind replaces the entry rather than adding
// one per picture.
const openOverlayEntry = (overlay, close) => {
  const stack = viewHistory.overlays;
  const top = stack.at(-1);
  const sameKind = top !== undefined && top.overlay.kind === overlay.kind;
  viewHistory.overlays = [...(sameKind ? stack.slice(0, -1) : stack), { overlay, close }];
  const current = currentEntry();
  if (viewHistory.restoring || current === null || current.view !== app.view || sameStep(current.overlay, overlay)) {
    return;
  }
  if (current.overlay && sameKind) {
    writeEntry("replaceState", { ...current, overlay });
    return;
  }
  pushEntry(current, { view: app.view, step: current.step, overlay, scrollY: window.scrollY });
};

// 关闭, Esc or a click beside the picture: the same as back when the entry
// before is the same screen with what lay under it, so forward never reopens
// a picture already closed.
const dismissOverlay = (close) => {
  const current = currentEntry();
  const prev = current?.prev;
  if (current?.overlay && prev?.view === current.view && sameStep(prev.step, current.step) && sameStep(prev.overlay, overlayBelowTop())) {
    history.back();
    return;
  }
  viewHistory.overlays = viewHistory.overlays.slice(0, -1);
  close();
  if (current?.overlay) {
    writeEntry("replaceState", { ...current, overlay: viewHistory.overlays.at(-1)?.overlay ?? null });
  }
};

// A page's own 「← …」 button: the browser's back when the entry before is the
// place it names (it comes back at the same scroll position), else `fallback`.
const goBackTo = (matches, fallback) => {
  const prev = currentEntry()?.prev;
  if (prev && !prev.overlay && matches(prev)) {
    history.back();
    return;
  }
  fallback();
};

window.addEventListener?.("popstate", (event) => {
  const entry = event.state;
  if (typeof entry?.view !== "string" || !document.getElementById(`view-${entry.view}`)) {
    return;
  }
  const shown = viewHistory.shown;
  const top = viewHistory.overlays.at(-1);
  const below = overlayBelowTop();
  viewHistory.overlays = viewHistory.overlays.slice(0, -1);
  viewHistory.restoring = true;
  let onlyClosed = false;
  try {
    top?.close();
    // Back from a picture: what lies underneath is already the right screen.
    onlyClosed = top !== undefined && entry.view === shown?.view && sameStep(entry.step, shown.step) && sameStep(entry.overlay ?? null, below);
    if (!onlyClosed) {
      // Another screen: whatever else was open belongs to the one left.
      const rest = viewHistory.overlays;
      viewHistory.overlays = [];
      rest.reverse().forEach((item) => item.close());
      const restore = VIEW_STEP_RESTORERS[entry.view];
      if (typeof restore === "function" && ((entry.step ?? null) !== null || entry.overlay)) {
        restore(entry.step ?? null, entry.overlay ?? null);
      } else {
        openView(entry.view);
      }
    }
  } finally {
    viewHistory.restoring = false;
  }
  viewHistory.shown = entryBrief(entry);
  renderViewBack();
  if (!onlyClosed) {
    const scrollY = Number(entry.scrollY) || 0;
    // After the page has drawn from what it already holds.
    requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo(0, scrollY)));
  }
});
