"use strict";

/* ---------- 设置 → 手机连线 (computer only) ----------
   Walks the user through Tailscale (install on both devices, sign in, enable
   HTTPS once), turns the remote entrance on and off, shows the pairing QR and
   lists the paired phones. On a phone this card is not shown at all. */

const REMOTE_POLL_MS = 3000;
const QR_MODULE_PX = 5;
const QR_QUIET_MODULES = 4;

const remoteState = { status: null, error: null, busy: false, notice: null, pairing: null, pollTimer: null, consentUrl: null };

const remoteNotice = (text, tone) => {
  remoteState.notice = text === null ? null : { text, tone };
};

const loadRemoteStatus = async ({ withTailscale = true } = {}) => {
  try {
    const status = await api(`/api/remote${withTailscale ? "" : "?tailscale=0"}`);
    // The quick poll has no Tailscale facts; keep the last ones.
    remoteState.status = withTailscale ? status : { ...status, tailscale: remoteState.status?.tailscale ?? null };
    remoteState.error = null;
  } catch (error) {
    remoteState.error = error.message;
  }
};

const rerenderRemoteCard = () => {
  const card = $("#remote-card");
  if (card !== null) {
    card.replaceWith(renderRemoteCard());
  }
};

const stopRemotePoll = () => {
  clearInterval(remoteState.pollTimer);
  remoteState.pollTimer = null;
};

// While a QR is up: notice the phone pairing (or the code running out).
const startRemotePoll = () => {
  stopRemotePoll();
  remoteState.pollTimer = setInterval(async () => {
    const before = remoteState.status?.devices?.length ?? 0;
    await loadRemoteStatus({ withTailscale: false });
    const after = remoteState.status?.devices?.length ?? 0;
    if (after > before) {
      remoteState.pairing = null;
      remoteNotice("手机已配对。以后在手机上直接打开 ChatLens 即可。", "ok");
      stopRemotePoll();
    } else if (remoteState.status?.pairing?.active === false) {
      remoteState.pairing = null;
      remoteNotice("配对码已失效，需要时再生成一个。", "warn");
      stopRemotePoll();
    }
    rerenderRemoteCard();
  }, REMOTE_POLL_MS);
};

VIEW_LEAVE_HOOKS.push(() => {
  stopRemotePoll();
  remoteState.pairing = null;
});

const remoteAction = async (path, body, { onDone } = {}) => {
  remoteState.busy = true;
  remoteNotice(null);
  rerenderRemoteCard();
  try {
    const result = await api(path, { method: "POST", body: JSON.stringify(body ?? {}) });
    onDone?.(result);
  } catch (error) {
    remoteNotice(error.message, "risk");
  }
  remoteState.busy = false;
  await loadRemoteStatus();
  rerenderRemoteCard();
};

const ENABLE_FAILURES = {
  "not-installed": "这台电脑还没有安装 Tailscale。",
  "not-running": "Tailscale 还没登录或没有连接，请先在电脑上打开 Tailscale 并登录。",
  "port-taken": "这台电脑在 Tailscale 上的 https 地址已经用于别的服务，为了不破坏它，这里没有改动。",
  "no-name": "Tailscale 没有给这台电脑一个可用的名字（MagicDNS），请在 Tailscale 网站的 DNS 页面打开 MagicDNS。",
  "funnel-on": "这台电脑的 https 地址开着 Tailscale Funnel（对整个互联网公开）。手机连线只走你自己的设备，请先关掉 Funnel（tailscale funnel --https=443 off）。",
  "listen-failed": "手机连线入口没能启动",
  "serve-failed": "Tailscale 没能开启 https 转发",
};

const enableRemote = () => remoteAction("/api/remote/enable", {}, {
  onDone: (result) => {
    if (result.ok) {
      remoteNotice("手机连线已开启。现在点「配对新手机」。", "ok");
      return;
    }
    if (result.reason === "needs-consent") {
      remoteState.consentUrl = result.consentUrl;
      remoteNotice("第一次使用需要在 Tailscale 网站上开启 HTTPS：点下面的按钮，在打开的页面里同意，然后回来再点「开启手机连线」。", "warn");
      return;
    }
    const base = ENABLE_FAILURES[result.reason] ?? "开启失败";
    remoteNotice([base, result.error, result.detail].filter(Boolean).join("："), "risk");
  },
});

