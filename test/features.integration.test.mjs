// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { stat, readFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { discoverConnection, connectDiscovered } from "../src/discovery.mjs";
import { createRelay } from "../src/relay.mjs";
import { connectCDP } from "../src/cdp.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
async function launch() {
  const env = { ...process.env, MACINSPECTOR_NATIVE_PORT: "0" };
  delete env.MACINSPECTOR_TOKEN;
  const app = spawn(path.join(root, ".build/debug/NativeShowcase"), [], {
    stdio: "ignore",
    env,
  });
  let failure;
  app.on("error", (error) => {
    failure = error;
  });
  app.ended = new Promise((resolve) => app.once("close", resolve));
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (failure) throw failure;
    if (app.exitCode !== null)
      throw Error("Native showcase exited before discovery");
    const record = await discoverConnection(app.pid);
    if (record) return { app, record };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  app.kill();
  await app.ended;
  throw Error("SDK discovery timed out");
}
async function stop(app) {
  app.kill("SIGTERM");
  await app.ended;
}

test(
  "SDK discovery, real constraint edits, shared undo and overrides replay after native relaunch",
  { skip: !process.env.MACINSPECTOR_TEST_FEATURES, timeout: 180000 },
  async () => {
    let launched, relay, client;
    try {
      launched = await launch();
      const recordFile = path.join(
        os.homedir(),
        "Library/Application Support/MacInspector/Connections",
        `${launched.app.pid}.json`,
      );
      assert.equal((await stat(recordFile)).mode & 0o077, 0);
      relay = await createRelay({
        backend: await connectDiscovered(launched.record),
        port: 0,
      });
      client = await connectCDP(relay.endpoint);
      const find = async (selector) =>
        (await client.send("DOM.querySelector", { nodeId: 1, selector }))
          .nodeId;
      let tile = await find("#animated-tile"),
        field = await find("#message-field");
      const layout = await client.send("MacInspector.getLayout", {
        node: tile,
      });
      const width = layout.constraints.find(
        (c) => c.identifier === "animated-tile.width",
      );
      assert.ok(width);
      await client.send("MacInspector.setLayout", {
        node: tile,
        constraint: width.id,
        constant: 92,
        priority: 999,
      });
      assert.equal(
        (await client.send("DOM.getBoxModel", { nodeId: tile })).model.width,
        92,
      );
      await client.send("CSS.setStyleSheetText", {
        styleSheetId: `native-${tile}`,
        text: "background: #8b5cf6; border: 3px solid #22c55e; border-radius: 18px;",
      });
      await client.send("DOM.setAttributeValue", {
        nodeId: field,
        name: "value",
        value: "Saved after relaunch",
      });
      const popup = await find("#city-menu");
      const { node: menuTree } = await client.send("DOM.describeNode", {
        nodeId: popup,
        depth: -1,
      });
      const menu = menuTree.children.find(
        (child) => child.nodeName === "NSMenu",
      );
      const secondItem = menu.children[1].nodeId;
      const originalSelection =
        relay.nodes.get(popup).attributes["selected-index"];
      await client.send("DOM.setAttributeValue", {
        nodeId: secondItem,
        name: "selected",
        value: "true",
      });
      await client.send("MacInspector.undo");
      assert.equal(
        relay.nodes.get(popup).attributes["selected-index"],
        originalSelection,
      );
      const fieldEnabled = relay.nodes.get(field).attributes.enabled;
      await client.send("DOM.setAttributeValue", {
        nodeId: field,
        name: "enabled",
        value: "false",
      });
      await client.send("MacInspector.undo");
      assert.equal(relay.nodes.get(field).attributes.enabled, fieldEnabled);
      const saved = await client.send("MacInspector.exportOverrides");
      assert.equal(saved.edits.length, 2);
      await client.send("MacInspector.undo");
      await client.send("MacInspector.undo");
      await client.send("MacInspector.undo");
      assert.equal(
        (
          await client.send("MacInspector.getLayout", { node: tile })
        ).constraints.find((c) => c.id === width.id).constant,
        64,
      );
      assert.deepEqual(
        (await client.send("MacInspector.exportOverrides")).edits,
        [],
      );
      client.close();
      await relay.close();
      relay = null;
      await stop(launched.app);
      assert.equal(await discoverConnection(launched.app.pid), null);
      launched = await launch();
      relay = await createRelay({
        backend: await connectDiscovered(launched.record),
        port: 0,
      });
      client = await connectCDP(relay.endpoint);
      await client.send("MacInspector.applyOverrides", { document: saved });
      tile = await find("#animated-tile");
      field = await find("#message-field");
      assert.equal(
        (await client.send("DOM.getBoxModel", { nodeId: tile })).model.width,
        92,
      );
      assert.equal(
        (
          await client.send("MacInspector.getLayout", { node: tile })
        ).constraints.find((c) => c.identifier === "animated-tile.width")
          .priority,
        999,
      );
      assert.equal(
        relay.nodes.get(field).attributes.value,
        "Saved after relaunch",
      );
      assert.equal(relay.nodes.get(tile).styles["border-width"], "3.0px");
      assert.match(
        (await client.send("MacInspector.exportSwift")).source,
        /animated-tile.width/,
      );
    } finally {
      client?.close();
      await relay?.close();
      if (launched) await stop(launched.app);
    }
  },
);

