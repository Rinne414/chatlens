"use strict";

// Pairing page of the remote entrance (served without a device cookie).
// The QR on the computer opens /pair#XXXXX-XXXXX; the code travels in the
// fragment, so it never appears in a request line or a proxy log.

const form = document.getElementById("pair-form");
const input = document.getElementById("pair-code");
const submit = document.getElementById("pair-submit");
const statusLine = document.getElementById("pair-status");

const showStatus = (text, tone) => {
  statusLine.textContent = text;
  statusLine.className = `pair-status ${tone ?? ""}`;
};

const pair = async (code) => {
  submit.disabled = true;
  showStatus("正在配对…");
  try {
    const response = await fetch("/remote/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
      credentials: "same-origin",
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      showStatus(payload.error ?? `配对失败（HTTP ${response.status}）`, "error");
      submit.disabled = false;
      return;
    }
    showStatus("配对成功，正在打开…", "ok");
    location.replace("/");
  } catch {
    showStatus("连不上电脑。请确认电脑开着、ChatLens 在运行，手机的 Tailscale 也已打开。", "error");
    submit.disabled = false;
  }
};

form.addEventListener("submit", (event) => {
  event.preventDefault();
  pair(input.value);
});

const readLinkCode = () => {
  try {
    return decodeURIComponent(location.hash.slice(1));
  } catch {
    return "";
  }
};

const fromLink = readLinkCode();
if (fromLink !== "") {
  input.value = fromLink;
  history.replaceState(null, "", "/pair");
  pair(fromLink);
}
