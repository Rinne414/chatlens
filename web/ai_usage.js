"use strict";

/* ---------- 设置 → AI 用量与费用, and the provider presets ----------
   Numbers come from the token counts the API itself reports for every call
   (llm_usage table); money is an estimate from the editable price table. */

const aiUsageState = { usage: null, providers: null, error: null, notice: null, hoverDay: null, showPrices: false, priceDraft: null };

const AI_PURPOSE_LABELS = { map: "简报：单段摘要", reduce: "简报：合并", manual: "自定义总结", quick: "选段总结", other: "其他" };
const AI_CURRENCY_SIGNS = { CNY: "¥", USD: "$" };

const aiMoney = (costs) => {
  const entries = Object.entries(costs ?? {}).filter(([, amount]) => amount > 0);
  if (entries.length === 0) {
    return "—";
  }
  return entries.map(([currency, amount]) => `${AI_CURRENCY_SIGNS[currency] ?? currency}${amount < 0.01 ? amount.toFixed(4) : amount.toFixed(2)}`).join(" + ");
};

const aiTokens = (count) => {
  const value = Number(count) || 0;
  return value >= 10000 ? `${(value / 10000).toFixed(value >= 1000000 ? 0 : 1)} 万` : value.toLocaleString("zh-CN");
};

const loadAiUsage = async () => {
  try {
    const [usage, providers] = await Promise.all([api("/api/llm/usage?days=30"), api("/api/llm/providers")]);
    aiUsageState.usage = usage;
    aiUsageState.providers = providers;
    aiUsageState.error = null;
  } catch (error) {
    aiUsageState.error = error.message;
  }
};

const aiAction = async (path, body, okText) => {
  try {
    await api(path, { method: "POST", body: JSON.stringify(body) });
    aiUsageState.notice = { text: okText, isError: false };
  } catch (error) {
    aiUsageState.notice = { text: error.message, isError: true };
  }
  await loadAiUsage();
  renderSettingsView();
};

const aiPauseRow = (usage) => {
  const pause = usage.pause ?? { paused: false };
  if (pause.paused) {
    return el("div", { class: "ai-pause paused" },
      el("strong", {}, pause.until === null ? "⏸ AI 整理已暂停（直到你恢复）" : `⏸ AI 整理已暂停到 ${unixToHkt(pause.until).slice(5, 16)}`),
      el("span", { class: "card-sub" }, "暂停期间照常收消息，只是不调用 AI；恢复后会接着总结。"),
      el("button", { class: "btn small primary", onclick: () => aiAction("/api/ai/pause", { minutes: 0 }, "已恢复。") }, "恢复"));
  }
  const endOfDayMinutes = Math.max(1, Math.ceil((86400 - ((Math.floor(Date.now() / 1000) + HKT_OFFSET_SECONDS) % 86400)) / 60));
  return el("div", { class: "ai-pause" },
    el("span", {}, "暂停 AI 整理："),
    el("button", { class: "btn small", onclick: () => aiAction("/api/ai/pause", { minutes: 60 }, "已暂停 1 小时。") }, "1 小时"),
    el("button", { class: "btn small", onclick: () => aiAction("/api/ai/pause", { minutes: endOfDayMinutes }, "今天不再调用 AI。") }, "到今天结束"),
    el("button", { class: "btn small", onclick: () => aiAction("/api/ai/pause", { minutes: -1 }, "已暂停，直到你恢复。") }, "一直暂停"));
};

const aiTile = (label, bucket, extra) =>
  el("div", { class: "ai-tile" },
    el("span", { class: "ai-tile-label" }, label),
    el("strong", { class: "ai-tile-value" }, aiMoney(bucket?.cost)),
    el("span", { class: "ai-tile-meta" }, `${bucket?.calls ?? 0} 次 · ${aiTokens((bucket?.promptTokens ?? 0) + (bucket?.completionTokens ?? 0))} token`),
    extra ? el("span", { class: "ai-tile-meta" }, extra) : null);

