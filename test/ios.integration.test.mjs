// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { connectCDP } from "../src/cdp.mjs";

async function observed(predicate) {
  const deadline = Date.now() + 20000;
  while (!(await predicate())) {
    if (Date.now() > deadline)
      throw Error("iOS debugger event was not observed");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test(
  "UIKit animations update native Styles and notify DevTools without style attributes",
  {
    skip: !process.env.MACINSPECTOR_TEST_IOS_URL,
    timeout: 30000,
  },
  async () => {
    const client = await connectCDP(process.env.MACINSPECTOR_TEST_IOS_URL);
    const events = [];
    client.onEvent((event) => events.push(event));
    let original, radius, animate;
    try {
      await client.send("DOM.getDocument", { depth: -1 });
      await client.send("CSS.enable");
      const { nodeId } = await client.send("DOM.querySelector", {
        nodeId: 1,
        selector: "#animated-tile",
      });
      assert.ok(nodeId);
      radius = async () =>
        (
          await client.send("CSS.getInlineStylesForNode", { nodeId })
        ).inlineStyle.cssProperties.find((p) => p.name === "border-radius")
          .value;
      animate = async () => {
        const result = await client.send("Runtime.evaluate", {
          expression: '$("#animate-button").click()',
        });
        assert.equal(result.exceptionDetails, undefined);
      };
      original = await radius();
      const expected = original === "14.0px" ? "36.0px" : "14.0px";
      await animate();
      await observed(() =>
        events.some(
          (event) =>
            event.method === "CSS.styleSheetChanged" &&
            event.params.styleSheetId === `native-${nodeId}`,
        ),
      );
      assert.equal(await radius(), expected);
      assert.ok(
        !(
          await client.send("DOM.getAttributes", { nodeId })
        ).attributes.includes("style"),
      );
    } finally {
      if (original && radius && animate && (await radius()) !== original)
        await animate();
      client.close();
    }
  },
);

test(
  "UIKit tree, reversible styles, constraints, menu metadata, native actions and Swift stepping",
  {
    skip: !process.env.MACINSPECTOR_TEST_IOS_URL,
    timeout: 180000,
  },
  async () => {
    const client = await connectCDP(process.env.MACINSPECTOR_TEST_IOS_URL);
    const events = [];
    client.onEvent((event) => events.push(event));
    const find = async (selector) =>
      (await client.send("DOM.querySelector", { nodeId: 1, selector })).nodeId;
    const evaluate = async (expression) => {
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
    let breakpoint;
    try {
      await client.send("Runtime.enable");
      await client.send("Debugger.enable");
      const { root } = await client.send("DOM.getDocument", { depth: -1 });
      assert.equal(root.children[0].nodeName, "UIApplication");
      const tile = await find("#animated-tile"),
        button = await find("#count-button");
      assert.ok(tile && button);
      assert.ok(
        !(
          await client.send("DOM.getAttributes", { nodeId: tile })
        ).attributes.includes("style"),
      );
      const original = (
        await client.send("CSS.getInlineStylesForNode", { nodeId: tile })
      ).inlineStyle;
      const setStyle = async (text) => {
        const current = (
          await client.send("CSS.getInlineStylesForNode", { nodeId: tile })
        ).inlineStyle;
        return client.send("CSS.setStyleTexts", {
          edits: [
            { styleSheetId: current.styleSheetId, range: current.range, text },
          ],
        });
      };
      await setStyle("background: red; opacity: 0.5; border-radius: 24px;");
      assert.equal(await evaluate('$("#animated-tile").style.opacity'), "0.5");
      const edited = (
        await client.send("CSS.getInlineStylesForNode", { nodeId: tile })
      ).inlineStyle;
      assert.equal(
        edited.cssProperties.filter((property) =>
          property.name.startsWith("background"),
        ).length,
        1,
      );
      await setStyle(
        "background: red; /* opacity: 0.5; */ border-radius: 24px;",
      );
      assert.equal(
        await evaluate('getComputedStyle($("#animated-tile")).opacity'),
        "1.0",
      );
      await assert.rejects(
        setStyle("background: blue; opacity: 4;"),
        /finite|point/,
      );
      assert.match(
        await evaluate(
          'getComputedStyle($("#animated-tile"))["background-color"]',
        ),
        /255, 0, 0/,
      );
      await setStyle(original.cssText);

      await evaluate('$("#message-field").value = "iOS live edit"');
      assert.equal(
        await evaluate('$("#message-field").value'),
        "iOS live edit",
      );
      await client.send("MacInspector.undo");
      assert.equal(await evaluate('$("#message-field").value'), "");
      await client.send("MacInspector.redo");
      assert.equal(
        await evaluate('$("#message-field").value'),
        "iOS live edit",
      );
      await evaluate('$("#message-field").value = ""');
      const layout = await client.send("MacInspector.getLayout", {
        node: tile,
      });
      const width = layout.constraints.find(
        (constraint) => constraint.identifier === "tile.width",
      );
      assert.ok(width);
      await client.send("MacInspector.setLayout", {
        node: tile,
        constraint: width.id,
        constant: 88,
      });
      assert.equal(
        await evaluate('$("#animated-tile").getBoundingClientRect().width'),
        88,
      );
      await client.send("MacInspector.undo");
      assert.equal(
        await evaluate('$("#animated-tile").getBoundingClientRect().width'),
        72,
      );
      assert.ok(await find("UIMenu"));
      assert.ok(await find("UIAction"));
      const png = await client.send("Page.captureScreenshot");
      assert.equal(
        Buffer.from(png.data, "base64").subarray(0, 8).toString("hex"),
        "89504e470d0a1a0a",
      );
      const resolved = await client.send("DOM.resolveNode", { nodeId: button });
      const { listeners } = await client.send("DOMDebugger.getEventListeners", {
        objectId: resolved.object.objectId,
      });
      const action = listeners.find(
        (listener) => listener.type === "touchUpInside",
      );
      assert.ok(action);
      const { scriptSource } = await client.send("Debugger.getScriptSource", {
        scriptId: action.scriptId,
      });
      assert.match(
        scriptSource
          .split("\n")
          .slice(action.lineNumber, action.lineNumber + 3)
          .join("\n"),
        /func increment/,
      );
      const script = events.find(
        (event) =>
          event.method === "Debugger.scriptParsed" &&
          event.params.url.endsWith("/demo/ios/Showcase.swift"),
      )?.params;
      assert.ok(script, "The simulator must publish actual demo Swift source");
      const source = (
        await client.send("Debugger.getScriptSource", {
          scriptId: script.scriptId,
        })
      ).scriptSource;
      const lineNumber = source
        .split("\n")
        .findIndex((line) => line.trim() === "incrementCount()");
      assert.ok(lineNumber > 0);
      breakpoint = (
        await client.send("Debugger.setBreakpointByUrl", {
          url: script.url,
          lineNumber,
        })
      ).breakpointId;
      const click = client.send("Runtime.evaluate", {
        expression: '$("#count-button").click()',
      });
      const completed = click.catch((error) => error);
      await observed(() =>
        events.some((event) => event.method === "Debugger.paused"),
      );
      let paused = events
        .filter((event) => event.method === "Debugger.paused")
        .at(-1).params;
      assert.ok(paused.hitBreakpoints.includes(breakpoint));
      assert.equal(paused.callFrames[0].location.scriptId, script.scriptId);
      const before = await client.send("Debugger.evaluateOnCallFrame", {
        callFrameId: paused.callFrames[0].callFrameId,
        expression: "self.actionCount",
      });
      assert.equal(before.exceptionDetails, undefined, JSON.stringify(before));
      assert.equal(before.result.value, 0);
      const count = events.filter(
        (event) => event.method === "Debugger.paused",
      ).length;
      await client.send("Debugger.stepInto");
      await observed(
        () =>
          events.filter((event) => event.method === "Debugger.paused").length >
          count,
      );
      paused = events
        .filter((event) => event.method === "Debugger.paused")
        .at(-1).params;
      assert.match(paused.callFrames[0].functionName, /incrementCount/);
      let steppedValue = 0;
      for (let step = 0; step < 3 && steppedValue !== 1; step++) {
        const count = events.filter(
          (event) => event.method === "Debugger.paused",
        ).length;
        await client.send("Debugger.stepOver");
        await observed(
          () =>
            events.filter((event) => event.method === "Debugger.paused")
              .length > count,
        );
        paused = events
          .filter((event) => event.method === "Debugger.paused")
          .at(-1).params;
        const value = await client.send("Debugger.evaluateOnCallFrame", {
          callFrameId: paused.callFrames[0].callFrameId,
          expression: "self.actionCount",
        });
        assert.equal(value.exceptionDetails, undefined, JSON.stringify(value));
        steppedValue = value.result.value;
      }
      assert.equal(
        steppedValue,
        1,
        "Line stepping must execute the actual Swift increment",
      );
      const returnCount = events.filter(
        (event) => event.method === "Debugger.paused",
      ).length;
      await client.send("Debugger.stepOut");
      await observed(
        () =>
          events.filter((event) => event.method === "Debugger.paused").length >
          returnCount,
      );
      paused = events
        .filter((event) => event.method === "Debugger.paused")
        .at(-1).params;
      assert.match(
        paused.callFrames[0].functionName,
        /ShowcaseController.increment/,
      );
      await client.send("Debugger.removeBreakpoint", {
        breakpointId: breakpoint,
      });
      breakpoint = undefined;
      await client.send("Debugger.resume");
      await completed;
      await observed(
        async () =>
          (await evaluate('$("#action-counter").textContent')) === "1 actions",
      );
    } finally {
      await client.send("Debugger.resume").catch(() => {});
      if (breakpoint)
        await client
          .send("Debugger.removeBreakpoint", { breakpointId: breakpoint })
          .catch(() => {});
      client.close();
    }
  },
);
