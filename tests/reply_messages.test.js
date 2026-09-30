"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { getMessageText, isChatMessageType } = require("../src/export_group_recent");
const { parseMessageMeta } = require("../src/message_meta");

const varint = (value) => {
  const bytes = [];
  let rest = value;
  while (rest >= 128) {
    bytes.push((rest % 128) | 0x80);
    rest = Math.floor(rest / 128);
  }
  bytes.push(rest);
  return Buffer.from(bytes);
};
const tag = (fieldNumber, wireType) => varint(fieldNumber * 8 + wireType);
const vField = (fieldNumber, value) => Buffer.concat([tag(fieldNumber, 0), varint(value)]);
const bField = (fieldNumber, payload) => Buffer.concat([tag(fieldNumber, 2), varint(payload.length), payload]);
const element = (...fields) => bField(40800, Buffer.concat(fields));

// Shape seen on real QQNT 9.9 replies (msg_type1 = 9): a reply element that
// embeds the quoted message's text elements under 47423, then the replier's
// own text elements.
const replyBody = () => Buffer.concat([
  element(
    vField(45002, 7),
    vField(47402, 144299),
    vField(47403, 1234567890),
    vField(47404, 1790736131),
    bField(47413, Buffer.from("被回覆的人的昵称")),
    bField(47423, Buffer.concat([vField(45002, 1), bField(45101, Buffer.from("这是被引用的原文"))])),
  ),
  element(vField(45002, 1), bField(45101, Buffer.from("我同意你说的"))),
]);

test("a reply's text is only the replier's own words, not the quoted message", () => {
  assert.equal(getMessageText(replyBody().toString("hex")), "我同意你说的");
});

test("a reply of just a symbol keeps the symbol and never falls back to the quoted text", () => {
  const body = Buffer.concat([
    element(
      vField(45002, 7),
      vField(47403, 1234567890),
      bField(47423, Buffer.concat([vField(45002, 1), bField(45101, Buffer.from("这是被引用的原文"))])),
    ),
    element(vField(45002, 1), bField(45101, Buffer.from("?"))),
  ]);
  assert.equal(getMessageText(body.toString("hex")), "?");
});

test("a reply still records who it replies to", () => {
  assert.equal(parseMessageMeta(replyBody()).replyTo.uin, "1234567890");
});

test("replies (type 9) are chat messages like plain ones (type 2); system tips are not", () => {
  assert.equal(isChatMessageType(2n), true);
  assert.equal(isChatMessageType(9n), true);
  assert.equal(isChatMessageType(5n), false);
  assert.equal(isChatMessageType(null), false);
});
