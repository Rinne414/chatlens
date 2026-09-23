"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
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

test("reads @someone targets, @all, and the replied-to sender", () => {
  const body = Buffer.concat([
    element(vField(45001, 1), vField(45002, 7), vField(47402, 495627), vField(47403, 3000000001), vField(47404, 1758650000)),
    element(vField(45002, 1), bField(45101, Buffer.from("@小明")), vField(45102, 2), vField(45103, 12345678)),
    element(vField(45002, 1), bField(45101, Buffer.from("@小明")), vField(45102, 2), vField(45103, 12345678)),
    element(vField(45002, 1), bField(45101, Buffer.from("@全体成员")), vField(45102, 1)),
    element(vField(45002, 1), bField(45101, Buffer.from(" 看这个"))),
  ]);
  assert.deepEqual(parseMessageMeta(body), {
    atUins: ["12345678"],
    atAll: true,
    replyTo: { uin: "3000000001", seq: "495627", sentAt: 1758650000 },
  });
  assert.deepEqual(parseMessageMeta(body.toString("hex")), parseMessageMeta(body));
});

test("text that merely starts with @ is not a mention", () => {
  const body = element(vField(45002, 1), bField(45101, Buffer.from("@not a mention")), vField(45102, 0));
  assert.deepEqual(parseMessageMeta(body), { atUins: [], atAll: false, replyTo: null });
});

test("malformed or empty bodies yield no meta instead of throwing", () => {
  assert.deepEqual(parseMessageMeta(null), { atUins: [], atAll: false, replyTo: null });
  assert.deepEqual(parseMessageMeta(Buffer.from([0x82, 0x92, 0x13, 0x7f, 0x01])), { atUins: [], atAll: false, replyTo: null });
  assert.deepEqual(parseMessageMeta(""), { atUins: [], atAll: false, replyTo: null });
});
