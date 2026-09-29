"use strict";

/* ---------- 画廊: dates, jumping to a day, and back to where you were ----------
   Beside the rolling "N 天" buttons: calendar days (今天 / 昨天) and any day
   range. 「跳到某天」 and 「回到上次看到的位置」 set a time cursor (until): the wall
   then starts at that moment and goes back in time from there, so nobody has
   to scroll through thousands of pictures to get back. Where you were is
   remembered per filter, in this browser only. */

const GALLERY_POSITION_KEY = "cc-gallery-position";
const GALLERY_POSITION_SAVE_MS = 800;
// Only offer to go back when the spot is further down than this.
const GALLERY_POSITION_MIN_GAP_SECONDS = 600;
const GALLERY_CALENDAR = [["today", "今天"], ["yesterday", "昨天"]];
const galleryNav = { saveTimer: null, dismissed: false, pickingDates: false, draftFrom: "", draftTo: "" };

const galleryNowUnix = () => Math.floor(Date.now() / 1000);
const galleryDayStart = (day) =>
  Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / 1000 - HKT_OFFSET_SECONDS;
const galleryTodayKey = () => unixToHkt(galleryNowUnix()).slice(0, 10);
const galleryShiftDay = (day, delta) => unixToHkt(galleryDayStart(day) + delta * 86400 + 3600).slice(0, 10);
const galleryMoment = (unix) => `${Number(unixToHkt(unix).slice(5, 7))}月${Number(unixToHkt(unix).slice(8, 10))}日 ${unixToHkt(unix).slice(11, 16)}`;

// Calendar days as { fromUnix, toUnix, preset }.
const galleryCalendarRange = (preset) => {
  const today = galleryTodayKey();
  return preset === "today"
    ? { fromUnix: galleryDayStart(today), toUnix: galleryNowUnix() + 60, preset }
    : { fromUnix: galleryDayStart(galleryShiftDay(today, -1)), toUnix: galleryDayStart(today), preset };
};

const galleryDaysRange = (fromDay, toDay) => ({ fromUnix: galleryDayStart(fromDay), toUnix: galleryDayStart(toDay) + 86400, preset: "custom" });

// The query's time bounds: the chosen range (or rolling days), cut at the cursor.
const galleryTimeBounds = (tab) => {
  const now = galleryNowUnix();
  const base = tab.range ?? (tab.days === 0 ? { fromUnix: 1, toUnix: now + 60 } : null);
  if (tab.until === null) {
    return base ?? { days: tab.days };
  }
  return {
    fromUnix: base?.fromUnix ?? now - tab.days * 86400,
    toUnix: Math.min(base?.toUnix ?? now + 60, tab.until),
  };
};

/* ---------- remembering the spot ---------- */

// Everything that decides which pictures are shown, except the cursor.
const galleryPositionSignature = (tab) => JSON.stringify({
  kind: tab.kind, ai: tab.ai, groupId: tab.groupId, sender: tab.sender, sort: tab.sort,
  time: tab.range === null ? `days:${tab.days}` : tab.range.preset ?? `${tab.range.fromUnix}-${tab.range.toUnix}`,
});

const readGalleryPosition = () => {
  try {
    return JSON.parse(wallReadPref(GALLERY_POSITION_KEY, "null"));
  } catch {
    return null;
  }
};

const saveGalleryPosition = () => {
  galleryNav.saveTimer = null;
  const tab = app.gallery;
  if (app.view !== "media" || tab.sort !== "recent" || tab.results === null) {
    return;
  }
  const index = wallTopIndex(GALLERY_WALL_KEY);
  const entries = galleryEntries();
  const entry = index === null ? null : entries.slice(index).find((candidate) => candidate.kind === "tile");
  if (!entry) {
    return;
  }
  wallWritePref(GALLERY_POSITION_KEY, JSON.stringify({ signature: galleryPositionSignature(tab), at: entry.item.lastAt, savedAt: galleryNowUnix() }));
};

const scheduleGalleryPositionSave = () => {
  if (galleryNav.saveTimer === null && app.view === "media") {
    galleryNav.saveTimer = setTimeout(saveGalleryPosition, GALLERY_POSITION_SAVE_MS);
  }
};
window.addEventListener("scroll", scheduleGalleryPositionSave, { passive: true });

