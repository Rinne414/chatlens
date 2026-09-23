"use strict";

// One query flag, used by the launcher and the page: opening
// http://127.0.0.1:8321/?run=unviewed starts "摘要我还没看过的" without
// injecting into QQ.

const parseAutostart = (search) => {
  const raw = String(search ?? "");
  const query = raw.startsWith("?") ? raw.slice(1) : raw;
  const value = new URLSearchParams(query).get("run");
  return value !== null && value.toLowerCase() === "unviewed" ? "unviewed" : null;
};

const withAutostart = (baseUrl, kind) => {
  const trimmed = String(baseUrl ?? "").replace(/\/+$/u, "");
  const url = `${trimmed}/`;
  return kind === "unviewed" ? `${url}?run=unviewed` : url;
};

module.exports = { parseAutostart, withAutostart };
