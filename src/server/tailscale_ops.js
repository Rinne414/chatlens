"use strict";

// Tailscale is how a phone reaches the console from anywhere: both devices
// join the user's own private network (tailnet), and `tailscale serve` puts
// the console's remote entrance at https://<this computer>.<tailnet>.ts.net
// with a real certificate. Only devices signed in to the same Tailscale
// account can reach that address; nothing is opened to the internet
// (that would be `tailscale funnel`, which is never used here).

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const platform = require("../platform");

const STATUS_TIMEOUT_MS = 8000;
// `serve` waits for the user when HTTPS is not yet enabled for the tailnet; it
// prints the page that enables it, which is all this needs from it.
const SERVE_TIMEOUT_MS = 20000;
const MAX_OUTPUT = 512 * 1024;
const CONSENT_URL = /https:\/\/login\.tailscale\.com\/\S+/u;

// A MagicDNS name as Tailscale reports it. It becomes the only Host the
// remote entrance accepts and the address in the pairing QR, so nothing else
// may pass.
const HOST_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/u;

const windowsCli = () => path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Tailscale", "tailscale.exe");

// Windows: only the installed copy, by full path. A bare name would also be
// looked up in the console's own folder first.
const findCli = () => {
  if (process.platform === "win32") {
    const installed = windowsCli();
    return fs.existsSync(installed) ? installed : null;
  }
  return platform.commandExists("tailscale") ? "tailscale" : null;
};

const run = (cli, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(cli, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: MAX_OUTPUT }, (error, stdout, stderr) => {
      resolve({
        ok: error === null,
        timedOut: error?.killed === true,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
      });
    });
  });

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// Whether https://<dnsName>/ is also published to the internet (`tailscale
// funnel`). The phone entrance must never be.
const funnelFrom = (serveStatus, dnsName) =>
  dnsName !== null && serveStatus?.AllowFunnel?.[`${dnsName}:443`] === true;

// The proxy target `serve` has for https://<dnsName>/ , or null.
const serveTargetFrom = (serveStatus, dnsName) => {
  const web = serveStatus?.Web;
  if (web === null || typeof web !== "object" || dnsName === null) {
    return null;
  }
  const site = web[`${dnsName}:443`];
  const proxy = site?.Handlers?.["/"]?.Proxy;
  return typeof proxy === "string" ? proxy : null;
};

const describeStatus = (status) => {
  const backendState = typeof status?.BackendState === "string" ? status.BackendState : "Unknown";
  const rawName = typeof status?.Self?.DNSName === "string" ? status.Self.DNSName : "";
  const name = rawName.replace(/\.$/u, "").toLowerCase();
  const dnsName = HOST_NAME.test(name) ? name : null;
  const certDomains = Array.isArray(status?.CertDomains) ? status.CertDomains : [];
  return {
    backendState,
    running: backendState === "Running",
    dnsName,
    httpsEnabled: certDomains.length > 0,
  };
};

const getStatus = async () => {
  const cli = findCli();
  if (cli === null) {
    return { installed: false, running: false, backendState: null, dnsName: null, httpsEnabled: false, serveTarget: null, funnel: false };
  }
  const status = await run(cli, ["status", "--json"], STATUS_TIMEOUT_MS);
  const described = describeStatus(parseJson(status.stdout));
  let serveTarget = null;
  let funnel = false;
  if (described.running) {
    const serve = parseJson((await run(cli, ["serve", "status", "--json"], STATUS_TIMEOUT_MS)).stdout);
    serveTarget = serveTargetFrom(serve, described.dnsName);
    funnel = funnelFrom(serve, described.dnsName);
  }
  return { installed: true, ...described, serveTarget, funnel };
};

const serveUrl = (port) => `http://127.0.0.1:${port}`;

// Points https://<this computer>/ at the remote entrance. Refuses to replace
// anything else the user already serves there.
const enableServe = async (port) => {
  const cli = findCli();
  if (cli === null) {
    return { ok: false, reason: "not-installed" };
  }
  const status = await getStatus();
  if (!status.running) {
    return { ok: false, reason: "not-running", backendState: status.backendState };
  }
  if (status.dnsName === null) {
    return { ok: false, reason: "no-name" };
  }
  if (status.funnel) {
    return { ok: false, reason: "funnel-on" };
  }
  if (status.serveTarget !== null && status.serveTarget !== serveUrl(port)) {
    return { ok: false, reason: "port-taken", serveTarget: status.serveTarget };
  }
  const serveArgs = ["--bg", "--https=443", "--set-path=/", serveUrl(port)];
  let result = await run(cli, ["serve", "--yes", ...serveArgs], SERVE_TIMEOUT_MS);
  // Older clients have no --yes.
  if (!result.ok && /flag provided but not defined: -yes/u.test(result.stderr)) {
    result = await run(cli, ["serve", ...serveArgs], SERVE_TIMEOUT_MS);
  }
  if (result.ok) {
    return { ok: true, dnsName: status.dnsName };
  }
  const output = `${result.stdout}\n${result.stderr}`;
  const consentUrl = output.match(CONSENT_URL)?.[0] ?? null;
  return {
    ok: false,
    reason: consentUrl === null ? "serve-failed" : "needs-consent",
    consentUrl,
    detail: output.trim().slice(-400),
  };
};

// Removes the https://<this computer>/ entry, only if it is ours, and only
// that path: anything else the user serves on 443 stays.
const disableServe = async (port) => {
  const cli = findCli();
  if (cli === null) {
    return { ok: true, changed: false };
  }
  const status = await getStatus();
  if (status.serveTarget !== serveUrl(port)) {
    return { ok: true, changed: false };
  }
  const result = await run(cli, ["serve", "--https=443", "--set-path=/", "off"], SERVE_TIMEOUT_MS);
  return { ok: result.ok, changed: result.ok, detail: result.ok ? null : `${result.stdout}\n${result.stderr}`.trim().slice(-400) };
};

module.exports = { getStatus, enableServe, disableServe, describeStatus, serveTargetFrom, funnelFrom, serveUrl };
