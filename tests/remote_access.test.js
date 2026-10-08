"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createRemoteDevices, normalizeCode, PAIR_CODE_TTL_MS, PAIR_CODE_ATTEMPTS } = require("../src/server/remote_devices");
const { createRemoteGateway, PAIR_RATE_LIMIT } = require("../src/server/remote_gateway");
const policy = require("../src/server/remote_policy");
const { describeStatus, serveTargetFrom, funnelFrom } = require("../src/server/tailscale_ops");
const { qrRows } = require("../src/server/remote_admin");

const HOST = "my-pc.tail1234.ts.net";
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36";

const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "remote-")), "remote-access.json");

const makeDevices = (options = {}) => {
  const clock = { now: 1_000_000 };
  const devices = createRemoteDevices({ filePath: options.filePath ?? tempFile(), now: () => clock.now });
  return { devices, clock };
};

test("a pairing code pairs exactly one phone, and only its hash reaches the disk", () => {
  const filePath = tempFile();
  const { devices } = makeDevices({ filePath });
  const { code } = devices.createPairingCode();
  assert.match(code, /^[2-9A-HJ-NP-Z]{5}-[2-9A-HJ-NP-Z]{5}$/u);

  const first = devices.pair(code.toLowerCase().replace("-", " "), { userAgent: ANDROID_UA });
  assert.equal(first.ok, true);
  assert.equal(first.device.name, "Android · Chrome");
  assert.equal(devices.pair(code).reason, "no-code", "a used code cannot pair a second phone");

  const saved = fs.readFileSync(filePath, "utf8");
  assert.equal(saved.includes(first.token), false, "the device token itself is never written");
  assert.equal(JSON.parse(saved).devices.length, 1);
  assert.deepEqual(devices.authenticate(first.token)?.id, first.device.id);
});

test("an expired code is refused", () => {
  const { devices, clock } = makeDevices();
  const { code } = devices.createPairingCode();
  clock.now += PAIR_CODE_TTL_MS;
  assert.equal(devices.pair(code).reason, "expired");
  assert.equal(devices.pairingStatus().active, false);
});

test("wrong guesses burn the code, so it cannot be brute-forced", () => {
  const { devices } = makeDevices();
  const { code } = devices.createPairingCode();
  for (let attempt = 1; attempt < PAIR_CODE_ATTEMPTS; attempt += 1) {
    assert.equal(devices.pair("AAAAA-AAAAA").reason, "wrong");
  }
  assert.equal(devices.pair("AAAAA-AAAAA").reason, "burned");
  assert.equal(devices.pair(code).reason, "no-code", "even the right code is dead now");
});

test("revoking a device ends its access at once; revoke-all ends every device", () => {
  const { devices } = makeDevices();
  const pairOne = () => devices.pair(devices.createPairingCode().code, { userAgent: ANDROID_UA });
  const one = pairOne();
  const two = pairOne();
  assert.equal(devices.revoke(one.device.id), true);
  assert.equal(devices.authenticate(one.token), null);
  assert.notEqual(devices.authenticate(two.token), null);
  devices.revokeAll();
  assert.equal(devices.authenticate(two.token), null);
});

test("malformed or foreign tokens never authenticate", () => {
  const { devices } = makeDevices();
  devices.pair(devices.createPairingCode().code);
  for (const token of [null, "", "x", "a".repeat(43), "a".repeat(44), "../../etc"]) {
    assert.equal(devices.authenticate(token), null);
  }
});

test("settings survive a restart; turning access off also kills a pending code", () => {
  const filePath = tempFile();
  const { devices } = makeDevices({ filePath });
  devices.saveSettings({ enabled: true, host: "My-PC.Tail1234.TS.NET" });
  devices.createPairingCode();
  devices.saveSettings({ enabled: false });
  assert.equal(devices.pairingStatus().active, false);
  const reopened = createRemoteDevices({ filePath });
  assert.deepEqual(reopened.getSettings(), { enabled: false, host: "my-pc.tail1234.ts.net" });
});

