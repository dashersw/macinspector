// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { connectCDP } from "../src/cdp.mjs";

test(
  "actual AppKit app supports CDP tree, native edits, actions, hit tests and screenshots",
  {
    skip: !process.env.MACINSPECTOR_TEST_URL,
  },
  async () => {
    const client = await connectCDP(process.env.MACINSPECTOR_TEST_URL);
    const find = async (selector) =>
      (await client.send("DOM.querySelector", { nodeId: 1, selector })).nodeId;
    try {
      await client.send("DOM.enable");
      await client.send("CSS.enable");
      await client.send("Runtime.enable");
      await client.send("Debugger.enable");
      const { root } = await client.send("DOM.getDocument", { depth: -1 });
      assert.equal(root.children[0].nodeName, "NSWindow");
      assert.ok(!root.children[0].attributes.includes("class"));
      const nativeCard = await find("NativeShowcase.FlippedView");
      assert.ok(nativeCard);
      assert.equal(await find("NativeShowcase\\.FlippedView"), nativeCard);
      const { node: card } = await client.send("DOM.describeNode", {
        nodeId: nativeCard,
      });
      assert.equal(card.nodeName, "NativeShowcase.FlippedView");
      assert.equal(card.localName, card.nodeName);
      assert.ok(!card.attributes.includes("class"));
      const tile = await find("#animated-tile"),
        field = await find("#message-field"),
        counter = await find("#action-counter");
      assert.ok(tile && field && counter);
      const { node: textField } = await client.send("DOM.describeNode", {
        nodeId: field,
      });
      assert.equal(textField.nodeName, "NSTextField");
      assert.equal(textField.localName, "NSTextField");
      assert.ok(!textField.attributes.includes("class"));
      const checkbox = await find("#remember-checkbox");
      const bounds = (
        await client.send("DOM.getBoxModel", { nodeId: checkbox })
      ).model.content;
      const located = await client.send("DOM.getNodeForLocation", {
        x: (bounds[0] + bounds[2]) / 2,
        y: (bounds[1] + bounds[5]) / 2,
      });
      assert.equal(
        located.backendNodeId,
        checkbox,
        "flipped content coordinates must hit the actual checkbox",
      );
      let style = (
          await client.send("CSS.getInlineStylesForNode", { nodeId: tile })
        ).inlineStyle,
        original = style.cssText;
      try {
        await client.send("CSS.setStyleTexts", {
          edits: [
            {
              styleSheetId: style.styleSheetId,
              range: style.range,
              text: "opacity: 0.5; background: #ff0000; border-radius: 24px;",
            },
          ],
        });
        const computed = (
          await client.send("CSS.getComputedStyleForNode", { nodeId: tile })
        ).computedStyle;
        assert.equal(computed.find((p) => p.name === "opacity").value, "0.5");
        assert.match(
          computed.find((p) => p.name === "background-color").value,
          /255, 0, 0/,
        );
        style = (
          await client.send("CSS.getInlineStylesForNode", { nodeId: tile })
        ).inlineStyle;
        assert.equal(
          style.cssProperties.filter((p) => p.name.startsWith("background"))
            .length,
          1,
        );
        await client.send("CSS.setStyleTexts", {
          edits: [
            {
              styleSheetId: style.styleSheetId,
              range: style.range,
              text: "/* opacity: 0.5; */ background: #ff0000; border-radius: 24px;",
            },
          ],
        });
        assert.equal(
          (
            await client.send("CSS.getComputedStyleForNode", { nodeId: tile })
          ).computedStyle.find((p) => p.name === "opacity").value,
          "1.0",
        );
      } finally {
        style = (
          await client.send("CSS.getInlineStylesForNode", { nodeId: tile })
        ).inlineStyle;
        await client.send("CSS.setStyleTexts", {
          edits: [
            {
              styleSheetId: style.styleSheetId,
              range: style.range,
              text: original,
            },
          ],
        });
      }
      await client.send("DOM.setAttributeValue", {
        nodeId: field,
        name: "value",
        value: "Edited through Chrome DevTools",
      });
      const attrs = Object.fromEntries(
        (
          await client.send("DOM.getAttributes", { nodeId: field })
        ).attributes.reduce(
          (out, _, i, a) => (i % 2 ? out : [...out, [a[i], a[i + 1]]]),
          [],
        ),
      );
      assert.equal(attrs.value, "Edited through Chrome DevTools");
      const countButton = await find("#count-button");
      const { object: actionObject } = await client.send("DOM.resolveNode", {
        nodeId: countButton,
        objectGroup: "event-test",
      });
      const { listeners } = await client.send("DOMDebugger.getEventListeners", {
        objectId: actionObject.objectId,
      });
      const action = listeners.find((l) => l.type === "action");
      assert.ok(action);
      assert.equal(action.backendNodeId, countButton);
      assert.match(action.handler.description, /AppDelegate.increment/);
      const handlerProperties = await client.send("Runtime.getProperties", {
        objectId: action.handler.objectId,
      });
      assert.equal(
        handlerProperties.result.find((p) => p.name === "selector").value.value,
        "increment",
      );
      const { scriptSource: handlerSource } = await client.send(
        "Debugger.getScriptSource",
        {
          scriptId: action.scriptId,
        },
      );
      assert.match(
        handlerSource
          .split("\n")
          .slice(action.lineNumber, action.lineNumber + 3)
          .join("\n"),
        /func increment/,
      );
      const metadata = await client.send("Runtime.evaluate", {
        expression: 'getEventListeners($("#count-button")).action[0]',
        returnByValue: true,
      });
      assert.equal(metadata.result.value.selector, "increment");
      await client.send("Runtime.releaseObjectGroup", {
        objectGroup: "event-test",
      });
      await client.send("Runtime.evaluate", {
        expression: '$("#count-button").click()',
      });
      const count = (
        await client.send("Runtime.evaluate", {
          expression: '$("#action-counter").textContent',
          returnByValue: true,
        })
      ).result.value;
      assert.equal(count, "Actions: 1");
      await client.send("Runtime.evaluate", {
        expression:
          '$("#reset-button").click(); $("#message-field").value="Hello from AppKit"',
      });
      const screenshot = await client.send("Page.captureScreenshot");
      assert.equal(
        Buffer.from(screenshot.data, "base64").subarray(1, 4).toString(),
        "PNG",
      );
      await client.send("Overlay.setInspectMode", { mode: "searchForNode" });
      await client.send("Overlay.setInspectMode", { mode: "none" });
    } finally {
      client.close();
    }
  },
);

