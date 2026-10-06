// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import net from "node:net";
import { createRelay } from "../src/relay.mjs";
import { connectCDP } from "../src/cdp.mjs";

class Backend extends EventEmitter {
  constructor(offset = 0) {
    super();
    this.node = 3 + offset;
    this.styles = { opacity: "1", "background-color": "transparent" };
    this.originals = new Map();
    this.value = "Original";
    this.constraint = {
      id: "session-constraint",
      key: "id:subject.width",
      identifier: "subject.width",
      constant: 100,
      priority: 1000,
      active: true,
    };
  }
  async request(method, p = {}) {
    if (method === "snapshot")
      return {
        root: 2,
        bundleId: "example.app",
        width: 400,
        height: 300,
        title: "History fixture",
        backend: "appkit",
        capabilities: ["styles", "attributes", "layout"],
        nodes: [
          {
            id: 2,
            parent: 1,
            tag: "NSWindow",
            text: "",
            children: [this.node],
            attributes: {},
            styles: {},
            x: 0,
            y: 0,
            width: 400,
            height: 300,
          },
          {
            id: this.node,
            parent: 2,
            tag: "NSTextField",
            text: this.value,
            children: [],
            attributes: { id: "subject", value: this.value },
            styles: { ...this.styles },
            x: 0,
            y: 0,
            width: this.constraint.constant,
            height: 30,
          },
        ],
      };
    if (method === "styles") {
      const next = { ...this.styles };
      for (const op of p.operations) {
        if (op.value === "invalid") throw Error("Invalid native color");
        const key = op.key === "background" ? "background-color" : op.key;
        if (!this.originals.has(key)) this.originals.set(key, next[key]);
        if (op.reset) next[key] = this.originals.get(key);
        else next[key] = op.value;
      }
      this.styles = next;
      return {};
    }
    if (method === "attribute") {
      this.value = p.value;
      return {};
    }
    if (method === "layout")
      return {
        constraints: [{ ...this.constraint }],
        intrinsic: { width: 100, height: 30 },
        huggingHorizontal: 250,
        huggingVertical: 250,
        compressionHorizontal: 750,
        compressionVertical: 750,
      };
    if (method === "layout-resolve") {
      if (p.key !== this.constraint.key) throw Error("Missing constraint");
      return { constraint: this.constraint.id };
    }
    if (method === "layout-edit") {
      for (const key of ["constant", "priority", "active"])
        if (key in p) this.constraint[key] = p[key];
      return {};
    }
    return {};
  }
  close() {}
}

test("CDP edits share history across clients, undo restores native baselines, and overrides survive new node identities", async () => {
  const backend = new Backend();
  const relay = await createRelay({ backend, port: 0 });
  const first = await connectCDP(relay.endpoint),
    second = await connectCDP(relay.endpoint);
  let other;
  try {
    await first.send("CSS.setStyleSheetText", {
      styleSheetId: "native-3",
      text: "opacity: 0.4; background: red;",
    });
    await second.send("DOM.undo");
    assert.equal(backend.styles.opacity, "1");
    assert.equal(backend.styles["background-color"], "transparent");
    assert.deepEqual(relay.changes.export().edits, []);
    await second.send("DOM.redo");
    assert.equal(backend.styles.opacity, "0.4");
    await first.send("CSS.setStyleSheetText", {
      styleSheetId: "native-3",
      text: "/* opacity: 0.4; */ background: red;",
    });
    assert.equal(backend.styles.opacity, "1");
    await first.send("DOM.setAttributeValue", {
      nodeId: 3,
      name: "value",
      value: "Persisted",
    });
    await first.send("MacInspector.setLayout", {
      node: 3,
      constraint: "session-constraint",
      constant: 180,
    });
    const saved = await first.send("MacInspector.exportOverrides");
    assert.equal(saved.edits.length, 1);
    assert.deepEqual(saved.edits[0].target, {
      tag: "NSTextField",
      id: "subject",
    });
    assert.equal(
      saved.edits[0].styles.find((p) => p.name === "opacity").disabled,
      true,
    );
    assert.equal(saved.edits[0].constraints[0].key, "id:subject.width");
    assert.ok(!JSON.stringify(saved).includes("session-constraint"));
    const restarted = new Backend(30);
    other = await createRelay({ backend: restarted, port: 0 });
    await other.changes.import(saved);
    assert.equal(restarted.value, "Persisted");
    assert.equal(restarted.constraint.constant, 180);
    assert.equal(restarted.styles["background-color"], "red");
    assert.equal(restarted.styles.opacity, "1");
    assert.match(
      other.changes.swift(),
      /try inspector.applyOverrides\(Data\(overrides.utf8\)\)/,
    );
    await other.changes.undo();
    assert.equal(restarted.constraint.constant, 100);
    await other.changes.undo();
    await other.changes.undo();
    assert.equal(restarted.value, "Original");
    assert.deepEqual(other.changes.export().edits, []);
  } finally {
    first.close();
    second.close();
    await other?.close();
    await relay.close();
  }
});

test("individual undo protects later edits, failed import rolls back, and native POSTs reject foreign origins", async () => {
  const backend = new Backend(),
    relay = await createRelay({ backend, port: 0 });
  try {
    await relay.changes.attribute(3, "value", "First");
    await relay.changes.attribute(3, "value", "Second");
    await assert.rejects(relay.changes.revert(1), /Later edits overlap/);
    assert.equal(backend.value, "Second");
    await relay.changes.revert(2);
    assert.equal(backend.value, "First");
    await relay.changes.undo();
    assert.equal(backend.value, "Second");
    const before = relay.changes.list();
    await assert.rejects(
      relay.changes.import({
        version: 1,
        bundleId: "example.app",
        edits: [
          {
            target: { tag: "NSTextField", id: "subject" },
            attributes: { value: "Temporary" },
          },
          {
            target: { tag: "NSTextField", id: "subject" },
            styles: [{ name: "background", value: "invalid" }],
          },
        ],
      }),
      /Invalid native color/,
    );
    assert.equal(backend.value, "Second");
    assert.deepEqual(relay.changes.list(), before);
    const response = await fetch(new URL("/native/command", relay.url), {
      method: "POST",
      headers: {
        Origin: "https://attacker.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ method: "undo" }),
    });
    assert.equal(response.status, 403);
    assert.equal(backend.value, "Second");
    const ok = await fetch(new URL("/native/command", relay.url), {
      method: "POST",
      headers: {
        Origin: new URL(relay.url).origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ method: "getChanges" }),
    });
    assert.equal(ok.status, 200);
  } finally {
    await relay.close();
  }
});

test("automatic relay ports recover from a occupied preferred port; explicit ports remain explicit", async () => {
  const occupied = net.createServer();
  await new Promise((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  const port = occupied.address().port;
  let relay;
  try {
    relay = await createRelay({ backend: new Backend(), port, autoPort: true });
    assert.notEqual(new URL(relay.url).port, String(port));
    assert.equal((await fetch(relay.url)).status, 200);
    await assert.rejects(createRelay({ backend: new Backend(), port }), {
      code: "EADDRINUSE",
    });
  } finally {
    await relay?.close();
    await new Promise((resolve) => occupied.close(resolve));
  }
});
