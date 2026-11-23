"use strict";

// The made-up groups, people and conversations of the demo copy
// (scripts/make_demo.js). Nobody here exists; nothing is taken from a real
// chat. Times are hours before the moment the demo is made, so a fresh demo
// always looks like the last three days.

const ME = { uin: "10001", name: "阿青" };
const PEOPLE = {
  me: ME,
  lin: { uin: "20011", name: "林木" },
  yu: { uin: "20012", name: "小雨" },
  wang: { uin: "20013", name: "老王" },
  tang: { uin: "20014", name: "糖糖" },
  kk: { uin: "20015", name: "KK" },
  mo: { uin: "20016", name: "墨鱼" },
  qi: { uin: "20017", name: "七七" },
  bai: { uin: "20018", name: "白夜" },
  nan: { uin: "20019", name: "南风" },
  dou: { uin: "20020", name: "豆包不是包" },
  shan: { uin: "20021", name: "山猫" },
};

// A line: [who, text, { reply: index of an earlier line in the thread, at: [who] }]
const GROUPS = [
  {
    id: "90000001",
    name: "画图交流群",
    summary: "这三天最要紧的是 Aurora XL 2.0 放出：群里实测手部和文字明显变好，但旧 LoRA 要重训。另外有人整理了 LoRA 训练的参数表，阿青答应周末把自己的笔记发出来。",
    threads: [
      {
        hoursAgo: 60,
        lines: [
          ["lin", "Aurora XL 2.0 放出来了，官方说手和文字都重做了"],
          ["yu", "真的假的，1.0 的手我已经放弃治疗了"],
          ["lin", "我跑了二十张，手基本没崩，招牌上的字也能认"],
          ["wang", "显存吃多少？我 12G 还能玩吗"],
          ["lin", "12G 开低显存模式能跑，一张四十秒左右", { reply: 3 }],
          ["tang", "旧的 LoRA 还能用吗"],
          ["kk", "不能直接用，文本编码器换了，得重训", { reply: 5 }],
          ["tang", "啊……那我那一堆岂不是白炼了"],
          ["me", "先别急着删，官方说下周出转换脚本"],
          ["yu", "@阿青 转换脚本的消息哪看到的", { at: ["me"] }],
          ["me", "发布页最下面的路线图里写的", { reply: 9 }],
        ],
        partial: {
          summary: "Aurora XL 2.0 发布，群友实测手部和文字改善明显；旧 LoRA 因文本编码器更换需要重训，官方路线图提到下周出转换脚本。",
          topics: [{ title: "Aurora XL 2.0 发布与实测", summary: "林木实测二十张手部基本不崩、招牌文字可辨认；12G 显存开低显存模式约四十秒一张。旧 LoRA 不能直接用，KK 说明是文本编码器换了，阿青指出官方路线图写着下周出转换脚本。", importance: "high", messageCountEstimate: 11, details: ["12G 低显存模式约 40 秒一张", "旧 LoRA 需重训或等转换脚本"], evidence: [] }],
          newThings: [{ kind: "model", name: "Aurora XL 2.0", detail: "新版底模，手部和文字重做，文本编码器更换", link: "https://example.com/aurora-xl-2", speaker: "林木" }],
          qa: [
            { question: "12G 显存能跑 Aurora XL 2.0 吗？", answer: "开低显存模式能跑，一张约四十秒。", asker: "老王", answerer: "林木", resolved: true },
            { question: "旧的 LoRA 还能用吗？", answer: "不能直接用，文本编码器换了，要重训；官方说下周出转换脚本。", asker: "糖糖", answerer: "KK", resolved: true },
          ],
          timeline: [], links: [{ title: "Aurora XL 2.0 发布页", url: "https://example.com/aurora-xl-2", why: "官方说明和路线图" }], uncategorized: [],
        },
      },
      {
        hoursAgo: 30,
        lines: [
          ["mo", "有没有人有 LoRA 训练的参数表，我每次都靠蒙"],
          ["qi", "我之前整理过一份，学习率、步数、分辨率对应不同数据量的"],
          ["mo", "求发！"],
          ["qi", "https://example.com/lora-params 放这了，按数据集张数查就行"],
          ["bai", "补一句：二十张以内别超过一千五百步，很容易过拟合"],
          ["mo", "我上次就是两千步炼出来全是同一张脸"],
          ["me", "我周末把自己的训练笔记也整理一下发群里"],
          ["mo", "@阿青 好耶，等你", { at: ["me"] }],
          ["tang", "顺便问下打标用什么？手打太累了"],
        ],
        partial: {
          summary: "七七分享了 LoRA 训练参数表；白夜提醒小数据集步数别太多；阿青答应周末发训练笔记。糖糖问打标工具没人回答。",
          topics: [{ title: "LoRA 训练参数表", summary: "七七分享了按数据集张数查学习率、步数、分辨率的参数表；白夜补充二十张以内别超过一千五百步，墨鱼确认两千步会过拟合成同一张脸。阿青答应周末整理自己的训练笔记发群。", importance: "medium", messageCountEstimate: 9, details: ["20 张以内不超过 1500 步"], evidence: [] }],
          newThings: [{ kind: "resource", name: "LoRA 训练参数表", detail: "按数据集张数查学习率、步数、分辨率", link: "https://example.com/lora-params", speaker: "七七" }],
          qa: [
            { question: "有没有 LoRA 训练的参数表？", answer: "七七发了一份，按数据集张数查。", asker: "墨鱼", answerer: "七七", resolved: true },
            { question: "打标用什么工具？", answer: null, asker: "糖糖", answerer: null, resolved: false },
          ],
          timeline: [], links: [{ title: "LoRA 训练参数表", url: "https://example.com/lora-params", why: "七七整理的参数对照" }], uncategorized: [],
        },
      },
    ],
  },
  {
    id: "90000002",
    name: "ComfyUI 互助群",
    summary: "两件事：更新后很多人遇到采样节点报错，回退一个版本可以解决；南风分享了一套放大工作流。",
    threads: [
      {
        hoursAgo: 50,
        lines: [
          ["nan", "更新完 ComfyUI 之后采样器节点直接红了，有人一样吗"],
          ["dou", "一样，报 tensor size 不匹配"],
          ["shan", "是新版改了潜空间的通道数，旧的自定义节点没跟上"],
          ["nan", "那怎么办，回退？"],
          ["shan", "回退一个版本，或者等节点作者更新，我是先回退了", { reply: 3 }],
          ["dou", "回退完好了，谢谢"],
          ["wang", "Aurora XL 2.0 在 ComfyUI 里要新节点吗"],
          ["shan", "要，文本编码器那个节点得换成新的", { reply: 6 }],
        ],
        partial: {
          summary: "ComfyUI 更新后采样器节点报 tensor size 不匹配，原因是潜空间通道数变化、旧自定义节点没跟上；回退一个版本可解决。Aurora XL 2.0 需要换新的文本编码器节点。",
          topics: [
            { title: "更新后采样节点报错", summary: "南风和豆包更新后采样器节点报 tensor size 不匹配。山猫解释是新版改了潜空间通道数、旧自定义节点没跟上，建议回退一个版本或等节点更新；豆包回退后恢复正常。", importance: "high", messageCountEstimate: 6, details: ["回退一个版本可解决"], evidence: [] },
            { title: "Aurora XL 2.0 在 ComfyUI 的用法", summary: "老王问新模型是否要新节点，山猫说文本编码器节点要换成新的。", importance: "medium", messageCountEstimate: 2, details: [], evidence: [] },
          ],
          newThings: [],
          qa: [
            { question: "更新后采样器节点报 tensor size 不匹配怎么办？", answer: "回退一个版本，或等自定义节点作者更新。", asker: "南风", answerer: "山猫", resolved: true },
            { question: "Aurora XL 2.0 在 ComfyUI 里要新节点吗？", answer: "要，文本编码器节点得换成新的。", asker: "老王", answerer: "山猫", resolved: true },
          ],
          timeline: [], links: [], uncategorized: [],
        },
      },
      {
        hoursAgo: 20,
        lines: [
          ["nan", "分享一个我在用的放大工作流，两段式，先潜空间放大再像素放大"],
          ["nan", "https://example.com/upscale-workflow"],
          ["kk", "第二段降噪开多少"],
          ["nan", "零点三左右，再高细节会变", { reply: 2 }],
          ["me", "这个我试了，8G 也能跑，就是慢"],
          ["dou", "@阿青 慢是多慢", { at: ["me"] }],
          ["me", "一张两分钟吧", { reply: 5 }],
          ["kk", "有人测过和 Tile 放大比哪个好吗"],
        ],
        partial: {
          summary: "南风分享两段式放大工作流，第二段降噪约零点三；阿青实测 8G 可跑但一张约两分钟。KK 问和 Tile 放大的对比没人回答。",
          topics: [{ title: "两段式放大工作流", summary: "南风分享先潜空间放大再像素放大的工作流，第二段降噪建议零点三左右。阿青实测 8G 显存能跑，一张约两分钟。", importance: "medium", messageCountEstimate: 8, details: ["第二段降噪约 0.3", "8G 可跑，约两分钟一张"], evidence: [] }],
          newThings: [{ kind: "resource", name: "两段式放大工作流", detail: "先潜空间放大再像素放大", link: "https://example.com/upscale-workflow", speaker: "南风" }],
          qa: [
            { question: "放大工作流第二段降噪开多少？", answer: "零点三左右，再高细节会变。", asker: "KK", answerer: "南风", resolved: true },
            { question: "两段式放大和 Tile 放大哪个好？", answer: null, asker: "KK", answerer: null, resolved: false },
          ],
          timeline: [], links: [{ title: "两段式放大工作流", url: "https://example.com/upscale-workflow", why: "南风在用的工作流" }], uncategorized: [],
        },
      },
    ],
  },
  {
    id: "90000003",
    name: "模型测评群",
    summary: "主要在比 Aurora XL 2.0 和上一代：细节和文字更好，但风格偏写实，二次元要配风格 LoRA。",
    threads: [
      {
        hoursAgo: 44,
        lines: [
          ["bai", "出了一组 Aurora XL 2.0 和 1.0 的同种子对比"],
          ["bai", "结论：细节、文字、手都好了一截，但默认风格更偏写实"],
          ["qi", "二次元怎么办"],
          ["bai", "得配风格 LoRA，裸跑二次元不如 1.0 干净", { reply: 2 }],
          ["shan", "速度呢"],
          ["bai", "同分辨率慢百分之三十左右", { reply: 4 }],
          ["lin", "和我在画图群说的差不多，手是真的好了"],
          ["mo", "那我先不换，等风格 LoRA 多起来再说"],
        ],
        partial: {
          summary: "白夜做了 Aurora XL 2.0 与 1.0 的同种子对比：细节、文字、手更好，但默认偏写实、慢约三成，二次元需配风格 LoRA。",
          topics: [{ title: "Aurora XL 2.0 对比 1.0", summary: "白夜的同种子对比显示 2.0 在细节、文字和手部都有提升，但默认风格偏写实，同分辨率慢约百分之三十；二次元需要配风格 LoRA，墨鱼决定先观望。", importance: "high", messageCountEstimate: 8, details: ["同分辨率慢约 30%", "二次元需配风格 LoRA"], evidence: [] }],
          newThings: [],
          qa: [{ question: "Aurora XL 2.0 画二次元怎么样？", answer: "要配风格 LoRA，裸跑不如 1.0 干净。", asker: "七七", answerer: "白夜", resolved: true }],
          timeline: [], links: [], uncategorized: [],
        },
      },
    ],
  },
  {
    id: "90000004",
    name: "同好闲聊群",
    summary: "在约月底的线下聚会，地点基本定在周六下午；糖糖答应把上次活动的照片发给阿青。",
    threads: [
      {
        hoursAgo: 26,
        lines: [
          ["tang", "月底线下聚会还办吗"],
          ["yu", "办啊，周六下午怎么样"],
          ["wang", "周六我可以"],
          ["kk", "周日不行吗，周六我加班"],
          ["yu", "那投个票吧"],
          ["me", "我都行，地点定了喊我"],
          ["tang", "@阿青 上次活动的照片我晚点发你", { at: ["me"] }],
          ["me", "好，谢啦", { reply: 6 }],
          ["dou", "有人带设备现场跑图吗哈哈"],
          ["lin", "我带笔记本，现场抽卡"],
        ],
        partial: {
          summary: "讨论月底线下聚会，倾向周六下午，KK 周六要加班；糖糖答应把上次活动照片发给阿青。",
          topics: [{ title: "月底线下聚会时间", summary: "小雨提议周六下午，老王可以，KK 周六加班想改周日，决定投票。糖糖答应把上次活动的照片发给阿青；林木说会带笔记本现场跑图。", importance: "medium", messageCountEstimate: 10, details: ["暂定周六下午，待投票"], evidence: [] }],
          newThings: [], qa: [], timeline: [], links: [], uncategorized: [],
        },
      },
    ],
  },
];

