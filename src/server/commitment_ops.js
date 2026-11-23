"use strict";

// 答应过的事 routes (src/commitments.js): the list for 简报, and ticking one
// off, taking it off the list, or putting it back. Finding them is the
// background refresh's job; nothing here calls the AI.

const state = require("./toolkit_state");
const commitments = require("../commitments");

let schemaReady = false;
const db = () => {
  const handle = state.getStore();
  if (!schemaReady) {
    commitments.ensureCommitmentSchema(handle);
    schemaReady = true;
  }
  return handle;
};

const nowUnix = () => Math.floor(Date.now() / 1000);

const list = () => commitments.listCommitments(db(), { nowUnix: nowUnix() });

const handleCommitmentApi = async (request, response, url, { sendJson, readBody }) => {
  if (request.method === "GET" && url.pathname === "/api/commitments") {
    sendJson(response, 200, list());
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/commitments/status") {
    const body = await readBody(request);
    commitments.setStatus(db(), { groupId: body.groupId, rowId: body.rowId, status: body.status, nowUnix: nowUnix() });
    sendJson(response, 200, list());
    return true;
  }
  return false;
};

module.exports = { handleCommitmentApi };
