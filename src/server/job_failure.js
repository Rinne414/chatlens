"use strict";

// Turns a failed child process's log into the message the page shows. The exit
// code alone ("进程退出码 1") tells the user nothing; the cause is in the log.

const MAX_MESSAGE_CHARS = 300;

// Causes with a known fix, checked against every log line.
const KNOWN_CAUSES = [
  {
    // SQLCipher checks page 1 first, so a wrong key fails exactly like this.
    pattern: /SQLITE_NOTADB|file is not a database/u,
    message: "打不开 QQ 数据库：保存的 QQ 数据库密钥解不开它。请保持 QQ 登录，到「设置 → 数据库密钥」点「自动获取密钥」重新获取；手动粘贴时注意别填成 AI 服务的 API key。",
  },
];

// Progress markers (progress=..., backupReport=...), stack frames and Node's
// crash banner are plumbing, never the reason.
const isNoise = (line) =>
  line === ""
  || /^[A-Za-z][\w-]*=/u.test(line)
  || /^at\s/u.test(line)
  || /^Node\.js v\d/u.test(line)
  || /^[{}[\]]$/u.test(line)
  || /^code: /u.test(line)
  || /\.[cm]?js:\d+$/u.test(line);

const ERROR_LINE = /^\w*Error(?: \[\w+\])?: /u;

const describeJobFailure = (logLines, code) => {
  const lines = (logLines ?? []).map((line) => String(line).trim());
  const known = KNOWN_CAUSES.find((cause) => lines.some((line) => cause.pattern.test(line)));
  if (known !== undefined) {
    return known.message;
  }
  const lastIndex = lines.findLastIndex((line) => !isNoise(line));
  if (lastIndex === -1) {
    return `进程退出码 ${code}`;
  }
  const last = lines[lastIndex];
  const cause = ERROR_LINE.test(last) ? undefined : lines.slice(0, lastIndex).findLast((line) => ERROR_LINE.test(line));
  const message = cause === undefined || last.includes(cause) ? last : `${last}：${cause}`;
  return message.slice(0, MAX_MESSAGE_CHARS);
};

module.exports = { describeJobFailure };
