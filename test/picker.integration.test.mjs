// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { connectCDP } from "../src/cdp.mjs";

test(
  "UIKit picking selects noninteractive labels and keeps their styles after reconnecting",
  { skip: !process.env.MACINSPECTOR_TEST_IOS_URL, timeout: 30000 },
  async () => {
    const url = process.env.MACINSPECTOR_TEST_IOS_URL;
    let client = await connectCDP(url);
    const findLabel = async () => {
      const { root } = await client.send("DOM.getDocument", { depth: -1 });
      const find = (node) => {
        if (
          node.nodeName === "UILabel" &&
          node.children?.some((child) => child.nodeValue === "Animations")
        )
          return node;
        for (const child of node.children || []) {
          const found = find(child);
          if (found) return found;
        }
      };
      const label = find(root);
      assert.ok(label, "The showcase must contain its Animations label");
      return label;
    };
    const styles = async (nodeId) =>
      (await client.send("CSS.getInlineStylesForNode", { nodeId })).inlineStyle;
    try {
      await client.send("CSS.enable");
      const label = await findLabel();
      const { model } = await client.send("DOM.getBoxModel", {
        nodeId: label.nodeId,
      });
      const point = {
        x: (model.content[0] + model.content[2]) / 2,
        y: (model.content[1] + model.content[5]) / 2,
      };
      const expectLabel = async () => {
        const picked = await client.send("DOM.getNodeForLocation", point);
        assert.equal(
          picked.backendNodeId,
          label.nodeId,
          "Inspection must select the visible label rather than its touch-enabled parent",
        );
        return styles(picked.nodeId);
      };
      const original = await expectLabel();
      assert.ok(original.cssProperties.some((p) => p.name === "color"));
      await client.send("Overlay.setInspectMode", { mode: "searchForNode" });
      await client.send("Overlay.highlightNode", { nodeId: label.nodeId });
      assert.equal(
        (await expectLabel()).cssText,
        original.cssText,
        "Picker and highlight overlays must not obscure the inspected label",
      );
      await client.send("Overlay.setInspectMode", { mode: "none" });
      await client.send("Overlay.hideHighlight");
      client.close();
      client = await connectCDP(url);
      await client.send("CSS.enable");
      const reloaded = await findLabel();
      assert.equal(reloaded.nodeId, label.nodeId);
      assert.equal(
        (await styles(reloaded.nodeId)).cssText,
        original.cssText,
        "Refreshing DevTools must retain the label's authored and native appearance",
      );
      await expectLabel();
    } finally {
      await client.send("Overlay.setInspectMode", { mode: "none" });
      await client.send("Overlay.hideHighlight");
      client.close();
    }
  },
);
