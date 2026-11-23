"use strict";

/* ---------- 画廊: the date rail at the right edge of the wall ----------
   Every day (or, over a long stretch, every month) that has pictures under
   the current filter, newest at the top. A click starts the wall at that day
   (the same as 「跳到」); the day the wall is showing is marked as it scrolls.
   Only in time order, and not on a phone. */

// Past this many days the rail lists months.
const GALLERY_RAIL_DAYS_MAX = 45;
const GALLERY_RAIL_SCROLL_MS = 150;

// key: the filter the days belong to. days: [{ day: "2026-11-24", n }] newest first.
// stamp: which load of the wall the days were asked for (a reload asks again).
const galleryRail = { key: "", days: null, timer: null, stamp: -1 };

const galleryRailShown = () => app.gallery.sort === "recent" && app.gallery.similar === null && window.innerWidth > KB_MOBILE_WIDTH;

// The filter without the 「跳到」 cursor: the rail shows the whole stretch it jumps within.
const galleryRailParams = () => {
  const params = galleryFilterParams();
  const bounds = galleryTimeBounds({ ...app.gallery, until: null });
  for (const name of ["fromUnix", "toUnix", "days"]) {
    params.delete(name);
  }
  if (app.gallery.range === null && app.gallery.days === 0) {
    // Everything recorded: said as such, or the question would change every second.
    params.set("days", "0");
  } else if (bounds.days === undefined) {
    params.set("fromUnix", String(bounds.fromUnix));
    params.set("toUnix", String(bounds.toUnix));
  } else {
    params.set("days", String(bounds.days));
  }
  return params.toString();
};

// [{ key, label, title, until, first }]: one stop per day, or per month.
const galleryRailStops = (days) => {
  if (days.length <= GALLERY_RAIL_DAYS_MAX) {
    return days.map(({ day, n }, index) => ({
      key: day,
      label: String(Number(day.slice(8, 10))),
      title: `${Number(day.slice(5, 7))}月${Number(day.slice(8, 10))}日 · ${briefNumber(n)} 张`,
      until: galleryDayStart(day) + 86400,
      // The month is written where it changes.
      heading: index === 0 || days[index - 1].day.slice(0, 7) !== day.slice(0, 7) ? `${Number(day.slice(5, 7))}月` : null,
    }));
  }
  const months = new Map();
  for (const { day, n } of days) {
    const month = day.slice(0, 7);
    const entry = months.get(month) ?? { n: 0, lastDay: day };
    months.set(month, { n: entry.n + n, lastDay: entry.lastDay });
  }
  return [...months].map(([month, { n, lastDay }], index, all) => ({
    key: month,
    label: `${Number(month.slice(5, 7))}月`,
    title: `${month.slice(0, 4)}年${Number(month.slice(5, 7))}月 · ${briefNumber(n)} 张`,
    until: galleryDayStart(lastDay) + 86400,
    heading: index === 0 || all[index - 1][0].slice(0, 4) !== month.slice(0, 4) ? month.slice(0, 4) : null,
  }));
};

// The stop of the picture at the top of the screen.
const galleryRailCurrent = (stops) => {
  const top = wallTopIndex(GALLERY_WALL_KEY);
  const entry = top === null ? null : galleryEntries().slice(top).find((candidate) => candidate.kind === "tile");
  if (!entry) {
    return null;
  }
  const day = galleryDayKey(entry.item.lastAt);
  return stops.find((stop) => stop.key === day || stop.key === day.slice(0, 7))?.key ?? null;
};

const galleryRailNodes = () => {
  const days = galleryRail.days;
  if (days === null || days.length < 2) {
    return [];
  }
  const stops = galleryRailStops(days);
  const current = galleryRailCurrent(stops);
  return [
    app.gallery.until === null ? null : el("button", {
      class: "gallery-rail-newest", type: "button", title: "回到最新的图", onclick: () => applyGalleryFilter({ until: null }),
    }, "最新"),
    stops.map((stop) => [
      stop.heading === null ? null : el("span", { class: "gallery-rail-heading" }, stop.heading),
      el("button", {
        class: stop.key === current ? "gallery-rail-stop active" : "gallery-rail-stop",
        type: "button",
        title: `${stop.title}，点一下从这里看起`,
        "data-stop": stop.key,
        onclick: () => galleryJumpTo(stop.until),
      }, stop.label),
    ]),
  ];
};

// Scrolls only the rail itself (scrollIntoView would move the page as well).
const showGalleryRailCurrent = (node) => {
  const stop = node.querySelector(".gallery-rail-stop.active");
  if (stop === null) {
    return;
  }
  if (stop.offsetTop < node.scrollTop) {
    node.scrollTop = stop.offsetTop;
  } else if (stop.offsetTop + stop.offsetHeight > node.scrollTop + node.clientHeight) {
    node.scrollTop = stop.offsetTop + stop.offsetHeight - node.clientHeight;
  }
};

const paintGalleryRail = () => {
  const node = document.getElementById("gallery-rail");
  if (node !== null) {
    setChildren(node, galleryRailNodes());
    node.hidden = node.childElementCount === 0;
    showGalleryRailCurrent(node);
  }
};

const loadGalleryRail = async () => {
  if (!galleryRailShown()) {
    return;
  }
  const key = galleryRailParams();
  // The same filter is asked again when the wall itself was loaded anew
  // (刷新, new pictures): the days may have changed.
  const stamp = app.gallery.loadedAt ?? 0;
  if (galleryRail.key === key && galleryRail.stamp === stamp) {
    return;
  }
  const sameFilter = galleryRail.key === key;
  galleryRail.key = key;
  galleryRail.stamp = stamp;
  if (!sameFilter) {
    // Another filter's days are not this one's.
    galleryRail.days = null;
  }
  try {
    const answer = await api(`/api/gallery/days?${key}`);
    if (galleryRail.key === key && galleryRail.stamp === stamp) {
      galleryRail.days = answer.days;
    }
  } catch {
    // A console that has not been restarted since this was added has no such
    // list: the wall has no rail until the wall is loaded again.
    if (galleryRail.key === key && galleryRail.stamp === stamp) {
      galleryRail.days = [];
    }
  }
  paintGalleryRail();
};

// The rail's place in the page (gallery.js); filled when the days arrive.
const galleryRailNode = () => {
  if (!galleryRailShown()) {
    return null;
  }
  // Asked first: another filter's days are dropped before anything is drawn from them.
  loadGalleryRail();
  const node = el("nav", { id: "gallery-rail", class: "gallery-rail", "aria-label": "按日期跳" }, galleryRailNodes());
  node.hidden = node.childElementCount === 0;
  // The wall mounts after this page is put together: the day in view is known then.
  requestAnimationFrame(() => markGalleryRailCurrent());
  return node;
};

// Marks the day in view as the wall scrolls.
const markGalleryRailCurrent = () => {
  galleryRail.timer = null;
  const node = document.getElementById("gallery-rail");
  if (app.view !== "media" || node === null || galleryRail.days === null) {
    return;
  }
  const current = galleryRailCurrent(galleryRailStops(galleryRail.days));
  for (const stop of node.querySelectorAll(".gallery-rail-stop")) {
    stop.classList.toggle("active", stop.dataset.stop === current);
  }
  showGalleryRailCurrent(node);
};

window.addEventListener("scroll", () => {
  if (app.view === "media" && galleryRail.timer === null) {
    galleryRail.timer = setTimeout(markGalleryRailCurrent, GALLERY_RAIL_SCROLL_MS);
  }
}, { passive: true });