test("code input is normalized: case, spaces and dashes do not matter", () => {
  assert.equal(normalizeCode(" ab2cd-ef3gh "), "AB2CDEF3GH");
});

test("phone policy: reading is allowed, computer-changing routes are not", () => {
  for (const route of ["GET /api/briefing", "GET /api/messages", "POST /api/readmark", "POST /api/ask", "POST /api/bookmarks"]) {
    const [method, pathname] = route.split(" ");
    assert.equal(policy.isRemoteApiAllowed(method, pathname), true, route);
  }
  for (const route of [
    "POST /api/settings/keys", "POST /api/settings/keys/auto-detect", "GET /api/settings", "POST /api/settings/llm",
    "POST /api/open", "POST /api/storage/cleanup", "POST /api/backup/start", "POST /api/update/apply",
    "POST /api/shutdown", "POST /api/desktop/autostart", "POST /api/knowledge/export", "POST /api/pictures/export",
    "POST /api/pictures/save-dir", "POST /api/qq-collection/save", "POST /api/background", "POST /api/llm/provider",
    "GET /api/remote", "POST /api/remote/pair-code", "POST /api/remote/enable", "POST /api/remote/revoke",
    "GET /api/briefing/../settings", "DELETE /api/bookmarks",
  ]) {
    const [method, pathname] = route.split(" ");
    assert.equal(policy.isRemoteApiAllowed(method, pathname), false, route);
  }
});

test("every phone route names a route the server really has", () => {
  const serverDir = path.join(__dirname, "..", "src", "server");
  const source = fs.readdirSync(serverDir).filter((file) => file.endsWith(".js") && !file.startsWith("remote_"))
    .map((file) => fs.readFileSync(path.join(serverDir, file), "utf8")).join("\n");
  for (const route of policy.REMOTE_API_ROUTES) {
    const pathname = route.split(" ")[1];
    assert.ok(source.includes(`"${pathname}"`) || source.includes(`${route}"`), route);
  }
});

test("only the pairing page, manifest and icons are public", () => {
  assert.equal(policy.isPublicPath("GET", "/pair"), true);
  assert.equal(policy.isPublicPath("GET", "/icons/icon-192.png"), true);
  assert.equal(policy.isPublicPath("POST", "/pair"), false);
  for (const pathname of ["/", "/index.html", "/app.js", "/runs/x.png", "/picture", "/knowledge-file", "/api/state", "/icons/../app.js"]) {
    assert.equal(policy.isPublicPath("GET", pathname), false, pathname);
  }
});

test("the host check accepts this computer's Tailscale name only", () => {
  assert.equal(policy.hostMatches(HOST, HOST), true);
  assert.equal(policy.hostMatches(`${HOST}:443`, HOST), true);
  assert.equal(policy.hostMatches(HOST.toUpperCase(), HOST), true);
  assert.equal(policy.hostMatches("127.0.0.1:8341", HOST), false);
  assert.equal(policy.hostMatches(`evil.${HOST}`, HOST), false);
  assert.equal(policy.hostMatches(HOST, null), false);
});

test("the device cookie is host-only, secure, http-only and same-site strict", () => {
  const cookie = policy.deviceCookie("token");
  for (const part of ["__Host-chatlens-device=token", "Path=/", "Secure", "HttpOnly", "SameSite=Strict"]) {
    assert.ok(cookie.includes(part), part);
  }
  assert.equal(cookie.includes("Domain"), false);
  assert.equal(policy.readCookie("a=1; __Host-chatlens-device=abc; b=2", policy.DEVICE_COOKIE), "abc");
  assert.equal(policy.readCookie("x__Host-chatlens-device=abc", policy.DEVICE_COOKIE), null);
});