const disableRemote = () => {
  if (!window.confirm("关闭手机连线？\n手机会立即连不上；已配对的手机会保留，重新开启后不用再配对。")) {
    return;
  }
  stopRemotePoll();
  remoteState.pairing = null;
  remoteAction("/api/remote/disable", {}, { onDone: () => remoteNotice("手机连线已关闭。", "ok") });
};

const startPairing = () => remoteAction("/api/remote/pair-code", {}, {
  onDone: (result) => {
    remoteState.pairing = result;
    startRemotePoll();
  },
});

const cancelPairing = () => {
  stopRemotePoll();
  remoteState.pairing = null;
  remoteAction("/api/remote/pair-cancel");
};

const revokeDevice = (device) => {
  if (!window.confirm(`取消「${device.name}」的配对？\n它会立即无法访问，要再用需重新配对。`)) {
    return;
  }
  remoteAction("/api/remote/revoke", { id: device.id }, { onDone: () => remoteNotice("已取消这台设备的配对。", "ok") });
};

const revokeAllDevices = () => {
  if (!window.confirm("取消所有手机的配对？\n手机丢了或不确定时用这个。")) {
    return;
  }
  remoteAction("/api/remote/revoke", { all: true }, { onDone: () => remoteNotice("已取消所有设备的配对。", "ok") });
};

// The QR is drawn on a canvas: dark modules on white whatever the theme, with
// the quiet zone scanners need.
const qrCanvas = (rows) => {
  const size = rows.length + QR_QUIET_MODULES * 2;
  const canvas = el("canvas", { class: "remote-qr", width: size * QR_MODULE_PX, height: size * QR_MODULE_PX, role: "img", "aria-label": "配对二维码" });
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#000000";
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) {
      if (row[x] === "1") {
        context.fillRect((x + QR_QUIET_MODULES) * QR_MODULE_PX, (y + QR_QUIET_MODULES) * QR_MODULE_PX, QR_MODULE_PX, QR_MODULE_PX);
      }
    }
  });
  return canvas;
};

const remoteTime = (ms) => (Number.isFinite(ms) ? unixToHkt(Math.floor(ms / 1000)).slice(0, 16) : "");

const remoteSteps = (tailscale) => {
  const pcReady = tailscale?.installed === true && tailscale.running === true;
  const step = (done, text, extra) => el("li", { class: done ? "done" : "" }, el("span", {}, text), extra ?? null);
  return el("ol", { class: "remote-steps" },
    step(tailscale?.installed === true, "在这台电脑上安装 Tailscale（免费）",
      tailscale?.installed === true ? null : el("a", { class: "btn small", href: "https://tailscale.com/download", target: "_blank", rel: "noopener noreferrer" }, "去下载")),
    step(pcReady, "在电脑上打开 Tailscale 并登录（Google / 微软 / GitHub 账号都可以）"),
    step(false, "手机在 Google Play 安装 Tailscale，用同一个账号登录并打开连接"),
    step(false, "回到这里点「开启手机连线」，再点「配对新手机」用手机扫码"));
};

const remotePairingPanel = (pairing) =>
  el("div", { class: "remote-pairing" },
    qrCanvas(pairing.qr),
    el("div", { class: "remote-pairing-text" },
      el("p", { class: "remote-pairing-lead" }, "用手机扫这个二维码（相机或 Google 智能镜头都行）。扫不了就在手机浏览器打开下面的地址，输入配对码："),
      el("code", { class: "remote-url" }, `${remoteState.status?.url ?? ""}pair`),
      el("strong", { class: "remote-code" }, pairing.code),
      el("p", { class: "card-sub", style: "margin:0" }, `${remoteTime(pairing.expiresAt).slice(11)} 前有效，只能配对一台手机。手机要先打开 Tailscale。`),
      el("button", { class: "btn small", type: "button", onclick: cancelPairing }, "取消")));

