"use strict";

/* ---------- motion: things arriving ----------
   The pages draw a window by removing it and appending a new one, also when
   only its content changed (the next picture, data that arrived). A plain CSS
   entrance would replay on every redraw, so this watches what is added to the
   page and marks a window with .motion-in only when it really opens:
   - not when the same kind of window was removed in the same step (a redraw);
     a redraw during the entrance carries the entrance on where it was;
   - not when the last thing the user did was press a key (keys are used to
     go fast: 空格 for the big picture, Ctrl+K, ?).
   Pictures on the walls fade in the first time they arrive, never again when
   the wall is redrawn. The looks are in motion.css. */

const MOTION_ENTER_MS = 160;

// Each window is known by the first of these classes it carries.
const MOTION_LAYER_KINDS = ["cc-dialog-layer", "kb-overlay", "modal-mask", "gallery-compare", "quick-look", "tray-drop", "gallery-hover-preview", "brief-keys-help", "cc-hint"];
const MOTION_LAYER_SELECTOR = MOTION_LAYER_KINDS.map((kind) => `.${kind}`).join(", ");
const MOTION_PICTURE_SELECTOR = ".wall-tile img, .brief-image img";

const motionState = {
  // "key" or "pointer": what the user did last.
  lastInput: "pointer",
  // kind -> when its entrance started (performance.now()).
  enteredAt: new Map(),
  // Addresses of pictures that have been shown once.
  seenPictures: new Set(),
};

const motionKindOf = (node) => MOTION_LAYER_KINDS.find((kind) => node.classList.contains(kind)) ?? null;

// removedKinds: the kinds taken away in the same step. Returns null (no
// entrance), or how many ms of the entrance are already over.
const motionEntranceFor = (kind, { removedKinds, lastInput, enteredAt, now }) => {
  if (removedKinds.has(kind)) {
    const elapsed = now - (enteredAt.get(kind) ?? -Infinity);
    return elapsed < MOTION_ENTER_MS ? elapsed : null;
  }
  return lastInput === "key" ? null : 0;
};

const motionEnterLayer = (node, removedKinds) => {
  const kind = motionKindOf(node);
  if (kind === null) {
    return;
  }
  const now = performance.now();
  const elapsed = motionEntranceFor(kind, { removedKinds, lastInput: motionState.lastInput, enteredAt: motionState.enteredAt, now });
  if (elapsed === null) {
    motionState.enteredAt.delete(kind);
    return;
  }
  motionState.enteredAt.set(kind, now - elapsed);
  if (elapsed > 0) {
    node.style.setProperty("--motion-skip", `-${Math.round(elapsed)}ms`);
  }
  node.classList.add("motion-in");
};

const motionPictureArrived = (event) => {
  const img = event.currentTarget;
  motionState.seenPictures.add(img.currentSrc || img.src);
  if (img.classList.contains("motion-img-wait")) {
    img.classList.replace("motion-img-wait", event.type === "load" ? "motion-img-in" : "motion-img-failed");
  }
};

const motionWatchPicture = (img) => {
  const address = img.currentSrc || img.src;
  if (address === "" || img.complete || motionState.seenPictures.has(address)) {
    return;
  }
  img.classList.add("motion-img-wait");
  img.addEventListener("load", motionPictureArrived, { once: true });
  img.addEventListener("error", motionPictureArrived, { once: true });
};

const motionElementsIn = (nodes, selector) => {
  const found = [];
  for (const node of nodes) {
    if (node.nodeType !== 1) {
      continue;
    }
    if (node.matches(selector)) {
      found.push(node);
    }
    found.push(...node.querySelectorAll(selector));
  }
  return found;
};

const motionOnChanges = (records) => {
  const removedKinds = new Set();
  const added = [];
  for (const record of records) {
    for (const node of record.removedNodes) {
      const kind = node.nodeType === 1 ? motionKindOf(node) : null;
      if (kind !== null) {
        removedKinds.add(kind);
      }
    }
    added.push(...record.addedNodes);
  }
  for (const node of added) {
    // Windows are appended whole, so only the added node itself can be one.
    if (node.nodeType === 1 && node.isConnected && node.matches(MOTION_LAYER_SELECTOR)) {
      motionEnterLayer(node, removedKinds);
    }
  }
  for (const img of motionElementsIn(added, MOTION_PICTURE_SELECTOR)) {
    motionWatchPicture(img);
  }
};

if (typeof MutationObserver === "function") {
  document.addEventListener("keydown", () => { motionState.lastInput = "key"; }, true);
  for (const type of ["pointerdown", "pointermove", "dragstart"]) {
    document.addEventListener(type, () => { motionState.lastInput = "pointer"; }, true);
  }
  new MutationObserver(motionOnChanges).observe(document.body, { childList: true, subtree: true });
}
