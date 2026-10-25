"use strict";

// 设置 → Obsidian 笔记库 → 立即同步: places the things the AI has not put
// into topics yet (the first time ~20 calls, then a few), then writes the
// notes from what the store has. 群里的共识 is left to the background refresh.
//
//   node src/pipeline/vault_run.js
// Prints one machine-readable line at the end: notesResult={...json}

const messageStore = require("../message_store");
const { loadConfig } = require("../server/toolkit_state");
const { syncNotes } = require("../vault_sync");
const { writeNotesStatus, recordSync } = require("../vault_ai");
const { runNotesAiAlone } = require("./refresh_run");
const { lowerOwnPriority } = require("../platform");
const common = require("./common");

const main = async () => {
  lowerOwnPriority();
  const config = loadConfig();
  const now = common.nowUnix();
  // The notes are written with what is placed so far even when the AI part fails.
  const ai = await runNotesAiAlone({ config, now }).catch((error) => ({ failed: error.message }));
  const db = messageStore.openStore(common.storeDbPath);
  try {
    const result = recordSync(common.storeDir, syncNotes({ db, config, storeDir: common.storeDir, nowUnix: now, serverUrl: process.env.CHATLENS_URL ?? "" }));
    common.result("notesResult", JSON.stringify({ ...result, ai }));
  } catch (error) {
    writeNotesStatus(common.storeDir, { syncError: { at: now, message: error.message } });
    throw error;
  } finally {
    db.close();
  }
};

if (require.main === module) {
  common.runMain(main);
}