test(
  "closed dropdown menu items are inspectable and editable through CDP and activate the native control",
  {
    skip: !process.env.MACINSPECTOR_TEST_URL,
  },
  async () => {
    const client = await connectCDP(process.env.MACINSPECTOR_TEST_URL);
    try {
      await client.send("Runtime.enable");
      const { nodeId: popup } = await client.send("DOM.querySelector", {
        nodeId: 1,
        selector: "#city-menu",
      });
      const { node } = await client.send("DOM.describeNode", {
        nodeId: popup,
        depth: -1,
      });
      const menu = node.children.find((child) => child.nodeName === "NSMenu");
      assert.ok(menu, "A closed dropdown publishes its attached native menu");
      assert.equal(menu.children.length, 4);
      const attributes = (node) =>
        Object.fromEntries(
          node.attributes.reduce(
            (out, _, i, array) =>
              i % 2 ? out : [...out, [array[i], array[i + 1]]],
            [],
          ),
        );
      assert.deepEqual(
        menu.children.map((item) => attributes(item).title),
        ["San Francisco", "London", "Berlin", "Tokyo"],
      );
      assert.ok(menu.children.every((item) => item.nodeName === "NSMenuItem"));
      const original = attributes(node).value;
      const berlin = menu.children.find(
        (item) => attributes(item).title === "Berlin",
      );
      try {
        const titles = await client.send("Runtime.evaluate", {
          expression:
            '$("#city-menu").querySelectorAll("NSMenuItem").map(item => item.getAttribute("title"))',
          returnByValue: true,
        });
        assert.deepEqual(titles.result.value, [
          "San Francisco",
          "London",
          "Berlin",
          "Tokyo",
        ]);
        const preview = await client.send("Runtime.evaluate", {
          expression:
            '$("#city-menu").querySelectorAll("NSMenuItem")[2].click()',
          throwOnSideEffect: true,
        });
        assert.match(
          preview.exceptionDetails.exception.description,
          /^EvalError: Possible side-effect in debug-evaluate/,
        );
        assert.equal(
          attributes(await client.send("DOM.getAttributes", { nodeId: popup }))
            .value,
          original,
        );
        await client.send("Runtime.evaluate", {
          expression:
            '$("#city-menu").querySelectorAll("NSMenuItem")[2].click()',
        });
        const selected = await client.send("DOM.getAttributes", {
          nodeId: popup,
        });
        assert.equal(attributes(selected).value, "Berlin");
        assert.equal(attributes(selected)["selected-index"], "2");
        assert.equal(
          attributes(
            await client.send("DOM.getAttributes", { nodeId: berlin.nodeId }),
          ).selected,
          "true",
        );
        await client.send("DOM.setAttributeValue", {
          nodeId: berlin.nodeId,
          name: "enabled",
          value: "false",
        });
        const rejected = await client.send("Runtime.evaluate", {
          expression:
            '$("#city-menu").querySelectorAll("NSMenuItem")[2].click()',
        });
        assert.match(rejected.exceptionDetails.text, /cannot be activated/);
      } finally {
        await client.send("DOM.setAttributeValue", {
          nodeId: berlin.nodeId,
          name: "enabled",
          value: "true",
        });
        await client.send("DOM.setAttributeValue", {
          nodeId: popup,
          name: "value",
          value: original,
        });
      }
    } finally {
      client.close();
    }
  },
);
