"use strict";

/* ---------- 群 → 个人页 ----------
   One person of the group, for the dates the 群 page shows (same range
   control): how much and when they talk, the "好感度趋势" (replies and @s
   with the 4 people they talk with most, per day or week), who warms up to
   them or cools off (second half of the range against the first), everyone
   they talk with, the other groups they talk in, and everything they said,
   newest first, paged to the end. A step of the 群 page ({ group, person }),
   so back returns to the group or the previous person. No AI calls. */

const PERSON_MESSAGE_PAGE = 50;
const PERSON_CHANGES_PREVIEW = 5;
const PERSON_PARTNERS_PREVIEW = 12;
const PERSON_CHART = { width: 640, height: 230, left: 34, right: 104, top: 12, bottom: 26 };
const PERSON_LABEL_GAP = 14;
const PERSON_TEXT_PREVIEW = 400;

/* ---------- navigation and loading ---------- */

// The page still shows what an answer was asked for (person, group or all
// groups, range; for the messages also the 所有群 page's group filter, which
// changes only them).
const personRequestKey = ({ withFilter = false } = {}) => {
  const page = app.groupPage;
  return { groupId: page.groupId, uin: page.person, all: page.personAll, range: JSON.stringify(page.range), filter: withFilter ? page.personGroupFilter : null };
};
const personRequestIsCurrent = (key) => JSON.stringify(personRequestKey({ withFilter: key.filter !== null })) === JSON.stringify(key);

// A person clicked in a list: the same kind of page (this group, or all
// groups). Their 所有群 page's 「← TA 在「群」」 names a group they talk in:
// where the two talk most (else this page's group, for someone further out).
const personOpen = (uin) => {
  if (!app.groupPage.personAll) {
    openPersonView(uin);
    return;
  }
  const partner = app.groupPage.personData?.partners?.find((item) => String(item.uin) === String(uin));
  openPersonAcross(uin, partner?.groups?.[0]?.groupId ?? app.groupPage.groupId);
};

const personGroupName = (groupId) =>
  (app.groupPage.data?.groupId === groupId ? app.groupPage.data.name : null)
  ?? groupChoices().find((group) => group.groupId === groupId)?.name
  ?? groupId;

const loadPersonMessages = async ({ more = false } = {}) => {
  const key = personRequestKey({ withFilter: true });
  const current = app.groupPage.personMessages;
  const last = more ? current?.items.at(-1) : undefined;
  replaceGroupPage({ personMessages: { items: more ? current.items : [], hasMore: false, loading: true, error: null } });
  renderGroupView();
  const range = groupRangeUnix();
  const params = new URLSearchParams({ uin: key.uin, fromUnix: String(range.fromUnix), toUnix: String(range.toUnix), limit: String(PERSON_MESSAGE_PAGE) });
  if (key.all && !key.filter) {
    params.set("all", "1");
  } else {
    params.set("groupId", key.all ? key.filter : key.groupId);
  }
  if (last !== undefined) {
    params.set("beforeSentAt", String(last.sentAt));
    params.set("beforeRowId", last.rowId);
  }
  try {
    const page = await api(`/api/group/person/messages?${params}`);
    if (personRequestIsCurrent(key)) {
      replaceGroupPage({ personMessages: { items: [...(more ? current.items : []), ...page.items], hasMore: page.hasMore, loading: false, error: null } });
    }
  } catch (error) {
    if (personRequestIsCurrent(key)) {
      replaceGroupPage({ personMessages: { items: more ? current.items : [], hasMore: more, loading: false, error: error.message } });
    }
  }
  renderGroupView();
};

// The profile only (the messages keep the pages already shown).
const loadPersonData = async () => {
  const key = personRequestKey();
  const range = groupRangeUnix();
  replaceGroupPage({ personLoading: true, personError: null });
  renderGroupView();
  try {
    const params = new URLSearchParams({ uin: key.uin, fromUnix: String(range.fromUnix), toUnix: String(range.toUnix) });
    if (!key.all) {
      params.set("groupId", key.groupId);
    }
    const data = await api(`${key.all ? "/api/person-across" : "/api/group/person"}?${params}`);
    if (personRequestIsCurrent(key)) {
      replaceGroupPage({ personData: data, personDataKey: JSON.stringify(key), personLoading: false });
    }
  } catch (error) {
    if (personRequestIsCurrent(key)) {
      replaceGroupPage({ personLoading: false, personError: error.message });
    }
  }
  renderGroupView();
};

