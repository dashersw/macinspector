// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { createRelay } from "../src/relay.mjs";
import { patchFrontend } from "../frontend/patches.mjs";
import { frontendManifest } from "../src/frontend.mjs";

test("pinned frontend highlights actual Swift syntax and rejects changed upstream patches", async () => {
  const pin = JSON.parse(
    await readFile(new URL("../frontend/pin.json", import.meta.url)),
  );
  assert.throws(
    () =>
      patchFrontend("core/sdk/sdk.js", Buffer.from("changed upstream"), pin),
    /integrity mismatch/,
  );
  const { CodeHighlighter } =
    await import("../.build/devtools/ui/components/code_highlighter/code_highlighter.js");
  const highlighter = await CodeHighlighter.create(
    "func increment() { let count: Int = 1; return nil }",
    "text/x-swift",
  );
  const tokens = [];
  highlighter.highlight((text, style) => tokens.push({ text, style }));
  assert.ok(
    tokens.some((t) => t.text === "func" && t.style.includes("token-keyword")),
  );
  assert.ok(
    tokens.some((t) => t.text === "let" && t.style.includes("token-keyword")),
  );
  assert.ok(
    tokens.some((t) => t.text === "nil" && t.style.includes("token-atom")),
  );
  const javascript = await CodeHighlighter.create(
    "const value = 1;",
    "text/javascript",
  );
  const js = [];
  javascript.highlight((text, style) => js.push({ text, style }));
  assert.ok(
    js.some((t) => t.text === "const" && t.style.includes("token-keyword")),
  );
});
test("discovery and preview use bundled DevTools, with a strict asset allowlist", async () => {
  class Backend extends EventEmitter {
    async request(method) {
      if (method === "snapshot")
        return {
          root: 2,
          width: 500,
          height: 300,
          title: "Native frontend fixture",
          backend: "appkit",
          capabilities: [],
          nodes: [
            {
              id: 2,
              parent: 1,
              tag: "ns-window",
              text: "",
              attributes: {},
              children: [],
              x: 0,
              y: 0,
              width: 500,
              height: 300,
              styles: {},
            },
          ],
        };
      return {};
    }
    close() {}
  }
  const relay = await createRelay({ backend: new Backend(), port: 0 });
  try {
    const response = await fetch(relay.frontend);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    assert.match(
      await response.text(),
      /entrypoints\/devtools_app\/devtools_app.js/,
    );
    const targets = await (
      await fetch(new URL("/json/list", relay.url))
    ).json();
    assert.equal(targets[0].devtoolsFrontendUrl, relay.frontend);
    const script = await fetch(new URL("/devtools/native/swift.js", relay.url));
    assert.match(script.headers.get("content-type"), /text\/javascript/);
    assert.match(await script.text(), /export const swift/);
    assert.equal(
      (await fetch(new URL("/devtools/not-an-asset.js", relay.url))).status,
      404,
    );
    const traversal = await new Promise((resolve, reject) => {
      const request = http.get(
        new URL(relay.url),
        { path: "/devtools/%2e%2e%2fPackage.swift" },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode));
        },
      );
      request.on("error", reject);
    });
    assert.equal(traversal, 403);
    assert.ok(Object.keys((await frontendManifest()).files).length > 300);
  } finally {
    await relay.close();
  }
});
