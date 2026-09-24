const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const { spawn } = require("node:child_process");
const state = require("./toolkit_state");
const jobs = require("./run_jobs");
const background = require("./background");
const platform = require("../platform");
const packageInfo = require("../../package.json");
const signature = require("../update_signature");

const GITHUB_REPO = "Rinne414/chatlens";
const USER_AGENT = `ChatLens/${packageInfo.version} (update-check)`;
const REQUEST_TIMEOUT_MS = 30000;
const MAX_REDIRECTS = 5;
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
const MAX_TEXT_ASSET_BYTES = 64 * 1024;
// The key every update must be signed with (scripts/make_update_key.js). An
// install without this file (older source checkouts) updates unverified.
const PUBLIC_KEY_FILE = "update-signing-public.pem";

const httpRequest = (url, { asStream = false, redirectsLeft = MAX_REDIRECTS } = {}) =>
  new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          "user-agent": USER_AGENT,
          accept: asStream ? "application/octet-stream" : "application/vnd.github+json",
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && typeof response.headers.location === "string") {
          response.resume();
          if (redirectsLeft <= 0) {
            reject(new Error("重定向次数过多。"));
            return;
          }
          resolve(httpRequest(new URL(response.headers.location, url).toString(), { asStream, redirectsLeft: redirectsLeft - 1 }));
          return;
        }
        if (status < 200 || status >= 300) {
          response.resume();
          reject(new Error(`GitHub 请求失败（HTTP ${status}）。`));
          return;
        }
        if (asStream) {
          resolve(response);
          return;
        }
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        response.on("error", reject);
      },
    );
    request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error("GitHub 请求超时。")));
    request.on("error", (error) => reject(new Error(`无法连接 GitHub：${error.message}`)));
  });

const parseVersion = (value) =>
  String(value ?? "")
    .replace(/^v/iu, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);

const isNewerVersion = (candidate, current) => {
  const left = parseVersion(candidate);
  const right = parseVersion(current);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) {
      return a > b;
    }
  }
  return false;
};

const checkUpdate = async () => {
  const body = await httpRequest(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
  let release;
  try {
    release = JSON.parse(body);
  } catch {
    throw new Error("GitHub 返回的内容无法解析。");
  }
  if (typeof release?.tag_name !== "string") {
    throw new Error("没有找到任何正式发布版本。");
  }
  const latestVersion = release.tag_name.replace(/^v/iu, "");
  return {
    currentVersion: packageInfo.version,
    latestVersion,
    hasUpdate: isNewerVersion(latestVersion, packageInfo.version),
    releaseName: release.name ?? release.tag_name,
    publishedAt: release.published_at ?? null,
    notes: String(release.body ?? "").slice(0, 4000),
    htmlUrl: release.html_url ?? `https://github.com/${GITHUB_REPO}/releases`,
    assets: (release.assets ?? []).map((asset) => ({
      name: String(asset.name ?? ""),
      size: asset.size ?? 0,
      downloadUrl: asset.browser_download_url ?? null,
    })),
  };
};

// Zero-setup bundles ship their own node (node\node.exe / node/bin/node);
// source installs don't. Each flavor must update with its own archive (a
// bundle carries a matched node + prebuilt better_sqlite3.node pair).
const isBundleInstall = () =>
  fs.existsSync(path.join(state.toolRoot, "node", "node.exe")) || fs.existsSync(path.join(state.toolRoot, "node", "bin", "node"));

const PLATFORM_ASSET = /-(?:win|linux)-x64\./iu;

// Pure: which release asset fits this install (exported for tests).
const pickAssetFor = (assets, { windows, bundle }) => {
  const usable = assets.filter((asset) => typeof asset.downloadUrl === "string");
  if (windows) {
    const zips = usable.filter((asset) => /\.zip$/iu.test(asset.name));
    return bundle
      ? zips.find((asset) => /-win-x64\.zip$/iu.test(asset.name)) ?? null
      : zips.find((asset) => !PLATFORM_ASSET.test(asset.name)) ?? null;
  }
  const tarballs = usable.filter((asset) => /\.tar\.gz$/iu.test(asset.name));
  return bundle
    ? tarballs.find((asset) => /-linux-x64\.tar\.gz$/iu.test(asset.name)) ?? null
    : tarballs.find((asset) => !PLATFORM_ASSET.test(asset.name)) ?? null;
};

const pickAsset = (assets) => pickAssetFor(assets, { windows: platform.isWindows, bundle: isBundleInstall() });

const readPublicKey = () => {
  try {
    // The override exists for automated tests only.
    return fs.readFileSync(process.env.CHATLENS_SIGNING_PUBLIC || path.join(state.toolRoot, PUBLIC_KEY_FILE), "utf8");
  } catch {
    return null;
  }
};

const downloadText = async (url) => {
  const response = await httpRequest(url, { asStream: true });
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response) {
    bytes += chunk.length;
    if (bytes > MAX_TEXT_ASSET_BYTES) {
      response.destroy();
      throw new Error("签名清单大小异常。");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
};

const unsignedError = (htmlUrl, reason) =>
  new Error(`${reason} 为安全起见没有自动安装。如果确认是作者发布的版本，请到发布页手动下载：${htmlUrl}`);

// Fetches the signed checksum list, or refuses the update.
const fetchSignedSums = async (info) => {
  const found = signature.findSignatureAssets(info.assets);
  if (found === null) {
    throw unsignedError(info.htmlUrl, "这个新版本没有附带签名。");
  }
  return { sumsText: await downloadText(found.sums.downloadUrl), signature: await downloadText(found.sig.downloadUrl) };
};

const downloadToFile = async (url, destination) => {
  const response = await httpRequest(url, { asStream: true });
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destination);
    let bytes = 0;
    response.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_DOWNLOAD_BYTES) {
        response.destroy(new Error("下载的安装包超过大小上限。"));
      }
    });
    response.on("error", (error) => {
      file.destroy();
      fs.rmSync(destination, { force: true });
      reject(error);
    });
    file.on("error", reject);
    file.on("finish", resolve);
    response.pipe(file);
  });
};

