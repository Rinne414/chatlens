"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openDatabase, requireEnv } = require("./query_ntqq");

const COLLECTOR_URL_RE =
  /https?:\/\/shp\.qpic\.cn\/collector\/(\d+)\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\//giu;
const LOCAL_ORI_RE =
  /[A-Za-z]:\\[^\u0000-\u001f"'<>|]{8,400}?\\Ori\\[^\u0000-\u001f"'<>|\\]+\.(?:jpeg|jpg|png|gif|webp|bmp|jfif|heic)/giu;
const IMAGE_EXTENSIONS = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/gif", ".gif"],
  ["image/webp", ".webp"],
  ["image/bmp", ".bmp"],
  ["image/avif", ".avif"],
  ["image/heic", ".heic"],
  ["image/heif", ".heic"],
  ["video/mp4", ".mp4"],
  ["video/quicktime", ".mov"],
  ["application/zip", ".zip"],
  ["application/pdf", ".pdf"],
]);
const KIND_BY_TYPE = {
  8: "photos",
  6: "files",
  5: "videos",
  2: "links",
  4: "text",
};
const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_TIMEOUT_MS = 20000;
const DOWNLOAD_CONCURRENCY = 8;
const MIN_ORIGINAL_BYTES = 32;

const blobText = (value) => (Buffer.isBuffer(value) ? value.toString("utf8") : "");

const fileExists = (filePath) => {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
};

const remapNtDataPath = (localPath, ntDataDir) => {
  const marker = /[\\/]nt_qq[\\/]nt_data/iu;
  const match = marker.exec(localPath);
  if (match === null) {
    return localPath;
  }
  // Recorded paths use the recording OS's separators; split on both so a
  // Windows-recorded path still resolves under a Linux nt_data (and vice versa).
  const rest = localPath.slice(match.index + match[0].length).split(/[\\/]+/u).filter((part) => part.length > 0);
  return path.join(ntDataDir, ...rest);
};

const extractCollectorRefs = (text) => {
  const refs = [];
  COLLECTOR_URL_RE.lastIndex = 0;
  for (const match of text.matchAll(COLLECTOR_URL_RE)) {
    refs.push({
      uin: match[1],
      uuid: match[2].toLowerCase(),
    });
  }
  return refs;
};

const extractOriPaths = (text) => {
  LOCAL_ORI_RE.lastIndex = 0;
  return [...text.matchAll(LOCAL_ORI_RE)].map((match) => match[0]);
};

const readVarint = (buf, index) => {
  let shift = 0;
  let result = 0;
  let pos = index;
  while (pos < buf.length) {
    const byte = buf[pos];
    pos += 1;
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      return [result, pos];
    }
    shift += 7;
    if (shift > 56) {
      return [null, pos];
    }
  }
  return [null, pos];
};

const parseProtobufFields = (buf) => {
  const fields = [];
  let i = 0;
  while (i < buf.length) {
    const [tag, next] = readVarint(buf, i);
    if (tag === null) {
      return null;
    }
    i = next;
    const fieldNumber = Math.floor(tag / 8);
    const wireType = tag & 7;
    if (fieldNumber === 0) {
      return null;
    }
    if (wireType === 0) {
      const [value, after] = readVarint(buf, i);
      if (after === null || after > buf.length) {
        return null;
      }
      fields.push({ fieldNumber, wireType, value });
      i = after;
    } else if (wireType === 2) {
      const [length, afterLength] = readVarint(buf, i);
      if (length === null || afterLength + length > buf.length) {
        return null;
      }
      fields.push({ fieldNumber, wireType, slice: buf.subarray(afterLength, afterLength + length) });
      i = afterLength + length;
    } else if (wireType === 5) {
      if (i + 4 > buf.length) {
        return null;
      }
      i += 4;
    } else if (wireType === 1) {
      if (i + 8 > buf.length) {
        return null;
      }
      i += 8;
    } else {
      return null;
    }
  }
  return fields;
};

