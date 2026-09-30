"use strict";

/* ---------- 个人页 → 「看 TA 在所有群」 ----------
   One person across every group (src/person_across.js), reached from their
   page in a group (which stays the step before it: back returns there).
   Many friends sit in the same few groups, so this page shows the groups
   they talk in and the name they use in each, the groups they share with
   you, their network across groups (their partners, and how those talk among
   themselves anywhere), whom they talk with and in which groups, the trend,
   and everything they said, tagged by group. Same dates as the 群 page. */

const PA_GROUPS_PREVIEW = 12;
const PA_PARTNERS_PREVIEW = 12;
const PA_PARTNER_GROUPS = 4;

// 「← TA 在「群」」: the browser's back when their group page is the step before.
const backFromPersonAcross = () => {
  const { groupId, person: uin } = app.groupPage;
  goBackTo((prev) => prev.view === "group" && prev.step?.person === uin && !prev.step?.all, () => openPersonView(uin, groupId));
};

const personAcrossHeader = (data) => {
  const { person } = data;
  return el("section", { class: "card pp-head" },
    el("button", { class: "btn small pp-back", type: "button", title: "回到 TA 在这个群的页", onclick: backFromPersonAcross },
      `← TA 在「${personGroupName(app.groupPage.groupId)}」`),
    el("div", { class: "pp-head-main" },
      el("span", { class: "pp-avatar" }, personAvatar(person)),
      el("div", {},
        el("h2", {}, person.name, person.isSelf ? el("span", { class: "kb-badge" }, "我") : null, el("span", { class: "kb-badge plain" }, "所有群")),
        el("p", { class: "gp-head-stats" },
          el("span", { class: "gp-range-label" }, groupRangeLabel()), " ",
          el("strong", {}, briefNumber(person.messages)), " 条发言",
          person.media > 0 ? `（${briefNumber(person.media)} 条图片 / 文件）` : "", " · 在 ",
          el("strong", {}, briefNumber(person.groupsInRange)), " 个群说话 · 活跃 ",
          el("strong", {}, briefNumber(person.activeDays)), " 天",
          person.lastAt ? ` · 最近一次 ${briefMoment(person.lastAt)}` : ""),
        // Only your own groups are stored, so "shared" means both of you spoke there.
        el("p", { class: "kb-meta" }, `本地记录里 TA 在 ${person.groupsEver} 个群说过话`, person.isSelf ? "" : `，其中 ${person.sharedWithMe} 个群你们都发过言`, "。"),
        groupRangeControl())));
};

const personAcrossGroups = (data) => {
  const max = Math.max(1, ...data.groups.map((group) => group.messages));
  return el("section", { class: "card gp-section" },
    el("h3", {}, "TA 在哪些群", el("span", { class: "kb-meta" }, "　所选时间的发言 · 点一个群看 TA 在那里")),
    expandable("paGroups", data.groups, PA_GROUPS_PREVIEW, (shown) => el("ol", { class: "pa-groups" }, shown.map((group) => el("li", {},
      el("button", { class: "pa-group", type: "button", title: `看 TA 在「${group.groupName}」`, onclick: () => openPersonView(data.uin, group.groupId) },
        avatarEl(group.groupName, group.groupId, "sm", groupAvatarUrl(group.groupId)),
        el("span", { class: "pa-group-name" }, el("strong", {}, group.groupName), el("small", {}, `叫「${group.name}」`)),
        el("span", { class: "gp-rank-bar" }, el("span", { style: `width:${(group.messages / max) * 100}%` })),
        el("span", { class: "rel-pair-count" }, group.messages > 0 ? `${briefNumber(group.messages)} 条` : "这段时间没说话"))))), "个群"));
};

const personAcrossNetwork = (data) => groupRelations(
  { groupId: `all-${data.uin}`, range: data.range, relations: data.network },
  {
    title: "跨群关系网",
    subtitle: "TA 和谁来往，这些人之间又怎么来往（所有群合起来）",
    openPerson: personOpen,
    openLabel: "看 TA 在所有群 →",
  },
);

const personAcrossPartners = (data) => el("section", { class: "card gp-section" },
  el("h3", {}, "和 TA 来往的人", el("span", { class: "kb-meta" }, `　所有群 · ${briefNumber(data.partners.length)} 人 · → TA 找对方　← 对方找 TA`)),
  data.partners.length === 0 ? el("p", { class: "kb-meta" }, "这段时间没有。") : expandable("paPartners", data.partners, PA_PARTNERS_PREVIEW, (shown) => el("ol", { class: "pp-list" },
    shown.map((partner) => el("li", { class: "pa-partner" },
      personLink(partner, el("span", {
        class: "rel-pair-count",
        title: `TA → ${partner.name}：${sentText(partner.out)}\n${partner.name} → TA：${sentText(partner.back)}`,
      }, `→${partner.out.replies + partner.out.ats} ←${partner.back.replies + partner.back.ats}`)),
      el("div", { class: "pa-partner-groups" },
        partner.groups.slice(0, PA_PARTNER_GROUPS).map((group) => el("span", { class: "tag plain", title: `在「${group.groupName}」来往 ${group.total} 次` }, `${group.groupName} ${group.total}`)),
        partner.groups.length > PA_PARTNER_GROUPS
          ? el("span", { class: "tag plain more", title: partner.groups.slice(PA_PARTNER_GROUPS).map((group) => `${group.groupName} ${group.total}`).join("、") }, `+${partner.groups.length - PA_PARTNER_GROUPS} 个群`)
          : null)))), "人"));

const personAcrossPage = (data) => {
  const names = new Map([...data.partners.map((partner) => [partner.uin, partner.name]), [data.person.uin, data.person.name]]);
  return el("div", { class: `gp-page pp-page ${app.groupPage.personLoading ? "is-loading" : ""}` },
    personAcrossHeader(data),
    personAcrossNetwork(data),
    el("div", { class: "gp-grid" },
      el("div", { class: "gp-col" }, personTrend(data, names), personMessageList(data, names)),
      el("div", { class: "gp-col" }, personAcrossGroups(data), personChanges(data), personHours(data), personAcrossPartners(data))));
};
