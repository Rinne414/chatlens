"use strict";

// 笔记库: the files side. Only ever writes inside the ChatLens folder of the
// vault; finds its notes by their `chatlens:` property, so a note the user
// renamed or moved inside the folder is still the same note; remembers in
// store/notes-manifest.json what it wrote, so a note the user deleted is not
// brought back and aliases the user edited are recognised as theirs.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { splitNote, readScalar } = require("./vault_note_io");
const { linkKey } = require("./things_index");

const MANIFEST_VERSION = 1;
const LOCK_STALE_MS = 30 * 60 * 1000;
const HEAD_BYTES = 4096;
const MAX_VAULT_FILES = 20000;
const VAULT_SCAN_SECONDS = 3600;
const SKIP_DIRS = new Set([".obsidian", ".trash", ".git", "node_modules"]);
const URL_KEYS = ["url", "source", "link", "homepage"];

const sha1 = (text) => crypto.createHash("sha1").update(text).digest("hex");

/* ---------- paths ---------- */

// The folder inside the vault, refusing anything that would leave it.
const folderRoot = (vaultPath, folder) => {
  const vault = path.resolve(vaultPath);
  const root = path.resolve(vault, folder);
  if (path.dirname(root) !== vault || folder.trim() === "" || /[\\/]/u.test(folder)) {
    throw new Error("文件夹名只能是库里的一层文件夹，例如 ChatLens。");
  }
  return root;
};

const insideRoot = (root, relPath) => {
  const target = path.resolve(root, relPath);
  if (!target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`拒绝写到 ChatLens 文件夹外面：${relPath}`);
  }
  return target;
};

const toPosix = (relPath) => relPath.split(path.sep).join("/");

/* ---------- the manifest ---------- */

// topics: id -> { name, aliases } as last written; topicPins: the user's
// decisions (src/vault_identity.js); topicsBuilt: the AI has placed the things
// into topics once, so the notes are organised by topic from then on.
const emptyManifest = (root) => ({
  version: MANIFEST_VERSION, root, topics: {}, topicPins: {}, topicsBuilt: false, deleted: [], written: {}, pending: {}, vaultUrls: null,
});

// One manifest per folder, so switching vaults and back keeps the user's
// decisions; the previous one is kept as .bak in case the newest is damaged.
const manifestPath = (storeDir, root) => path.join(storeDir, `notes-manifest-${sha1(root.toLowerCase()).slice(0, 12)}.json`);

const readManifestFile = (file, root) => {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed?.version === MANIFEST_VERSION && parsed.root === root ? { ...emptyManifest(root), ...parsed } : null;
  } catch {
    return null;
  }
};

const loadManifest = (storeDir, root) => {
  const file = manifestPath(storeDir, root);
  return readManifestFile(file, root) ?? readManifestFile(`${file}.bak`, root) ?? emptyManifest(root);
};

const saveManifest = (storeDir, manifest) => {
  const file = manifestPath(storeDir, manifest.root);
  const temp = `${file}.tmp-${process.pid}`;
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(temp, `${JSON.stringify(manifest)}\n`, "utf8");
  if (fs.existsSync(file)) {
    fs.copyFileSync(file, `${file}.bak`);
  }
  fs.renameSync(temp, file);
};

/* ---------- what is in the folder ---------- */

// A folder of a sane vault; picking a whole drive must not walk all of it.
const MAX_DIRS = 5000;

const listFiles = (dir, extensions, limit = Infinity) => {
  const found = [];
  let dirs = 0;
  const walk = (current) => {
    dirs += 1;
    if (dirs > MAX_DIRS) {
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= limit || dirs > MAX_DIRS) {
        return;
      }
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
          walk(full);
        }
      } else if (entry.isFile() && extensions.some((extension) => entry.name.toLowerCase().endsWith(extension))) {
        found.push(full);
      }
    }
  };
  walk(dir);
  return found;
};

const readNote = (root, relPath) => {
  const text = fs.readFileSync(insideRoot(root, relPath), "utf8");
  const { blocks } = splitNote(text);
  return { relPath, text, blocks, id: readScalar(blocks, "chatlens") };
};

// id -> { relPath, text, blocks } for every note in the folder that carries a
// chatlens id. A copy the user made (same id) is left alone: the note at the
// path last written wins, else the shortest name ("Foo.md" over "Foo 1.md").
const scanNotes = (root, lastWritten = {}) => {
  const notes = new Map();
  const files = listFiles(root, [".md"]).map((file) => toPosix(path.relative(root, file)))
    .sort((left, right) => left.length - right.length || left.localeCompare(right));
  for (const relPath of files) {
    const note = readNote(root, relPath);
    if (!note.id) {
      continue;
    }
    const seen = notes.get(note.id);
    if (seen === undefined || (lastWritten[note.id] === relPath && seen.relPath !== relPath)) {
      notes.set(note.id, note);
    }
  }
  return notes;
};

/* ---------- writing ---------- */