const asUtf8 = (slice) => {
  const text = slice.toString("utf8");
  if (text.includes("\uFFFD")) {
    return null;
  }
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code < 9 || (code > 13 && code < 32)) {
      return null;
    }
  }
  return text;
};

const walkProtobuf = (buf, visit, depth = 0) => {
  if (depth > 8 || !Buffer.isBuffer(buf)) {
    return;
  }
  const fields = parseProtobufFields(buf);
  if (fields === null) {
    return;
  }
  for (const field of fields) {
    visit(field);
    if (field.wireType === 2 && field.slice.length >= 2) {
      walkProtobuf(field.slice, visit, depth + 1);
    }
  }
};

const extractFileMeta = (buf) => {
  const names = [];
  const md5s = [];
  const ids = [];
  let size = null;
  walkProtobuf(buf, (field) => {
    if (field.wireType === 2 && field.fieldNumber === 180604) {
      const text = asUtf8(field.slice);
      if (text) {
        names.push(text);
      }
    }
    if (field.wireType === 2 && field.fieldNumber === 180606 && field.slice.length === 16) {
      md5s.push(field.slice.toString("hex"));
    }
    if (field.wireType === 2 && field.fieldNumber === 180603) {
      const text = asUtf8(field.slice);
      if (text) {
        ids.push(text);
      }
    }
    if (field.wireType === 0 && field.fieldNumber === 180605) {
      size = field.value;
    }
  });
  const fileName = names.find((name) => name.includes(".")) ?? names[0] ?? null;
  return { fileName, md5s: [...new Set(md5s)], fileIds: [...new Set(ids)], size };
};

const extractNoteText = (buf) => {
  const parts = [];
  walkProtobuf(buf, (field) => {
    if (field.wireType !== 2) {
      return;
    }
    if (field.fieldNumber === 181052 || field.fieldNumber === 181452 || field.fieldNumber === 180852 || field.fieldNumber === 180853) {
      const text = asUtf8(field.slice);
      if (text && text.trim().length > 0) {
        parts.push(text.trim());
      }
    }
  });
  return [...new Set(parts)].join("\n");
};

const extractLinkMeta = (buf) => {
  let url = null;
  let title = null;
  walkProtobuf(buf, (field) => {
    if (field.wireType !== 2) {
      return;
    }
    const text = asUtf8(field.slice);
    if (!text) {
      return;
    }
    if (field.fieldNumber === 180850) {
      url = text;
    }
    if (field.fieldNumber === 180852 || field.fieldNumber === 180851) {
      title ??= text;
    }
  });
  return { url, title };
};

const extractSpeakerMeta = (buf) => {
  let groupName = null;
  let speaker = null;
  walkProtobuf(buf, (field) => {
    if (field.wireType !== 2) {
      return;
    }
    const text = asUtf8(field.slice);
    if (!text) {
      return;
    }
    if (field.fieldNumber === 18505) {
      groupName = text;
    }
    if (field.fieldNumber === 180503) {
      speaker = text;
    }
  });
  return { groupName, speaker };
};

const formatHkt = (unixMs) => {
  if (!Number.isFinite(unixMs) || unixMs <= 0) {
    return "1970-01-01 00:00:00";
  }
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(unixMs));
};

const collectorUrl = (uin, uuid) => `https://shp.qpic.cn/collector/${uin}/${uuid}/0`;

const uniquePush = (list, seen, value) => {
  if (seen.has(value)) {
    return;
  }
  seen.add(value);
  list.push(value);
};

const sanitizeFileName = (value) =>
  String(value)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 120) || "unnamed";

const kindForRow = (type, hasMedia) => {
  if (type === 8 && !hasMedia) {
    return "text";
  }
  return KIND_BY_TYPE[type] ?? "other";
};

