"use strict";

// 设置 → 手机连线, on the computer only. None of these routes is on the phone
// list (remote_policy.js), and the handler refuses a remote request anyway.

const qrcode = require("../vendor/qrcode_generator");
const tailscale = require("./tailscale_ops");

const ROUTES = new Set([
  "GET /api/remote",
  "POST /api/remote/enable",
  "POST /api/remote/disable",
  "POST /api/remote/pair-code",
  "POST /api/remote/pair-cancel",
  "POST /api/remote/revoke",
]);

// The QR as rows of "0"/"1"; the page draws it (no image library needed).
const qrRows = (text) => {
  const code = qrcode(0, "M");
  code.addData(text);
  code.make();
  const size = code.getModuleCount();
  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (__, column) => (code.isDark(row, column) ? "1" : "0")).join(""));
};

const createRemoteAdmin = ({ devices, gateway, port }) => {
  // withTailscale=false skips the CLI calls (the page polls while a QR is shown).
  const status = async ({ withTailscale = true } = {}) => {
    const settings = devices.getSettings();
    return {
      enabled: settings.enabled,
      host: settings.host,
      url: settings.host === null ? null : `https://${settings.host}/`,
      port,
      listening: gateway.isListening(),
      listenError: gateway.listenError(),
      tailscale: withTailscale ? await tailscale.getStatus() : null,
      devices: devices.listDevices(),
      pairing: devices.pairingStatus(),
    };
  };

  const enable = async () => {
    const started = await gateway.start();
    if (!started.ok) {
      return { ok: false, reason: "listen-failed", error: started.error, status: await status() };
    }
    const served = await tailscale.enableServe(port);
    if (!served.ok) {
      // Nothing points at the entrance, but keep it closed until setup succeeds.
      await gateway.stop();
      return { ...served, status: await status() };
    }
    devices.saveSettings({ enabled: true, host: served.dnsName });
    console.log(`手机连线已开启：https://${served.dnsName}/`);
    return { ok: true, status: await status() };
  };

  const disable = async () => {
    devices.saveSettings({ enabled: false });
    await gateway.stop();
    const unserved = await tailscale.disableServe(port);
    console.log("手机连线已关闭。");
    return { ok: unserved.ok, detail: unserved.detail ?? null, status: await status() };
  };

  const pairCode = () => {
    const settings = devices.getSettings();
    if (!settings.enabled || settings.host === null) {
      throw new Error("先开启手机连线。");
    }
    const { code, expiresAt } = devices.createPairingCode();
    const url = `https://${settings.host}/pair#${code}`;
    return { code, expiresAt, url, qr: qrRows(url) };
  };

  const revoke = (body) => {
    if (body.all === true) {
      devices.revokeAll();
      console.log("手机连线：已取消所有设备的配对。");
      return { ok: true };
    }
    if (typeof body.id !== "string" || !devices.revoke(body.id)) {
      throw new Error("没有这台设备。");
    }
    console.log("手机连线：已取消一台设备的配对。");
    return { ok: true };
  };

  // Returns true when the request was one of ours.
  const handle = async (request, response, url, { sendJson, readBody, remote }) => {
    const route = `${request.method} ${url.pathname}`;
    if (!ROUTES.has(route)) {
      return false;
    }
    if (remote) {
      sendJson(response, 403, { error: "这个功能只能在电脑上用。", code: "desktop-only" });
      return true;
    }
    switch (route) {
      case "GET /api/remote":
        sendJson(response, 200, await status({ withTailscale: url.searchParams.get("tailscale") !== "0" }));
        break;
      case "POST /api/remote/enable":
        sendJson(response, 200, await enable());
        break;
      case "POST /api/remote/disable":
        sendJson(response, 200, await disable());
        break;
      case "POST /api/remote/pair-code":
        sendJson(response, 200, pairCode());
        break;
      case "POST /api/remote/pair-cancel":
        devices.cancelPairing();
        sendJson(response, 200, { ok: true });
        break;
      default:
        sendJson(response, 200, revoke(await readBody(request)));
    }
    return true;
  };

  return { handle, status };
};

module.exports = { createRemoteAdmin, qrRows };