const loadPersonPage = () => {
  loadPersonMessages();
  loadPersonData();
};

// Back to a page already shown (same person, group, kind and range): draw
// what it holds, messages paged as far as they were, so back lands at the
// same spot; only the profile is fetched again.
const showPersonPage = (patch, step) => {
  showView("group");
  replaceGroupPage({ choosing: false, ...patch });
  const kept = app.groupPage.personData !== null && app.groupPage.personDataKey === JSON.stringify(personRequestKey());
  if (!kept) {
    replaceGroupPage({ personData: null, personDataKey: null, personMessages: null });
  }
  // Back / forward restore the scroll position themselves; a click starts at the top.
  if (!viewHistory.restoring) {
    window.scrollTo(0, 0);
  }
  markViewStep(step);
  if (kept) {
    loadPersonData();
    return;
  }
  loadPersonPage();
};

// Opens one person's page (in this group, or in `groupId`).
const openPersonView = (uin, groupId = app.groupPage.groupId) => {
  const sameGroup = groupId === app.groupPage.groupId;
  wallWritePref(GROUP_LAST_KEY, groupId);
  showPersonPage({
    groupId, person: String(uin), personAll: false,
    ...(sameGroup ? {} : { data: null, relFocus: null, openDays: new Set(), expanded: new Set() }),
  }, { group: groupId, person: String(uin) });
};

// One person across every group (web/person_across.js), reached from their
// page in a group, which stays the step before it.
const openPersonAcross = (uin, groupId = app.groupPage.groupId) => {
  const samePage = app.groupPage.personAll && app.groupPage.person === String(uin) && app.groupPage.groupId === groupId;
  const sameGroup = groupId === app.groupPage.groupId;
  showPersonPage({
    groupId, person: String(uin), personAll: true, relFocus: null,
    ...(samePage ? {} : { personGroupFilter: "" }),
    ...(sameGroup ? {} : { data: null, openDays: new Set(), expanded: new Set() }),
  }, { group: groupId, person: String(uin), all: true });
};

// 「← 群名」: the browser's back when the group is the screen before.
const backFromPerson = () => {
  const groupId = app.groupPage.groupId;
  goBackTo((prev) => prev.view === "group" && prev.step?.group === groupId && !prev.step?.person, () => openGroupView(groupId));
};

/* ---------- charts ---------- */

const TREND_UNIT_NAMES = { hour: "小时", day: "天", week: "周" };

const bucketLabel = (trend, start) => {
  const hkt = unixToHkt(start);
  const day = shortDay(hkt.slice(0, 10));
  if (trend.unit === "hour") {
    return `${day} ${hkt.slice(11, 13)}点`;
  }
  return trend.unit === "week" ? `${day}起一周` : day;
};

// Plain columns (one series, so no legend): values with a tooltip each.
// With `onPick`, a column is a button (a day's column shows that day).
const personBars = (values, labelOf, ariaLabel, onPick = null) => {
  const max = Math.max(1, ...values);
  return el("figure", { class: "gp-bars pp-bars", "aria-label": ariaLabel },
    el("div", { class: "gp-bars-plot" },
      el("span", { class: "gp-axis-max" }, briefNumber(max)),
      values.map((value, index) => el(onPick === null ? "span" : "button", {
        class: `gp-bar pp-bar${value === 0 ? " empty" : ""}${onPick === null ? "" : " pickable"}`,
        type: onPick === null ? undefined : "button",
        style: `height:${Math.max(value === 0 ? 4 : 6, (value / max) * 100)}%`,
        title: `${labelOf(index)}：${briefNumber(value)} 条${onPick === null ? "" : "。点击只看这天"}`,
        onclick: onPick === null ? undefined : () => onPick(index),
      }))),
    el("figcaption", { class: "gp-axis-days" },
      el("span", {}, labelOf(0)),
      values.length > 2 ? el("span", {}, labelOf(Math.floor(values.length / 2))) : null,
      el("span", {}, labelOf(values.length - 1))));
};