const collectPhotoJobs = (rows, ntDataDir) => {
  const byUuid = new Map();
  const extraLocal = new Map();

  for (const row of rows) {
    const text = `${blobText(row.b4)}\n${blobText(row.b15)}`;
    const refs = extractCollectorRefs(text);
    const oriPaths = [];
    const seenPath = new Set();
    for (const rawPath of extractOriPaths(text)) {
      uniquePush(oriPaths, seenPath, remapNtDataPath(rawPath, ntDataDir));
    }
    const existingOri = oriPaths.filter(fileExists);
    const timestampMs = Number(row.ts) || 0;

    if (refs.length === 1 && existingOri.length >= 1) {
      const [ref] = refs;
      const current = byUuid.get(ref.uuid) ?? {
        uuid: ref.uuid,
        uin: ref.uin,
        timestampMs,
        ids: [],
        localPath: null,
      };
      current.ids.push(row.id);
      current.timestampMs = Math.max(current.timestampMs, timestampMs);
      current.localPath ??= existingOri[0];
      byUuid.set(ref.uuid, current);
      for (const extra of existingOri.slice(1)) {
        extraLocal.set(path.basename(extra).toLowerCase(), { localPath: extra, timestampMs, id: row.id });
      }
      continue;
    }

    if (refs.length > 0 && refs.length === existingOri.length) {
      refs.forEach((ref, index) => {
        const current = byUuid.get(ref.uuid) ?? {
          uuid: ref.uuid,
          uin: ref.uin,
          timestampMs,
          ids: [],
          localPath: null,
        };
        current.ids.push(row.id);
        current.timestampMs = Math.max(current.timestampMs, timestampMs);
        current.localPath ??= existingOri[index];
        byUuid.set(ref.uuid, current);
      });
      continue;
    }

    for (const ref of refs) {
      const current = byUuid.get(ref.uuid) ?? {
        uuid: ref.uuid,
        uin: ref.uin,
        timestampMs,
        ids: [],
        localPath: null,
      };
      current.ids.push(row.id);
      current.timestampMs = Math.max(current.timestampMs, timestampMs);
      byUuid.set(ref.uuid, current);
    }
    for (const localPath of existingOri) {
      extraLocal.set(path.basename(localPath).toLowerCase(), { localPath, timestampMs, id: row.id });
    }
  }

  const usedLocal = new Set(
    [...byUuid.values()].map((job) => (job.localPath ? path.basename(job.localPath).toLowerCase() : "")).filter(Boolean),
  );
  const extraJobs = [];
  for (const [name, extra] of extraLocal) {
    if (!usedLocal.has(name)) {
      extraJobs.push(extra);
    }
  }

  return {
    remoteJobs: [...byUuid.values()].sort((left, right) => left.timestampMs - right.timestampMs),
    extraJobs,
  };
};

const targetName = (timestampMs, stem, extension) => {
  const stamp = formatHkt(timestampMs).replace(/[-: ]/gu, "");
  return `${stamp}_${stem}${extension}`;
};

const kindMonthDir = (outputDir, kind, timestampMs) =>
  path.join(outputDir, kind, formatHkt(timestampMs).slice(0, 7));

const copyLocal = (sourcePath, outputDir, kind, timestampMs, stem) => {
  const extension = path.extname(sourcePath).toLowerCase() || ".bin";
  const targetPath = path.join(kindMonthDir(outputDir, kind, timestampMs), targetName(timestampMs, stem, extension));
  if (fileExists(targetPath) && fs.statSync(targetPath).size > 0) {
    return { status: "exists", targetPath, bytes: fs.statSync(targetPath).size };
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
  return { status: "copied", targetPath, bytes: fs.statSync(targetPath).size };
};

const writeTextFile = (outputDir, kind, timestampMs, stem, extension, body) => {
  const targetPath = path.join(kindMonthDir(outputDir, kind, timestampMs), targetName(timestampMs, stem, extension));
  if (fileExists(targetPath) && fs.statSync(targetPath).size > 0) {
    return { status: "exists", targetPath, bytes: fs.statSync(targetPath).size };
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, body, "utf8");
  return { status: "written", targetPath, bytes: Buffer.byteLength(body) };
};

const extensionFromContentType = (contentType) => {
  const type = (contentType ?? "").split(";", 1)[0].trim().toLowerCase();
  return IMAGE_EXTENSIONS.get(type) ?? null;
};

const downloadCollector = async (job, outputDir, kind, fetchImplementation) => {
  const url = collectorUrl(job.uin, job.uuid);
  let lastError = null;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchImplementation(url, {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (response.status === 404) {
        return { status: "not-found", url, statusCode: 404 };
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const extension = extensionFromContentType(response.headers.get("content-type")) ?? ".bin";
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length < MIN_ORIGINAL_BYTES) {
        throw new Error(`response too small (${bytes.length} bytes)`);
      }
      const targetPath = path.join(
        kindMonthDir(outputDir, kind, job.timestampMs),
        targetName(job.timestampMs, job.stem || job.uuid, extension),
      );
      if (fileExists(targetPath) && fs.statSync(targetPath).size > 0) {
        return { status: "exists", url, statusCode: response.status, targetPath, bytes: fs.statSync(targetPath).size };
      }
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, bytes);
      return { status: "downloaded", url, statusCode: response.status, targetPath, bytes: bytes.length };
    } catch (error) {
      lastError = error;
    }
  }
  return { status: "failed", url, error: lastError?.message ?? "unknown" };
};

