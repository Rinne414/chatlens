"use strict";

// Phones allowed to open the console from outside the computer (手机连线).
//
// A phone becomes a device by typing (or scanning) a short-lived pairing code
// that only the computer's own console can show. It then holds a long random
// device token in a cookie. Only the token's SHA-256 is written to disk, so
// the file grants nothing if it is copied.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// 32 symbols without 0/O/1/I, so a code read off the screen cannot be mistyped
// into another valid symbol.
const PAIR_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const PAIR_CODE_LENGTH = 10;
const PAIR_CODE_TTL_MS = 5 * 60 * 1000;
// Wrong guesses against the current code before it is thrown away.
const PAIR_CODE_ATTEMPTS = 5;
const MAX_DEVICES = 20;
const DEVICE_TOKEN_BYTES = 32;
const DEVICE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
// lastSeenAt changes on every request; the file is rewritten at most this often.
const LAST_SEEN_WRITE_MS = 10 * 60 * 1000;
const MAX_NAME_LENGTH = 60;

const sha256 = (text) => crypto.createHash("sha256").update(text).digest();

const sameDigest = (left, right) => left.length === right.length && crypto.timingSafeEqual(left, right);

const normalizeCode = (input) => String(input ?? "").toUpperCase().replace(/[^0-9A-Z]/gu, "");

const formatCode = (code) => `${code.slice(0, 5)}-${code.slice(5)}`;

// "Android · Chrome" from a user agent; only shown to the user in the device list.
const deviceNameFrom = (userAgent) => {
  const ua = String(userAgent ?? "");
  const system = /Android/u.test(ua) ? "Android"
    : /iPhone|iPad/u.test(ua) ? "iPhone / iPad"
      : /Windows/u.test(ua) ? "Windows"
        : /Mac OS X/u.test(ua) ? "Mac"
          : /Linux/u.test(ua) ? "Linux" : "未知设备";
  const browser = /EdgA?\//u.test(ua) ? "Edge"
    : /SamsungBrowser\//u.test(ua) ? "Samsung 浏览器"
      : /Firefox\//u.test(ua) ? "Firefox"
        : /Chrome\//u.test(ua) ? "Chrome"
          : /Safari\//u.test(ua) ? "Safari" : "浏览器";
  return `${system} · ${browser}`.slice(0, MAX_NAME_LENGTH);
};

const EMPTY_STATE = Object.freeze({ enabled: false, host: null, devices: [] });

const readState = (filePath) => {
  try {
    const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const devices = Array.isArray(saved.devices)
      ? saved.devices.filter((device) => typeof device?.id === "string" && /^[0-9a-f]{64}$/u.test(String(device.tokenHash)))
      : [];
    return {
      enabled: saved.enabled === true,
      host: typeof saved.host === "string" && saved.host !== "" ? saved.host : null,
      devices,
    };
  } catch {
    return EMPTY_STATE;
  }
};

