"use strict";

// Harvests AI metadata for the images referenced by one export, and attributes
// them to the group and sender in the same pass.
//
// This is the forward-looking path and the one that matters: it runs while the
// message is still in the local cache, so the (image -> who posted it, where,
// when) link is captured before QQ evicts either side. The bulk
// build_knowledge_base.js scan is the backfill counterpart; it can attribute
// nothing, because by the time it runs the messages are usually gone.
//
// Read-only with respect to QQ. Ori files are copied into store/media-objects
// (hash-verified) so cards survive QQ cache eviction. Thumbs are never copied:
// they are re-encodes whose bytes do not match the md5 in the filename.
//
// Usage:
//   node src/harvest_run_media.js <mediaMessagesJson> <ntDataDir> <knowledgeStorePath> [exportJson]
//
// exportJson is optional: when given, "show me the prompt" exchanges in that
// export are detected and stored too. It is a separate argument because the
// media list is derived (post-analysis) while quote links live on the raw export.

const fs = require("node:fs");
const path = require("node:path");
const { parseAiMetadata, PARSER_VERSION } = require("./ai_metadata");
const { pairPromptRequests } = require("./prompt_requests");
const {
  openKnowledgeStore,
  upsertImage,
  recordSighting,
  recordPromptRequest,
  markScanned,
  loadScanState,
  isUnchanged,
} = require("./knowledge_store");
const { persistOriginalsForHashes, buildOriIndex } = require("./media_object_store");
const { repairExifPrompts } = require("./knowledge_repair");

const parseArgs = (argv) => {
  if (argv.length < 5) {
    throw new Error("Usage: node harvest_run_media.js <mediaMessagesJson> <ntDataDir> <knowledgeStorePath> [exportJson]");
  }
  return {
    mediaMessagesJson: argv[2],
    ntDataDir: argv[3],
    storePath: argv[4],
    exportJson: argv[5] ?? "",
  };
};

const defaultObjectDir = (storePath) => path.join(path.dirname(path.resolve(storePath)), "media-objects");

const hashesFromThisRun = (refs, requests) => {
  const hashes = new Set(refs.keys());
  for (const request of requests) {
    if (typeof request.imageHash === "string" && request.imageHash.length === 32) {
      hashes.add(request.imageHash.toLowerCase());
    }
    for (const media of request.answerMedia ?? []) {
      if (typeof media.hash === "string" && media.hash.length === 32) {
        hashes.add(media.hash.toLowerCase());
      }
    }
  }
  return hashes;
};

// Smallest Thumb sibling per hash. Used only when Ori is gone, so the card can
// still show a picture; Thumb never has generation parameters.
// `wanted` limits the (expensive) stat calls to hashes this run references:
// a busy account's cache holds hundreds of thousands of thumbnails, and
// stat-ing all of them made every 15-minute background refresh take ~1 min.
const buildThumbIndex = (ntDataDir, wanted = null) => {
  const picRoot = path.join(ntDataDir, "Pic");
  const byHash = new Map();
  let months;
  try {
    months = fs.readdirSync(picRoot, { withFileTypes: true });
  } catch {
    return byHash;
  }
  for (const month of months) {
    if (!month.isDirectory()) {
      continue;
    }
    const thumbDir = path.join(picRoot, month.name, "Thumb");
    let names;
    try {
      names = fs.readdirSync(thumbDir);
    } catch {
      continue;
    }
    for (const name of names) {
      const match = name.toLowerCase().match(/^([a-f0-9]{32})/u);
      if (match === null || (wanted !== null && !wanted.has(match[1]))) {
        continue;
      }
      const full = path.join(thumbDir, name);
      let size = Number.POSITIVE_INFINITY;
      try {
        size = fs.statSync(full).size;
      } catch {
        continue;
      }
      const current = byHash.get(match[1]);
      if (current === undefined || size < current.size) {
        byHash.set(match[1], { full, size });
      }
    }
  }
  const paths = new Map();
  for (const [hash, candidate] of byHash) {
    paths.set(hash, candidate.full);
  }
  return paths;
};

const speakerOf = (message) =>
  message.speaker || message.senderName || message.memberName || String(message.senderUin ?? "") || "";

// Collect (hash -> earliest message that referenced it). The earliest sighting
// is the original post; later ones are replies and forwards re-embedding the
// same ref, which the exporter already treats as non-authoritative.
const collectImageRefs = (mediaMessages) => {
  const byHash = new Map();
  for (const message of mediaMessages) {
    for (const ref of message.mediaRefs ?? []) {
      if (ref.kind !== "image" || typeof ref.hash !== "string" || ref.hash.length !== 32) {
        continue;
      }
      const hash = ref.hash.toLowerCase();
      const existing = byHash.get(hash);
      const sentAt = Number(message.sentAt ?? 0);
      if (existing === undefined || sentAt < existing.sentAt) {
        byHash.set(hash, {
          hash,
          sentAt,
          groupId: String(message.groupId ?? ""),
          groupName: String(message.groupName ?? ""),
          rowId: String(message.rowId ?? ""),
          speaker: speakerOf(message),
          speakerUin: String(message.senderUin ?? message.memberUin ?? ""),
        });
      }
    }
  }
  return byHash;
};

