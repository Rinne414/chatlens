"use strict";

// 存图托盘: named folders a picture is saved into with one action (a button,
// a key, or a drop). The list lives in config.pictures.trays; the first tray
// is always there and its folder is config.pictures.saveDir, the folder the
// multi-select 「另存到文件夹」 already used, so the two never disagree. With
// no folder chosen the first tray writes to <reportsDir>/saved-pictures.

const path = require("node:path");

const FIRST_ID = "t1";
const DEFAULT_FOLDER = "saved-pictures";
const DEFAULT_NAME = "存图";
const MAX_NAME_CHARS = 24;
const ID = /^t[0-9a-z]{1,12}$/u;

const cleanName = (name) => String(name ?? "").replace(/\s+/gu, " ").trim().slice(0, MAX_NAME_CHARS);

const folderLabel = (dir) => path.basename(String(dir).replace(/[\\/]+$/u, "")) || DEFAULT_NAME;

// Stored shape -> what the pages and the export use. `dir` is "" only for a
// first tray without a chosen folder; `path` is always where files go.
// `ownName` is the name the user typed ("" = named after its folder).
const listTrays = (pictures, reportsDir) => {
  const stored = Array.isArray(pictures?.trays) ? pictures.trays : [];
  const saveDir = String(pictures?.saveDir ?? "").trim();
  const first = stored.find((tray) => tray?.id === FIRST_ID) ?? {};
  const others = stored.filter((tray) => ID.test(String(tray?.id ?? "")) && tray.id !== FIRST_ID && String(tray.dir ?? "").trim() !== "");
  return [
    {
      id: FIRST_ID,
      ownName: cleanName(first.name),
      name: cleanName(first.name) || (saveDir === "" ? DEFAULT_NAME : folderLabel(saveDir)),
      dir: saveDir,
      path: saveDir === "" ? path.join(reportsDir, DEFAULT_FOLDER) : saveDir,
    },
    ...others.map((tray) => ({
      id: tray.id,
      ownName: cleanName(tray.name),
      name: cleanName(tray.name) || folderLabel(tray.dir),
      dir: String(tray.dir).trim(),
      path: String(tray.dir).trim(),
    })),
  ];
};

// Never an id a removed tray had: a page still showing the old tray would
// otherwise save into the new one's folder. traySeq is the highest number given out.
const nextNumber = (pictures, trays) => {
  const numbers = trays.map((tray) => Number.parseInt(tray.id.slice(1), 10)).filter(Number.isInteger);
  return Math.max(1, Number.parseInt(pictures?.traySeq, 10) || 1, ...numbers) + 1;
};

const samePath = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();

// Each change returns the new `pictures` config section; `dir` has already
// been validated by the caller (it is "" only when the first tray goes back
// to its default folder).
const stored = (trays) => trays.map((tray) => ({ id: tray.id, name: tray.ownName, dir: tray.id === FIRST_ID ? "" : tray.dir }));

const addTray = (pictures, reportsDir, { name, dir }) => {
  const trays = listTrays(pictures, reportsDir);
  if (trays.some((tray) => samePath(tray.path, dir))) {
    throw new Error("已经有一个托盘存到这个文件夹了。");
  }
  const number = nextNumber(pictures, trays);
  const tray = { id: `t${number}`, ownName: cleanName(name), dir };
  return { pictures: { ...pictures, traySeq: number, trays: stored([...trays, tray]) }, id: tray.id };
};

const updateTray = (pictures, reportsDir, { id, name, dir }) => {
  const trays = listTrays(pictures, reportsDir);
  const current = trays.find((tray) => tray.id === id);
  if (current === undefined) {
    throw new Error("没有这个托盘。");
  }
  const nextDir = dir === undefined ? current.dir : dir;
  if (id !== FIRST_ID && nextDir === "") {
    throw new Error("请填写这个托盘的文件夹。");
  }
  // Only a folder that changes is checked: two trays the old 「另存到」 setting
  // put on one folder can still be renamed.
  if (nextDir !== "" && nextDir !== current.dir && trays.some((tray) => tray.id !== id && samePath(tray.path, nextDir))) {
    throw new Error("已经有一个托盘存到这个文件夹了。");
  }
  // A name left empty follows the folder again.
  const ownName = name === undefined ? current.ownName : cleanName(name);
  const next = trays.map((tray) => (tray.id === id ? { ...tray, ownName, dir: nextDir } : tray));
  return {
    pictures: {
      ...pictures,
      ...(id === FIRST_ID ? { saveDir: nextDir } : {}),
      trays: stored(next),
    },
  };
};

// The folder and what is in it are left alone.
const removeTray = (pictures, reportsDir, { id }) => {
  if (id === FIRST_ID) {
    throw new Error("第一个托盘一直都在，可以改它的文件夹。");
  }
  const trays = listTrays(pictures, reportsDir);
  if (!trays.some((tray) => tray.id === id)) {
    throw new Error("没有这个托盘。");
  }
  return { pictures: { ...pictures, trays: stored(trays.filter((tray) => tray.id !== id)) } };
};

module.exports = { listTrays, addTray, updateTray, removeTray, FIRST_ID, DEFAULT_FOLDER };
