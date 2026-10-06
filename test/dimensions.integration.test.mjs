// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { connectCDP } from "../src/cdp.mjs";

test(
  "UIKit label size resets restore intrinsic sizing as its font changes",
  { skip: !process.env.MACINSPECTOR_TEST_IOS_URL, timeout: 30000 },
  async () => {
    const client = await connectCDP(process.env.MACINSPECTOR_TEST_IOS_URL);
    let label, original;
    const set = async (text) => {
      const current = (
        await client.send("CSS.getInlineStylesForNode", { nodeId: label })
      ).inlineStyle;
      await client.send("CSS.setStyleTexts", {
        edits: [
          { styleSheetId: current.styleSheetId, range: current.range, text },
        ],
      });
    };
    const height = async () =>
      (await client.send("DOM.getBoxModel", { nodeId: label })).model.height;
    try {
      const { root } = await client.send("DOM.getDocument", { depth: -1 });
      const find = (node) => {
        if (
          node.nodeName === "UILabel" &&
          node.children?.some((n) => n.nodeValue === "Animations")
        )
          return node;
        for (const child of node.children || []) {
          const found = find(child);
          if (found) return found;
        }
      };
      label = find(root)?.nodeId;
      assert.ok(label);
      original = (
        await client.send("CSS.getInlineStylesForNode", { nodeId: label })
      ).inlineStyle.cssText;
      const baseline = await height();
      await set(`${original} height: 60px;`);
      assert.equal(await height(), 60);
      await set(`${original} font-size: 24px; height: 60px;`);
      assert.equal(await height(), 60);
      await set(`${original} font-size: 24px; /* height: 60px; */`);
      const intrinsic = await height();
      assert.ok(
        intrinsic > baseline && intrinsic < 60,
        "Disabling a size must restore live intrinsic sizing",
      );
      await set(`${original} font-size: 24px;`);
      assert.equal(await height(), intrinsic);
      await set(original);
      assert.equal(await height(), baseline);
    } finally {
      if (label && original !== undefined) await set(original);
      client.close();
    }
  },
);

for (const [platform, variable] of [
  ["AppKit", "MACINSPECTOR_TEST_URL"],
  ["UIKit", "MACINSPECTOR_TEST_IOS_URL"],
])
  test(
    `${platform} sizes use reversible native constraints with stable identity and history`,
    { skip: !process.env[variable], timeout: 60000 },
    async () => {
      let client = await connectCDP(process.env[variable]);
      let tile, original;
      const style = async (id) =>
        (await client.send("CSS.getInlineStylesForNode", { nodeId: id }))
          .inlineStyle;
      const set = async (text, id = tile) => {
        const current = await style(id);
        return client.send("CSS.setStyleTexts", {
          edits: [
            { styleSheetId: current.styleSheetId, range: current.range, text },
          ],
        });
      };
      const size = async () =>
        (await client.send("DOM.getBoxModel", { nodeId: tile })).model;
      const layout = async () =>
        client.send("MacInspector.getLayout", { node: tile });
      const owned = (constraints) =>
        constraints.filter(
          (c) => c.active && c.identifier.startsWith("MacInspector."),
        );
      try {
        await client.send("CSS.enable");
        await client.send("DOM.getDocument", { depth: -1 });
        tile = (
          await client.send("DOM.querySelector", {
            nodeId: 1,
            selector: "#animated-tile",
          })
        ).nodeId;
        assert.ok(tile);
        original = (await style(tile)).cssText;
        const baseline = await size();
        const originalConstraints = (await layout()).constraints.filter(
          (c) =>
            c.active &&
            c.first === tile &&
            c.second === 0 &&
            c.relation === "=" &&
            ["width", "height"].includes(c.firstAttribute),
        );
        await set(`${original} width: 100px; height: 96px;`);
        assert.equal((await size()).width, 100);
        assert.equal((await size()).height, 96);
        const updated = await layout();
        const identities = owned(updated.constraints)
          .map((c) => c.id)
          .sort();
        assert.equal(identities.length, 2);
        assert.ok(owned(updated.constraints).every((c) => c.priority === 999));
        for (const original of originalConstraints) {
          const suspended = updated.constraints.find(
            (c) => c.id === original.id,
          );
          assert.ok(suspended && !suspended.active);
          assert.equal(suspended.constant, original.constant);
        }
        for (let width = 101; width <= 120; width++) {
          await set(`${original} width: ${width}px; height: 96px;`);
          assert.equal((await size()).width, width);
          assert.deepEqual(
            owned((await layout()).constraints)
              .map((c) => c.id)
              .sort(),
            identities,
          );
        }
        await assert.rejects(
          set(`${original} width: 50%; height: 96px;`),
          /finite size/,
        );
        assert.equal((await size()).width, 120);
        await set(`${original} /* width: 120px; */ height: 96px;`);
        assert.equal((await size()).width, baseline.width);
        assert.equal((await size()).height, 96);
        await client.send("MacInspector.undo");
        assert.equal((await size()).width, 120);
        await client.send("MacInspector.redo");
        assert.equal((await size()).width, baseline.width);
        await set(`${original} height: auto;`);
        assert.equal((await size()).height, baseline.height);
        assert.equal(
          (await style(tile)).cssProperties.find((p) => p.name === "height")
            .value,
          "auto",
        );
        const computed = await client.send("CSS.getComputedStyleForNode", {
          nodeId: tile,
        });
        assert.equal(
          parseFloat(
            computed.computedStyle.find((p) => p.name === "height").value,
          ),
          baseline.height,
        );
        const consoleHeight = await client.send("Runtime.evaluate", {
          expression: 'getComputedStyle($("#animated-tile")).height',
          returnByValue: true,
        });
        assert.equal(parseFloat(consoleHeight.result.value), baseline.height);
        await set(`${original} width: 110px; height: 90px;`);
        const exported = await client.send("MacInspector.exportOverrides");
        const edit = exported.edits.find(
          (e) => e.target.id === "animated-tile",
        );
        assert.equal(
          edit.styles.find((p) => p.name === "width").value,
          "110px",
        );
        assert.equal(
          edit.styles.find((p) => p.name === "height").value,
          "90px",
        );
        client.close();
        client = await connectCDP(process.env[variable]);
        await client.send("CSS.enable");
        assert.equal(
          (await style(tile)).cssProperties.find((p) => p.name === "height")
            .value,
          "90px",
        );
        assert.equal((await size()).height, 90);
        if (platform === "UIKit") {
          const stack = (
            await client.send("DOM.querySelector", {
              nodeId: 1,
              selector: "#showcase",
            })
          ).nodeId;
          const before = (await style(stack)).cssText;
          await assert.rejects(
            set(`${before} width: 100px; opacity: 0.5;`, stack),
            /Auto Layout cannot apply width/,
          );
          assert.equal((await style(stack)).cssText, before);
        }
      } finally {
        if (tile && original !== undefined) await set(original);
        client.close();
      }
    },
  );
