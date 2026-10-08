"use strict";

/* ---------- phone layout (手机版) ----------
   Loaded in <head> so the phone class is on <html> before the first paint.

   The phone layout applies only to a touch screen at most 900 px wide; a
   computer with a mouse never matches, whatever its window size. Every phone
   rule in phone.css sits under html.phone, and the shell below is only built
   while that class is on, so the computer's page is exactly what it was.

   html.remote marks a page opened through the remote entrance (手机连线),
   whatever its size: the pages that change the computer are not offered. */

const PHONE_QUERY = "(pointer: coarse) and (max-width: 900px)";
const PHONE_TABS = ["brief", "messages", "ask", "review"];
const PHONE_MORE_VIEWS = ["bookmarks", "trends", "group", "media", "knowledge", "qqcollect", "backup", "storage", "settings"];
const REMOTE_DESKTOP_ONLY_VIEWS = new Set(["settings", "backup", "storage", "qqcollect", "watchlist"]);

const phoneRemote = document.querySelector('meta[name="cc-remote"]')?.content === "1";
const phoneMedia = typeof window.matchMedia === "function" ? window.matchMedia(PHONE_QUERY) : null;
const isPhoneLayout = () => phoneMedia?.matches === true;

const phoneShell = { mounted: false, sheetOpen: false, observers: [] };

// How a message is picked for 总结所选: right-click on the computer, a long
// press on a phone (Chrome turns it into the same contextmenu event).
const selectGestureWord = () => (isPhoneLayout() ? "长按" : "右键");

// Picture walls (画廊, 咒语库) start at two columns on a phone instead of one
// screen-wide picture; the 大小 slider still overrides it.
const PHONE_WALL_SIZE = 150;
const phoneWallSize = (computerDefault) => (isPhoneLayout() ? PHONE_WALL_SIZE : computerDefault);

document.documentElement.classList.toggle("phone", isPhoneLayout());
document.documentElement.classList.toggle("remote", phoneRemote);

const phoneTabLabel = (view) => VIEW_TITLES[view] ?? view;

const syncPhoneTabs = () => {
  const activeNav = document.querySelector("#nav button.active")?.dataset.view ?? app.view;
  const onTab = PHONE_TABS.includes(activeNav);
  for (const button of document.querySelectorAll(".phone-tab")) {
    const view = button.dataset.view;
    button.classList.toggle("active", view === "more" ? !onTab || phoneShell.sheetOpen : view === activeNav && !phoneShell.sheetOpen);
  }
};

// A dot on 消息 when someone @-ed or replied to you in a followed group.
const syncPhoneBadges = () => {
  const mentions = (railState.data?.groups ?? []).reduce((sum, group) => sum + (Number(group.mentions) || 0), 0);
  const tab = document.querySelector('.phone-tab[data-view="messages"]');
  if (tab !== null) {
    tab.classList.toggle("has-mention", mentions > 0);
    tab.setAttribute("aria-label", mentions > 0 ? `消息（${mentions} 条 @你 或回复你）` : "消息");
  }
};

const closePhoneSheet = () => {
  phoneShell.sheetOpen = false;
  const sheet = $("#phone-sheet");
  if (sheet !== null) {
    sheet.hidden = true;
  }
  document.documentElement.classList.remove("phone-sheet-open");
  syncPhoneTabs();
};

const openPhoneSheet = () => {
  if (phoneShell.sheetOpen) {
    return;
  }
  phoneShell.sheetOpen = true;
  $("#phone-sheet").hidden = false;
  document.documentElement.classList.add("phone-sheet-open");
  syncPhoneTabs();
  // Back (the Android gesture too) closes the sheet first.
  openOverlayEntry({ kind: "phone-more" }, closePhoneSheet);
};

const dismissPhoneSheet = () => {
  if (phoneShell.sheetOpen) {
    dismissOverlay(closePhoneSheet);
  }
};

// Leaving through the sheet: close it the way back would (that is a history
// step), then open the page once that step has landed.
const openFromSheet = (view) => {
  if (!phoneShell.sheetOpen) {
    openView(view);
    return;
  }
  const go = () => openView(view);
  const afterBack = () => setTimeout(go, 0);
  window.addEventListener("popstate", afterBack, { once: true });
  dismissOverlay(closePhoneSheet);
  if (!phoneShell.sheetOpen) {
    // Closed without a history step: no popstate is coming.
    window.removeEventListener("popstate", afterBack);
    go();
  }
};

const unpairThisPhone = async () => {
  if (!window.confirm("让这台手机退出配对？\n之后要再用，需要在电脑上重新生成配对码。")) {
    return;
  }
  try {
    await fetch("/remote/unpair", { method: "POST", credentials: "same-origin" });
  } finally {
    location.replace("/pair");
  }
};

const phoneSheetPages = () => PHONE_MORE_VIEWS
  .filter((view) => !(phoneRemote && REMOTE_DESKTOP_ONLY_VIEWS.has(view)))
  .map((view) => el("button", { class: "phone-sheet-page", type: "button", onclick: () => openFromSheet(view) },
    el("span", { class: "phone-sheet-icon", "aria-hidden": "true" }, NAV_ICONS[view] ?? "•"),
    el("span", {}, VIEW_TITLES[view] ?? view)));

