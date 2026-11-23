"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { listTrays, addTray, updateTray, removeTray, FIRST_ID, DEFAULT_FOLDER } = require("../src/picture_trays");

const REPORTS = path.join("X:", "tool", "reports");
const view = (pictures) => listTrays(pictures, REPORTS).map((tray) => [tray.id, tray.name, tray.path]);

test("there is always a first tray: a default folder until one is chosen", () => {
  assert.deepEqual(view(undefined), [[FIRST_ID, "存图", path.join(REPORTS, DEFAULT_FOLDER)]]);
  assert.deepEqual(view({ saveDir: "" }), [[FIRST_ID, "存图", path.join(REPORTS, DEFAULT_FOLDER)]]);
});

test("the first tray is the folder 另存到文件夹 already used, named after it", () => {
  assert.deepEqual(view({ saveDir: "D:\\图片\\QQ好图" }), [[FIRST_ID, "QQ好图", "D:\\图片\\QQ好图"]]);
  assert.deepEqual(view({ saveDir: "D:\\图片\\QQ好图\\" }), [[FIRST_ID, "QQ好图", "D:\\图片\\QQ好图\\"]]);
});

test("added trays keep their order, get the next free id, and may be named", () => {
  const one = addTray({ saveDir: "D:\\a" }, REPORTS, { name: "", dir: "D:\\角色" });
  assert.equal(one.id, "t2");
  const two = addTray(one.pictures, REPORTS, { name: "  壁纸  候选 ", dir: "E:\\wall" });
  assert.equal(two.id, "t3");
  assert.deepEqual(view(two.pictures), [[FIRST_ID, "a", "D:\\a"], ["t2", "角色", "D:\\角色"], ["t3", "壁纸 候选", "E:\\wall"]]);
  // The first tray's folder stays in saveDir, never duplicated in the list.
  assert.equal(two.pictures.saveDir, "D:\\a");
  assert.equal(two.pictures.trays[0].dir, "");
});

test("two trays never share a folder", () => {
  const { pictures } = addTray({ saveDir: "D:\\a" }, REPORTS, { name: "", dir: "D:\\b" });
  assert.throws(() => addTray(pictures, REPORTS, { name: "x", dir: "d:\\B" }), /已经有一个托盘/u);
  assert.throws(() => addTray(pictures, REPORTS, { name: "x", dir: "D:\\a" }), /已经有一个托盘/u);
  assert.throws(() => updateTray(pictures, REPORTS, { id: "t2", dir: "D:\\a" }), /已经有一个托盘/u);
});

test("changing the first tray's folder changes saveDir; an empty folder goes back to the default", () => {
  const changed = updateTray({ saveDir: "D:\\a" }, REPORTS, { id: FIRST_ID, name: "", dir: "D:\\新" });
  assert.equal(changed.pictures.saveDir, "D:\\新");
  assert.deepEqual(view(changed.pictures), [[FIRST_ID, "新", "D:\\新"]]);
  const back = updateTray(changed.pictures, REPORTS, { id: FIRST_ID, dir: "" });
  assert.equal(back.pictures.saveDir, "");
  assert.deepEqual(view(back.pictures), [[FIRST_ID, "存图", path.join(REPORTS, DEFAULT_FOLDER)]]);
});

test("a typed name stays when the folder changes; a cleared name follows the folder again", () => {
  const named = updateTray({ saveDir: "D:\\a" }, REPORTS, { id: FIRST_ID, name: "收藏" });
  const moved = updateTray(named.pictures, REPORTS, { id: FIRST_ID, dir: "D:\\b" });
  assert.deepEqual(view(moved.pictures), [[FIRST_ID, "收藏", "D:\\b"]]);
  const cleared = updateTray(moved.pictures, REPORTS, { id: FIRST_ID, name: "" });
  assert.deepEqual(view(cleared.pictures), [[FIRST_ID, "b", "D:\\b"]]);
});

test("removing a tray leaves the others; the first one cannot be removed", () => {
  const one = addTray({ saveDir: "" }, REPORTS, { name: "", dir: "D:\\b" });
  const two = addTray(one.pictures, REPORTS, { name: "", dir: "D:\\c" });
  const removed = removeTray(two.pictures, REPORTS, { id: "t2" });
  assert.deepEqual(view(removed.pictures).map(([id]) => id), [FIRST_ID, "t3"]);
  assert.throws(() => removeTray(removed.pictures, REPORTS, { id: FIRST_ID }), /一直都在/u);
  assert.throws(() => removeTray(removed.pictures, REPORTS, { id: "t9" }), /没有这个托盘/u);
  // A freed id is never given out again: a page still showing the removed
  // tray must not save into the new one.
  assert.equal(addTray(removed.pictures, REPORTS, { name: "", dir: "D:\\d" }).id, "t4");
  const last = removeTray(removed.pictures, REPORTS, { id: "t3" });
  assert.equal(addTray(last.pictures, REPORTS, { name: "", dir: "D:\\e" }).id, "t4");
});

test("two trays an older setting put on one folder can still be renamed", () => {
  const pictures = { saveDir: "D:\\foo", trays: [{ id: "t1", name: "", dir: "" }, { id: "t2", name: "", dir: "D:\\foo" }] };
  assert.deepEqual(view(updateTray(pictures, REPORTS, { id: "t2", name: "备用" }).pictures).map(([, name]) => name), ["foo", "备用"]);
  assert.deepEqual(view(updateTray(pictures, REPORTS, { id: "t1", name: "主" }).pictures).map(([, name]) => name), ["主", "foo"]);
});

test("other tray rows without a folder, or with a made-up id, are ignored", () => {
  const pictures = { saveDir: "", trays: [{ id: "t2", name: "x", dir: "" }, { id: "../etc", name: "y", dir: "D:\\y" }, { id: "t3", name: "", dir: "D:\\z" }] };
  assert.deepEqual(view(pictures).map(([id]) => id), [FIRST_ID, "t3"]);
});
