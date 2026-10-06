// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { connectAppKit } from "../src/backends.mjs";
import { connectCDP } from "../src/cdp.mjs";
import { createRelay } from "../src/relay.mjs";

test(
  "compiled AppKit showcase supports expanded styles through CDP, toggling and rollback",
  {
    skip: !process.env.MACINSPECTOR_TEST_STYLES,
    timeout: 60000,
  },
  async () => {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    const token = randomBytes(32).toString("hex");
    const child = spawn(
      fileURLToPath(new URL("../.build/debug/NativeShowcase", import.meta.url)),
      [],
      {
        env: {
          ...process.env,
          MACINSPECTOR_NATIVE_PORT: String(port),
          MACINSPECTOR_TOKEN: token,
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let output = "";
    let failure;
    child.stderr.on("data", (chunk) => {
      output = (output + chunk).slice(-4096);
    });
    child.on("error", (error) => {
      failure = error;
    });
    const exited = new Promise((resolve) => child.once("close", resolve));
    let backend, relay, client;
    try {
      const deadline = Date.now() + 15000;
      while (!backend) {
        if (failure) throw failure;
        if (child.exitCode != null)
          throw Error(`Native showcase exited: ${output}`);
        try {
          backend = await connectAppKit({ port, token });
          await backend.request("snapshot");
        } catch (error) {
          backend?.close();
          backend = null;
          if (Date.now() >= deadline) throw error;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      relay = await createRelay({ backend, port: 0 });
      client = await connectCDP(relay.endpoint);
      await client.send("DOM.getDocument", { depth: -1 });
      await client.send("CSS.enable");
      const find = async (selector) =>
        (await client.send("DOM.querySelector", { nodeId: 1, selector }))
          .nodeId;
      const style = async (nodeId) =>
        (await client.send("CSS.getInlineStylesForNode", { nodeId }))
          .inlineStyle;
      const edit = async (nodeId, text) => {
        const s = await style(nodeId);
        await client.send("CSS.setStyleTexts", {
          edits: [{ styleSheetId: s.styleSheetId, range: s.range, text }],
        });
      };
      const computed = async (nodeId) =>
        Object.fromEntries(
          (
            await client.send("CSS.getComputedStyleForNode", { nodeId })
          ).computedStyle.map((p) => [p.name, p.value]),
        );
      const tile = await find("#animated-tile"),
        field = await find("#action-counter");
      assert.ok(tile && field);
      assert.equal(relay.snapshot.styleProperties.length, 47);
      const oldTile = (await style(tile)).cssText;
      const oldField = (await style(field)).cssText;
      const originalBackground = (await computed(tile))["background-color"];
      const background = async () =>
        (await style(tile)).cssProperties.find((p) => p.name === "background");
      const replaceBackground = async (text) =>
        client.send("CSS.setStyleTexts", {
          edits: [
            {
              styleSheetId: `native-${tile}`,
              range: (await background()).range,
              text,
            },
          ],
        });
      await edit(tile, `${oldTile} background: red;`);
      const redBackground = (await computed(tile))["background-color"];
      assert.notEqual(redBackground, originalBackground);
      await replaceBackground("/* background: red; */");
      assert.equal(
        (await computed(tile))["background-color"],
        originalBackground,
      );
      await relay.refresh();
      assert.equal((await background()).disabled, true);
      await replaceBackground("background: red;");
      assert.equal((await computed(tile))["background-color"], redBackground);
      await replaceBackground("");
      assert.equal(
        (await computed(tile))["background-color"],
        originalBackground,
      );
      await client.send("DOM.undo");
      assert.equal((await computed(tile))["background-color"], redBackground);
      await client.send("DOM.redo");
      assert.equal(
        (await computed(tile))["background-color"],
        originalBackground,
      );
      await edit(
        tile,
        "border: 3px solid red; box-shadow: 4px 5px 10px rgba(0, 0, 0, 0.4); transform: rotate(10deg); overflow: hidden; z-index: 3;",
      );
      const tileState = await computed(tile);
      assert.equal(tileState["border-width"], "3.0px");
      assert.equal(tileState["overflow"], "hidden");
      assert.equal(tileState["z-index"], "3");
      assert.match(tileState["box-shadow"], /^4.0px 5.0px 10.0px/);
      assert.notEqual(tileState.transform, "none");
      const good = (await style(tile)).cssText;
      await assert.rejects(
        edit(tile, "border: 9px solid blue; transform: rotate(NaNdeg);"),
        /finite|numeric/,
      );
      assert.equal((await style(tile)).cssText, good);
      assert.equal((await computed(tile))["border-width"], "3.0px");
      await edit(
        tile,
        "/* border: 3px solid red; */ box-shadow: 4px 5px 10px rgba(0, 0, 0, 0.4); transform: rotate(10deg); overflow: hidden; z-index: 3;",
      );
      await relay.refresh();
      assert.ok(
        (await style(tile)).cssProperties.find((p) => p.name === "border")
          .disabled,
      );
      assert.match((await computed(tile))["box-shadow"], /^4.0px/);
      await edit(
        field,
        "font-family: Helvetica; font-size: 22px; font-weight: 700; font-style: italic; letter-spacing: 2px; text-decoration: underline dashed blue; line-height: 1.5;",
      );
      const fieldState = await computed(field);
      assert.equal(fieldState["font-size"], "22.0px");
      assert.equal(fieldState["font-weight"], "700");
      assert.equal(fieldState["font-style"], "italic");
      assert.equal(fieldState["text-decoration-line"], "underline");
      assert.equal(fieldState["text-decoration-style"], "dashed");
      assert.equal(fieldState["line-height"], "33.0px");
      await edit(
        field,
        "font-family: Helvetica; /* font-size: 22px; */ font-weight: 700; font-style: italic; letter-spacing: 2px; text-decoration: underline dashed blue; line-height: 1.5;",
      );
      await relay.refresh();
      assert.equal((await computed(field))["font-style"], "italic");
      assert.ok(
        (await style(field)).cssProperties.find((p) => p.name === "font-size")
          .disabled,
      );
      await edit(tile, oldTile);
      await edit(field, oldField);
    } finally {
      client?.close();
      if (relay) await relay.close();
      else backend?.close();
      child.kill("SIGTERM");
      await exited;
    }
  },
);