const remoteDeviceList = (devices) => {
  if (devices.length === 0) {
    return el("p", { class: "card-sub", style: "margin:8px 0 0" }, "还没有配对过的手机。");
  }
  return el("div", { class: "remote-devices" },
    devices.map((device) => el("div", { class: "remote-device" },
      el("span", { class: "remote-device-name" }, `📱 ${device.name}`),
      el("span", { class: "remote-device-meta" }, `配对于 ${remoteTime(device.createdAt)} · 最近使用 ${railAgo(Math.floor(device.lastSeenAt / 1000)) || "—"}`),
      el("button", { class: "btn small danger", type: "button", disabled: remoteState.busy, onclick: () => revokeDevice(device) }, "取消配对"))),
    devices.length > 1
      ? el("button", { class: "btn small danger", type: "button", disabled: remoteState.busy, onclick: revokeAllDevices }, "全部取消")
      : null);
};

const remoteBody = (status) => {
  const tailscale = status.tailscale;
  if (!status.enabled) {
    const ready = tailscale?.installed === true && tailscale.running === true;
    return [
      remoteSteps(tailscale),
      el("div", { class: "row", style: "margin-top:12px" },
        el("button", { class: "btn small primary", type: "button", disabled: remoteState.busy || !ready, onclick: enableRemote }, remoteState.busy ? "处理中…" : "开启手机连线"),
        el("button", { class: "btn small", type: "button", disabled: remoteState.busy, onclick: async () => { await loadRemoteStatus(); rerenderRemoteCard(); } }, "重新检测"),
        remoteState.consentUrl
          ? el("a", { class: "btn small", href: remoteState.consentUrl, target: "_blank", rel: "noopener noreferrer" }, "打开 Tailscale 授权页面")
          : null),
    ];
  }
  return [
    tailscale?.funnel
      ? el("div", { class: "notice risk" }, "注意：这台电脑的 https 地址现在开着 Tailscale Funnel，等于对整个互联网公开。请关掉 Funnel（tailscale funnel --https=443 off），或关闭手机连线。")
      : null,
    el("div", { class: "remote-on" },
      el("span", { class: `remote-dot ${status.listening ? "ok" : "risk"}` }),
      el("span", {}, status.listening ? "已开启，手机地址：" : `入口没有运行${status.listenError ? `（${status.listenError}）` : ""}：`),
      el("code", { class: "remote-url" }, status.url ?? "")),
    remoteState.pairing !== null
      ? remotePairingPanel(remoteState.pairing)
      : el("div", { class: "row", style: "margin-top:12px" },
        el("button", { class: "btn small primary", type: "button", disabled: remoteState.busy, onclick: startPairing }, "📱 配对新手机"),
        el("button", { class: "btn small danger", type: "button", disabled: remoteState.busy, onclick: disableRemote }, "关闭手机连线")),
    el("h3", { class: "remote-subhead" }, "已配对的手机"),
    remoteDeviceList(status.devices ?? []),
  ];
};

const renderRemoteCard = () => {
  const status = remoteState.status;
  const notice = remoteState.notice;
  return el("div", { class: "card", id: "remote-card", "data-testid": "remote-card" },
    el("h2", {}, "手机连线"),
    el("p", { class: "card-sub" },
      "躺在床上或出门时用手机看简报、聊天和回顾。手机只是屏幕，整理仍在这台电脑上进行，所以电脑要开着（不能睡眠），ChatLens 要在运行。连接走 Tailscale：只有登录你自己的 Tailscale 账号、并在这里配对过的手机才进得来，不会开放到互联网。设置、密钥、备份和存储只能在电脑上改。"),
    notice !== null ? el("div", { class: `notice ${notice.tone}` }, notice.text) : null,
    remoteState.error !== null ? el("div", { class: "notice risk" }, `读取失败：${remoteState.error}`) : null,
    status === null ? el("p", { class: "card-sub" }, "正在检测 Tailscale…") : remoteBody(status));
};
