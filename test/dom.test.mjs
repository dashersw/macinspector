// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRelay } from "../src/relay.mjs";
import { connectCDP } from "../src/cdp.mjs";

class TextFixture extends EventEmitter {
  operations = [];
  constructor() {
    super();
    const node = (
      id,
      parent,
      tag,
      text,
      textMode,
      children = [],
      attributes = {},
    ) => ({
      id,
      parent,
      tag,
      text,
      textMode,
      children,
      attributes: { id: `view-${id}`, ...attributes },
      x: 10,
      y: 20,
      width: 120,
      height: 40,
      styles: { opacity: "1" },
    });
    this.snapshot = {
      root: 2,
      width: 500,
      height: 300,
      backend: "uikit",
      title: "Text fixture",
      capabilities: ["attributes", "styles", "actions", "layout"],
      nodes: [
        node(2, 1, "UIWindow", "", "none", [3, 4, 5, 7, 9]),
        node(3, 2, "UILabel", "Hello <world> & friends", "content", [], {
          text: "Hello <world> & friends",
        }),
        node(4, 2, "UITextField", "Editable value", "value", [], {
          value: "Editable value",
        }),
        node(5, 2, "UIButton", "Animate", "content", [6], { title: "Animate" }),
        node(6, 5, "UIButtonLabel", "Animate", "content", [], {
          text: "Animate",
        }),
        node(7, 2, "UIView", "", "none", [8]),
        node(8, 7, "NSTextField", "Read-only label", "content", [], {
          value: "Read-only label",
        }),
        node(9, 2, "UITextView", "First line\nSecond line", "content", [], {
          value: "First line\nSecond line",
        }),
      ],
    };
    this.snapshot.nodes.find((node) => node.id === 6).textOwner = 5;
  }
  async request(method, params = {}) {
    if (method === "snapshot") return structuredClone(this.snapshot);
    this.operations.push({ method, ...params });
    if (method === "attribute") {
      const node = this.snapshot.nodes.find((node) => node.id === params.node);
      assert.ok(node, "Synthetic IDs must never reach the native backend");
      node.text = params.value;
      node.attributes[params.key] = params.value;
      if (node.textMode === "value") node.attributes.value = params.value;
      for (const child of this.snapshot.nodes.filter(
        (child) => child.textOwner === node.id,
      ))
        child.text = params.value;
    }
    if (method === "layout") return { node: params.node, constraints: [] };
    return {};
  }
  close() {}
}

