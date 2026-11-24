"use strict";

/* ---------- the interface's own icons ----------
   One family, drawn for ChatLens: 24 px grid, one line weight, round ends,
   the text's own colour. Every icon sits next to its word (the rail, the
   phone tabs) or carries a tooltip and an aria-label (the theme button). */

const SVG_NS = "http://www.w3.org/2000/svg";
const ICON_FRAME = "M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z";

const ICON_PATHS = {
  brief: ["M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z", "M7 8.5h10", "M7 12h4.5", "M7 15.5h4.5", "M14.5 12H17v3.5h-2.5z"],
  review: ["M5 5h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z", "M3 10h18", "M8 3v4", "M16 3v4"],
  bookmarks: ["M7 4h10a1 1 0 0 1 1 1v15l-6-4-6 4V5a1 1 0 0 1 1-1z"],
  ask: ["M11 4a7 7 0 1 1 0 14a7 7 0 0 1 0-14z", "M16.2 16.2l4.3 4.3"],
  trends: ["M12 3c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-2 1-3.2 2-4.2c.3 1.6 1 2.4 2 2.7c-.6-2.6-.2-5.8 1-8.5z"],
  group: ["M9 11a3.2 3.2 0 1 0 0-6.4a3.2 3.2 0 0 0 0 6.4z", "M3 19.5c0-3 2.7-5 6-5s6 2 6 5", "M16 5a3 3 0 0 1 0 5.8", "M17.5 14.8c2.1.6 3.5 2.3 3.5 4.7"],
  messages: ["M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7l-4.5 3.5V17H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"],
  media: [ICON_FRAME, "M3.5 16l4.5-4.5 4 4 3-3 5.5 5", "M15.5 9.4a.6.6 0 1 0 .01 0"],
  qqcollect: ["M12 3.5v9", "M8.5 9.5L12 13l3.5-3.5", "M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4", "M4 14h4.5l1.5 2.5h4l1.5-2.5H20"],
  knowledge: ["M12 6.5c-2-1.5-4.5-2-8-2v13c3.5 0 6 .5 8 2c2-1.5 4.5-2 8-2v-13c-3.5 0-6 .5-8 2z", "M12 6.5v13"],
  backup: ["M4 8h16v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z", "M3 4.5h18V8H3z", "M10 12h4"],
  storage: [ICON_FRAME, "M3 13.5h18", "M7 16.4h.01", "M10.5 16.4h.01"],
  settings: ["M4 7h9", "M17 7h3", "M15 5v4", "M4 12h3", "M11 12h9", "M9 10v4", "M4 17h11", "M19 17h1", "M17 15v4"],
  run: ["M8 5.5v13l10.5-6.5z"],
  history: ["M12 4a8 8 0 1 1 0 16a8 8 0 0 1 0-16z", "M12 8v4.5l3 2"],
  watchlist: ["M12 3.8l2.5 5.2 5.7.8-4.1 4 1 5.7-5.1-2.7-5.1 2.7 1-5.7-4.1-4 5.7-.8z"],
  moon: ["M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"],
  sun: ["M12 8a4 4 0 1 1 0 8a4 4 0 0 1 0-8z", "M12 2.5V5", "M12 19v2.5", "M2.5 12H5", "M19 12h2.5", "M5.3 5.3l1.8 1.8", "M16.9 16.9l1.8 1.8", "M5.3 18.7l1.8-1.8", "M16.9 7.1l1.8-1.8"],
  monitor: ["M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z", "M9 20.5h6", "M12 17v3.5"],
  power: ["M12 3.5v8", "M7 6.5a7.5 7.5 0 1 0 10 0"],
  phone: ["M8 3.5h8A1.5 1.5 0 0 1 17.5 5v14a1.5 1.5 0 0 1-1.5 1.5H8A1.5 1.5 0 0 1 6.5 19V5A1.5 1.5 0 0 1 8 3.5z", "M11 17.5h2"],
  menu: ["M4 7h16", "M4 12h16", "M4 17h16"],
};

// An icon as an element, sized by the text around it (1.15em unless a size is given).
const lineIcon = (name, size = null) => {
  const paths = ICON_PATHS[name];
  if (paths === undefined || typeof document.createElementNS !== "function") {
    return document.createElement("span");
  }
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "line-icon");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  if (size !== null) {
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
  }
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
};