// Single series (daily cost, or tokens when nothing is priced): one hue, no
// legend, 4px rounded tops on a shared baseline, hover/focus readout below.
const aiDailyChart = (usage) => {
  const days = usage.byDay ?? [];
  const primaryCurrency = Object.keys(usage.month?.cost ?? {})[0] ?? null;
  const valueOf = (day) => (primaryCurrency === null ? day.promptTokens + day.completionTokens : day.cost[primaryCurrency] ?? 0);
  const max = Math.max(...days.map(valueOf), 0);
  const describe = (day) => `${day.day.slice(5).replace("-", "月")}日：${aiMoney(day.cost)} · ${day.calls} 次 · ${aiTokens(day.promptTokens + day.completionTokens)} token`;
  const hovered = days.find((day) => day.day === aiUsageState.hoverDay) ?? days.at(-1);
  const readout = el("p", { class: "ai-chart-readout" }, hovered ? describe(hovered) : "");
  const setHover = (day) => {
    aiUsageState.hoverDay = day.day;
    readout.textContent = describe(day);
  };
  return el("figure", { class: "ai-chart" },
    el("figcaption", {}, primaryCurrency === null ? "近 30 天每日 token（价格表里没有当前模型，无法估算费用）" : `近 30 天每日费用（${primaryCurrency}，估算）`),
    el("div", { class: "ai-bars", role: "list" }, days.map((day) => {
      const value = valueOf(day);
      const height = max > 0 ? Math.max(value > 0 ? 3 : 0, Math.round((value / max) * 100)) : 0;
      return el("button", {
        class: `ai-bar ${day.day === hovered?.day ? "on" : ""}`,
        role: "listitem",
        "aria-label": describe(day),
        onmouseenter: () => setHover(day),
        onfocus: () => setHover(day),
      }, el("span", { class: "ai-bar-fill", style: `height:${height}%` }));
    })),
    el("div", { class: "ai-chart-axis" }, el("span", {}, days[0]?.day.slice(5) ?? ""), el("span", {}, "今天")),
    readout);
};

const aiPurposeTable = (usage) => {
  const rows = Object.entries(usage.byPurpose ?? {});
  if (rows.length === 0) {
    return null;
  }
  return el("table", { class: "ai-table" },
    el("thead", {}, el("tr", {}, ["用途", "次数", "输入 token", "输出 token", "费用（30 天）"].map((head) => el("th", {}, head)))),
    el("tbody", {}, rows.map(([purpose, bucket]) => el("tr", {},
      el("td", {}, AI_PURPOSE_LABELS[purpose] ?? purpose),
      el("td", {}, bucket.calls),
      el("td", {}, aiTokens(bucket.promptTokens)),
      el("td", {}, aiTokens(bucket.completionTokens)),
      el("td", {}, aiMoney(bucket.cost))))));
};