// Windows PowerShell 5.1 updater: waits for this server to exit, unpacks the
// release zip over the install dir (release zips contain no user data — runs/
// reports/store/config\defaults.json are never inside), then relaunches.
const updaterScriptText = () =>
  [
    "[CmdletBinding()]",
    "param(",
    "    [Parameter(Mandatory = $true)][string]$ZipPath,",
    "    [Parameter(Mandatory = $true)][string]$InstallDir,",
    "    [Parameter(Mandatory = $true)][int]$ServerPid",
    ")",
    "$ErrorActionPreference = 'Stop'",
    "$logPath = Join-Path (Split-Path -Parent $ZipPath) 'update.log'",
    "function Write-Log([string]$Message) {",
    "    (\"[{0}] {1}\" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message) | Out-File -FilePath $logPath -Append -Encoding utf8",
    "}",
    "try {",
    "    Write-Log \"等待控制台进程退出 (PID=$ServerPid)\"",
    "    for ($i = 0; $i -lt 60; $i += 1) {",
    "        if ($null -eq (Get-Process -Id $ServerPid -ErrorAction SilentlyContinue)) { break }",
    "        Start-Sleep -Seconds 1",
    "    }",
    "    Start-Sleep -Seconds 1",
    "",
    "    $extractDir = Join-Path (Split-Path -Parent $ZipPath) 'extracted'",
    "    if (Test-Path -LiteralPath $extractDir) { Remove-Item -LiteralPath $extractDir -Recurse -Force }",
    "    Write-Log \"解压 $ZipPath\"",
    "    Expand-Archive -LiteralPath $ZipPath -DestinationPath $extractDir -Force",
    "",
    "    $sourceDir = $extractDir",
    "    $children = @(Get-ChildItem -LiteralPath $extractDir)",
    "    if ($children.Count -eq 1 -and $children[0].PSIsContainer) { $sourceDir = $children[0].FullName }",
    "",
    "    Write-Log \"覆盖安装到 $InstallDir\"",
    "    Copy-Item -Path (Join-Path $sourceDir '*') -Destination $InstallDir -Recurse -Force",
    "",
    "    Remove-Item -LiteralPath $extractDir -Recurse -Force",
    "    Remove-Item -LiteralPath $ZipPath -Force",
    "    Write-Log '更新完成，重新启动控制台。'",
    "",
    "    $launcher = Join-Path $InstallDir 'Start-QQ-Console.cmd'",
    "    if (Test-Path -LiteralPath $launcher) {",
    "        Start-Process -FilePath $launcher -WorkingDirectory $InstallDir -WindowStyle Minimized",
    "    }",
    "} catch {",
    "    Write-Log ('更新失败: ' + $_.Exception.Message)",
    "}",
    "",
  ].join("\r\n");

// POSIX updater: same flow with tar; all values arrive as positional args.
const LINUX_UPDATER_SCRIPT = [
  "#!/bin/sh",
  "ARCHIVE=\"$1\"; INSTALL_DIR=\"$2\"; SERVER_PID=\"$3\"",
  "WORK_DIR=$(dirname \"$ARCHIVE\")",
  "LOG=\"$WORK_DIR/update.log\"",
  "log() { echo \"[$(date '+%Y-%m-%d %H:%M:%S')] $1\" >> \"$LOG\"; }",
  "log \"waiting for server pid $SERVER_PID\"",
  "i=0; while kill -0 \"$SERVER_PID\" 2>/dev/null && [ $i -lt 60 ]; do sleep 1; i=$((i+1)); done",
  "rm -rf \"$WORK_DIR/extracted\" && mkdir -p \"$WORK_DIR/extracted\"",
  "if ! tar -xzf \"$ARCHIVE\" -C \"$WORK_DIR/extracted\"; then log 'extract failed'; exit 1; fi",
  "SRC=\"$WORK_DIR/extracted\"",
  "if [ \"$(ls -1 \"$SRC\" | wc -l)\" -eq 1 ] && [ -d \"$SRC/$(ls -1 \"$SRC\")\" ]; then SRC=\"$SRC/$(ls -1 \"$SRC\")\"; fi",
  "if ! cp -a \"$SRC/.\" \"$INSTALL_DIR/\"; then log 'copy failed'; exit 1; fi",
  "rm -rf \"$WORK_DIR/extracted\" \"$ARCHIVE\"",
  "log 'update installed, restarting'",
  "cd \"$INSTALL_DIR\" && nohup sh ./start.sh >/dev/null 2>&1 &",
  "",
].join("\n");

