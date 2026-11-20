"use strict";

/* ---------- asking and telling, inside the page ----------
   The browser's own confirm() and alert() look like they come from somewhere
   else, freeze the whole page, and cannot lay out a long explanation.
   confirmInPage() asks in the program's own panel (Esc or a click outside
   means no; a dangerous yes is red and is never the focused button).
   notify() says something at the bottom of the page without stopping it. */

const NOTICE_MS = 6000;
const ERROR_NOTICE_MS = 12000;

const dialogState = { open: null };

const closeDialog = (answer) => {
  const current = dialogState.open;
  if (current === null) {
    return;
  }
  dialogState.open = null;
  current.layer.remove();
  current.restoreFocus?.focus?.();
  current.resolve(answer);
};

// Before the pages' own Escape handlers: Esc closes only the top layer.
window.addEventListener("keydown", (event) => {
  if (dialogState.open !== null && event.key === "Escape") {
    event.preventDefault();
    event.stopImmediatePropagation();
    closeDialog(false);
  }
}, true);

// The first line is the question; the rest explains it (blank lines split paragraphs).
const dialogBody = (message) => {
  const [question, ...rest] = String(message).split("\n");
  return [
    el("h2", { id: "cc-dialog-title", class: "cc-dialog-title" }, question),
    rest.filter((line) => line.trim() !== "").map((line) => el("p", { class: "cc-dialog-text" }, line)),
  ];
};

// Resolves true only when the user presses the confirm button.
const confirmInPage = (message, { confirmLabel = "确定", cancelLabel = "取消", danger = false } = {}) => new Promise((resolve) => {
  closeDialog(false);
  const cancel = el("button", { class: "btn", type: "button", onclick: () => closeDialog(false) }, cancelLabel);
  const confirm = el("button", { class: danger ? "btn danger" : "btn primary", type: "button", onclick: () => closeDialog(true) }, confirmLabel);
  const layer = el("div", {
    class: "cc-dialog-layer",
    onclick: (event) => {
      if (event.target === event.currentTarget) {
        closeDialog(false);
      }
    },
  }, el("div", { class: "cc-dialog", role: "alertdialog", "aria-modal": "true", "aria-labelledby": "cc-dialog-title" },
    dialogBody(message),
    el("div", { class: "cc-dialog-actions" }, cancel, confirm)));
  dialogState.open = { layer, resolve, restoreFocus: document.activeElement };
  document.body.append(layer);
  (danger ? cancel : confirm).focus?.();
});

const noticeHost = () => {
  const existing = document.getElementById("cc-notices");
  if (existing !== null) {
    return existing;
  }
  const host = el("div", { id: "cc-notices", class: "cc-notices", "aria-live": "polite" });
  document.body.append(host);
  return host;
};

// isError: stays longer and is styled as a problem. Always dismissible.
const notify = (message, { isError = false } = {}) => {
  const note = el("div", { class: isError ? "cc-notice is-error" : "cc-notice", role: isError ? "alert" : "status" },
    el("span", { class: "cc-notice-text" }, String(message)),
    el("button", { class: "cc-notice-close", type: "button", "aria-label": "关掉这条提示", onclick: () => note.remove() }, "×"));
  noticeHost().append(note);
  setTimeout(() => note.remove(), isError ? ERROR_NOTICE_MS : NOTICE_MS);
};

// For .catch(): something the user asked for did not work.
const notifyError = (error) => notify(error?.message ?? String(error), { isError: true });
