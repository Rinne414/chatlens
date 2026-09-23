"use strict";

// Structural facts about a QQNT message body that the text extractor throws
// away: who it @-mentions and which message it replies to. They power the
// "跟我有关" section (someone @'d me / replied to me) without any LLM.
//
// Layout (probed on real QQNT 9.9 data; numbers are protobuf field ids):
//   body (column 40800) = repeated field 40800, one per element
//   element.45002 = element type: 1 text, 2 picture, 7 reply, ...
//   text element:  45102 = at type (0 plain text, 1 @全体成员, 2 @someone)
//                  45103 = target uin (varint) when at type is 2
//   reply element: 47402 = replied message's msg_seq
//                  47403 = replied message's sender uin
//                  47404 = replied message's sent_at (unix seconds)

const ELEMENT_FIELD = 40800;
const ELEMENT_TYPE = 45002;
const TYPE_TEXT = 1;
const TYPE_REPLY = 7;
const AT_TYPE = 45102;
const AT_TARGET_UIN = 45103;
const AT_ALL = 1;
const AT_SOMEONE = 2;
const REPLY_SEQ = 47402;
const REPLY_UIN = 47403;
const REPLY_SENT_AT = 47404;

// Returns [value, nextIndex]; value is a Number (QQ uins, seqs and unix times
// are all far below 2^53) or null on malformed input.
const readVarint = (buf, index) => {
  let result = 0;
  let multiplier = 1;
  let pos = index;
  while (pos < buf.length) {
    const byte = buf[pos];
    pos += 1;
    result += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) {
      return [result, pos];
    }
    multiplier *= 128;
    if (multiplier > 2 ** 63) {
      return [null, pos];
    }
  }
  return [null, pos];
};

// Flat parse of one protobuf message: varints keep their value, length-
// delimited fields keep their slice. null on any malformed field.
const parseFields = (buf) => {
  const fields = [];
  let i = 0;
  while (i < buf.length) {
    const [tag, afterTag] = readVarint(buf, i);
    if (tag === null || tag < 8) {
      return null;
    }
    i = afterTag;
    const fieldNumber = Math.floor(tag / 8);
    const wireType = tag % 8;
    if (wireType === 0) {
      const [value, next] = readVarint(buf, i);
      if (value === null) {
        return null;
      }
      fields.push({ fieldNumber, value });
      i = next;
    } else if (wireType === 2) {
      const [length, next] = readVarint(buf, i);
      if (length === null || next + length > buf.length) {
        return null;
      }
      fields.push({ fieldNumber, slice: buf.subarray(next, next + length) });
      i = next + length;
    } else if (wireType === 5) {
      i += 4;
    } else if (wireType === 1) {
      i += 8;
    } else {
      return null;
    }
  }
  return i === buf.length ? fields : null;
};

const varintOf = (fields, fieldNumber) => {
  const field = fields.find((item) => item.fieldNumber === fieldNumber && item.value !== undefined);
  return field === undefined ? null : field.value;
};

const EMPTY_META = Object.freeze({ atUins: [], atAll: false, replyTo: null });

const parseMessageMeta = (body) => {
  if (body === null || body === undefined || body.length === 0) {
    return EMPTY_META;
  }
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "hex");
  const top = parseFields(buf);
  if (top === null) {
    return EMPTY_META;
  }
  const atUins = [];
  let atAll = false;
  let replyTo = null;
  for (const element of top) {
    if (element.fieldNumber !== ELEMENT_FIELD || element.slice === undefined) {
      continue;
    }
    const fields = parseFields(element.slice);
    if (fields === null) {
      continue;
    }
    const type = varintOf(fields, ELEMENT_TYPE);
    if (type === TYPE_TEXT) {
      const atType = varintOf(fields, AT_TYPE);
      if (atType === AT_ALL) {
        atAll = true;
      } else if (atType === AT_SOMEONE) {
        const uin = varintOf(fields, AT_TARGET_UIN);
        if (uin !== null && uin > 0 && !atUins.includes(String(uin))) {
          atUins.push(String(uin));
        }
      }
    } else if (type === TYPE_REPLY && replyTo === null) {
      const uin = varintOf(fields, REPLY_UIN);
      const seq = varintOf(fields, REPLY_SEQ);
      if (uin !== null && uin > 0) {
        replyTo = {
          uin: String(uin),
          seq: seq === null ? null : String(seq),
          sentAt: varintOf(fields, REPLY_SENT_AT),
        };
      }
    }
  }
  return atUins.length === 0 && !atAll && replyTo === null ? EMPTY_META : { atUins, atAll, replyTo };
};

module.exports = { parseMessageMeta, parseFields, readVarint };
