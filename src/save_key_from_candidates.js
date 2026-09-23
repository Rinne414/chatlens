"use strict";

// Verifies memory-scan key candidates against the user's own database and
// saves the one that decrypts it (src/secrets.js: DPAPI on Windows, keyring or
// 0600 file on Linux). The key itself is never printed.
//
//   node src/save_key_from_candidates.js <databaseSample> <candidateFile>
//
// <databaseSample> only needs the first page(s) of nt_msg.db with QQ's
// 1024-byte prefix stripped (see writeDatabaseSample): SQLCipher checks the
// page-1 HMAC before anything else, so a wrong key fails with SQLITE_NOTADB
// while the right one reads page 1. That avoids copying a ~10 GB database.
//
// Tens of thousands of candidates each cost one PBKDF2 derivation, so they
// are verified in parallel worker threads.

const fs = require("node:fs");
const os = require("node:os");
const { Worker, isMainThread, parentPort, workerData } = require("node:worker_threads");
const Database = require("better-sqlite3-multiple-ciphers");

const SAMPLE_BYTES = 4 * 1024 * 1024;
const MAX_WORKERS = 8;

// The legacy=4 variant is what current QQNT uses (verified on real data), so
// it is tried first; each extra config doubles the PBKDF2 cost per candidate.
const DATABASE_CONFIGS = [
  {
    name: "ntqq-legacy4-overrides",
    pragmas: ["cipher='sqlcipher'", "legacy=4", "legacy_page_size=4096", "kdf_iter=4000", "hmac_algorithm=0", "kdf_algorithm=2"],
  },
  {
    name: "ntqq-hmac-sha1-kdf-sha512",
    pragmas: ["cipher='sqlcipher'", "legacy_page_size=4096", "kdf_iter=4000", "hmac_algorithm=0", "kdf_algorithm=2"],
  },
];

const sqlQuote = (value) => `'${value.replaceAll("'", "''")}'`;

// Copies the start of the database (after QQ's prefix) to samplePath.
const writeDatabaseSample = (sourcePath, samplePath, prefixBytes) => {
  const source = fs.openSync(sourcePath, "r");
  try {
    const buffer = Buffer.alloc(SAMPLE_BYTES);
    const read = fs.readSync(source, buffer, 0, SAMPLE_BYTES, prefixBytes);
    fs.writeFileSync(samplePath, buffer.subarray(0, read));
  } finally {
    fs.closeSync(source);
  }
};

const decrypts = (databasePath, key, config) => {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    for (const pragma of config.pragmas) {
      db.pragma(pragma);
    }
    db.pragma(`key=${sqlQuote(key)}`);
    // Reading the schema cookie forces page 1 through the codec's HMAC check.
    db.pragma("schema_version");
    return true;
  } catch (error) {
    // A truncated sample can make a CORRECT key hit a short read beyond page
    // 1; only "not a database" means the key is wrong.
    return error.code !== "SQLITE_NOTADB" && error.code !== "SQLITE_CANTOPEN";
  } finally {
    db.close();
  }
};

// stopFlag (Int32Array over a SharedArrayBuffer) lets the first worker that
// finds the key stop the others between candidates. Terminating a worker
// while it is inside better-sqlite3's native code aborts the whole process.
const findKeyInSlice = (databasePath, candidates, stopFlag = null) => {
  for (let index = 0; index < candidates.length; index += 1) {
    if (stopFlag !== null && Atomics.load(stopFlag, 0) === 1) {
      return { key: null, configName: null, tested: index };
    }
    for (const config of DATABASE_CONFIGS) {
      if (decrypts(databasePath, candidates[index], config)) {
        return { key: candidates[index], configName: config.name, tested: index + 1 };
      }
    }
  }
  return { key: null, configName: null, tested: candidates.length };
};

const parseCandidates = (candidatePath) => [
  ...new Set(
    fs.readFileSync(candidatePath, "utf8")
      .split(/\r?\n/u)
      .map((value) => value.trim())
      .filter((value) => value.length === 16 || value.length === 32),
  ),
];

const findKeyParallel = (databasePath, candidates) => {
  const workerCount = Math.max(1, Math.min(MAX_WORKERS, (os.availableParallelism?.() ?? os.cpus().length) - 1, Math.ceil(candidates.length / 500)));
  if (workerCount === 1) {
    return Promise.resolve(findKeyInSlice(databasePath, candidates));
  }
  const sliceSize = Math.ceil(candidates.length / workerCount);
  const stopFlag = new Int32Array(new SharedArrayBuffer(4));
  return new Promise((resolve, reject) => {
    let finished = 0;
    let tested = 0;
    let found = null;
    let failure = null;
    // Resolve only after every worker has returned on its own, so no worker
    // is still inside native code (or holding the sample open) afterwards.
    const onDone = () => {
      finished += 1;
      if (finished < workerCount) {
        return;
      }
      if (failure !== null && found === null) {
        reject(failure);
      } else {
        resolve(found === null ? { key: null, configName: null, tested } : { ...found, tested });
      }
    };
    for (let index = 0; index < workerCount; index += 1) {
      const worker = new Worker(__filename, {
        workerData: { databasePath, candidates: candidates.slice(index * sliceSize, (index + 1) * sliceSize), stopFlag },
      });
      worker.once("message", (result) => {
        tested += result.tested;
        if (result.key !== null && found === null) {
          found = result;
          Atomics.store(stopFlag, 0, 1);
        }
      });
      worker.once("error", (error) => {
        failure = error;
        Atomics.store(stopFlag, 0, 1);
      });
      worker.once("exit", onDone);
    }
  });
};

const main = async () => {
  const [databasePath, candidatePath] = process.argv.slice(2);
  if (!databasePath || !candidatePath) {
    throw new Error("Usage: node save_key_from_candidates.js <databaseSample> <candidateFile>");
  }
  const candidates = parseCandidates(candidatePath);
  const found = await findKeyParallel(databasePath, candidates);
  if (found.key !== null) {
    // Loaded lazily so worker threads never touch the secret store.
    const { saveSecret } = require("./secrets");
    await saveSecret("ntqqKey", found.key);
  }
  process.stdout.write(JSON.stringify({
    saved: found.key !== null,
    candidateCount: candidates.length,
    tested: found.tested,
    configName: found.configName,
  }));
  if (found.key === null) {
    process.exitCode = 2;
  }
};

if (!isMainThread) {
  parentPort.postMessage(findKeyInSlice(workerData.databasePath, workerData.candidates, workerData.stopFlag));
} else if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { writeDatabaseSample, findKeyParallel, decrypts, DATABASE_CONFIGS };