const buildPhoneSheet = () =>
  el("div", { id: "phone-sheet", class: "phone-sheet", hidden: true },
    el("button", { class: "phone-sheet-backdrop", type: "button", "aria-label": "关闭", onclick: dismissPhoneSheet }),
    el("section", { class: "phone-sheet-panel", role: "dialog", "aria-label": "更多" },
      el("div", { class: "phone-sheet-grip", "aria-hidden": "true" }),
      el("div", { class: "phone-sheet-pages" }, phoneSheetPages()),
      el("div", { id: "phone-sheet-groups", class: "phone-sheet-groups" }),
      el("div", { id: "phone-sheet-status", class: "phone-sheet-status" }),
      el("div", { id: "phone-sheet-prefs", class: "phone-sheet-prefs" }),
      phoneRemote
        ? el("div", { class: "phone-sheet-foot" },
          el("p", {}, "这台手机通过 Tailscale 连到你电脑上的 ChatLens。设置、密钥、备份和存储只能在电脑上改。"),
          el("button", { class: "btn small danger", type: "button", onclick: unpairThisPhone }, "退出这台手机的配对"))
        : null));

const buildPhoneTabs = () =>
  el("nav", { class: "phone-tabs", "aria-label": "页面" },
    [...PHONE_TABS, "more"].map((view) => el("button", {
      class: "phone-tab",
      type: "button",
      dataset: { view },
      onclick: () => {
        if (view === "more") {
          if (phoneShell.sheetOpen) {
            dismissPhoneSheet();
          } else {
            openPhoneSheet();
          }
          return;
        }
        if (phoneShell.sheetOpen) {
          openFromSheet(view);
          return;
        }
        openView(view);
      },
    },
    el("span", { class: "phone-tab-icon", "aria-hidden": "true" }, view === "more" ? "☰" : NAV_ICONS[view]),
    el("span", { class: "phone-tab-label" }, view === "more" ? "更多" : phoneTabLabel(view)))));

// The rail's live parts (followed groups, background status, theme and text
// size) move into the sheet while the phone layout is on, and back after.
const RAIL_PARTS = [
  { id: "rail-groups", into: "phone-sheet-groups" },
  { id: "rail-status", into: "phone-sheet-status" },
];

const moveRailParts = (toSheet) => {
  for (const part of RAIL_PARTS) {
    const node = document.getElementById(part.id);
    const target = toSheet ? document.getElementById(part.into) : document.querySelector(".rail");
    if (node !== null && target !== null) {
      if (toSheet) {
        target.append(node);
      } else {
        target.insertBefore(node, document.getElementById("rail-version"));
      }
    }
  }
  const prefs = document.querySelector(".rail-foot .settings-row, #phone-sheet-prefs .settings-row");
  const prefsTarget = toSheet ? document.getElementById("phone-sheet-prefs") : document.querySelector(".rail-foot");
  if (prefs !== null && prefsTarget !== null) {
    if (toSheet) {
      prefsTarget.append(prefs);
    } else {
      prefsTarget.prepend(prefs);
    }
  }
};

const mountPhoneShell = () => {
  if (phoneShell.mounted) {
    return;
  }
  phoneShell.mounted = true;
  document.body.append(buildPhoneSheet(), buildPhoneTabs());
  moveRailParts(true);
  const navObserver = new MutationObserver(syncPhoneTabs);
  navObserver.observe($("#nav"), { attributes: true, subtree: true, attributeFilter: ["class"] });
  const railObserver = new MutationObserver(syncPhoneBadges);
  railObserver.observe($("#phone-sheet-groups"), { childList: true, subtree: true });
  phoneShell.observers = [navObserver, railObserver];
  syncPhoneTabs();
  syncPhoneBadges();
};

const unmountPhoneShell = () => {
  if (!phoneShell.mounted) {
    return;
  }
  closePhoneSheet();
  moveRailParts(false);
  for (const observer of phoneShell.observers) {
    observer.disconnect();
  }
  phoneShell.observers = [];
  $("#phone-sheet")?.remove();
  document.querySelector(".phone-tabs")?.remove();
  phoneShell.mounted = false;
};

const syncPhoneLayout = () => {
  const phone = isPhoneLayout();
  document.documentElement.classList.toggle("phone", phone);
  if (phone) {
    mountPhoneShell();
  } else {
    unmountPhoneShell();
  }
};

// A page that changes the computer itself, opened on a phone.
const showDesktopOnlyView = (name) => {
  showView(name);
  setChildren($(`#view-${name}`),
    el("div", { class: "card phone-desktop-only" },
      el("h2", {}, `${VIEW_TITLES[name] ?? name}只能在电脑上用`),
      el("p", { class: "card-sub" }, "手机只用来阅读。设置、密钥、备份、存储和 QQ 收藏图会改动电脑上的东西，请到电脑上的 ChatLens 里操作。"),
      el("button", { class: "btn small", type: "button", onclick: () => openView("brief") }, "回到简报")));
};

if (phoneMedia !== null) {
  phoneMedia.addEventListener?.("change", () => {
    if (document.readyState !== "loading") {
      syncPhoneLayout();
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  if (isPhoneLayout()) {
    mountPhoneShell();
  }
});