// The remembered spot for this filter, if it is well below the top.
const galleryReturnOffer = () => {
  const tab = app.gallery;
  const saved = readGalleryPosition();
  const newest = tab.results?.items[0]?.lastAt ?? null;
  if (galleryNav.dismissed || saved === null || tab.until !== null || tab.sort !== "recent" || newest === null) {
    return null;
  }
  if (saved.signature !== galleryPositionSignature(tab) || newest - saved.at < GALLERY_POSITION_MIN_GAP_SECONDS) {
    return null;
  }
  return saved;
};

const galleryJumpTo = (until) => {
  galleryNav.dismissed = true;
  applyGalleryFilter({ until });
};

/* ---------- toolbar pieces ---------- */

const galleryCalendarButtons = () => GALLERY_CALENDAR.map(([preset, label]) => el("button", {
  class: app.gallery.range?.preset === preset ? "wall-mode active" : "wall-mode",
  type: "button",
  "aria-pressed": String(app.gallery.range?.preset === preset),
  onclick: () => applyGalleryFilter({ range: galleryCalendarRange(preset), until: null }),
}, label));

const galleryDatePicker = () => {
  if (!galleryNav.pickingDates) {
    return el("button", {
      class: app.gallery.range?.preset === "custom" ? "wall-mode active" : "wall-mode",
      type: "button",
      onclick: () => {
        galleryNav.pickingDates = true;
        galleryNav.draftFrom = galleryNav.draftFrom || galleryShiftDay(galleryTodayKey(), -1);
        galleryNav.draftTo = galleryNav.draftTo || galleryTodayKey();
        renderMediaView();
      },
    }, "选日期…");
  }
  const input = (key) => el("input", {
    type: "date",
    value: galleryNav[key],
    max: galleryTodayKey(),
    oninput: (event) => { galleryNav[key] = event.target.value; },
  });
  return el("span", { class: "gallery-date-picker" },
    input("draftFrom"), "到", input("draftTo"),
    el("button", {
      class: "btn small primary",
      type: "button",
      onclick: () => {
        const [from, to] = [galleryNav.draftFrom, galleryNav.draftTo].sort();
        if (!/^\d{4}-\d{2}-\d{2}$/u.test(from) || !/^\d{4}-\d{2}-\d{2}$/u.test(to)) {
          return;
        }
        galleryNav.pickingDates = false;
        applyGalleryFilter({ range: galleryDaysRange(from, to), until: null });
      },
    }, "看这几天"),
    el("button", { class: "btn small", type: "button", onclick: () => { galleryNav.pickingDates = false; renderMediaView(); } }, "取消"));
};

// 「跳到某天」: the wall starts at the end of that day.
const galleryJumpControl = () => (app.gallery.sort !== "recent"
  ? null
  : el("label", { class: "gallery-jump", title: "从这一天的最后一张图开始往前看" },
    "跳到",
    el("input", {
      type: "date",
      max: galleryTodayKey(),
      value: app.gallery.until === null ? "" : unixToHkt(app.gallery.until - 1).slice(0, 10),
      onchange: (event) => {
        if (/^\d{4}-\d{2}-\d{2}$/u.test(event.target.value)) {
          galleryJumpTo(galleryDayStart(event.target.value) + 86400);
        }
      },
    })));

// Shown above the wall when there is somewhere to go back to.
const galleryReturnBanner = () => {
  const offer = galleryReturnOffer();
  if (offer === null) {
    return null;
  }
  return el("div", { class: "gallery-return" },
    el("span", {}, `上次看到 ${galleryMoment(offer.at)} 附近`),
    el("button", { class: "btn small primary", type: "button", onclick: () => galleryJumpTo(offer.at + 1) }, "回到那里"),
    el("button", { class: "btn small ghost", type: "button", "aria-label": "不用了", onclick: () => { galleryNav.dismissed = true; renderMediaView(); } }, "×"));
};

// The cursor as a removable condition chip.
const galleryCursorChip = () => (app.gallery.until === null
  ? null
  : { text: `从 ${galleryMoment(app.gallery.until - 1)} 往前看`, remove: () => applyGalleryFilter({ until: null }) });
