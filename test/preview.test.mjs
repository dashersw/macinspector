// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRelay } from "../src/relay.mjs";

test("concurrent previews share one native capture and reuse recently captured pixels", async () => {
  const backend = new EventEmitter();
  let captures = 0;
  backend.close = () => {};
  backend.request = async (method) => {
    if (method === "snapshot")
      return {
        root: 2,
        title: "Preview fixture",
        width: 100,
        height: 100,
        backend: "appkit",
        capabilities: ["screenshot"],
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
            width: 100,
            height: 100,
            styles: {},
          },
        ],
      };
    if (method === "screenshot") {
      captures++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { data: Buffer.from("native pixels").toString("base64") };
    }
    return {};
  };
  const relay = await createRelay({ backend, port: 0 });
  try {
    const images = await Promise.all([
      fetch(relay.url + "preview.png"),
      fetch(relay.url + "preview.png"),
    ]);
    assert.equal(captures, 1);
    for (const image of images)
      assert.equal(await image.text(), "native pixels");
    await fetch(relay.url + "preview.png");
    assert.equal(captures, 1);
  } finally {
    await relay.close();
  }
});