const readJsonOrNull = (filePath) => {
  if (filePath === "") {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
};

const harvestRunMedia = ({ mediaMessagesJson, ntDataDir, storePath, exportJson = "", objectDir = "" }) => {
  const mediaMessages = JSON.parse(fs.readFileSync(mediaMessagesJson, "utf8"));
  const refs = collectImageRefs(Array.isArray(mediaMessages) ? mediaMessages : []);
  const exportData = readJsonOrNull(exportJson);
  // Prompt requests are detected from the raw export; pair them against the
  // analysed media list, which carries the resolved speaker names.
  const requests = exportData === null
    ? []
    : pairPromptRequests({ ...exportData, mediaMessages: Array.isArray(mediaMessages) ? mediaMessages : [] });

  const stats = {
    imageRefs: refs.size,
    originalMissing: 0,
    parsed: 0,
    stripped: 0,
    skipped: 0,
    attributed: 0,
    placeholders: 0,
    promptRequests: requests.length,
    answeredRequests: requests.filter((request) => request.answerKind !== "").length,
    durableStored: 0,
    durableReused: 0,
    durableFailed: 0,
  };
  // An ask can occur in a window that contributed no new images, so the store is
  // still opened when only requests were found.
  if (refs.size === 0 && requests.length === 0) {
    return { stats };
  }

  const db = openKnowledgeStore(storePath);
  // No-op after the first run on a library parsed before PARSER_VERSION 3.
  const repaired = repairExifPrompts(db);
  if (repaired.checked > 0) {
    process.stdout.write(`exif-repair checked=${repaired.checked} recovered=${repaired.recovered} stripped=${repaired.stripped}\n`);
  }
  const oriIndex = buildOriIndex(ntDataDir);
  const thumbIndex = buildThumbIndex(ntDataDir, hashesFromThisRun(refs, requests));
  const scanState = loadScanState(db, PARSER_VERSION);
  const knownHashes = new Set(db.prepare("SELECT hash FROM images").all().map((row) => row.hash));

  const writeStrippedCard = ({ hash, filePath, fileMtime, fileSize, parsedAt }) => {
    const existing = db.prepare("SELECT file_path AS filePath FROM images WHERE hash = ?").get(hash);
    if (existing === undefined) {
      upsertImage(db, {
        hash,
        filePath: filePath ?? "",
        fileSize: fileSize ?? 0,
        fileMtime: fileMtime ?? 0,
        container: null,
        width: 0,
        height: 0,
        generator: "stripped",
        prompt: "",
        negativePrompt: "",
        checkpoint: "",
        modelHash: "",
        loras: [],
        params: {},
        rawChunks: {},
        parserVersion: PARSER_VERSION,
        parsedAt,
      });
    } else if ((existing.filePath === "" || existing.filePath === null) && filePath) {
      db.prepare("UPDATE images SET file_path = ?, file_mtime = ?, file_size = ?, file_missing = 0 WHERE hash = ?")
        .run(filePath, fileMtime ?? 0, fileSize ?? 0, hash);
    }
    knownHashes.add(hash);
  };

  const applyAll = db.transaction(() => {
    for (const [hash, sighting] of refs) {
      const filePath = oriIndex.get(hash);
      const scannedAt = Math.floor(Date.now() / 1000);
      if (filePath === undefined) {
        // No original: still keep who posted it. Prefer a Thumb so the card is
        // not a blank hole; parameters are gone either way.
        stats.originalMissing += 1;
        const thumbPath = thumbIndex.get(hash) ?? "";
        let fileMtime = sighting.sentAt ?? 0;
        let fileSize = 0;
        if (thumbPath !== "") {
          try {
            const stat = fs.statSync(thumbPath);
            fileMtime = Math.floor(stat.mtimeMs / 1000);
            fileSize = stat.size;
          } catch {
            // The listing can race with QQ deleting the thumb.
          }
        }
        writeStrippedCard({ hash, filePath: thumbPath, fileMtime, fileSize, parsedAt: scannedAt });
        recordSighting(db, sighting);
        stats.attributed += 1;
        continue;
      }

      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch {
        stats.originalMissing += 1;
        writeStrippedCard({
          hash,
          filePath: thumbIndex.get(hash) ?? "",
          fileMtime: sighting.sentAt ?? 0,
          fileSize: 0,
          parsedAt: scannedAt,
        });
        recordSighting(db, sighting);
        stats.attributed += 1;
        continue;
      }
      const fileMtime = Math.floor(stat.mtimeMs / 1000);
      const alreadyParsed = isUnchanged(scanState, filePath, stat.size, fileMtime);

      if (alreadyParsed) {
        stats.skipped += 1;
        writeStrippedCard({ hash, filePath, fileMtime, fileSize: stat.size, parsedAt: scannedAt });
        knownHashes.add(hash);
      } else {
        const result = parseAiMetadata(filePath, stat.size);
        if (result.generator === "unknown") {
          stats.stripped += 1;
          writeStrippedCard({ hash, filePath, fileMtime, fileSize: stat.size, parsedAt: scannedAt });
          markScanned(db, {
            filePath,
            fileSize: stat.size,
            fileMtime,
            parserVersion: PARSER_VERSION,
            outcome: result.container === null ? "unreadable" : "no-metadata",
            scannedAt,
          });
        } else {
          stats.parsed += 1;
          knownHashes.add(hash);
          upsertImage(db, { ...result, hash, filePath, fileMtime, parsedAt: scannedAt });
          markScanned(db, {
            filePath,
            fileSize: stat.size,
            fileMtime,
            parserVersion: PARSER_VERSION,
            outcome: result.generator,
            scannedAt,
          });
        }
      }

      recordSighting(db, sighting);
      stats.attributed += 1;
    }

    // Stored after the images, so a request pointing at an image harvested in
    // this same pass resolves against a row that already exists.
    //
    // A request's target frequently has NO metadata row: QQ stripped the
    // parameters, which is exactly why somebody had to ask for the prompt. Keep
    // a minimal placeholder row for those so the pairing can still show the
    // picture and the chat-sourced prompt together, with generator "stripped"
    // marking that nothing was read from the file itself.
    const recordedAt = Math.floor(Date.now() / 1000);
    const ensurePlaceholder = (hash) => {
      if (hash === null || knownHashes.has(hash)) {
        return;
      }
      const filePath = oriIndex.get(hash);
      const sighting = refs.get(hash);
      upsertImage(db, {
        hash,
        filePath: filePath ?? "",
        fileSize: 0,
        fileMtime: 0,
        container: null,
        width: 0,
        height: 0,
        generator: "stripped",
        prompt: "",
        negativePrompt: "",
        checkpoint: "",
        modelHash: "",
        loras: [],
        params: {},
        rawChunks: {},
        parserVersion: PARSER_VERSION,
        parsedAt: recordedAt,
      });
      knownHashes.add(hash);
      stats.placeholders += 1;
      if (sighting !== undefined) {
        recordSighting(db, sighting);
      }
    };
    for (const request of requests) {
      ensurePlaceholder(request.imageHash);
      for (const media of request.answerMedia) {
        ensurePlaceholder(media.hash);
      }
      recordPromptRequest(db, { ...request, recordedAt });
    }
  });
  applyAll();
  // Only this export. Copying every known row here would stall a live summary;
  // harvest_existing_runs / backfillHarvestedMediaObjects covers history.
  const durable = persistOriginalsForHashes({
    hashes: hashesFromThisRun(refs, requests),
    sourceByHash: oriIndex,
    objectDir: objectDir === "" ? defaultObjectDir(storePath) : objectDir,
    db,
  });
  stats.durableStored = durable.durableStored;
  stats.durableReused = durable.durableReused;
  stats.durableFailed = durable.durableFailed;
  db.close();
  return { stats };
};

const main = () => {
  const args = parseArgs(process.argv);
  const { stats } = harvestRunMedia(args);

  const withOriginal = stats.parsed + stats.stripped + stats.skipped;
  process.stdout.write(`image refs=${stats.imageRefs} originals-on-disk=${withOriginal} `);
  process.stdout.write(`parsed=${stats.parsed} stripped=${stats.stripped} `);
  process.stdout.write(`already-known=${stats.skipped} no-original=${stats.originalMissing} `);
  process.stdout.write(`attributed=${stats.attributed}`);
  if (stats.durableStored + stats.durableReused + stats.durableFailed > 0) {
    process.stdout.write(` durable-stored=${stats.durableStored} durable-reused=${stats.durableReused}`);
    if (stats.durableFailed > 0) {
      process.stdout.write(` durable-failed=${stats.durableFailed}`);
    }
  }
  process.stdout.write("\n");
  if (stats.promptRequests > 0) {
    process.stdout.write(`prompt requests=${stats.promptRequests} answered=${stats.answeredRequests}`);
    process.stdout.write(` metadata-stripped-targets=${stats.placeholders}\n`);
  }

  // Surfaced because it is actionable: QQ only keeps a full-resolution original
  // when PC QQ saved the original, which it does only for pictures the user
  // opened full size (there is no "download every original" setting).
  if (stats.imageRefs > 0 && stats.originalMissing / stats.imageRefs > 0.5) {
    const percent = ((stats.originalMissing / stats.imageRefs) * 100).toFixed(0);
    process.stdout.write(`提示：本次 ${percent}% 的图片本地没有原图，AI 参数无法读取。\n`);
    process.stdout.write("      电脑 QQ 只在点开大图时保存原图；发图时勾选「原图」、点开看大图，以后的图片才有生成参数。\n");
  }
};

if (require.main === module) {
  main();
}

module.exports = { harvestRunMedia, collectImageRefs, buildOriIndex };
