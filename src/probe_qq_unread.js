"use strict";

// Copy-then-read QQ's recent_contact.db. Writes store/qq-unread-hint.json.
// Never opens the original Tencent Files database for writing.

const fs = require("node:fs");
const path = require("node:path");
const { openDatabase, requireEnv } = require("./query_ntqq");
const { extractUnreadRows, hintForWatchlist } = require("./qq_unread_hint");

const parseArgs = (argv) => {
  if (argv.length < 4) {
    throw new Error("Usage: node probe_qq_unread.js <cleanDbPath> <outputJson> [watchlistJson]");
  }
  return {
    databasePath: argv[2],
    outputPath: argv[3],
    watchlistPath: argv[4] ?? "",
  };
};

const loadWatchlist = (filePath) => {
  if (filePath === "") {
    return [];
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(parsed) ? parsed : parsed.watchlist ?? [];
  } catch {
    return [];
  }
};

const main = () => {
  const args = parseArgs(process.argv);
  const key = requireEnv("NTQQ_DB_KEY");
  const db = openDatabase(args.databasePath, key);
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
    const rows = extractUnreadRows(db);
    const watchlist = loadWatchlist(args.watchlistPath);
    const hint = hintForWatchlist(rows, watchlist);
    const payload = {
      probedAt: new Date().toISOString(),
      tables,
      rowCount: rows.length,
      sample: rows.slice(0, 20),
      ...hint,
    };
    fs.mkdirSync(path.dirname(args.outputPath), { recursive: true });
    fs.writeFileSync(args.outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    process.stdout.write(`tables=${tables.length} unreadRows=${rows.length} watchlistHits=${hint.groups.length}\n`);
  } finally {
    db.close();
  }
};

if (require.main === module) {
  main();
}