// Moves end labels apart vertically so none overlap, and back up from
// `bottom` when lines ending near zero would push them below the plot.
const spreadLabels = (ends, bottom) => {
  const sorted = [...ends].sort((left, right) => left.y - right.y);
  for (let index = 1; index < sorted.length; index += 1) {
    sorted[index].labelY = Math.max(sorted[index].y, sorted[index - 1].labelY + PERSON_LABEL_GAP);
  }
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const limit = index === sorted.length - 1 ? bottom : sorted[index + 1].labelY - PERSON_LABEL_GAP;
    sorted[index].labelY = Math.min(sorted[index].labelY, limit);
  }
  return sorted;
};

const trendChart = (trend, names) => {
  const { width, height, left, right, top, bottom } = PERSON_CHART;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const count = trend.starts.length;
  const max = Math.max(1, ...trend.series.flatMap((line) => line.values));
  const xOf = (index) => left + (count === 1 ? plotW / 2 : (index * plotW) / (count - 1));
  const yOf = (value) => top + plotH - (value / max) * plotH;
  const ends = spreadLabels(trend.series.map((line, index) => ({ line, index, y: yOf(line.values.at(-1)), labelY: yOf(line.values.at(-1)) })), top + plotH);
  const crosshair = svgEl("line", { class: "pp-cross", x1: 0, x2: 0, y1: top, y2: top + plotH, visibility: "hidden" });
  const tip = el("div", { class: "pp-tip", hidden: true });
  const svg = svgEl("svg", { class: "pp-trend-svg", viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": "好感度趋势：每段时间互相回复和 @ 的次数" },
    // Whole counts only, each once (a max of 1 would label 0 / 1 / 1).
    [...new Set([0, Math.round(max / 2), max])].map((tick) => [
      svgEl("line", { class: "pp-grid", x1: left, x2: left + plotW, y1: yOf(tick), y2: yOf(tick) }),
      svgEl("text", { class: "pp-axis", x: left - 6, y: yOf(tick), dy: "0.35em", "text-anchor": "end" }, briefNumber(tick)),
    ]),
    [0, Math.floor((count - 1) / 2), count - 1].filter((value, index, all) => all.indexOf(value) === index).map((index) => svgEl("text", {
      class: "pp-axis", x: xOf(index), y: height - 8, "text-anchor": index === 0 ? "start" : index === count - 1 ? "end" : "middle",
    }, bucketLabel(trend, trend.starts[index]))),
    crosshair,
    trend.series.map((line, index) => [
      svgEl("path", { class: `pp-line s${index}`, d: line.values.map((value, bucket) => `${bucket === 0 ? "M" : "L"}${xOf(bucket).toFixed(1)} ${yOf(value).toFixed(1)}`).join("") }),
      svgEl("circle", { class: `pp-end s${index}`, cx: xOf(count - 1), cy: yOf(line.values.at(-1)), r: 4 }),
    ]),
    ends.map((end) => svgEl("text", { class: "pp-end-label", x: xOf(count - 1) + 9, y: end.labelY, dy: "0.35em" }, shortName(names.get(end.line.uin) ?? end.line.name))),
    svgEl("rect", {
      class: "pp-hit", x: left, y: top, width: plotW, height: plotH,
      onpointermove: (event) => {
        const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(svg.getScreenCTM().inverse());
        const index = count === 1 ? 0 : Math.max(0, Math.min(count - 1, Math.round(((point.x - left) / plotW) * (count - 1))));
        crosshair.setAttribute("x1", xOf(index));
        crosshair.setAttribute("x2", xOf(index));
        crosshair.setAttribute("visibility", "visible");
        const rows = trend.series.map((line, series) => ({ line, series, value: line.values[index] })).sort((a, b) => b.value - a.value);
        setChildren(tip, el("strong", {}, bucketLabel(trend, trend.starts[index])), rows.map((row) => el("div", { class: "pp-tip-row" },
          el("span", { class: `pp-swatch s${row.series}` }), el("span", {}, names.get(row.line.uin) ?? row.line.name), el("b", {}, briefNumber(row.value)))));
        tip.hidden = false;
        const box = svg.getBoundingClientRect();
        const x = ((xOf(index) / width) * box.width);
        tip.style.left = `${Math.min(box.width - tip.offsetWidth - 4, Math.max(4, x + 12))}px`;
      },
      onpointerleave: () => {
        crosshair.setAttribute("visibility", "hidden");
        tip.hidden = true;
      },
    }));
  return el("div", { class: "pp-trend-chart" }, svg, tip);
};

/* ---------- sections ---------- */

const personLink = (person, extra = null) => el("button", {
  class: "pp-person", type: "button", title: `打开 ${person.name} 的个人页`, onclick: () => personOpen(person.uin),
}, personAvatar(person, "sm"), el("span", { class: "rel-pair-names" }, personLabel(person)), extra);

const personHeader = (data) => {
  const { person } = data;
  const groupId = app.groupPage.groupId;
  return el("section", { class: "card pp-head" },
    el("button", { class: "btn small pp-back", type: "button", title: "回到这个群", onclick: backFromPerson }, `← ${personGroupName(groupId)}`),
    el("div", { class: "pp-head-main" },
      el("span", { class: "pp-avatar" }, personAvatar(person)),
      el("div", {},
        el("h2", {}, person.name, person.isSelf ? el("span", { class: "kb-badge" }, "我") : null),
        el("p", { class: "gp-head-stats" },
          el("span", { class: "gp-range-label" }, groupRangeLabel()), " ",
          el("strong", {}, briefNumber(person.messages)), " 条发言",
          person.media > 0 ? `（${briefNumber(person.media)} 条图片 / 文件）` : "", " · 活跃 ",
          el("strong", {}, briefNumber(person.activeDays)), " 天",
          person.lastAt ? ` · 最近一次 ${briefMoment(person.lastAt)}` : ""),
        person.firstEverAt ? el("p", { class: "kb-meta" }, `本地记录里 TA 第一次在这个群说话：${shortDay(unixToHkt(person.firstEverAt).slice(0, 10))}`) : null,
        groupRangeControl())),
    el("div", { class: "gp-head-actions" },
      person.lastAt ? el("button", {
        class: "btn primary", type: "button",
        onclick: () => openMessagesView({ groupId, groupName: personGroupName(groupId), fromUnix: person.lastAt - 600, scrollToTime: person.lastAt, origin: groupOrigin() }),
      }, "在聊天里看 TA 最近的发言") : null,
      el("button", { class: "btn", type: "button", onclick: () => openGroupGallery({ sender: person.uin, senderLabel: person.name }) }, "看 TA 发的图"),
      data.otherGroups.length === 0 ? null : el("button", {
        class: "btn", type: "button", title: "TA 在所有群的发言、来往和跨群关系网",
        onclick: () => openPersonAcross(person.uin),
      }, `看 TA 在所有群（另有 ${data.otherGroups.length} 个群）→`)));
};

const personTrend = (data, names) => {
  const { trend } = data;
  const unit = TREND_UNIT_NAMES[trend.unit];
  return el("section", { class: "card gp-section pp-trend" },
    el("h3", {}, "好感度趋势", el("span", { class: "kb-meta" }, `　每${unit}和 TA 互相回复 / @ 的次数`)),
    trend.series.length === 0
      ? el("p", { class: "kb-meta" }, "这段时间 TA 没有和谁互相回复或 @ 过。")
      : [
        el("div", { class: "pp-legend" }, trend.series.map((line, index) => el("button", {
          class: "pp-legend-item", type: "button", title: `打开 ${names.get(line.uin) ?? line.name} 的个人页`, onclick: () => personOpen(line.uin),
        }, el("span", { class: `pp-swatch s${index}` }), personAvatar({ uin: line.uin, name: line.name }, "sm"),
        el("span", {}, names.get(line.uin) ?? line.name), el("small", {}, `${briefNumber(line.values.reduce((sum, value) => sum + value, 0))} 次`)))),
        trendChart(trend, names),
      ],
    el("span", { class: "gp-label" }, `TA 每${unit}的发言`),
    personBars(trend.own, (index) => bucketLabel(trend, trend.starts[index]), `TA 每${unit}的发言数`, trend.unit !== "day" ? null : (index) => {
      const day = unixToHkt(trend.starts[index]).slice(0, 10);
      setGroupRange({ preset: "custom", fromDay: day, toDay: day });
    }));
};

const changeList = (id, items, arrow) => (items.length === 0
  ? el("p", { class: "kb-meta" }, "没有")
  : expandable(id, items, PERSON_CHANGES_PREVIEW, (shown) => el("ol", { class: "pp-list" }, shown.map((item) => el("li", {},
    personLink(item, el("span", { class: "rel-pair-count" }, `${item.before} → ${item.after} ${arrow}`))))), "人"));

const personChanges = (data) => el("section", { class: "card gp-section" },
  el("h3", {}, "升温 / 降温", el("span", { class: "kb-meta" }, "　所选时间的后半段比前半段")),
  el("div", { class: "pp-changes" },
    el("div", {}, el("span", { class: "gp-label" }, "最近更常来往"), changeList("ppRising", data.changes.rising, "↑")),
    el("div", {}, el("span", { class: "gp-label" }, "最近少了"), changeList("ppFalling", data.changes.falling, "↓"))));

const personHours = (data) => {
  const busiest = data.hours.indexOf(Math.max(...data.hours));
  return el("section", { class: "card gp-section" },
    el("h3", {}, "什么时候说话"),
    personBars(data.hours, (hour) => `${hour} 点`, "每个小时的发言数"),
    data.person.messages === 0 ? null : el("p", { class: "kb-meta" }, `最常在 ${busiest} 点前后说话。`));
};

const personPartners = (data) => el("section", { class: "card gp-section" },
  el("h3", {}, "和 TA 来往的人", el("span", { class: "kb-meta" }, `　${briefNumber(data.partners.length)} 人 · → TA 找对方　← 对方找 TA`)),
  data.partners.length === 0 ? el("p", { class: "kb-meta" }, "这段时间没有。") : expandable("ppPartners", data.partners, PERSON_PARTNERS_PREVIEW, (shown) => el("ol", { class: "pp-list" },
    shown.map((partner) => el("li", {}, personLink(partner, el("span", {
      class: "rel-pair-count",
      title: `TA → ${partner.name}：${sentText(partner.out)}\n${partner.name} → TA：${sentText(partner.back)}`,
    }, `→${partner.out.replies + partner.out.ats} ←${partner.back.replies + partner.back.ats}`))))), "人"));

const personOtherGroups = (data) => (data.otherGroups.length === 0 ? null : el("section", { class: "card gp-section" },
  el("h3", {}, "TA 也在这些群说话", el("span", { class: "kb-meta" }, "　所选时间")),
  el("ol", { class: "pp-list" }, data.otherGroups.map((group) => el("li", {}, el("button", {
    class: "pp-person", type: "button", onclick: () => openPersonView(data.person.uin, group.groupId),
  }, avatarEl(group.name, group.groupId, "sm", groupAvatarUrl(group.groupId)), el("span", { class: "rel-pair-names" }, group.name),
  el("span", { class: "rel-pair-count" }, `${briefNumber(group.messages)} 条`)))))));

const messageText = (item) => {
  const text = item.isMedia === 1 ? mediaLabelText(item.mediaKinds, item.text) : item.text;
  return Array.from(text).length > PERSON_TEXT_PREVIEW ? `${Array.from(text).slice(0, PERSON_TEXT_PREVIEW).join("")}…` : text;
};

// On the 所有群 page: which group's messages to list ("" = all).
const personGroupFilter = (data) => el("select", {
  class: "kb-select pp-group-filter",
  "aria-label": "只看某个群的发言",
  onchange: (event) => {
    replaceGroupPage({ personGroupFilter: event.target.value });
    loadPersonMessages();
  },
},
el("option", { value: "", selected: app.groupPage.personGroupFilter === "" }, "所有群"),
data.groups.filter((group) => group.messages > 0).map((group) => el("option", {
  value: group.groupId, selected: app.groupPage.personGroupFilter === group.groupId,
}, `${group.groupName}（${briefNumber(group.messages)}）`)));

const personMessageList = (data, names) => {
  const page = app.groupPage.personMessages;
  const across = app.groupPage.personAll;
  const groupTitles = new Map((data.groups ?? []).map((group) => [group.groupId, group.groupName]));
  const groupOf = (item) => item.groupId ?? app.groupPage.groupId;
  const openAt = (item) => openMessagesView({ groupId: groupOf(item), groupName: groupTitles.get(groupOf(item)) ?? personGroupName(groupOf(item)), fromUnix: item.sentAt - 600, scrollToTime: item.sentAt, origin: groupOrigin() });
  return el("section", { class: "card gp-section pp-messages" },
    el("div", { class: "gp-section-head" },
      el("h3", {}, "TA 的发言", el("span", { class: "kb-meta" }, `　所选时间 ${briefNumber(data.person.messages)} 条，最新在前；点一条跳到聊天里`)),
      across ? personGroupFilter(data) : null),
    page === null ? el("p", { class: "kb-meta" }, "正在读取…") : [
      el("ol", { class: "pp-msgs" }, page.items.map((item) => el("li", {}, el("button", { type: "button", onclick: () => openAt(item) },
        el("span", { class: "pp-msg-time" }, `${shortDay(unixToHkt(item.sentAt).slice(0, 10))} ${unixToHkt(item.sentAt).slice(11, 16)}`),
        el("span", { class: "pp-msg-body" },
          across ? el("span", { class: "kb-badge plain pp-msg-group" }, groupTitles.get(groupOf(item)) ?? groupOf(item)) : null,
          item.replyToUin ? el("span", { class: "kb-badge" }, `回复 ${names.get(item.replyToUin) ?? item.replyToUin}`) : null,
          messageText(item)))))),
      page.error ? el("p", { class: "notice risk" }, `读取失败：${page.error}`) : null,
      page.hasMore || page.loading
        ? el("button", { class: "kb-facet-more gp-more", type: "button", disabled: page.loading, onclick: () => loadPersonMessages({ more: true }) },
          page.loading ? "正在读取…" : `再显示 ${PERSON_MESSAGE_PAGE} 条（已显示 ${briefNumber(page.items.length)} 条）`)
        : null,
    ]);
};

const groupPersonPage = () => {
  const page = app.groupPage;
  const data = page.personData;
  if (data === null || data === undefined) {
    return el("div", { class: "gp-page" },
      page.personAll
        ? el("button", { class: "btn small", type: "button", onclick: backFromPersonAcross }, `← TA 在「${personGroupName(page.groupId)}」`)
        : el("button", { class: "btn small", type: "button", onclick: backFromPerson }, `← ${personGroupName(page.groupId)}`),
      page.personError ? el("div", { class: "notice risk" }, `读取失败：${page.personError}`) : el("p", { class: "kb-meta" }, page.personAll ? "正在整理 TA 在所有群的记录…" : "正在读取…"));
  }
  if (page.personAll) {
    return personAcrossPage(data);
  }
  const names = new Map([...data.partners.map((partner) => [partner.uin, partner.name]), [data.person.uin, data.person.name]]);
  return el("div", { class: `gp-page pp-page ${page.personLoading ? "is-loading" : ""}` },
    personHeader(data),
    el("div", { class: "gp-grid" },
      el("div", { class: "gp-col" }, personTrend(data, names), personMessageList(data, names)),
      el("div", { class: "gp-col" }, personChanges(data), personHours(data), personPartners(data), personOtherGroups(data))));
};