test("a phone gets only media out of runs/, never exports or database copies", () => {
  for (const pathname of ["/runs/r1/media/a.jpg", "/runs/r1/media/B.PNG", "/runs/r1/media/clip.mp4", "/runs/r1/media/v.amr", "/runs/r1/media/original"]) {
    assert.equal(policy.isRemoteRunsFileAllowed(pathname), true, pathname);
  }
  for (const pathname of [
    "/runs/c/clean-db/collection.clean.db", "/runs/c/clean-db/collection.clean.db-wal", "/runs/r1/export.json",
    "/runs/r1/summary.txt", "/runs/r1/report.html", "/runs/r1/", "/runs/r1/%E0%A4%A", "/runs/r1/a.db%2Ex",
  ]) {
    assert.equal(policy.isRemoteRunsFileAllowed(pathname), false, pathname);
  }
});

test("resuming paused AI spending stays on the computer", () => {
  assert.equal(policy.isRemoteApiAllowed("POST", "/api/ai/pause"), false);
});

test("tailscale: a funnel on this computer's address is detected; odd names are refused", () => {
  assert.equal(funnelFrom({ AllowFunnel: { [`${HOST}:443`]: true } }, HOST), true);
  assert.equal(funnelFrom({ AllowFunnel: { "other.ts.net:443": true } }, HOST), false);
  assert.equal(funnelFrom({}, HOST), false);
  for (const name of ['evil"/x.ts.net.', "a b.ts.net.", "x..ts.net.", "-x.ts.net.", "single."]) {
    assert.equal(describeStatus({ Self: { DNSName: name } }).dnsName, null, name);
  }
});

test("tailscale status: name, running state and HTTPS readiness", () => {
  assert.deepEqual(describeStatus({ BackendState: "Running", Self: { DNSName: "My-PC.tail1234.ts.net." }, CertDomains: ["my-pc.tail1234.ts.net"] }), {
    backendState: "Running", running: true, dnsName: "my-pc.tail1234.ts.net", httpsEnabled: true,
  });
  assert.equal(describeStatus({ BackendState: "NeedsLogin" }).running, false);
  assert.equal(describeStatus(null).httpsEnabled, false);
  const serve = { Web: { [`${HOST}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:8341" } } } } };
  assert.equal(serveTargetFrom(serve, HOST), "http://127.0.0.1:8341");
  assert.equal(serveTargetFrom({}, HOST), null);
});

test("the pairing QR is a square matrix", () => {
  const rows = qrRows(`https://${HOST}/pair#ABCDE-FGHJK`);
  assert.ok(rows.length >= 21);
  assert.ok(rows.every((row) => row.length === rows.length && /^[01]+$/u.test(row)));
});

// ---- the gateway over real HTTP ----

const startGateway = async () => {
  const { devices } = makeDevices();
  devices.saveSettings({ enabled: true, host: HOST });
  const routed = [];
  const sendJson = (response, status, payload) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  };
  const webDir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-web-"));
  fs.writeFileSync(path.join(webDir, "pair.html"), "<p>pair</p>");
  const gateway = createRemoteGateway({
    devices,
    routeRequest: (request, response, context) => {
      routed.push({ path: request.url, remote: context.remote });
      sendJson(response, 200, { routed: true });
    },
    applySecurityHeaders: (response) => response.setHeader("x-frame-options", "DENY"),
    sendJson,
    sendError: (response, status, message) => sendJson(response, status, { error: message }),
    webDir,
    port: 0,
    log: () => {},
  });
  const server = http.createServer(gateway.handle);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const request = (method, pathname, { headers = {}, body } = {}) =>
    new Promise((resolve, reject) => {
      const outgoing = http.request({ host: "127.0.0.1", port, method, path: pathname, headers: { host: HOST, ...headers } }, (response) => {
        let text = "";
        response.on("data", (chunk) => { text += chunk; });
        response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: text }));
      });
      outgoing.on("error", reject);
      outgoing.end(body);
    });
  const pairPhone = async () => {
    const { code } = devices.createPairingCode();
    const response = await request("POST", "/remote/pair", { body: JSON.stringify({ code }), headers: { "content-type": "application/json", "user-agent": ANDROID_UA } });
    const cookie = String(response.headers["set-cookie"]).split(";")[0];
    return { response, cookie };
  };
  return { devices, routed, request, pairPhone, close: () => server.close() };
};

