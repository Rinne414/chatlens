"use strict";

// Linux counterpart of scripts/scan_qq_memory_keys.ps1: reads the running QQ
// processes' memory READ-ONLY through /proc/<pid>/mem and collects 16/32-char
// key candidates. Reading another process's memory needs ptrace permission.
//
// The settings page never runs this toolkit's own code as root (it lives in a
// user-writable install dir, so a tampered file would turn the password prompt
// into a root exploit). Instead streamPrivilegedScan runs only the system
// /bin/sh + dd under pkexec, with a fixed script that copies the listed memory
// regions to stdout; this unprivileged process scans the stream.
//
// Manual fallback (the user runs it knowingly with sudo):
//   sudo node src/linux_key_scan.js --output /tmp/qq-candidates.txt [--pid 1234]
// That output file holds the real key among the noise: it is created 0600 and
// handed to the invoking user (SUDO_UID / PKEXEC_UID).

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { parseArgs } = require("node:util");
const { scanBuffer } = require("./key_candidates");

const CHUNK_BYTES = 16 * 1024 * 1024;
const OVERLAP_BYTES = 128;
const QQ_COMMAND_NAMES = new Set(["qq", "QQ"]);

const readText = (filePath) => {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
};

// QQ for Linux is an Electron app whose processes are all named "qq"
// (native package, AppImage and Flatpak alike).
const findQqPids = (procRoot = "/proc") =>
  fs.readdirSync(procRoot)
    .filter((name) => /^\d+$/u.test(name))
    .map(Number)
    .filter((pid) => pid !== process.pid && QQ_COMMAND_NAMES.has(readText(path.join(procRoot, String(pid), "comm")).trim()));

// Heap and anonymous private mappings: where a runtime-derived key lives.
// File-backed mappings (libraries, fonts, the app bundle) are skipped.
const parseMaps = (mapsText) =>
  mapsText.split("\n").flatMap((line) => {
    const match = line.match(/^([0-9a-f]+)-([0-9a-f]+)\s+(\S{4})\s+\S+\s+\S+\s+(\d+)\s*(.*)$/u);
    if (match === null) {
      return [];
    }
    const [, startHex, endHex, perms, inode, pathname] = match;
    const name = pathname.trim();
    const anonymous = inode === "0" && (name === "" || name === "[heap]" || name.startsWith("[anon"));
    if (!perms.startsWith("r") || !anonymous) {
      return [];
    }
    return [{ start: Number.parseInt(startHex, 16), end: Number.parseInt(endHex, 16) }];
  });

const scanProcess = (pid, candidates, procRoot = "/proc") => {
  const regions = parseMaps(readText(path.join(procRoot, String(pid), "maps")));
  let fd;
  try {
    fd = fs.openSync(path.join(procRoot, String(pid), "mem"), "r");
  } catch (error) {
    return { pid, regions: regions.length, scannedBytes: 0, error: error.code ?? error.message };
  }
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES + OVERLAP_BYTES);
  let scannedBytes = 0;
  try {
    for (const region of regions) {
      let carry = 0;
      for (let address = region.start; address < region.end; address += CHUNK_BYTES) {
        const wanted = Math.min(CHUNK_BYTES, region.end - address);
        let read = 0;
        try {
          read = fs.readSync(fd, buffer, carry, wanted, address);
        } catch {
          // Unmapped/guard pages inside a region: skip this chunk.
          carry = 0;
          continue;
        }
        const length = carry + read;
        scanBuffer(buffer, length, candidates);
        scannedBytes += read;
        carry = Math.min(OVERLAP_BYTES, length);
        buffer.copy(buffer, 0, length - carry, length);
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return { pid, regions: regions.length, scannedBytes, error: null };
};

/* ---------- privileged dump through system binaries only ---------- */

// Arguments are "pid:start:length" triples (validated below). GNU dd's
// skip_bytes/count_bytes read exactly one mapping; unreadable pages just end
// that region early.
const DUMP_SCRIPT = [
  "for spec in \"$@\"; do",
  "  pid=${spec%%:*}; rest=${spec#*:}; start=${rest%%:*}; len=${rest#*:}",
  "  dd if=/proc/$pid/mem bs=1048576 iflag=skip_bytes,count_bytes skip=$start count=$len status=none 2>/dev/null",
  "done",
  "exit 0",
].join("\n");

const SPEC_PATTERN = /^\d+:\d+:\d+$/u;

// Region list for the dump, built WITHOUT privileges: /proc/<pid>/maps of the
// user's own processes is readable; only /proc/<pid>/mem needs ptrace rights.
const regionSpecs = (pids, procRoot = "/proc") =>
  pids.flatMap((pid) =>
    parseMaps(readText(path.join(procRoot, String(pid), "maps")))
      .map((region) => `${pid}:${region.start}:${region.end - region.start}`))
    .filter((spec) => SPEC_PATTERN.test(spec));

// Streams stdout of `command args` through the candidate scanner.
// Resolves { code, candidates, bytes } — never rejects on a non-zero exit.
const streamScan = (command, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
    const candidates = new Set();
    let carry = Buffer.alloc(0);
    let bytes = 0;
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      const merged = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
      scanBuffer(merged, merged.length, candidates);
      carry = merged.subarray(Math.max(0, merged.length - OVERLAP_BYTES));
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, candidates, bytes });
    });
  });

const streamPrivilegedScan = (specs, timeoutMs) =>
  streamScan("pkexec", ["/bin/sh", "-c", DUMP_SCRIPT, "sh", ...specs.filter((spec) => SPEC_PATTERN.test(spec))], timeoutMs);

const handOverToInvokingUser = (filePath) => {
  const uid = Number(process.env.PKEXEC_UID ?? process.env.SUDO_UID);
  if (Number.isInteger(uid) && uid > 0 && typeof process.getuid === "function" && process.getuid() === 0) {
    const gid = Number(process.env.SUDO_GID);
    fs.chownSync(filePath, uid, Number.isInteger(gid) && gid > 0 ? gid : uid);
  }
};

const main = () => {
  const { values } = parseArgs({
    options: { output: { type: "string" }, pid: { type: "string", multiple: true } },
    strict: true,
  });
  if (!values.output || !path.isAbsolute(values.output)) {
    throw new Error("Usage: linux_key_scan.js --output <absolute path> [--pid N ...]");
  }
  const pids = (values.pid ?? []).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0);
  const targets = pids.length > 0 ? pids : findQqPids();
  if (targets.length === 0) {
    throw new Error("没有找到正在运行的 QQ 进程。请先打开并登录 QQ，再重试自动获取密钥。");
  }
  const candidates = new Set();
  const reports = targets.map((pid) => scanProcess(pid, candidates));
  if (reports.every((report) => report.error !== null)) {
    throw new Error(`无法读取 QQ 进程内存（${reports[0].error}）。需要管理员权限：请在弹出的系统密码框中确认，或在终端用 sudo 运行。`);
  }
  fs.writeFileSync(values.output, [...candidates].join("\n"), { mode: 0o600 });
  handOverToInvokingUser(values.output);
  process.stdout.write(`candidates=${candidates.size} pids=${targets.join(",")}\n`);
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { DUMP_SCRIPT, findQqPids, parseMaps, scanProcess, regionSpecs, streamScan, streamPrivilegedScan };