const writeState = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, ...value }, null, 2)}\n`);
  fs.renameSync(temporary, filePath);
};

const publicDevice = (device) => ({
  id: device.id,
  name: device.name,
  createdAt: device.createdAt,
  lastSeenAt: device.lastSeenAt,
});

const createRemoteDevices = ({ filePath, now = Date.now, randomBytes = crypto.randomBytes }) => {
  let state = readState(filePath);
  let pairing = null;
  let lastSeenWrittenAt = 0;

  // Disk first: if the write fails, nothing changes in memory either.
  const save = (next) => {
    writeState(filePath, next);
    state = next;
  };

  const randomCode = () => {
    const bytes = randomBytes(PAIR_CODE_LENGTH);
    // 256 is a multiple of 32, so taking the byte modulo 32 has no bias.
    return Array.from(bytes, (byte) => PAIR_CODE_ALPHABET[byte % PAIR_CODE_ALPHABET.length]).join("");
  };

  const createPairingCode = () => {
    const code = randomCode();
    const expiresAt = now() + PAIR_CODE_TTL_MS;
    pairing = { digest: sha256(code), expiresAt, attemptsLeft: PAIR_CODE_ATTEMPTS };
    return { code: formatCode(code), expiresAt };
  };

  const pairingStatus = () => {
    if (pairing === null || pairing.expiresAt <= now() || pairing.attemptsLeft <= 0) {
      return { active: false, expiresAt: null };
    }
    return { active: true, expiresAt: pairing.expiresAt };
  };

  const cancelPairing = () => {
    pairing = null;
  };

  const pair = (input, { userAgent } = {}) => {
    if (pairing === null) {
      return { ok: false, reason: "no-code" };
    }
    if (pairing.expiresAt <= now()) {
      pairing = null;
      return { ok: false, reason: "expired" };
    }
    if (pairing.attemptsLeft <= 0) {
      pairing = null;
      return { ok: false, reason: "burned" };
    }
    const code = normalizeCode(input);
    if (code.length !== PAIR_CODE_LENGTH || !sameDigest(sha256(code), pairing.digest)) {
      pairing = { ...pairing, attemptsLeft: pairing.attemptsLeft - 1 };
      if (pairing.attemptsLeft <= 0) {
        pairing = null;
        return { ok: false, reason: "burned" };
      }
      return { ok: false, reason: "wrong" };
    }
    if (state.devices.length >= MAX_DEVICES) {
      return { ok: false, reason: "full" };
    }
    const token = randomBytes(DEVICE_TOKEN_BYTES).toString("base64url");
    const at = now();
    const device = {
      id: randomBytes(9).toString("hex"),
      name: deviceNameFrom(userAgent),
      tokenHash: sha256(token).toString("hex"),
      createdAt: at,
      lastSeenAt: at,
    };
    save({ ...state, devices: [...state.devices, device] });
    // One code, one phone (spent only once the phone is really saved).
    pairing = null;
    return { ok: true, token, device: publicDevice(device) };
  };

  const findDevice = (token) => {
    if (typeof token !== "string" || !DEVICE_TOKEN_PATTERN.test(token)) {
      return null;
    }
    const digest = sha256(token);
    return state.devices.find((device) => sameDigest(Buffer.from(device.tokenHash, "hex"), digest)) ?? null;
  };

  // The device holding this token, or null. Also records when it was last seen.
  const authenticate = (token) => {
    const device = findDevice(token);
    if (device === null) {
      return null;
    }
    const at = now();
    const devices = state.devices.map((item) => (item.id === device.id ? { ...item, lastSeenAt: at } : item));
    state = { ...state, devices };
    if (at - lastSeenWrittenAt >= LAST_SEEN_WRITE_MS) {
      lastSeenWrittenAt = at;
      // Only "last used" is at stake; a failed write must not fail the request.
      try {
        writeState(filePath, state);
      } catch (error) {
        console.error(`手机连线：保存设备使用时间失败：${error.message}`);
      }
    }
    return publicDevice(device);
  };

  const revoke = (id) => {
    const devices = state.devices.filter((device) => device.id !== id);
    if (devices.length === state.devices.length) {
      return false;
    }
    save({ ...state, devices });
    return true;
  };

  const revokeAll = () => {
    pairing = null;
    save({ ...state, devices: [] });
  };

  const getSettings = () => ({ enabled: state.enabled, host: state.host });

  const saveSettings = ({ enabled, host }) => {
    save({
      ...state,
      enabled: enabled === true,
      host: typeof host === "string" && host !== "" ? host.toLowerCase() : state.host,
    });
    if (!state.enabled) {
      pairing = null;
    }
    return getSettings();
  };

  return {
    createPairingCode,
    pairingStatus,
    cancelPairing,
    pair,
    authenticate,
    revoke,
    revokeAll,
    listDevices: () => state.devices.map(publicDevice),
    getSettings,
    saveSettings,
  };
};

module.exports = {
  createRemoteDevices,
  deviceNameFrom,
  normalizeCode,
  PAIR_CODE_TTL_MS,
  PAIR_CODE_ATTEMPTS,
  MAX_DEVICES,
};
