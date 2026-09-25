"use strict";

// The rkey: the short-lived key Tencent's picture server wants for NT group
// pictures. QQ fetches one whenever it shows a picture and keeps the recent
// ones in memory; there is no local file holding it. Measured 2026-09-24: 151
// candidates in QQ's memory, 69 valid; one valid key fetched pictures from
// every group, and 63/69 still worked 31 minutes later. So: scan, try the
// candidates against one real picture, keep the first that works IN MEMORY
// only, and scan again when the server refuses it.
//
// Windows reads QQ's memory like the database-key scan does (read-only).
// Linux needs ptrace rights for that; without them (the default on most
// distributions) there is no rkey and fetching falls back to the md5 route.

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const platform = require("./platform");
const linuxScan = require("./linux_key_scan");
const { fetchPicture } = require("./picture_fetch");

const SCAN_TIMEOUT_MS = 120 * 1000;
const RKEY_TOKEN = /^[\w-]{40,200}$/u;
const MAX_TRIES = 40;
const NEEDLE = Buffer.from("rkey=", "ascii");
const CHUNK_BYTES = 16 * 1024 * 1024;
// Longer than "rkey=" plus the longest key, so each chunk read runs past the
// next chunk's start and a key split across the boundary is still whole once.
const OVERLAP_BYTES = 256;

const runScript = (scriptPath) =>
  new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath,
    ], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), SCAN_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });

// "count<TAB>key" lines, most frequent first.
const parseCandidates = (text) =>
  String(text ?? "").split(/\r?\n/u)
    .map((line) => line.trim().split("\t"))
    .filter((parts) => parts.length === 2 && /^\d+$/u.test(parts[0]) && RKEY_TOKEN.test(parts[1]))
    .map(([count, key]) => ({ key, count: Number(count) }))
    .sort((left, right) => right.count - left.count);

const scanWindows = async (toolRoot) => {
  const result = await runScript(path.join(toolRoot, "scripts", "scan_qq_rkeys.ps1"));
  if (result.code === 3) {
    return { candidates: [], problem: "no-qq" };
  }
  if (result.code !== 0) {
    return { candidates: [], problem: "scan-failed" };
  }
  return { candidates: parseCandidates(result.stdout), problem: null };
};

const collectFromBuffer = (buffer, length, found) => {
  let at = buffer.indexOf(NEEDLE, 0);
  while (at !== -1 && at < length) {
    let end = at + NEEDLE.length;
    while (end < length && /[\w-]/u.test(String.fromCharCode(buffer[end]))) {
      end += 1;
    }
    const key = buffer.toString("ascii", at + NEEDLE.length, end);
    if (RKEY_TOKEN.test(key)) {
      found.set(key, (found.get(key) ?? 0) + 1);
    }
    at = buffer.indexOf(NEEDLE, end);
  }
};