test(
  "CLI attach discovers the SDK, falls back to a free relay port and leaves its target running",
  { skip: !process.env.MACINSPECTOR_TEST_FEATURES, timeout: 120000 },
  async () => {
    const launched = await launch();
    let child, ended;
    const savedPath = path.join(
      root,
      ".build/macinspector-test-overrides.json",
    );
    await assert.rejects(stat(savedPath), { code: "ENOENT" });
    // This fixture occupies a port; it must not retain reconnecting inspector
    // sockets and prevent server.close() from completing during cleanup.
    const occupied = net.createServer((socket) => socket.destroy());
    await new Promise((resolve, reject) => {
      occupied.once("error", (error) =>
        error.code === "EADDRINUSE" ? resolve() : reject(error),
      );
      occupied.listen(9333, "127.0.0.1", resolve);
    });
    try {
      child = spawn(
        process.execPath,
        [
          "bin/macinspector.mjs",
          "attach",
          "--pid",
          String(launched.app.pid),
          "--no-open",
          "--save-overrides",
          savedPath,
        ],
        { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
      );
      ended = new Promise((resolve) => child.once("close", resolve));
      let output = "",
        failure;
      child.on("error", (error) => {
        failure = error;
      });
      child.stdout.on("data", (data) => {
        output += data;
      });
      child.stderr.on("data", (data) => {
        output += data;
      });
      const deadline = Date.now() + 60000;
      while (!output.includes("Chrome: ")) {
        if (failure) throw failure;
        if (child.exitCode !== null) throw Error(output);
        if (Date.now() >= deadline)
          throw Error("CLI attach timed out: " + output);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.match(output, /Backend: appkit/);
      assert.match(output, /Capabilities: .*layout/);
      const url = output.match(/Chrome: (\S+)/)[1];
      assert.notEqual(new URL(url).port, "9333");
      const state = await (await fetch(new URL("/state", url))).json();
      const tile = state.nodes.find(
        (node) => node.attributes.id === "animated-tile",
      ).id;
      const command = async (method, params) => {
        const response = await fetch(new URL("/native/command", url), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ method, params }),
        });
        const value = await response.json();
        assert.equal(response.status, 200, value.error);
        return value;
      };
      const layout = await command("getLayout", { node: tile });
      const width = layout.constraints.find(
        (c) => c.identifier === "animated-tile.width",
      );
      await command("setLayout", {
        node: tile,
        constraint: width.id,
        constant: 91,
      });
      child.kill("SIGTERM");
      await ended;
      child = null;
      const saved = JSON.parse(await readFile(savedPath, "utf8"));
      assert.equal(saved.edits[0].constraints[0].constant, 91);
      assert.equal((await stat(savedPath)).mode & 0o077, 0);
      assert.doesNotThrow(() => process.kill(launched.app.pid, 0));
      const backend = await connectDiscovered(launched.record);
      assert.equal((await backend.request("snapshot")).pid, launched.app.pid);
      backend.close();
    } finally {
      child?.kill("SIGTERM");
      await ended;
      await unlink(savedPath).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      if (occupied.listening)
        await new Promise((resolve) => occupied.close(resolve));
      await stop(launched.app);
    }
  },
);