const mapWithConcurrency = async (items, concurrency, operation) => {
  const results = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await operation(items[index], index);
    }
  };
  const workerCount = Math.min(Math.max(concurrency, 1), Math.max(items.length, 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
};

const isThumbPath = (filePath) => /(?:^|[\\/])Thumb[\\/]|_[0-9]{2,4}\.(?:jpe?g|png|webp)$/iu.test(filePath);

const walkFiles = (rootDir, visit) => {
  if (!fs.existsSync(rootDir)) {
    return;
  }
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile()) {
        visit(entryPath);
      }
    }
  }
};

const buildLocalIndex = (ntDataDir) => {
  const byHash = new Map();
  const byFileName = new Map();
  const roots = ["Pic", "Video", "File", "Emoji"].map((name) => path.join(ntDataDir, name));
  const downloads = path.join(os.homedir(), "Downloads");
  if (fs.existsSync(downloads)) {
    roots.push(downloads);
  }
  for (const root of roots) {
    walkFiles(root, (filePath) => {
      const fileName = path.basename(filePath).toLowerCase();
      const hashMatch = fileName.match(/[a-f0-9]{32}/u);
      if (hashMatch !== null) {
        const list = byHash.get(hashMatch[0]) ?? [];
        list.push(filePath);
        byHash.set(hashMatch[0], list);
      }
      const names = byFileName.get(fileName) ?? [];
      names.push(filePath);
      byFileName.set(fileName, names);
    });
  }
  return { byHash, byFileName };
};

const pickBestLocal = (candidates, declaredSize) => {
  const existing = candidates.filter(fileExists);
  if (existing.length === 0) {
    return null;
  }
  const originals = existing.filter((filePath) => !isThumbPath(filePath));
  const pool = originals.length > 0 ? originals : existing;
  const sized = [];
  for (const filePath of pool) {
    try {
      sized.push({ filePath, size: fs.statSync(filePath).size });
    } catch {
      // skip vanished
    }
  }
  if (sized.length === 0) {
    return null;
  }
  sized.sort((left, right) => right.size - left.size);
  const best = sized[0];
  if (declaredSize && declaredSize > 200 * 1024 && best.size < 80 * 1024 && originals.length === 0) {
    return null;
  }
  return best.filePath;
};

const readCollectionRows = (db) =>
  db.prepare(
    `SELECT "180001" AS id, "180002" AS type, "180011" AS ts, "180004" AS b4, "180015" AS b15
     FROM collection_list_info_table`,
  ).all();

const tally = (status) => {
  if (status === "copied" || status === "written") {
    return "copied";
  }
  if (status === "downloaded") {
    return "downloaded";
  }
  if (status === "exists") {
    return "existed";
  }
  if (status === "not-found" || status === "missing") {
    return "missing";
  }
  return "failed";
};