test("gateway: wrong host and cross-site requests are refused before anything else", async () => {
  const gate = await startGateway();
  try {
    assert.equal((await gate.request("GET", "/pair", { headers: { host: "127.0.0.1" } })).status, 403);
    const { cookie } = await gate.pairPhone();
    const foreign = await gate.request("GET", "/picture?md5=x", { headers: { cookie, "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors" } });
    assert.equal(foreign.status, 403);
    assert.equal(gate.routed.length, 0);
  } finally {
    gate.close();
  }
});

test("gateway: an unpaired phone gets only the pairing page", async () => {
  const gate = await startGateway();
  try {
    assert.equal((await gate.request("GET", "/pair")).status, 200);
    const page = await gate.request("GET", "/", { headers: { accept: "text/html" } });
    assert.equal(page.status, 303);
    assert.equal(page.headers.location, "/pair");
    const api = await gate.request("GET", "/api/state", { headers: { "x-cc-token": "whatever" } });
    assert.equal(api.status, 401);
    assert.equal(JSON.parse(api.body).code, "device-unpaired");
    for (const pathname of ["/app.js", "/runs/a.png", "/picture?md5=abc", "/knowledge-file?hash=abc"]) {
      assert.equal((await gate.request("GET", pathname)).status, 401, pathname);
    }
    assert.equal(gate.routed.length, 0, "nothing reached the console");
  } finally {
    gate.close();
  }
});

test("gateway: a paired phone reads, but computer-only routes stay closed", async () => {
  const gate = await startGateway();
  try {
    const { response, cookie } = await gate.pairPhone();
    assert.equal(response.status, 200);
    assert.ok(String(response.headers["set-cookie"]).includes("HttpOnly"));
    assert.equal((await gate.request("GET", "/api/briefing", { headers: { cookie } })).status, 200);
    const denied = await gate.request("POST", "/api/settings/keys", { headers: { cookie }, body: "{}" });
    assert.equal(denied.status, 403);
    assert.equal(JSON.parse(denied.body).code, "desktop-only");
    assert.equal((await gate.request("POST", "/api/remote/pair-code", { headers: { cookie } })).status, 403);
    assert.equal((await gate.request("GET", "/runs/c/clean-db/collection.clean.db", { headers: { cookie } })).status, 403);
    assert.equal((await gate.request("GET", "/runs/r1/export.json", { headers: { cookie } })).status, 403);
    assert.deepEqual(gate.routed.map((item) => item.path), ["/api/briefing"]);
    assert.equal(gate.routed[0].remote, true);
  } finally {
    gate.close();
  }
});

test("gateway: a phone can cancel its own pairing, and is then locked out", async () => {
  const gate = await startGateway();
  try {
    const { cookie } = await gate.pairPhone();
    const out = await gate.request("POST", "/remote/unpair", { headers: { cookie } });
    assert.equal(out.status, 200);
    assert.match(String(out.headers["set-cookie"]), /Max-Age=0/u);
    assert.equal((await gate.request("GET", "/api/briefing", { headers: { cookie } })).status, 401);
  } finally {
    gate.close();
  }
});

test("gateway: turning phone access off closes the door even for a paired phone", async () => {
  const gate = await startGateway();
  try {
    const { cookie } = await gate.pairPhone();
    gate.devices.saveSettings({ enabled: false });
    assert.equal((await gate.request("GET", "/api/briefing", { headers: { cookie } })).status, 403);
  } finally {
    gate.close();
  }
});

test("gateway: pairing attempts are rate limited", async () => {
  const gate = await startGateway();
  try {
    gate.devices.createPairingCode();
    let limited = 0;
    for (let attempt = 0; attempt <= PAIR_RATE_LIMIT; attempt += 1) {
      const response = await gate.request("POST", "/remote/pair", { body: JSON.stringify({ code: "22222-22222" }) });
      if (response.status === 429) {
        limited += 1;
      }
    }
    assert.equal(limited, 1);
  } finally {
    gate.close();
  }
});