test("native text children are editable, live, stable and route selection to native owners", async () => {
  const backend = new TextFixture();
  const relay = await createRelay({ backend, port: 0, pollMs: 60000 });
  const client = await connectCDP(relay.endpoint);
  const events = [];
  client.onEvent((event) => events.push(event));
  const describe = async (id) =>
    (await client.send("DOM.describeNode", { nodeId: id, depth: -1 })).node;
  const drain = async () => {
    await client.send("DOM.getAttributes", { nodeId: 2 });
  };
  try {
    await client.send("DOM.getDocument", { depth: -1 });
    const label = await describe(3),
      text = label.children[0];
    assert.equal(text.nodeType, 3);
    assert.equal(text.nodeName, "#text");
    assert.equal(text.nodeValue, "Hello <world> & friends");
    assert.ok(!label.attributes.includes("text"));
    assert.equal((await describe(4)).childNodeCount, 0);
    assert.ok((await describe(4)).attributes.includes("value"));
    assert.deepEqual(
      (await describe(5)).children.map((child) => child.nodeId),
      [6],
    );
    assert.equal((await describe(6)).children[0].nodeValue, "Animate");
    await client.send("DOM.setNodeValue", {
      nodeId: -6,
      value: "New button title",
    });
    assert.equal(backend.operations.at(-1).node, 5);
    assert.equal((await describe(5)).children.length, 1);
    assert.equal((await describe(6)).children[0].nodeValue, "New button title");
    await client.send("DOM.undo");
    assert.deepEqual(
      (await describe(7)).children.map((child) => child.nodeId),
      [8],
    );
    assert.ok(!(await describe(8)).attributes.includes("value"));
    assert.ok(!(await describe(9)).attributes.includes("value"));
    assert.equal(
      (await describe(9)).children[0].nodeValue,
      "First line\nSecond line",
    );
    const html = (await client.send("DOM.getOuterHTML", { nodeId: 3 }))
      .outerHTML;
    assert.equal(
      html,
      '<UILabel id="view-3">Hello &lt;world> &amp; friends</UILabel>',
    );
    assert.match(
      (await client.send("DOM.getOuterHTML", { nodeId: 7 })).outerHTML,
      /<NSTextField id="view-8">Read-only label<\/NSTextField>/,
    );

    await client.send("DOM.setNodeValue", {
      nodeId: text.nodeId,
      value: "Edited text",
    });
    await drain();
    assert.equal(backend.snapshot.nodes[1].text, "Edited text");
    assert.equal((await describe(3)).children[0].nodeId, text.nodeId);
    assert.ok(
      events.some(
        (event) =>
          event.method === "DOM.characterDataModified" &&
          event.params.nodeId === text.nodeId &&
          event.params.characterData === "Edited text",
      ),
    );
    assert.ok(!events.some((event) => event.method === "DOM.documentUpdated"));
    await client.send("DOM.undo");
    assert.equal(
      (await describe(text.nodeId)).nodeValue,
      "Hello <world> & friends",
    );
    await client.send("DOM.redo");
    assert.equal((await describe(text.nodeId)).nodeValue, "Edited text");
    assert.equal(relay.changes.export().edits[0].target.id, "view-3");
    assert.equal(
      relay.changes.export().edits[0].attributes.text,
      "Edited text",
    );

    await client.send("Overlay.highlightNode", { backendNodeId: text.nodeId });
    assert.equal(backend.operations.at(-1).node, 3);
    assert.equal(
      (await client.send("DOM.getBoxModel", { nodeId: text.nodeId })).model
        .width,
      120,
    );
    assert.equal(
      (await client.send("CSS.getInlineStylesForNode", { nodeId: text.nodeId }))
        .inlineStyle.styleSheetId,
      "native-3",
    );
    assert.equal(
      (
        await client.send("CSS.getMatchedStylesForNode", {
          nodeId: text.nodeId,
        })
      ).inherited[0].inlineStyle.styleSheetId,
      "native-3",
    );
    assert.equal(
      (await client.send("MacInspector.getLayout", { node: text.nodeId })).node,
      3,
    );
    await client.send("DOM.setInspectedNode", { nodeId: text.nodeId });
    const read = await client.send("Runtime.evaluate", {
      expression:
        "$0.nodeType + ':' + $0.nodeValue + ':' + $0.parentNode.tagName",
      returnByValue: true,
    });
    assert.equal(read.result.value, "3:Edited text:UILabel");
    const edit = await client.send("Runtime.evaluate", {
      expression: '$0.nodeValue="From console"',
      returnByValue: true,
    });
    assert.equal(edit.exceptionDetails, undefined);
    assert.equal((await describe(text.nodeId)).nodeValue, "From console");
    assert.equal(
      (await client.send("DOM.resolveNode", { nodeId: text.nodeId })).object
        .className,
      "Text",
    );

    backend.snapshot.nodes[1].text = "";
    await relay.refresh();
    await drain();
    assert.equal((await describe(text.nodeId)).nodeValue, "");
    backend.snapshot.nodes[1].text = "Live native change";
    await relay.refresh();
    await drain();
    assert.equal((await describe(text.nodeId)).nodeValue, "Live native change");
    assert.ok(!events.some((event) => event.method === "DOM.documentUpdated"));
    backend.snapshot.nodes = backend.snapshot.nodes.filter(
      (node) => node.id !== 3,
    );
    backend.snapshot.nodes[0].children =
      backend.snapshot.nodes[0].children.filter((id) => id !== 3);
    await relay.refresh();
    await assert.rejects(
      client.send("DOM.setNodeValue", { nodeId: text.nodeId, value: "Stale" }),
      /Stale native element/,
    );
  } finally {
    client.close();
    await relay.close();
  }
});