const scanLinux = () => {
  const pids = linuxScan.findQqPids();
  if (pids.length === 0) {
    return { candidates: [], problem: "no-qq" };
  }
  const found = new Map();
  let readable = false;
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES + OVERLAP_BYTES);
  for (const pid of pids) {
    let fd;
    try {
      fd = fs.openSync(`/proc/${pid}/mem`, "r");
    } catch {
      continue;
    }
    readable = true;
    try {
      const maps = fs.readFileSync(`/proc/${pid}/maps`, "utf8");
      for (const region of linuxScan.parseMaps(maps)) {
        for (let address = region.start; address < region.end; address += CHUNK_BYTES) {
          try {
            const read = fs.readSync(fd, buffer, 0, Math.min(CHUNK_BYTES + OVERLAP_BYTES, region.end - address), address);
            collectFromBuffer(buffer, read, found);
          } catch {
            // Unmapped pages inside a region: skip the chunk.
          }
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  if (!readable) {
    return { candidates: [], problem: "no-permission" };
  }
  const candidates = [...found].map(([key, count]) => ({ key, count })).sort((left, right) => right.count - left.count);
  return { candidates, problem: null };
};

const scanCandidates = (toolRoot) => (platform.isWindows ? scanWindows(toolRoot) : Promise.resolve(scanLinux()));

// The first candidate that fetches `probe`'s thumbnail (an NT picture still
// on the server). Returns { key } or { key: null, probeGone } - a probe that
// Tencent already deleted says nothing about the keys, so try another probe.
const pickWorking = async (candidates, probe, { fetchImpl } = {}) => {
  const ntOnly = { ...probe, legacyPath: "", md5: "" };
  for (const { key } of candidates.slice(0, MAX_TRIES)) {
    const result = await fetchPicture(ntOnly, "thumb", { rkey: key, fetchImpl });
    if (result.outcome === "ok") {
      return { key, probeGone: false };
    }
    if (result.outcome === "gone") {
      return { key: null, probeGone: true };
    }
  }
  return { key: null, probeGone: false };
};

// The key the console holds, in memory only. `scan` returns { key, problem }.
// A scan reads every QQ process (~12 s, measured 2026-09-25), so it runs at
// most every RESCAN_MIN_MS. Tencent refusing a key usually means it expired,
// but it can also be one picture the key is not good for: a key that worked
// in the last KEY_TRUST_MS is kept until it is refused MAX_REFUSALS times in
// a row. Earlier every refusal forced an immediate rescan.
const KEY_TRUST_MS = 60 * 1000;
const RESCAN_MIN_MS = 2 * 60 * 1000;
const MAX_REFUSALS = 3;

const createKeyHolder = ({ scan, now = Date.now }) => {
  const state = { key: null, problem: null, checkedAt: 0, lastOkAt: 0, lastScanAt: 0, refusals: 0, scanning: null };

  const rescan = () => {
    state.lastScanAt = now();
    state.scanning = Promise.resolve()
      .then(scan)
      .then(({ key, problem }) => {
        if (key === null) {
          state.problem = problem;
          return null;
        }
        Object.assign(state, { key, problem: null, checkedAt: now(), lastOkAt: now(), refusals: 0 });
        return key;
      })
      .catch(() => {
        state.problem = "scan-failed";
        return null;
      })
      .finally(() => {
        state.scanning = null;
      });
    return state.scanning;
  };

  // A usable key, scanning when there is none (not more often than
  // RESCAN_MIN_MS, so a closed QQ is not rescanned on every request).
  const ensure = async () => {
    if (state.key !== null) {
      return state.key;
    }
    if (state.scanning !== null) {
      return state.scanning;
    }
    if (now() - state.lastScanAt < RESCAN_MIN_MS) {
      return null;
    }
    return rescan();
  };

  const succeeded = (key) => {
    if (key !== null && key === state.key) {
      state.lastOkAt = now();
      state.refusals = 0;
    }
  };

  // Tencent refused `key`: returns a different key to retry with, or null.
  const refused = async (key) => {
    if (key === null) {
      return null;
    }
    if (state.key === key) {
      state.refusals += 1;
      const stale = now() - state.lastOkAt >= KEY_TRUST_MS || state.refusals >= MAX_REFUSALS;
      if (!stale || now() - state.lastScanAt < RESCAN_MIN_MS) {
        return null;
      }
      state.key = null;
    }
    const fresh = await ensure();
    return fresh !== null && fresh !== key ? fresh : null;
  };

  const status = () => ({
    ready: state.key !== null,
    problem: state.problem,
    checkedAt: state.checkedAt > 0 ? new Date(state.checkedAt).toISOString() : null,
    scanning: state.scanning !== null,
  });

  return { ensure, succeeded, refused, status };
};

module.exports = {
  KEY_TRUST_MS,
  RESCAN_MIN_MS,
  MAX_REFUSALS,
  scanCandidates,
  parseCandidates,
  collectFromBuffer,
  pickWorking,
  createKeyHolder,
};
