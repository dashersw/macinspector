// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SourceDebugger } from "../src/source-debugger.mjs";
import { NativeBackend } from "../src/backends.mjs";

const file = fileURLToPath(
  new URL("../demo/macos/main.swift", import.meta.url),
);
class Transport {
  requests = [];
  onEvent(listener) {
    this.event = listener;
    return () => {
      this.event = () => {};
    };
  }
  async request(method, params) {
    this.requests.push({ method, ...params });
    if (method === "attach")
      return { pid: 123, sources: [{ file, lines: [277, 278, 279] }] };
    if (method === "breakpoint") return { id: 7, file, line: params.line };
    if (method === "variables")
      return {
        values: [
          { name: "self", type: "AppDelegate", value: "0x1234", handle: 1 },
        ],
      };
    if (method === "evaluate") return { type: "Int", value: "42" };
    if (method === "resume") this.event({ event: "running" });
    return {};
  }
  async close() {}
}
test("native sources publish DWARF locations, scopes and stale-frame protection; disconnect resumes", async () => {
  const transport = new Transport(),
    debugger_ = new SourceDebugger(transport);
  const events = [],
    emit = (method, params) => events.push({ method, params });
  await debugger_.start({ pid: 123 });
  try {
    await debugger_.handle("owner", emit, "Debugger.enable");
    const script = events.find(
      (e) => e.method === "Debugger.scriptParsed",
    ).params;
    assert.equal(script.url, pathToFileURL(file).href);
    const { locations } = await debugger_.handle(
      "owner",
      emit,
      "Debugger.getPossibleBreakpoints",
      { start: { scriptId: script.scriptId, lineNumber: 277 } },
    );
    assert.deepEqual(
      locations.map((l) => l.lineNumber),
      [277, 278],
    );
    const breakpoint = await debugger_.handle(
      "owner",
      emit,
      "Debugger.setBreakpointByUrl",
      { url: script.url, lineNumber: 276, condition: "actionCount == 0" },
    );
    assert.equal(breakpoint.breakpointId, "lldb-7");
    transport.event({
      event: "stopped",
      thread: "1",
      reason: "breakpoint",
      breakpoints: [7],
      frames: [{ file, line: 277, level: 0, function: "increment" }],
    });
    const pause = events.find((e) => e.method === "Debugger.paused").params;
    assert.deepEqual(pause.hitBreakpoints, ["lldb-7"]);
    const properties = await debugger_.handle(
      "owner",
      emit,
      "Runtime.getProperties",
      { objectId: pause.callFrames[0].scopeChain[0].object.objectId },
    );
    assert.equal(
      properties.result[0].value.type,
      "object",
      "native pointers must remain inspectable objects",
    );
    const result = await debugger_.handle(
      "owner",
      emit,
      "Debugger.evaluateOnCallFrame",
      {
        callFrameId: pause.callFrames[0].callFrameId,
        expression: "self.actionCount",
      },
    );
    assert.equal(result.result.value, 42);
    assert.equal(
      result.result.description,
      "42",
      "DevTools renders the number's description in Watch and Scope",
    );
    assert.equal(
      debugger_.remote({ type: "Swift.Bool", value: "1" }).value,
      true,
    );
    assert.deepEqual(
      debugger_.remote({ type: "Int64", value: "9223372036854775807" }),
      {
        type: "bigint",
        unserializableValue: "9223372036854775807n",
        description: "9223372036854775807",
      },
    );
    await assert.rejects(
      debugger_.handle("other", emit, "Debugger.removeBreakpoint", {
        breakpointId: "lldb-7",
      }),
      /another inspector/,
    );
    await debugger_.removeOwner("owner");
    assert.equal(debugger_.paused, false);
    assert.ok(
      transport.requests.some((r) => r.method === "remove" && r.id === 7),
    );
    assert.throws(
      () => debugger_.frame(pause.callFrames[0].callFrameId),
      /not paused/,
    );
  } finally {
    await debugger_.close();
  }
});
test("pausing cancels pending native UI requests without dropping the transport", async () => {
  const backend = new NativeBackend(
    () => {},
    () => {},
  );
  const pending = backend.request("action", { node: 3, key: "click" });
  const rejection = assert.rejects(pending, /paused during a UI operation/);
  backend.suspend(true);
  await rejection;
  await assert.rejects(backend.request("snapshot"), /paused/);
  assert.equal(backend.closed, undefined);
  backend.suspend(false);
  const resumed = backend.request("snapshot");
  backend.receive(JSON.stringify({ id: backend.nextID, result: { root: 2 } }));
  assert.deepEqual(await resumed, { root: 2 });
  backend.close();
});
