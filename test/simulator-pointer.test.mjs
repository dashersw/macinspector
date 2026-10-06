// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { NativeBackend } from "../src/backends.mjs";
import { attachSimulatorPointer } from "../src/simulator-pointer.mjs";

async function observed(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error("Pointer update was not observed");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("Simulator hover is bounded, owned and stopped on pick, pause and disconnect", async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  let killed = false;
  child.kill = () => {
    killed = true;
  };
  const commands = [];
  child.stdin.on("data", (data) => commands.push(JSON.parse(data.toString())));
  const operations = [],
    pending = [];
  const backend = new NativeBackend(
    (message) => {
      operations.push(message);
      if (message.method === "hover") pending.push(message);
      else
        backend.receive(
          JSON.stringify({
            id: message.id,
            result:
              message.method === "snapshot" ? { width: 440, height: 956 } : {},
          }),
        );
    },
    () => {},
  );
  attachSimulatorPointer(backend, {
    device: { name: "My iPhone" },
    chrome: { top: 18, right: 27, bottom: 18, left: 27 },
    launch: () => child,
  });
  const point = (x) =>
    child.stdout.write(
      JSON.stringify({
        method: "pointer",
        params: {
          inside: true,
          window: { x: 0, y: 0, width: 494, height: 1054 },
          pointer: { x, y: 180 },
        },
      }) + "\n",
    );
  const complete = () => {
    const operation = pending.shift();
    backend.receive(JSON.stringify({ id: operation.id, result: {} }));
  };
  try {
    await backend.request("snapshot");
    point(127);
    assert.equal(pending.length, 0, "Disabled picker must not hit-test");
    await backend.request("inspect", { enabled: true, owner: "first" });
    assert.deepEqual(commands.at(-1), { enabled: true, device: "My iPhone" });
    point(127);
    await observed(() => pending.length === 1);
    assert.deepEqual(pending[0].params, {
      inside: true,
      x: 100,
      y: 100,
      owner: "first",
    });
    point(227);
    point(327);
    assert.equal(
      pending.length,
      1,
      "At most one hover operation may be in flight",
    );
    complete();
    await observed(() => pending.length === 1);
    assert.equal(
      pending[0].params.x,
      300,
      "Intermediate positions must coalesce",
    );
    complete();
    await backend.request("inspect", { enabled: false, owner: "stale" });
    point(227);
    await observed(() => pending.length === 1);
    assert.equal(pending[0].params.owner, "first");
    backend.emit("event", {
      method: "picked",
      params: { owner: "first", node: 18 },
    });
    assert.equal(commands.at(-1).enabled, false);
    point(127);
    complete();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      pending.length,
      0,
      "A late update must not revive a completed pick",
    );
    await backend.request("inspect", { enabled: true, owner: "second" });
    backend.suspend(true);
    assert.equal(commands.at(-1).enabled, false);
    point(127);
    assert.equal(pending.length, 0);
    backend.suspend(false);
    point(127);
    assert.equal(
      pending.length,
      0,
      "Resuming must not silently re-enable picking",
    );
    backend.close();
    assert.equal(killed, true);
    assert.equal(commands.at(-1).enabled, false);
  } finally {
    backend.close();
  }
});
