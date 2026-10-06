// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { Session } from "../src/session.mjs";
import { projectNativeDOM } from "../src/dom.mjs";

function fixture() {
  const info = {
    type: "action",
    kind: "control",
    target: "Demo.Controller",
    selector: "increment:",
    dispatch: "explicit target",
    enabled: true,
    address: "0x1234",
  };
  const nodes = new Map([
    [
      3,
      {
        id: 3,
        tag: "NSView",
        children: [4],
        attributes: {},
        styles: {},
        listeners: [],
      },
    ],
    [
      4,
      {
        id: 4,
        tag: "NSButton",
        children: [],
        attributes: {},
        styles: {},
        listeners: [info],
      },
    ],
  ]);
  const events = [],
    requests = [];
  const relay = {
    nodes,
    domNodes: projectNativeDOM(nodes),
    snapshot: { root: 3, capabilities: ["event-listeners"] },
    styles: new Map(),
    backend: {
      async request(method, p) {
        requests.push({ method, ...p });
        return { listeners: nodes.get(p.node).listeners };
      },
    },
  };
  const session = new Session(relay, (method, params) =>
    events.push({ method, params }),
  );
  return { session, relay, events, requests, info };
}

test("registered SwiftUI closures link to readable native source without requiring an Objective-C implementation address", async () => {
  const { session, relay, info } = fixture();
  delete info.address;
  info.file = "/app/Showcase.swift";
  info.line = 42;
  info.kind = "SwiftUI closure";
  let requested;
  relay.sourceDebugger = {
    addSource(file) {
      requested = file;
      return "swiftui-source";
    },
  };
  const node = session.remote(session.wrap(4));
  const { listeners } = await session.handle("DOMDebugger.getEventListeners", {
    objectId: node.objectId,
  });
  assert.equal(requested, info.file);
  assert.equal(listeners[0].scriptId, "swiftui-source");
  assert.equal(listeners[0].lineNumber, 41);
  assert.equal(session.listenerScripts.size, 0);
});

test("CDP native listeners expose source links and metadata, support subtree depth and object release", async () => {
  const { session, relay, events, requests } = fixture();
  await session.handle("Debugger.enable");
  const node = session.remote(session.wrap(4), "events");
  const { listeners } = await session.handle("DOMDebugger.getEventListeners", {
    objectId: node.objectId,
  });
  assert.equal(listeners.length, 1);
  const listener = listeners[0];
  assert.equal(listener.type, "action");
  assert.equal(listener.backendNodeId, 4);
  assert.equal(listener.handler.type, "function");
  assert.equal(listener.handler.description, "Demo.Controller.increment:");
  assert.deepEqual(requests, [{ method: "event-listeners", node: 4 }]);
  assert.equal(events[0].method, "Debugger.scriptParsed");
  const source = await session.handle("Debugger.getScriptSource", {
    scriptId: listener.scriptId,
  });
  assert.match(source.scriptSource, /handler metadata, not executable/);
  assert.match(source.scriptSource, /source debugging is disabled/);
  assert.match(
    source.scriptSource,
    /--source-debug.*Debug build with debug symbols/,
  );
  const properties = await session.handle("Runtime.getProperties", {
    objectId: listener.handler.objectId,
  });
  assert.equal(
    properties.result.find((p) => p.name === "selector").value.value,
    "increment:",
  );
  assert.ok(!properties.result.some((p) => p.name === "address"));
  assert.equal(
    properties.internalProperties[0].value.value.scriptId,
    listener.scriptId,
  );
  session.context.testHandler = session.object(listener.handler.objectId);
  assert.equal(
    vm.runInContext("testHandler.constructor === Object", session.context),
    true,
    "Native metadata must stay in the console realm",
  );
  const root = session.remote(session.wrap(3));
  assert.equal(
    (
      await session.handle("DOMDebugger.getEventListeners", {
        objectId: root.objectId,
      })
    ).listeners.length,
    0,
  );
  assert.equal(
    (
      await session.handle("DOMDebugger.getEventListeners", {
        objectId: root.objectId,
        depth: -1,
      })
    ).listeners.length,
    1,
  );
  await assert.rejects(
    session.handle("DOMDebugger.getEventListeners", {
      objectId: root.objectId,
      depth: -2,
    }),
    /depth/,
  );
  await session.handle("Runtime.releaseObjectGroup", { objectGroup: "events" });
  await assert.rejects(
    session.handle("Runtime.getProperties", {
      objectId: listener.handler.objectId,
    }),
    /Released/,
  );
  relay.snapshot.capabilities = [];
  assert.deepEqual(
    await session.handle("DOMDebugger.getEventListeners", {
      objectId: root.objectId,
    }),
    { listeners: [] },
  );
});

test("native handler metadata reports missing source without suggesting LLDB is disabled", async () => {
  const { session, relay, events } = fixture();
  relay.sourceDebugger = {
    async handlerLocations() {
      return {};
    },
  };
  const node = session.remote(session.wrap(4));
  const { listeners } = await session.handle("DOMDebugger.getEventListeners", {
    objectId: node.objectId,
  });
  const { scriptSource } = await session.handle("Debugger.getScriptSource", {
    scriptId: listeners[0].scriptId,
  });
  assert.match(scriptSource, /source debugging is enabled.*no readable source/);
  assert.match(scriptSource, /System\/framework handlers/);
  assert.match(scriptSource, /matching debug symbols and local source files/);
  assert.doesNotMatch(scriptSource, /--source-debug|symbol-bearing/);
  assert.equal(events[0].params.endLine, scriptSource.split("\n").length - 1);
  assert.deepEqual(
    await session.handle("Debugger.getPossibleBreakpoints", {
      start: { scriptId: listeners[0].scriptId, lineNumber: 0 },
    }),
    { locations: [] },
  );
});

test("native handler metadata distinguishes unresolved addresses and updates when they resolve", async () => {
  const { session, relay, info } = fixture();
  delete info.address;
  relay.sourceDebugger = {
    async handlerLocations() {
      return {};
    },
  };
  const node = session.remote(session.wrap(4));
  const source = async () => {
    const { listeners } = await session.handle(
      "DOMDebugger.getEventListeners",
      {
        objectId: node.objectId,
      },
    );
    return session.handle("Debugger.getScriptSource", {
      scriptId: listeners[0].scriptId,
    });
  };
  const unresolved = await source();
  assert.match(unresolved.scriptSource, /no resolved implementation address/);
  assert.doesNotMatch(unresolved.scriptSource, /--source-debug/);
  info.address = "0x1234";
  const resolved = await source();
  assert.match(resolved.scriptSource, /no readable source location/);
  assert.doesNotMatch(
    resolved.scriptSource,
    /no resolved implementation address/,
  );
});

test("native listeners use DWARF locations when available; Console lists current snapshot metadata", async () => {
  const { session, relay, info } = fixture();
  const location = {
    scriptId: "source-native",
    lineNumber: 20,
    columnNumber: 2,
  };
  relay.sourceDebugger = {
    async handlerLocations(addresses) {
      assert.deepEqual(addresses, [info.address]);
      return { [info.address]: location };
    },
  };
  const node = session.remote(session.wrap(4));
  const { listeners } = await session.handle("DOMDebugger.getEventListeners", {
    objectId: node.objectId,
  });
  assert.equal(listeners[0].scriptId, location.scriptId);
  assert.equal(listeners[0].lineNumber, 20);
  session.context.testNode = session.wrap(4);
  const metadata = vm.runInContext(
    "getEventListeners(testNode).action[0]",
    session.context,
  );
  assert.equal(metadata.selector, "increment:");
  assert.equal(metadata.address, undefined);
});