// Windows: PowerShell started with Node's detached:true (DETACHED_PROCESS)
// never runs at all, and a plain child is torn down with the server. `cmd /c
// start` gives the updater its own console that outlives the server —
// verified in a launcher -> detached server -> updater chain, paths with
// spaces and CJK. cmd would expand %VAR% inside the paths, so those refuse.
// Pure (exported for tests): cmd.exe arguments that start the updater.
const windowsUpdaterArgs = ({ scriptPath, archivePath, installDir, serverPid }) => {
  const quoted = (value) => `"${value}"`;
  const command = [
    "powershell.exe", "-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass",
    "-File", quoted(scriptPath), "-ZipPath", quoted(archivePath), "-InstallDir", quoted(installDir), "-ServerPid", String(serverPid),
  ].join(" ");
  return ["/d", "/s", "/c", `"start "" /min ${command}"`];
};

const startWindowsUpdater = (scriptPath, archivePath) =>
  spawn("cmd.exe", windowsUpdaterArgs({ scriptPath, archivePath, installDir: state.toolRoot, serverPid: process.pid }), {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    windowsVerbatimArguments: true,
  });

const WINDOWS_UNSAFE_PATH = /[%"]/u;

const spawnUpdater = (updateDir, archivePath) => {
  if (platform.isWindows) {
    // BOM so Windows PowerShell 5.1 reads the Chinese log strings correctly.
    const scriptPath = path.join(updateDir, "apply_update.ps1");
    fs.writeFileSync(scriptPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(updaterScriptText(), "utf8")]));
    return startWindowsUpdater(scriptPath, archivePath);
  }
  const scriptPath = path.join(updateDir, "apply_update.sh");
  fs.writeFileSync(scriptPath, LINUX_UPDATER_SCRIPT, { mode: 0o755 });
  return spawn("sh", [scriptPath, archivePath, state.toolRoot, String(process.pid)], { detached: true, stdio: "ignore" });
};

// A running pipeline child keeps the native sqlite addon (and store files)
// open; on Windows the updater's copy would then fail halfway through.
const assertIdle = () => {
  if (jobs.jobSnapshot(0).job?.status === "running") {
    throw new Error("有任务正在运行，请等它完成后再更新。");
  }
  if (background.getStatus().running) {
    throw new Error("后台正在整理新消息，请等一两分钟它完成后再更新。");
  }
};

const applyUpdate = async () => {
  assertIdle();
  if (platform.isWindows && WINDOWS_UNSAFE_PATH.test(state.toolRoot)) {
    throw new Error("安装路径里含有 % 或引号，无法自动更新。请到 GitHub 发布页手动下载新版。");
  }

  const info = await checkUpdate();
  if (!info.hasUpdate) {
    throw new Error(`当前已是最新版本（v${info.currentVersion}）。`);
  }
  const asset = pickAsset(info.assets);
  if (asset === null) {
    throw new Error("最新版本没有适用于本安装方式的安装包，请到 GitHub 发布页手动下载。");
  }

  const publicKeyPem = readPublicKey();
  const signed = publicKeyPem === null ? null : await fetchSignedSums(info);

  const updateDir = path.join(state.toolRoot, "dist", "update");
  fs.mkdirSync(updateDir, { recursive: true });
  const archivePath = path.join(updateDir, path.basename(asset.name));
  await downloadToFile(asset.downloadUrl, archivePath);
  if (signed !== null) {
    try {
      signature.verifyArchive({ archivePath, archiveName: asset.name, ...signed, publicKeyPem, version: info.latestVersion });
    } catch (error) {
      fs.rmSync(archivePath, { force: true });
      throw unsignedError(info.htmlUrl, error.message);
    }
  }
  // The download took a while: re-check, and stop the scheduler so no new
  // refresh starts between now and exit.
  assertIdle();
  background.stop();
  const updater = spawnUpdater(updateDir, archivePath);
  updater.on("error", (error) => console.error(`updater failed to start: ${error.message}`));
  updater.unref();

  // Let the HTTP response flush, then exit so the updater can swap files.
  setTimeout(() => process.exit(0), 800);
  return { updating: true, targetVersion: info.latestVersion };
};

module.exports = { checkUpdate, applyUpdate, pickAssetFor, isNewerVersion, windowsUpdaterArgs };