// Writes only when the text differs; the temp file + rename means Obsidian
// never sees half a note. Returns "written" or "same".
const writeIfChanged = (root, relPath, text) => {
  const target = insideRoot(root, relPath);
  let current = null;
  try {
    current = fs.readFileSync(target, "utf8");
  } catch {
    current = null;
  }
  if (current === text) {
    return "same";
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.chatlens-tmp`;
  fs.writeFileSync(temp, text, "utf8");
  fs.renameSync(temp, target);
  return "written";
};

// A free file path for a new note: "name.md", else "name (2).md" ...; taken
// holds lower-cased paths (Windows and macOS ignore case). A file already on
// disk (a note of the user's own) is never a free path.
const freePath = (root, dir, stem, taken) => {
  for (let index = 1; ; index += 1) {
    const candidate = `${dir}/${index === 1 ? stem : `${stem} (${index})`}.md`;
    if (!taken.has(candidate.toLowerCase()) && !fs.existsSync(insideRoot(root, candidate))) {
      taken.add(candidate.toLowerCase());
      return candidate;
    }
  }
};

// Moves a note ChatLens no longer writes into the vault's .trash folder (the
// one Obsidian's "move to Obsidian trash" uses), keeping its path; returns
// where it went. The user can move it back from there.
const moveToTrash = (vaultPath, root, relPath) => {
  const source = insideRoot(root, relPath);
  const trash = path.join(path.resolve(vaultPath), ".trash", path.basename(root));
  const parsed = path.parse(path.resolve(trash, relPath));
  if (!parsed.dir.startsWith(trash)) {
    throw new Error(`拒绝移到回收站外面：${relPath}`);
  }
  fs.mkdirSync(parsed.dir, { recursive: true });
  let target = path.join(parsed.dir, parsed.base);
  for (let index = 2; fs.existsSync(target); index += 1) {
    target = path.join(parsed.dir, `${parsed.name} (${index})${parsed.ext}`);
  }
  fs.renameSync(source, target);
  return target;
};

// Removes the folders under root that moving notes away left empty.
const removeEmptyDirs = (root, relDirs) => {
  for (const relDir of [...new Set(relDirs)].sort((left, right) => right.length - left.length)) {
    try {
      const dir = insideRoot(root, relDir);
      if (fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir);
      }
    } catch {
      // Not there or not empty: nothing to tidy.
    }
  }
};

/* ---------- one sync at a time ---------- */

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

const readLock = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    // Missing: free. Unreadable (an empty file left by a crash): stale.
    return error.code === "ENOENT" ? null : { pid: -1, at: 0 };
  }
};

// Whether another live process holds a `name` lock younger than staleMs.
const isLockHeld = (storeDir, name, { staleMs = LOCK_STALE_MS } = {}) => {
  const held = readLock(path.join(storeDir, `${name}.lock`));
  return held !== null && held.pid !== process.pid && isAlive(held.pid) && Date.now() - held.at < staleMs;
};

// Returns a release function, or null when another process holds the lock
// (notes-sync: writing the vault; notes-ai: the AI passes, whose first run
// takes longer than a sync -- staleMs must outlast it).
const takeLock = (storeDir, name = "notes-sync", { staleMs = LOCK_STALE_MS } = {}) => {
  const file = path.join(storeDir, `${name}.lock`);
  fs.mkdirSync(storeDir, { recursive: true });
  if (isLockHeld(storeDir, name, { staleMs })) {
    return null;
  }
  fs.rmSync(file, { force: true });
  try {
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: "wx" });
  } catch {
    return null;
  }
  // Only our own lock is removed, never one another process took over.
  return () => {
    if (readLock(file)?.pid === process.pid) {
      fs.rmSync(file, { force: true });
    }
  };
};

/* ---------- the user's own notes that point at a thing ---------- */

// link key -> vault-relative note path (no .md) for notes outside the ChatLens
// folder whose frontmatter names a URL (e.g. notes a GitHub-stars sync wrote).
const scanVaultUrls = (vaultPath, root) => {
  const found = new Map();
  for (const file of listFiles(vaultPath, [".md"], MAX_VAULT_FILES)) {
    if (file.startsWith(`${root}${path.sep}`)) {
      continue;
    }
    let head;
    try {
      const handle = fs.openSync(file, "r");
      try {
        const buffer = Buffer.alloc(HEAD_BYTES);
        head = buffer.subarray(0, fs.readSync(handle, buffer, 0, HEAD_BYTES, 0)).toString("utf8");
      } finally {
        fs.closeSync(handle);
      }
    } catch {
      continue;
    }
    const { blocks, hasFrontmatter } = splitNote(head);
    if (!hasFrontmatter) {
      continue;
    }
    for (const key of URL_KEYS) {
      const value = linkKey(readScalar(blocks, key) ?? "");
      if (value !== "" && !found.has(value)) {
        found.set(value, toPosix(path.relative(vaultPath, file)).replace(/\.md$/iu, ""));
      }
    }
  }
  return found;
};

// Rescanned at most hourly; the map is kept in the manifest.
const vaultUrls = (vaultPath, root, manifest, nowUnix) => {
  const cached = manifest.vaultUrls;
  if (cached !== null && nowUnix - cached.at < VAULT_SCAN_SECONDS) {
    return { map: new Map(cached.entries), manifest };
  }
  const map = scanVaultUrls(vaultPath, root);
  return { map, manifest: { ...manifest, vaultUrls: { at: nowUnix, entries: [...map] } } };
};

module.exports = {
  sha1,
  folderRoot,
  insideRoot,
  emptyManifest,
  manifestPath,
  loadManifest,
  saveManifest,
  readNote,
  scanNotes,
  writeIfChanged,
  freePath,
  moveToTrash,
  removeEmptyDirs,
  isLockHeld,
  takeLock,
  scanVaultUrls,
  vaultUrls,
  listFiles,
};