test("text publication respects collapsed parents and native override paths", async () => {
  const backend = new TextFixture();
  const relay = await createRelay({ backend, port: 0, pollMs: 60000 });
  const client = await connectCDP(relay.endpoint),
    events = [];
  client.onEvent((event) => events.push(event));
  try {
    await client.send("DOM.getDocument", { depth: 1 });
    backend.snapshot.nodes[0].attributes.title = "Updated while collapsed";
    backend.snapshot.nodes[1].text = "Updated while collapsed";
    await relay.refresh();
    await client.send("DOM.getAttributes", { nodeId: 2 });
    assert.ok(
      !events.some((event) => event.method === "DOM.characterDataModified"),
    );
    assert.ok(
      events.some(
        (event) =>
          event.method === "DOM.attributeModified" &&
          event.params.nodeId === 2 &&
          event.params.name === "title",
      ),
    );
    await client.send("DOM.pushNodesByBackendIdsToFrontend", {
      backendNodeIds: [-3],
    });
    assert.ok(
      events.some(
        (event) =>
          event.method === "DOM.setChildNodes" &&
          event.params.parentId === 3 &&
          event.params.nodes[0].nodeValue === "Updated while collapsed",
      ),
    );
    delete backend.snapshot.nodes.find((node) => node.id === 8).attributes.id;
    await relay.refresh();
    assert.deepEqual(
      relay.changes.target(8).path,
      [3, 0],
      "Presentation text must not shift persisted native paths",
    );
  } finally {
    client.close();
    await relay.close();
  }
});

test("native text renderer replacement, sibling reordering and reparenting update incrementally", async () => {
  const backend = new TextFixture();
  const fragment = (id) => ({
    id,
    parent: 3,
    tag: "NativeTextFragment",
    text: "",
    textMode: "none",
    attributes: {},
    children: [],
    styles: { opacity: "1" },
    x: 10,
    y: 20,
    width: 120,
    height: 40,
  });
  backend.snapshot.nodes.find((node) => node.id === 3).children = [10];
  backend.snapshot.nodes.push(fragment(10));
  const relay = await createRelay({ backend, port: 0, pollMs: 60000 }),
    client = await connectCDP(relay.endpoint),
    events = [];
  client.onEvent((event) => events.push(event));
  const refresh = async () => {
    await relay.refresh();
    await client.send("DOM.getAttributes", { nodeId: 2 });
  };
  try {
    await client.send("DOM.getDocument", { depth: -1 });
    await client.send("CSS.enable");
    events.length = 0;
    const label = backend.snapshot.nodes.find((node) => node.id === 3);
    label.text = "Live replacement";
    label.children = [11];
    backend.snapshot.nodes = backend.snapshot.nodes.filter(
      (node) => node.id !== 10,
    );
    backend.snapshot.nodes.push(fragment(11));
    await refresh();
    assert.ok(
      events.some(
        (event) =>
          event.method === "DOM.childNodeRemoved" && event.params.nodeId === 10,
      ),
    );
    const inserted = events.find(
      (event) =>
        event.method === "DOM.childNodeInserted" &&
        event.params.node.nodeId === 11,
    );
    assert.equal(inserted.params.previousNodeId, -3);
    assert.ok(
      events.some(
        (event) =>
          event.method === "DOM.characterDataModified" &&
          event.params.nodeId === -3,
      ),
    );
    assert.ok(
      events.some(
        (event) =>
          event.method === "CSS.styleSheetAdded" &&
          event.params.header.styleSheetId === "native-11",
      ),
    );
    assert.ok(
      events.some(
        (event) =>
          event.method === "CSS.styleSheetRemoved" &&
          event.params.styleSheetId === "native-10",
      ),
    );
    backend.snapshot.nodes[0].children = [4, 3, 5, 7, 9];
    await refresh();
    assert.ok(
      events.some(
        (event) =>
          event.method === "DOM.childNodeInserted" &&
          event.params.node.nodeId === 4 &&
          event.params.previousNodeId === 0,
      ),
    );
    backend.snapshot.nodes[0].children = [4, 5, 7, 9];
    backend.snapshot.nodes.find((node) => node.id === 7).children.push(3);
    label.parent = 7;
    await refresh();
    const moved = events.find(
      (event) =>
        event.method === "DOM.childNodeInserted" &&
        event.params.node.nodeId === 3 &&
        event.params.parentNodeId === 7,
    );
    assert.equal(moved.params.node.children[0].nodeId, -3);
    assert.equal(moved.params.node.children[0].nodeValue, "Live replacement");
    assert.ok(!events.some((event) => event.method === "DOM.documentUpdated"));
  } finally {
    client.close();
    await relay.close();
  }
});