const aiBudgetRow = (usage) => {
  const budget = usage.dailyBudget;
  const amountInput = el("input", { type: "number", min: "0", step: "0.5", value: budget?.amount ?? "", placeholder: "不限", style: "width:90px" });
  const currencySelect = el("select", {}, ["CNY", "USD"].map((currency) =>
    el("option", { value: currency, selected: (budget?.currency ?? "CNY") === currency }, currency)));
  const intervalSelect = el("select", {
    onchange: (event) => aiAction("/api/background", { reduceIntervalMinutes: Number(event.target.value) }, "已保存合并频率。"),
  }, [[0, "每有新段就合并"], [15, "最多每 15 分钟"], [30, "最多每 30 分钟"], [60, "最多每小时"], [120, "最多每 2 小时"], [240, "最多每 4 小时"]].map(([value, label]) =>
    el("option", { value: String(value), selected: Number(usage.reduceIntervalMinutes) === value }, label)));
  const tailSelect = el("select", {
    title: "消息少的群，新消息攒不到一段时，等多久再单独总结。等得越久，段越大、越省钱，但总结出来得越晚。",
    onchange: (event) => aiAction("/api/background", { tailWaitMinutes: Number(event.target.value) }, "已保存。"),
  }, [[60, "等 1 小时"], [180, "等 3 小时（省钱）"], [360, "等 6 小时（最省）"]].map(([value, label]) =>
    el("option", { value: String(value), selected: Number(usage.tailWaitMinutes ?? 60) === value }, label)));
  return el("div", { class: "ai-controls" },
    el("label", {}, "每日预算", amountInput, currencySelect,
      el("button", {
        class: "btn small",
        onclick: () => aiAction("/api/background", {
          dailyBudget: amountInput.value.trim() === "" || Number(amountInput.value) === 0 ? null : { amount: Number(amountInput.value), currency: currencySelect.value },
        }, "已保存每日预算。"),
      }, "保存")),
    el("label", {}, "简报合并", intervalSelect),
    el("label", {}, "零散消息", tailSelect),
    el("span", { class: "card-sub" }, `另有每日 ${usage.callCap?.limit ?? 400} 次调用上限（今天已用 ${usage.callCap?.used ?? 0} 次）。`));
};

const aiPriceEditor = () => {
  const providers = aiUsageState.providers;
  if (providers === null) {
    return null;
  }
  const rows = aiUsageState.priceDraft ?? providers.customPrices.map((row) => ({ ...row }));
  const update = (index, patch) => {
    aiUsageState.priceDraft = rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row));
  };
  const numberCell = (row, index, key) => el("input", {
    type: "number", min: "0", step: "0.01", value: row[key], style: "width:80px",
    oninput: (event) => update(index, { [key]: event.target.value }),
  });
  return el("details", { class: "ai-prices", open: aiUsageState.showPrices, ontoggle: (event) => { aiUsageState.showPrices = event.target.open; } },
    el("summary", {}, "价格表（每百万 token）"),
    el("p", { class: "card-sub" }, `内置价格抄自官网（${providers.priceSourceDate}），会过时。你的服务商或模型不在表里，就在下面加一行：模型名只要包含这里填的文字就算匹配，排在内置价格前面。`),
    el("table", { class: "ai-table" },
      el("thead", {}, el("tr", {}, ["模型名包含", "币种", "输入", "缓存命中", "输出", "离峰半价", ""].map((head) => el("th", {}, head)))),
      el("tbody", {},
        rows.map((row, index) => el("tr", {},
          el("td", {}, el("input", { type: "text", value: row.match, style: "width:170px", oninput: (event) => update(index, { match: event.target.value }) })),
          el("td", {}, el("select", { onchange: (event) => update(index, { currency: event.target.value }) },
            ["CNY", "USD"].map((currency) => el("option", { value: currency, selected: row.currency === currency }, currency)))),
          el("td", {}, numberCell(row, index, "input")),
          el("td", {}, numberCell(row, index, "cachedInput")),
          el("td", {}, numberCell(row, index, "output")),
          el("td", {}, el("input", { type: "checkbox", checked: row.offPeakHalf === true, onchange: (event) => update(index, { offPeakHalf: event.target.checked }) })),
          el("td", {}, el("button", {
            class: "btn small danger",
            onclick: () => {
              aiUsageState.priceDraft = rows.filter((_, rowIndex) => rowIndex !== index);
              renderSettingsView();
            },
          }, "删除")))),
        providers.defaultPrices.map((row) => el("tr", { class: "ai-default-price" },
          el("td", {}, `${row.match}（内置）`),
          el("td", {}, row.currency),
          el("td", {}, row.input),
          el("td", {}, row.cachedInput),
          el("td", {}, row.output),
          el("td", {}, row.offPeakHalf ? "是" : ""),
          el("td", {}, ""))))),
    el("div", { class: "row" },
      el("button", {
        class: "btn small",
        onclick: () => {
          aiUsageState.priceDraft = [...rows, { match: "", currency: "CNY", input: "", cachedInput: "", output: "", offPeakHalf: false }];
          aiUsageState.showPrices = true;
          renderSettingsView();
        },
      }, "＋ 添加一行"),
      el("button", {
        class: "btn small primary",
        onclick: async () => {
          await aiAction("/api/llm/prices", { prices: rows }, "价格表已保存，费用按新价格重算。");
          aiUsageState.priceDraft = null;
        },
      }, "保存价格表")));
};

