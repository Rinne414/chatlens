"use strict";

// The Obsidian vaults this computer knows: Obsidian keeps the list in its own
// obsidian.json (%APPDATA%\obsidian on Windows, ~/.config/obsidian on Linux,
// ~/Library/Application Support/obsidian on macOS). Read-only.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const obsidianConfigPath = (env = process.env, platform = process.platform, home = os.homedir()) => {
  if (platform === "win32") {
    return path.join(env.APPDATA ?? path.join(home, "AppData", "Roaming"), "obsidian", "obsidian.json");
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "obsidian", "obsidian.json");
  }
  return path.join(env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "obsidian", "obsidian.json");
};

// [{ path, name, open, exists }], the vault Obsidian last had open first.
const detectVaults = (configPath = obsidianConfigPath()) => {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return [];
  }
  const vaults = parsed?.vaults !== null && typeof parsed?.vaults === "object" ? Object.values(parsed.vaults) : [];
  return vaults
    .filter((vault) => typeof vault?.path === "string" && vault.path.trim() !== "")
    .map((vault) => ({
      path: vault.path,
      name: path.basename(vault.path),
      open: vault.open === true,
      lastOpened: Number(vault.ts) || 0,
      exists: fs.existsSync(vault.path),
    }))
    .sort((left, right) => Number(right.open) - Number(left.open) || right.lastOpened - left.lastOpened);
};

module.exports = { obsidianConfigPath, detectVaults };