const exportCollectionPhotos = async (args, fetchImplementation = globalThis.fetch) => {
  if (typeof fetchImplementation !== "function") {
    throw new TypeError("Collection export requires fetch (Node.js 18+).");
  }
  fs.mkdirSync(args.outputDir, { recursive: true });
  const db = openDatabase(args.databasePath, args.key);
  let rows;
  try {
    rows = readCollectionRows(db);
  } finally {
    db.close();
  }

  const photoRows = rows.filter((row) => row.type === 8);
  const photoJobs = collectPhotoJobs(photoRows, args.ntDataDir);
  const localIndex = buildLocalIndex(args.ntDataDir);

  const manifest = [];
  const counts = { copied: 0, downloaded: 0, existed: 0, missing: 0, failed: 0 };
  const bump = (status) => {
    counts[tally(status)] += 1;
  };
  const record = (item) => {
    manifest.push(item);
    bump(item.status);
  };

  for (const extra of photoJobs.extraJobs) {
    try {
      record({ source: "local-extra", kind: "photos", id: extra.id, localPath: extra.localPath, ...copyLocal(extra.localPath, args.outputDir, "photos", extra.timestampMs, path.parse(extra.localPath).name) });
    } catch (error) {
      record({ source: "local-extra", kind: "photos", id: extra.id, localPath: extra.localPath, status: "failed", error: error.message });
    }
  }

  const photoDownloads = [];
  for (const job of photoJobs.remoteJobs) {
    if (job.localPath && fileExists(job.localPath)) {
      try {
        record({
          source: "local",
          kind: "photos",
          uuid: job.uuid,
          ids: job.ids,
          localPath: job.localPath,
          ...copyLocal(job.localPath, args.outputDir, "photos", job.timestampMs, job.uuid),
        });
      } catch (error) {
        record({ source: "local", kind: "photos", uuid: job.uuid, ids: job.ids, localPath: job.localPath, status: "failed", error: error.message });
        photoDownloads.push({ ...job, kind: "photos" });
      }
    } else {
      photoDownloads.push({ ...job, kind: "photos" });
    }
  }

  const otherDownloads = [];
  for (const row of rows) {
    if (row.type === 8) {
      const text = `${blobText(row.b4)}\n${blobText(row.b15)}`;
      if (extractCollectorRefs(text).length === 0 && extractOriPaths(text).length === 0) {
        const note = extractNoteText(row.b15) || extractNoteText(row.b4);
        if (note) {
          record({
            source: "text",
            kind: "text",
            id: row.id,
            ...writeTextFile(args.outputDir, "text", Number(row.ts) || 0, sanitizeFileName(row.id), ".txt", `${note}\n`),
          });
        }
      }
      continue;
    }

    const timestampMs = Number(row.ts) || 0;
    const speaker = extractSpeakerMeta(row.b4);
    const fileMeta = extractFileMeta(row.b15);
    const note = extractNoteText(row.b15);
    const link = extractLinkMeta(row.b15);
    const kind = kindForRow(row.type, Boolean(fileMeta.fileName || extractCollectorRefs(blobText(row.b15)).length));

    if (kind === "text" || row.type === 4) {
      const body = [
        speaker.groupName ? `群: ${speaker.groupName}` : "",
        speaker.speaker ? `发送者: ${speaker.speaker}` : "",
        note || "(无文本)",
      ].filter(Boolean).join("\n");
      record({
        source: "text",
        kind: "text",
        id: row.id,
        ...writeTextFile(args.outputDir, "text", timestampMs, sanitizeFileName(row.id), ".txt", `${body}\n`),
      });
      continue;
    }

    if (kind === "links") {
      const payload = {
        id: row.id,
        title: link.title,
        url: link.url && !link.url.startsWith("http") ? `https://${link.url}` : link.url,
        groupName: speaker.groupName,
        speaker: speaker.speaker,
        collectedAt: formatHkt(timestampMs),
      };
      record({
        source: "link-json",
        kind: "links",
        id: row.id,
        ...writeTextFile(args.outputDir, "links", timestampMs, sanitizeFileName(row.id), ".json", `${JSON.stringify(payload, null, 2)}\n`),
      });
      const refs = extractCollectorRefs(blobText(row.b15));
      for (const ref of refs) {
        otherDownloads.push({ ...ref, timestampMs, ids: [row.id], kind: "links" });
      }
      continue;
    }

    if (kind === "files" || kind === "videos") {
      const stem = sanitizeFileName(path.parse(fileMeta.fileName || row.id).name);
      let localPath = null;
      for (const md5 of fileMeta.md5s) {
        localPath = pickBestLocal(localIndex.byHash.get(md5) ?? [], fileMeta.size);
        if (localPath) {
          break;
        }
      }
      if (!localPath && fileMeta.fileName) {
        localPath = pickBestLocal(localIndex.byFileName.get(fileMeta.fileName.toLowerCase()) ?? [], fileMeta.size);
      }
      if (localPath) {
        try {
          record({
            source: "local-file",
            kind,
            id: row.id,
            fileName: fileMeta.fileName,
            md5s: fileMeta.md5s,
            localPath,
            ...copyLocal(localPath, args.outputDir, kind, timestampMs, stem),
          });
        } catch (error) {
          record({ source: "local-file", kind, id: row.id, fileName: fileMeta.fileName, status: "failed", error: error.message });
        }
      } else {
        record({
          source: "local-file",
          kind,
          id: row.id,
          fileName: fileMeta.fileName,
          md5s: fileMeta.md5s,
          fileIds: fileMeta.fileIds,
          size: fileMeta.size,
          status: "missing",
        });
      }
      if (kind === "videos") {
        const refs = extractCollectorRefs(blobText(row.b15));
        for (const ref of refs) {
          otherDownloads.push({ ...ref, timestampMs, ids: [row.id], kind: "videos", stem: `${ref.uuid}-cover` });
        }
      }
    }
  }

  const allDownloads = [...photoDownloads, ...otherDownloads];
  let done = 0;
  const remoteResults = await mapWithConcurrency(allDownloads, DOWNLOAD_CONCURRENCY, async (job) => {
    const result = await downloadCollector(job, args.outputDir, job.kind, fetchImplementation);
    done += 1;
    if (done % 50 === 0 || done === allDownloads.length) {
      process.stdout.write(`progress ${done}/${allDownloads.length}\n`);
    }
    return { job, result };
  });
  for (const item of remoteResults) {
    record({
      source: "cdn",
      kind: item.job.kind,
      uuid: item.job.uuid,
      ids: item.job.ids,
      uin: item.job.uin,
      ...item.result,
    });
  }

  const byKind = {};
  for (const item of manifest) {
    const kind = item.kind || "other";
    const bucket = byKind[kind] ?? { copied: 0, downloaded: 0, existed: 0, missing: 0, failed: 0 };
    bucket[tally(item.status)] += 1;
    byKind[kind] = bucket;
  }

  const summary = {
    outputDir: args.outputDir,
    collectionRows: rows.length,
    collectorImages: photoJobs.remoteJobs.length,
    extraLocalImages: photoJobs.extraJobs.length,
    ...counts,
    totalWritten: counts.copied + counts.downloaded + counts.existed,
    byKind,
  };
  fs.writeFileSync(path.join(args.outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(args.outputDir, "manifest.jsonl"), `${manifest.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  return summary;
};

const parseArgs = (argv) => {
  if (argv.length !== 5) {
    throw new Error("Usage: node export_collection_photos.js <collectionCleanDb> <ntDataDir> <outputDir>");
  }
  return {
    databasePath: argv[2],
    ntDataDir: argv[3],
    outputDir: argv[4],
    key: requireEnv("NTQQ_DB_KEY"),
  };
};

const main = async () => {
  const summary = await exportCollectionPhotos(parseArgs(process.argv));
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  collectPhotoJobs,
  collectorUrl,
  extractCollectorRefs,
  extractFileMeta,
  extractOriPaths,
  exportCollectionPhotos,
  kindForRow,
  remapNtDataPath,
  sanitizeFileName,
};
