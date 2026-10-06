// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import { createRelay } from "../src/relay.mjs";
import { connectCDP } from "../src/cdp.mjs";

async function observed(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw Error("Expected protocol lifecycle event was not observed");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

class Fixture extends EventEmitter {
  constructor() {
    super();
    this.operations = [];
    this.snapshot = {
      root: 2,
      width: 500,
      height: 300,
      title: "Native fixture",
      backend: "appkit",
      capabilities: ["styles", "attributes", "pick", "actions"],
      nodes: [
        {
          id: 2,
          parent: 1,
          tag: "NSWindow",
          text: "",
          attributes: { title: "Native fixture" },
          children: [3],
          x: 0,
          y: 0,
          width: 500,
          height: 300,
          styles: {},
        },
        {
          id: 3,
          parent: 2,
          tag: "NativeShowcase.FlippedView",
          text: "",
          attributes: { id: "surface" },
          children: [4],
          x: 0,
          y: 0,
          width: 500,
          height: 300,
          styles: { opacity: "1", "background-color": "rgba(0, 0, 0, 0)" },
        },
        {
          id: 4,
          parent: 3,
          tag: "NSButton",
          text: "Press",
          attributes: { id: "button", title: "Press" },
          children: [],
          x: 20,
          y: 20,
          width: 120,
          height: 30,
          styles: { opacity: "1" },
        },
      ],
    };
    this.originals = new Map();
  }
  async request(method, p = {}) {
    if (method === "snapshot") return structuredClone(this.snapshot);
    this.operations.push({ method, ...p });
    if (method === "styles") {
      for (const operation of p.operations)
        await this.request("style", { node: p.node, ...operation });
      return {};
    }
    if (method === "style") {
      const n = this.snapshot.nodes.find((n) => n.id === p.node),
        key = p.key === "background" ? "background-color" : p.key;
      if (p.reset) {
        n.styles[key] = this.originals.get(p.node + "-" + key) ?? n.styles[key];
      } else {
        if (!this.originals.has(p.node + "-" + key))
          this.originals.set(p.node + "-" + key, n.styles[key]);
        n.styles[key] = p.value;
      }
    }
    if (method === "attribute") {
      const n = this.snapshot.nodes.find((n) => n.id === p.node);
      n.attributes[p.key] = p.value;
      n.text = p.value;
    }
    return {};
  }
  close() {}
}
test("CDP publishes native nodes, applies appearance edits, preserves disabled properties and shorthand source", async () => {
  const backend = new Fixture(),
    relay = await createRelay({ backend, port: 0 }),
    client = await connectCDP(relay.endpoint);
  try {
    await client.send("DOM.enable");
    await client.send("CSS.enable");
    const { root } = await client.send("DOM.getDocument", { depth: -1 });
    assert.equal(root.children[0].children[0].children[0].nodeName, "NSButton");
    assert.equal(
      root.children[0].children[0].localName,
      "NativeShowcase.FlippedView",
    );
    assert.equal(
      root.children[0].children[0].nodeName,
      "NativeShowcase.FlippedView",
    );
    assert.ok(!root.children[0].children[0].attributes.includes("class"));
    for (const selector of [
      "NativeShowcase.FlippedView",
      "NativeShowcase\\.FlippedView",
      "NativeShowcase\\2e FlippedView",
    ]) {
      assert.equal(
        (await client.send("DOM.querySelector", { nodeId: 1, selector }))
          .nodeId,
        3,
      );
    }
    assert.equal(
      (
        await client.send("Runtime.evaluate", {
          expression: '$$("NSButton")[0].tagName',
          returnByValue: true,
        })
      ).result.value,
      "NSButton",
    );
    assert.ok(!root.children[0].children[0].attributes.includes("style"));
    const id = (
      await client.send("DOM.querySelector", {
        nodeId: 1,
        selector: "#surface",
      })
    ).nodeId;
    let style = (
      await client.send("CSS.getInlineStylesForNode", { nodeId: id })
    ).inlineStyle;
    await client.send("CSS.setStyleTexts", {
      edits: [
        {
          styleSheetId: style.styleSheetId,
          range: style.range,
          text: "opacity: 0.4; background: red;",
        },
      ],
    });
    style = (await client.send("CSS.getInlineStylesForNode", { nodeId: id }))
      .inlineStyle;
    assert.equal(
      style.cssProperties.filter((p) => p.name.startsWith("background")).length,
      1,
    );
    assert.equal(relay.styles.get(id).editing, false);
    backend.snapshot.nodes[1].styles.opacity = "0.3";
    await relay.refresh();
    assert.equal(
      (
        await client.send("CSS.getInlineStylesForNode", { nodeId: id })
      ).inlineStyle.cssProperties.find((p) => p.name === "opacity").value,
      "0.3",
      "Shorthand edits must release polling for other native properties",
    );
    assert.ok(
      !(
        await client.send("DOM.getAttributes", { nodeId: id })
      ).attributes.includes("style"),
    );
    await client.send("CSS.setStyleTexts", {
      edits: [
        {
          styleSheetId: style.styleSheetId,
          range: style.range,
          text: "/* opacity: 0.4; */ background: red;",
        },
      ],
    });
    assert.equal(backend.snapshot.nodes[1].styles.opacity, "1");
    await relay.refresh();
    style = (await client.send("CSS.getInlineStylesForNode", { nodeId: id }))
      .inlineStyle;
    assert.ok(style.cssProperties.find((p) => p.name === "opacity").disabled);
    assert.equal(
      style.cssProperties.filter((p) => p.name.startsWith("background")).length,
      1,
    );
    const result = await client.send("Runtime.evaluate", {
      expression: '$("#button").textContent="Edited"; 6*7',
      returnByValue: true,
    });
    assert.equal(result.result.value, 42);
    assert.equal(backend.snapshot.nodes[2].text, "Edited");
    const preview = await client.send("Runtime.evaluate", {
      expression: '$("#button").click()',
      throwOnSideEffect: true,
    });
    assert.match(
      preview.exceptionDetails.exception.description,
      /^EvalError: Possible side-effect in debug-evaluate/,
    );
    assert.ok(
      !backend.operations.some((operation) => operation.method === "action"),
      "Eager previews must not dispatch native actions",
    );
    const denied = await client.send("Runtime.evaluate", {
      expression: "process.cwd()",
      returnByValue: true,
    });
    assert.ok(denied.exceptionDetails);
    for (const expression of [
      'document.querySelector.constructor("return process")()',
      'getComputedStyle($("#button")).constructor.constructor("return process")()',
      '$("#button").click.constructor("return process")()',
    ])
      assert.ok(
        (await client.send("Runtime.evaluate", { expression }))
          .exceptionDetails,
      );
  } finally {
    client.close();
    await relay.close();
  }
});
test("deleting or disabling an appended background restores its native baseline despite the projected longhand", async () => {
  const backend = new Fixture(),
    relay = await createRelay({ backend, port: 0 }),
    client = await connectCDP(relay.endpoint);
  const style = async () =>
    (await client.send("CSS.getInlineStylesForNode", { nodeId: 3 }))
      .inlineStyle;
  const replace = async (range, text) =>
    client.send("CSS.setStyleTexts", {
      edits: [{ styleSheetId: "native-3", range, text }],
    });
  const property = async (name) =>
    (await style()).cssProperties.find((p) => p.name === name);
  const original = backend.snapshot.nodes[1].styles["background-color"];
  try {
    const initial = await style();
    await replace(initial.range, `${initial.cssText} background: red;`);
    assert.equal(backend.snapshot.nodes[1].styles["background-color"], "red");
    await replace((await property("opacity")).range, "opacity: 0.4;");
    await replace(
      (await property("background")).range,
      "/* background: red; */",
    );
    assert.equal(
      backend.snapshot.nodes[1].styles["background-color"],
      original,
    );
    assert.equal(backend.snapshot.nodes[1].styles.opacity, "0.4");
    await relay.refresh();
    assert.equal((await property("background")).disabled, true);
    await replace((await property("background")).range, "background: red;");
    assert.equal(backend.snapshot.nodes[1].styles["background-color"], "red");
    await replace((await property("background")).range, "");
    assert.equal(
      backend.snapshot.nodes[1].styles["background-color"],
      original,
    );
    assert.equal(backend.snapshot.nodes[1].styles.opacity, "0.4");
    await client.send("DOM.undo");
    assert.equal(backend.snapshot.nodes[1].styles["background-color"], "red");
    await client.send("DOM.redo");
    assert.equal(
      backend.snapshot.nodes[1].styles["background-color"],
      original,
    );
    assert.ok(
      !relay.changes
        .export()
        .edits[0].styles.some((p) => p.name.startsWith("background")),
      "Deleted declarations must not survive in saved overrides",
    );
  } finally {
    client.close();
    await relay.close();
  }
});

test("removing one background alias replays the remaining override and restores the baseline after the last deletion", async () => {
  const backend = new Fixture(),
    relay = await createRelay({ backend, port: 0 }),
    client = await connectCDP(relay.endpoint);
  const style = async () =>
    (await client.send("CSS.getInlineStylesForNode", { nodeId: 3 }))
      .inlineStyle;
  const original = backend.snapshot.nodes[1].styles["background-color"];
  try {
    await client.send("CSS.setStyleSheetText", {
      styleSheetId: "native-3",
      text: "background: red; background-color: blue; opacity: 0.4;",
    });
    assert.equal(backend.snapshot.nodes[1].styles["background-color"], "blue");
    for (const [name, expected] of [
      ["background-color", "red"],
      ["background", original],
    ]) {
      const property = (await style()).cssProperties.find(
        (p) => p.name === name,
      );
      await client.send("CSS.setStyleTexts", {
        edits: [{ styleSheetId: "native-3", range: property.range, text: "" }],
      });
      assert.equal(
        backend.snapshot.nodes[1].styles["background-color"],
        expected,
      );
      assert.equal(backend.snapshot.nodes[1].styles.opacity, "0.4");
      await relay.refresh();
      assert.equal(
        backend.snapshot.nodes[1].styles["background-color"],
        expected,
      );
    }
    assert.equal(
      (await style()).cssProperties.find((p) => p.name === "background-color")
        .value,
      original,
      "The Styles panel must show the restored native appearance",
    );
    assert.deepEqual(relay.styles.get(3).overrides, ["opacity"]);
  } finally {
    client.close();
    await relay.close();
  }
});

test("native appearance changes invalidate stylesheet caches for every CSS client without style attributes", async () => {
  const backend = new Fixture();
  backend.snapshot.nodes[1].styles["border-radius"] = "14px";
  const relay = await createRelay({ backend, port: 0, pollMs: 60000 }),
    first = await connectCDP(relay.endpoint),
    second = await connectCDP(relay.endpoint);
  const events = [[], []];
  first.onEvent((event) => events[0].push(event));
  second.onEvent((event) => events[1].push(event));
  const changes = (index) =>
    events[index].filter((event) => event.method === "CSS.styleSheetChanged");
  try {
    for (const client of [first, second]) {
      await client.send("DOM.getDocument", { depth: -1 });
      await client.send("CSS.enable");
    }
    const attributes = await first.send("DOM.getAttributes", { nodeId: 3 });
    backend.snapshot.nodes[1].styles["border-radius"] = "36px";
    await relay.refresh();
    await observed(() =>
      events.every((_, index) => changes(index).length === 1),
    );
    for (const index of [0, 1])
      assert.deepEqual(changes(index)[0].params, { styleSheetId: "native-3" });
    assert.deepEqual(
      await first.send("DOM.getAttributes", { nodeId: 3 }),
      attributes,
      "Appearance updates must not add inline style attributes",
    );
    assert.match(
      (await first.send("CSS.getStyleSheetText", { styleSheetId: "native-3" }))
        .text,
      /border-radius: 36px;/,
    );
    const { inlineStyle } = await first.send("CSS.getMatchedStylesForNode", {
      nodeId: 3,
    });
    assert.equal(
      inlineStyle.cssProperties.find((p) => p.name === "border-radius").value,
      "36px",
    );
    await relay.refresh();
    await first.send("DOM.getAttributes", { nodeId: 3 });
    assert.equal(changes(0).length, 1, "Unchanged snapshots must stay quiet");
    await second.send("CSS.disable");
    backend.snapshot.nodes[1].styles["border-radius"] = "14px";
    await relay.refresh();
    await observed(() => changes(0).length === 2);
    await second.send("DOM.getAttributes", { nodeId: 3 });
    assert.equal(changes(1).length, 1, "CSS.disable must stop notifications");
  } finally {
    first.close();
    second.close();
    await relay.close();
  }
});

test("picker publishes collapsed ancestors, has one owner and restores inspection on disconnect", async () => {
  const backend = new Fixture(),
    relay = await createRelay({ backend, port: 0 }),
    first = await connectCDP(relay.endpoint),
    second = await connectCDP(relay.endpoint);
  const events = [];
  first.onEvent((event) => events.push(event));
  try {
    await first.send("DOM.getDocument", { depth: 0 });
    await first.send("Overlay.setInspectMode", { mode: "searchForNode" });
    const owner = backend.operations.find((o) => o.method === "inspect").owner;
    backend.emit("event", { method: "picked", params: { node: 4, owner } });
    await observed(() =>
      events.some((e) => e.method === "Overlay.inspectNodeRequested"),
    );
    assert.deepEqual(
      events
        .filter((e) => e.method === "DOM.setChildNodes")
        .map((e) => e.params.parentId),
      [1, 2, 3, 4],
    );
    assert.equal(
      events.find((e) => e.method === "Overlay.inspectNodeRequested").params
        .backendNodeId,
      4,
    );
    await first.send("Overlay.setInspectMode", { mode: "searchForNode" });
    await second.send("Overlay.setInspectMode", { mode: "searchForNode" });
    assert.ok(events.some((e) => e.method === "Overlay.inspectModeCanceled"));
    first.close();
    await observed(() => relay.sessions.size === 1);
    assert.ok(
      relay.inspection,
      "disconnecting an old owner must not disable the new picker",
    );
    second.close();
    await observed(() => relay.inspection === null);
    assert.equal(relay.inspection, null);
    assert.ok(
      backend.operations.some((o) => o.method === "inspect" && !o.enabled),
    );
  } finally {
    first.close();
    second.close();
    await relay.close();
  }
});
test("native property metadata controls style edits and authored shorthand order survives polling", async () => {
  const backend = new Fixture();
  backend.snapshot.styleProperties = [
    "opacity",
    "background-color",
    "padding",
    "padding-left",
    "box-shadow",
  ];
  const relay = await createRelay({ backend, port: 0 });
  const client = await connectCDP(relay.endpoint);
  const edit = async (text) => {
    const { inlineStyle: style } = await client.send(
      "CSS.getInlineStylesForNode",
      { nodeId: 3 },
    );
    await client.send("CSS.setStyleTexts", {
      edits: [{ styleSheetId: style.styleSheetId, range: style.range, text }],
    });
  };
  try {
    await client.send("DOM.getDocument", { depth: -1 });
    await edit(
      "padding: 8px; padding-left: 20px; box-shadow: 2px 3px 4px red;",
    );
    await relay.refresh();
    await edit(
      "padding-left: 20px; padding: 8px; box-shadow: 2px 3px 4px red;",
    );
    const last = backend.operations
      .filter((op) => op.method === "styles")
      .at(-1);
    assert.deepEqual(
      last.operations.map((op) => op.key),
      ["padding-left", "padding", "box-shadow"],
    );
    await edit(
      "/* padding-left: 20px; */ padding: 8px; box-shadow: 2px 3px 4px red;",
    );
    assert.ok(
      backend.operations.some(
        (op) => op.method === "style" && op.key === "padding-left" && op.reset,
      ),
    );
    await relay.refresh();
    const { inlineStyle: style } = await client.send(
      "CSS.getInlineStylesForNode",
      { nodeId: 3 },
    );
    assert.ok(
      style.cssProperties.find((p) => p.name === "padding-left").disabled,
    );
    await assert.rejects(
      edit("filter: blur(4px);"),
      /Unsupported native style/,
    );
    backend.snapshot.styleProperties.push("filter");
    await relay.refresh();
    await edit("filter: blur(4px);");
    assert.equal(
      backend.snapshot.nodes[1].styles.filter,
      "blur(4px)",
      "A newly advertised mapping needs no relay registry change",
    );
  } finally {
    client.close();
    await relay.close();
  }
});

test("relay refuses remote origins and accessibility reports appearance limitations", async () => {
  const backend = new Fixture();
  backend.snapshot.backend = "accessibility";
  backend.snapshot.capabilities = ["attributes", "pick", "actions"];
  const relay = await createRelay({ backend, port: 0 }),
    client = await connectCDP(relay.endpoint);
  try {
    assert.equal(
      (await fetch(relay.url, { headers: { "sec-fetch-site": "cross-site" } }))
        .status,
      403,
    );
    const status = await new Promise((resolve, reject) => {
      http
        .get(relay.url, { headers: { Host: "attacker.example" } }, (res) => {
          res.resume();
          resolve(res.statusCode);
        })
        .on("error", reject);
    });
    assert.equal(status, 403);
    const style = (
      await client.send("CSS.getInlineStylesForNode", { nodeId: 3 })
    ).inlineStyle;
    await assert.rejects(
      client.send("CSS.setStyleTexts", {
        edits: [
          {
            styleSheetId: style.styleSheetId,
            range: style.range,
            text: "background:red;",
          },
        ],
      }),
      /Accessibility cannot/,
    );
  } finally {
    client.close();
    await relay.close();
  }
});