// What ties the groups together on the briefing: topics as [group index, thread index, topic index].
const THINGS = [
  { title: "Aurora XL 2.0 发布", takeaway: "手和文字明显变好，默认偏写实、慢约三成；旧 LoRA 要重训，官方说下周出转换脚本。", kind: "new", status: "", topics: [[0, 0, 0], [1, 0, 1], [2, 0, 0]] },
  { title: "ComfyUI 更新后采样节点报错", takeaway: "潜空间通道数变了，旧自定义节点没跟上；回退一个版本可解决。", kind: "qa", status: "resolved", topics: [[1, 0, 0]] },
  { title: "LoRA 训练参数表", takeaway: "七七分享了按数据集张数查的参数表；二十张以内别超过一千五百步。", kind: "resource", status: "", topics: [[0, 1, 0]] },
  { title: "两段式放大工作流", takeaway: "先潜空间再像素放大，第二段降噪约零点三；8G 可跑但约两分钟一张。", kind: "resource", status: "", topics: [[1, 1, 0]] },
  { title: "月底线下聚会", takeaway: "暂定周六下午，KK 想改周日，等投票结果。", kind: "group", status: "", topics: [[3, 0, 0]] },
];

// Things said to or by 阿青 that the briefing lists as promised: [group index, thread index, line index, kind, what, who].
const PROMISES = [
  [0, 1, 6, "promise", "周末把训练笔记整理好发群里", "墨鱼"],
  [3, 0, 6, "owed", "糖糖把上次活动的照片发给你", "糖糖"],
];

const CHATTER = ["哈哈哈", "确实", "学到了", "收藏了", "草", "这也行", "好活", "太强了", "我也想知道", "等一个结果", "蹲", "已阅", "+1", "有点东西", "晚点试试"];

module.exports = { ME, PEOPLE, GROUPS, THINGS, PROMISES, CHATTER };