const renderAiUsageCard = () => {
  const usage = aiUsageState.usage;
  const msg = el("span", { style: "font-size:13px" });
  if (aiUsageState.notice !== null) {
    settingsFeedback(msg, aiUsageState.notice.text, aiUsageState.notice.isError);
  }
  if (usage === null) {
    return el("div", { class: "card" }, el("h2", {}, "AI 用量与费用"),
      aiUsageState.error !== null
        ? el("div", { class: "notice risk" }, `读取失败：${aiUsageState.error}`)
        : el("p", { class: "card-sub" }, "正在读取…"));
  }
  const perThousand = usage.perThousandMessages;
  return el("div", { class: "card" },
    el("h2", {}, "AI 用量与费用"),
    el("p", { class: "card-sub" }, "按 AI 服务每次返回的实际 token 数统计，费用按下方价格表估算，以服务商账单为准。每 15 分钟的刷新本身不调用 AI：群里攒够一段新消息才总结一次（按消息量计费），各群总览再按「简报合并」的间隔重写，所以费用主要看群有多热闹。"),
    aiPauseRow(usage),
    el("div", { class: "ai-tiles" },
      aiTile("今天", usage.today),
      aiTile("近 7 天", usage.week),
      aiTile("近 30 天", usage.month),
      el("div", { class: "ai-tile emphasis" },
        el("span", { class: "ai-tile-label" }, "按最近用量估算每月"),
        el("strong", { class: "ai-tile-value" }, aiMoney(usage.projectedMonth)),
        el("span", { class: "ai-tile-meta" }, perThousand === null
          ? "还没有足够的记录"
          : `你的群每 1000 条消息约 ${aiMoney(perThousand.cost)}（${aiTokens(perThousand.promptTokens)} 输入 token）`),
        usage.observedDays > 0 && usage.observedDays < 3
          ? el("span", { class: "ai-tile-meta" }, `才 ${usage.observedDays} 天的记录，跑满一周后更准`)
          : null)),
    usage.month.calls > 0 ? aiDailyChart(usage) : el("p", { class: "card-sub" }, "还没有记录到 AI 调用。后台下一次总结后这里就会有数字。"),
    aiPurposeTable(usage),
    aiBudgetRow(usage),
    aiPriceEditor(),
    msg);
};

/* ---------- provider presets for the LLM card ---------- */

const renderProviderPresets = (onPick) => {
  const presets = aiUsageState.providers?.presets ?? [];
  if (presets.length === 0) {
    return null;
  }
  return el("div", { class: "ai-presets" },
    el("div", { class: "row" },
      el("span", { class: "card-sub", style: "margin:0" }, "常用服务："),
      presets.map((preset) => el("button", {
        class: `chip ${preset.recommended ? "recommended" : ""}`,
        title: preset.notes.join("\n"),
        onclick: () => onPick(preset),
      }, preset.recommended ? `${preset.name} · 推荐` : preset.name))),
    el("details", { class: "ai-guide" },
      el("summary", {}, "该选哪家？"),
      el("ul", {}, presets.map((preset) => el("li", {},
        el("strong", {}, preset.name),
        "：",
        preset.notes.join(" "),
        preset.keyUrl ? [" ", el("a", { href: preset.keyUrl, target: "_blank", rel: "noopener noreferrer" }, "申请 key")] : null))),
      el("p", { class: "card-sub" }, "简报对模型的要求不高：便宜、中文好、支持 JSON 输出就够了。先用推荐的，跑几天后看上面的「AI 用量」再决定要不要换。")));
};
