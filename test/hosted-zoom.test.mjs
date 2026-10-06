// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { installHostedZoom } from "../frontend/hosted-zoom.mjs";

function fixture({
  platform = "mac",
  saved,
  storageDenied = false,
  hosted = true,
} = {}) {
  const values = new Map([["macinspector-ui-zoom", saved]]);
  const win = new EventTarget();
  win.Event = Event;
  win.document = { documentElement: { style: {} } };
  win.localStorage = {
    getItem(key) {
      if (storageDenied) throw Error("Storage disabled");
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      if (storageDenied) throw Error("Storage disabled");
      values.set(key, value);
    },
  };
  const host = { isHostedMode: () => hosted, platform: () => platform };
  let resizes = 0;
  win.addEventListener("resize", () => resizes++);
  installHostedZoom(host, win);
  const key = (key, modifiers = {}) => {
    const event = Object.assign(new Event("keydown", { cancelable: true }), {
      key,
      code: "",
      metaKey: platform === "mac",
      ctrlKey: platform !== "mac",
      altKey: false,
      shiftKey: false,
      ...modifiers,
    });
    win.dispatchEvent(event);
    return event.defaultPrevented;
  };
  return { win, host, values, key, resizes: () => resizes };
}

test("hosted zoom consumes zoom shortcuts, persists scale and notifies panel layout", () => {
  const { win, host, values, key, resizes } = fixture();
  assert.equal(host.zoomFactor(), 1);
  assert.equal(key("="), true);
  assert.equal(host.zoomFactor(), 1.1);
  assert.equal(win.document.documentElement.style.zoom, "1.1");
  assert.equal(key("+", { shiftKey: true }), true);
  assert.equal(host.zoomFactor(), 1.25);
  assert.equal(key("-"), true);
  assert.equal(host.zoomFactor(), 1.1);
  assert.equal(key("0"), true);
  assert.equal(host.zoomFactor(), 1);
  assert.equal(values.get("macinspector-ui-zoom"), "1");
  assert.equal(resizes(), 4);

  for (const [value, modifiers] of [
    ["=", { metaKey: false }],
    ["=", { ctrlKey: true }],
    ["=", { altKey: true }],
    ["0", { shiftKey: true }],
    ["c", {}],
  ])
    assert.equal(key(value, modifiers), false);
  assert.equal(resizes(), 4);

  for (let i = 0; i < 25; i++) key("+");
  assert.equal(host.zoomFactor(), 3);
  const maximumResizes = resizes();
  key("+");
  assert.equal(resizes(), maximumResizes);
  for (let i = 0; i < 25; i++) key("-");
  assert.equal(host.zoomFactor(), 0.5);
  const minimumResizes = resizes();
  key("-");
  assert.equal(resizes(), minimumResizes);
});

test("zoom restores valid preferences and works with blocked storage and Ctrl/numpad keys", () => {
  const restored = fixture({ saved: "1.5" });
  assert.equal(restored.host.zoomFactor(), 1.5);
  assert.equal(restored.win.document.documentElement.style.zoom, "1.5");
  assert.equal(restored.resizes(), 0);
  for (const saved of ["Infinity", "-1", "garbage", "1.17"]) {
    assert.equal(fixture({ saved }).host.zoomFactor(), 1);
  }
  const blocked = fixture({ storageDenied: true });
  assert.equal(blocked.key("="), true);
  assert.equal(blocked.host.zoomFactor(), 1.1);

  const other = fixture({ platform: "linux" });
  assert.equal(other.key("+", { ctrlKey: false, metaKey: true }), false);
  assert.equal(other.key("+"), true);
  assert.equal(other.host.zoomFactor(), 1.1);
  assert.equal(other.key("Add", { code: "NumpadAdd" }), true);
  assert.equal(other.host.zoomFactor(), 1.25);
  assert.equal(other.key("Subtract", { code: "NumpadSubtract" }), true);
  assert.equal(other.host.zoomFactor(), 1.1);
  assert.equal(other.key("0", { code: "Numpad0" }), true);
  assert.equal(other.host.zoomFactor(), 1);

  const embedded = fixture({ hosted: false });
  assert.equal(embedded.host.zoomFactor, undefined);
  assert.equal(embedded.win.document.documentElement.style.zoom, undefined);
  assert.equal(embedded.key("+"), false);
});
