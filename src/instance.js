"use strict";

// One console per install. The instance id is random per install (stored in
// store/instance-id), so /healthz can tell the launcher "this is your console"
// without exposing anything derived from the install path. The server lock
// (store/server.lock) stops two consoles — e.g. login autostart racing a
// double-click — from running two background schedulers on one store.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ID_PATTERN = /^[0-9a-f]{16}$/u;

const idPath = (toolRoot) => path.join(toolRoot, "store", "instance-id");
const lockPath = (toolRoot) => path.join(toolRoot, "store", "server.lock");

const readInstanceId = (toolRoot) => {
  try {
    const value = fs.readFileSync(idPath(toolRoot), "utf8").trim();
    return ID_PATTERN.test(value) ? value : null;
  } catch {
    return null;
  }
};

const ensureInstanceId = (toolRoot) => {
  const existing = readInstanceId(toolRoot);
  if (existing !== null) {
    return existing;
  }
  fs.mkdirSync(path.dirname(idPath(toolRoot)), { recursive: true });
  try {
    fs.writeFileSync(idPath(toolRoot), crypto.randomBytes(8).toString("hex"), { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
  }
  return readInstanceId(toolRoot);
};

const isProcessAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

const readLockHolder = (toolRoot) => {
  try {
    const holder = JSON.parse(fs.readFileSync(lockPath(toolRoot), "utf8"));
    return Number.isInteger(holder?.pid) ? holder : null;
  } catch {
    return null;
  }
};

// Returns true when this process now owns the lock. `isHolderServing` lets the
// caller distinguish a live console from a reused pid of an unrelated process.
const acquireServerLock = async (toolRoot, isHolderServing) => {
  fs.mkdirSync(path.dirname(lockPath(toolRoot)), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.writeFileSync(lockPath(toolRoot), JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: "wx" });
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
    }
    const holder = readLockHolder(toolRoot);
    if (holder !== null && holder.pid !== process.pid && isProcessAlive(holder.pid) && await isHolderServing()) {
      return false;
    }
    fs.rmSync(lockPath(toolRoot), { force: true });
  }
  return false;
};

const releaseServerLock = (toolRoot) => {
  const holder = readLockHolder(toolRoot);
  if (holder?.pid === process.pid) {
    fs.rmSync(lockPath(toolRoot), { force: true });
  }
};

module.exports = { readInstanceId, ensureInstanceId, acquireServerLock, releaseServerLock };
