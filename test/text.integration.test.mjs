// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { connectCDP } from "../src/cdp.mjs";

for (const [platform, variable, textView] of [
  ["AppKit", "MACINSPECTOR_TEST_URL", "NSTextView"],
  ["UIKit", "MACINSPECTOR_TEST_IOS_URL", "UITextView"],
])
  test(
    `${platform} publishes and edits live native text children without breaking styles or input values`,
    {
      skip: !process.env[variable],
      timeout: 30000,
    },
    async () => {
      const client = await connectCDP(process.env[variable]),
        events = [];
      client.onEvent((event) => events.push(event));
      const find = async (selector) =>
        (await client.send("DOM.querySelector", { nodeId: 1, selector }))
          .nodeId;
      const describe = async (id) =>
        (await client.send("DOM.describeNode", { nodeId: id, depth: -1 })).node;
      let notes, original, button, originalButton;
      try {
        await client.send("DOM.getDocument", { depth: -1 });
        const counter = await find("#action-counter"),
          input = await find("#message-field");
        assert.ok(counter && input);
        const counterNode = await describe(counter);
        const counterText = counterNode.children.find(
          (child) => child.nodeType === 3,
        );
        assert.ok(
          counterText,
          "Read-only labels must contain text instead of value/text attributes",
        );
        assert.ok(
          !counterNode.attributes.includes("value") &&
            !counterNode.attributes.includes("text"),
        );
        assert.ok(
          (await describe(input)).attributes.includes("value"),
          "Single-line input values remain attributes",
        );
        button = await find("#count-button");
        const buttonNode = await describe(button);
        originalButton =
          buttonNode.attributes[buttonNode.attributes.indexOf("title") + 1];
        const textNodes = (node) =>
          node.nodeType === 3
            ? [node]
            : (node.children || []).flatMap(textNodes);
        const buttonText = textNodes(buttonNode).find(
          (node) => node.nodeValue === originalButton,
        );
        assert.ok(buttonText);
        await client.send("DOM.setNodeValue", {
          nodeId: buttonText.nodeId,
          value: "Edited native button",
        });
        const title = await client.send("Runtime.evaluate", {
          expression: '$("#count-button").getAttribute("title")',
          returnByValue: true,
        });
        assert.equal(
          title.result.value,
          "Edited native button",
          "An internal title label must edit its owning button",
        );
        assert.equal(
          textNodes(await describe(button)).filter(
            (node) => node.nodeValue === "Edited native button",
          ).length,
          1,
          "Native button text appears once",
        );
        await client.send("DOM.setAttributeValue", {
          nodeId: button,
          name: "title",
          value: originalButton,
        });
        notes = await find("#notes-field");
        const editor = await describe(notes);
        assert.equal(editor.nodeName, textView);
        const text = editor.children.find((child) => child.nodeType === 3);
        assert.ok(text);
        original = text.nodeValue;
        await client.send("DOM.setNodeValue", {
          nodeId: text.nodeId,
          value: "Edited through DevTools\nSecond line",
        });
        assert.equal(
          (await describe(text.nodeId)).nodeValue,
          "Edited through DevTools\nSecond line",
        );
        const native = await client.send("Runtime.evaluate", {
          expression: '$("#notes-field").textContent',
          returnByValue: true,
        });
        assert.equal(
          native.result.value,
          "Edited through DevTools\nSecond line",
        );
        await client.send("DOM.undo");
        assert.equal((await describe(text.nodeId)).nodeValue, original);
        await client.send("DOM.redo");
        assert.equal(
          (await describe(text.nodeId)).nodeValue,
          "Edited through DevTools\nSecond line",
        );
        await client.send("Overlay.highlightNode", { nodeId: text.nodeId });
        await client.send("Overlay.hideHighlight");
        const styles = await client.send("CSS.getInlineStylesForNode", {
          nodeId: text.nodeId,
        });
        assert.equal(styles.inlineStyle.styleSheetId, `native-${notes}`);
        assert.ok(styles.inlineStyle.cssProperties.length);
        await client.send("DOM.getAttributes", { nodeId: notes });
        assert.ok(
          events.some(
            (event) =>
              event.method === "DOM.characterDataModified" &&
              event.params.nodeId === text.nodeId,
          ),
        );
        assert.ok(
          !events.some((event) => event.method === "DOM.documentUpdated"),
          "Editing text must preserve the live document",
        );
      } finally {
        if (button && originalButton !== undefined)
          await client.send("DOM.setAttributeValue", {
            nodeId: button,
            name: "title",
            value: originalButton,
          });
        if (notes && original !== undefined) {
          const text = (await describe(notes)).children.find(
            (child) => child.nodeType === 3,
          );
          await client.send("DOM.setNodeValue", {
            nodeId: text.nodeId,
            value: original,
          });
        }
        client.close();
      }
    },
  );
