// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { connectCDP } from "../src/cdp.mjs";

async function observed(predicate, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw Error("SwiftUI state was not observed");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

for (const [platform, variable] of [
  ["macOS", "MACINSPECTOR_TEST_SWIFTUI_URL"],
  ["iOS", "MACINSPECTOR_TEST_SWIFTUI_IOS_URL"],
]) {
  test(
    `${platform} SwiftUI writes bindings, follows redraws, restores edits and handles mount/unmount`,
    { skip: !process.env[variable], timeout: 90000 },
    async () => {
      const endpoint = process.env[variable];
      const base = new URL(endpoint);
      base.protocol = "http:";
      base.pathname = "/state";
      const client = await connectCDP(endpoint);
      const state = async () => (await (await fetch(base)).json()).nodes;
      const find = async (selector) =>
        (await client.send("DOM.querySelector", { nodeId: 1, selector }))
          .nodeId;
      const value = async (expression) => {
        const result = await client.send("Runtime.evaluate", {
          expression,
          returnByValue: true,
        });
        assert.equal(
          result.exceptionDetails,
          undefined,
          JSON.stringify(result.exceptionDetails),
        );
        return result.result.value;
      };
      const set = (nodeId, name, value) =>
        client.send("DOM.setAttributeValue", {
          nodeId,
          name,
          value: String(value),
        });
      const css = async (nodeId) =>
        (await client.send("CSS.getInlineStylesForNode", { nodeId }))
          .inlineStyle.cssText;
      let originals, tile, title, field, enabled, choice;
      try {
        await client.send("DOM.getDocument", { depth: -1 });
        await client.send("CSS.enable");
        tile = await find("#animated-tile");
        title = await find("#swiftui-title");
        field = await find("#message-field");
        enabled = await find("#enabled-switch");
        choice = await find("#city-menu");
        assert.ok(
          tile && title && field && enabled && choice,
          "All SwiftUI demo controls must be registered",
        );
        const initial = await state();
        assert.ok(initial.some((n) => n.tag === "SwiftUI.Text"));
        assert.ok(!initial.some((n) => /Hosting|InspectorProbe/.test(n.tag)));
        const cards = [
          "text-card",
          "toggle-card",
          "values-card",
          "pickers-card",
          "motion-card",
          "actions-card",
        ].map((id) => initial.find((n) => n.attributes.id === id));
        assert.ok(
          cards.every(Boolean),
          "All six showcase cards must be mounted",
        );
        for (const card of cards) {
          assert.ok(
            Math.abs(card.width - cards[0].width) < 1,
            "Cards fill equal-width columns",
          );
        }
        if (platform === "macOS") {
          for (let row = 0; row < cards.length; row += 2) {
            assert.equal(
              cards[row].y,
              cards[row + 1].y,
              "Cards align at each row's top",
            );
            assert.equal(
              cards[row].height,
              cards[row + 1].height,
              "Cards fill each row's height",
            );
          }
        }
        originals = {
          tile: await css(tile),
          title: await value('$("#swiftui-title").textContent'),
          field: await value('$("#message-field").getAttribute("value")'),
          enabled: await value('$("#enabled-switch").getAttribute("checked")'),
          choice: await value('$("#city-menu").getAttribute("value")'),
        };
        await client.send("Runtime.evaluate", {
          expression: '$("#reset-button").click()',
        });
        const titleText = (
          await client.send("DOM.describeNode", { nodeId: title, depth: -1 })
        ).node.children.find((n) => n.nodeType === 3);
        await client.send("DOM.setNodeValue", {
          nodeId: titleText.nodeId,
          value: "Edited SwiftUI title",
        });
        assert.equal(
          await value('$("#swiftui-title").textContent'),
          "Edited SwiftUI title",
        );
        await set(field, "value", "Edited through CDP");
        await set(choice, "value", "Berlin");
        await set(enabled, "checked", "false");
        await observed(
          async () =>
            (await state()).find((n) => n.attributes.id === "animate-button")
              .attributes.enabled === "false",
        );
        await assert.rejects(
          set(choice, "value", "Invalid city"),
          /Choose one of/,
        );
        await set(enabled, "checked", "true");
        const original = await css(tile);
        await client.send("CSS.setStyleSheetText", {
          styleSheetId: `native-${tile}`,
          text: original
            .replace(/width:[^;]+/, "width: 110px")
            .replace(/background-color:[^;]+/, "background: red"),
        });
        await observed(
          async () =>
            (await client.send("DOM.getBoxModel", { nodeId: tile })).model
              .width === 110,
        );
        assert.equal(
          (await state()).find((n) => n.id === tile).styles["background-color"],
          "rgba(255, 0, 0, 1.0)",
        );
        await client.send("MacInspector.undo");
        await observed(
          async () =>
            (await client.send("DOM.getBoxModel", { nodeId: tile })).model
              .width === 64,
        );
        await client.send("MacInspector.redo");
        await observed(
          async () =>
            (await client.send("DOM.getBoxModel", { nodeId: tile })).model
              .width === 110,
        );
        await client.send("MacInspector.undo");
        await assert.rejects(
          client.send("CSS.setStyleSheetText", {
            styleSheetId: `native-${tile}`,
            text: original + " position: absolute;",
          }),
          /registered binding|Unsupported native style/,
        );
        await value('$("#animate-button").click()');
        await observed(async () =>
          (await css(tile)).includes("border-radius: 36.0px"),
        );
        assert.equal(
          (
            await client.send("DOM.querySelector", {
              nodeId: 1,
              selector: "#animated-tile",
            })
          ).nodeId,
          tile,
          "Identity survives redraws",
        );
        const animated = await css(tile);
        await client.send("CSS.setStyleSheetText", {
          styleSheetId: `native-${tile}`,
          text: animated + " opacity: 0.3;",
        });
        await observed(
          async () =>
            (await value('$("#opacity-slider").getAttribute("value")')) ===
            "0.3",
        );
        await client.send("CSS.setStyleSheetText", {
          styleSheetId: `native-${tile}`,
          text: animated.replace(/opacity:[^;]+;/, "") + " /* opacity: 0.3; */",
        });
        await observed(
          async () =>
            (await value('$("#opacity-slider").getAttribute("value")')) ===
            "1.0",
        );
        assert.match(await css(tile), /\/\* opacity: 0.3; \*\//);
        await client.send("CSS.setStyleSheetText", {
          styleSheetId: `native-${tile}`,
          text: animated + " opacity: 0.3;",
        });
        await client.send("CSS.setStyleSheetText", {
          styleSheetId: `native-${tile}`,
          text: animated.replace(/opacity:[^;]+;/, ""),
        });
        await observed(
          async () =>
            (await value('$("#opacity-slider").getAttribute("value")')) ===
            "1.0",
        );
        const node = (await state()).find((n) => n.id === enabled);
        const locate = await client.send("DOM.getNodeForLocation", {
          x: Math.floor(node.x + node.width / 2),
          y: Math.floor(node.y + node.height / 2),
        });
        assert.equal(locate.nodeId, enabled);
        await client.send("Overlay.highlightNode", { nodeId: enabled });
        await client.send("Overlay.hideHighlight");
        await set(enabled, "checked", "false");
        await observed(async () => (await find("#paused-description")) > 0);
        const detached = await find("#paused-description");
        await set(enabled, "checked", "true");
        await observed(async () => (await find("#paused-description")) === 0);
        await assert.rejects(
          client.send("DOM.setAttributeValue", {
            nodeId: detached,
            name: "text",
            value: "Stale",
          }),
          /Unknown|detached|Stale/,
        );
        const reload = await connectCDP(endpoint);
        try {
          await reload.send("DOM.getDocument");
          assert.match(
            (await reload.send("CSS.getInlineStylesForNode", { nodeId: title }))
              .inlineStyle.cssText,
            /font-size/,
          );
          assert.equal(
            await value('$("#message-field").getAttribute("value")'),
            "Edited through CDP",
          );
        } finally {
          reload.close();
        }
        await assert.rejects(
          client.send("MacInspector.getLayout", { node: tile }),
          /SwiftUI uses its own layout/,
        );
        const { data } = await client.send("Page.captureScreenshot");
        const image = Buffer.from(data, "base64");
        assert.deepEqual(
          image.subarray(0, 8),
          Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        );
        const frame = await (await fetch(base)).json();
        assert.equal(image.readUInt32BE(16), Math.round(frame.width));
        assert.equal(image.readUInt32BE(20), Math.round(frame.height));
      } finally {
        if (originals) {
          await value('$("#reset-button").click()');
          await set(title, "text", originals.title);
          await set(field, "value", originals.field);
          await set(enabled, "checked", originals.enabled);
          await set(choice, "value", originals.choice);
        }
        client.close();
      }
    },
  );

  test(
    `${platform} SwiftUI source breakpoints and step-in/over/out run real native code`,
    { skip: !process.env[variable], timeout: 120000 },
    async () => {
      const client = await connectCDP(process.env[variable]),
        events = [];
      client.onEvent((event) => events.push(event));
      let breakpoint, click;
      try {
        await client.send("DOM.getDocument", { depth: -1 });
        const countButton = (
          await client.send("DOM.querySelector", {
            nodeId: 1,
            selector: "#count-button",
          })
        ).nodeId;
        assert.ok(countButton, "The demo action control must be mounted");
        await client.send("Debugger.enable");
        const script = events.find(
          (e) =>
            e.method === "Debugger.scriptParsed" &&
            e.params.url.endsWith("/demo/swiftui/Showcase.swift"),
        )?.params;
        assert.ok(script, "Publish SwiftUI source from native debug symbols");
        const { scriptSource } = await client.send("Debugger.getScriptSource", {
          scriptId: script.scriptId,
        });
        const lineNumber = scriptSource
          .split("\n")
          .findIndex((line) => line.trim() === "incrementCount()");
        const incrementLine = scriptSource
          .split("\n")
          .findIndex((line) => line.trim() === "count += 1");
        await client.send("Runtime.evaluate", {
          expression: '$("#reset-button").click()',
        });
        breakpoint = (
          await client.send("Debugger.setBreakpointByUrl", {
            url: script.url,
            lineNumber,
          })
        ).breakpointId;
        click = client.send("Runtime.evaluate", {
          expression: '$("#count-button").click()',
        });
        await observed(() =>
          events.some((e) => e.method === "Debugger.paused"),
        );
        const latest = () =>
          events.filter((e) => e.method === "Debugger.paused").at(-1).params;
        assert.ok(latest().hitBreakpoints.includes(breakpoint));
        let value = await client.send("Debugger.evaluateOnCallFrame", {
          callFrameId: latest().callFrames[0].callFrameId,
          expression: "self.count",
        });
        assert.equal(value.result.value, 0, JSON.stringify(value));
        let pauses = events.filter(
          (e) => e.method === "Debugger.paused",
        ).length;
        await client.send("Debugger.stepInto");
        await observed(
          () =>
            events.filter((e) => e.method === "Debugger.paused").length >
            pauses,
        );
        assert.match(latest().callFrames[0].functionName, /incrementCount/);
        if (latest().callFrames[0].location.lineNumber < incrementLine) {
          pauses++;
          await client.send("Debugger.stepOver");
          await observed(
            () =>
              events.filter((e) => e.method === "Debugger.paused").length >
              pauses,
          );
        }
        assert.equal(latest().callFrames[0].location.lineNumber, incrementLine);
        pauses = events.filter((e) => e.method === "Debugger.paused").length;
        await client.send("Debugger.stepOver");
        await observed(
          () =>
            events.filter((e) => e.method === "Debugger.paused").length >
            pauses,
        );
        value = await client.send("Debugger.evaluateOnCallFrame", {
          callFrameId: latest().callFrames[0].callFrameId,
          expression: "self.count",
        });
        // @Published's accessor can span multiple LLDB line stops before its setter completes.
        for (let step = 0; value.result.value === 0 && step < 8; step++) {
          pauses = events.filter((e) => e.method === "Debugger.paused").length;
          await client.send("Debugger.stepOver");
          await observed(
            () =>
              events.filter((e) => e.method === "Debugger.paused").length >
              pauses,
          );
          value = await client.send("Debugger.evaluateOnCallFrame", {
            callFrameId: latest().callFrames[0].callFrameId,
            expression: "self.count",
          });
        }
        assert.equal(
          value.result.value,
          1,
          JSON.stringify({ value, frame: latest().callFrames[0] }),
        );
        pauses = events.filter((e) => e.method === "Debugger.paused").length;
        const callers = new Set(
          latest()
            .callFrames.slice(1)
            .map((f) => f.functionName),
        );
        await client.send("Debugger.stepOut");
        await observed(
          () =>
            events.filter((e) => e.method === "Debugger.paused").length >
            pauses,
        );
        assert.ok(
          callers.has(latest().callFrames[0].functionName),
          "Step out returns to a native caller, skipping compiler thunks",
        );
        await client.send("Debugger.resume");
        await click;
      } finally {
        if (breakpoint)
          await client.send("Debugger.removeBreakpoint", {
            breakpointId: breakpoint,
          });
        await client.send("Debugger.resume").catch(() => {});
        await click;
        await client.send("Runtime.evaluate", {
          expression: '$("#reset-button").click()',
        });
        client.close();
      }
    },
  );
}
