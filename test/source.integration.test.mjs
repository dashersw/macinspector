// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { connectCDP } from "../src/cdp.mjs";

async function observed(predicate, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() > deadline)
      throw Error("Native debugger event was not observed");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
test(
  "real Swift breakpoints, variables, line stepping and inspector-disconnect recovery",
  {
    skip: !process.env.MACINSPECTOR_TEST_SOURCES,
    timeout: 180000,
  },
  async () => {
    const endpoint =
      process.env.MACINSPECTOR_TEST_URL ||
      "ws://127.0.0.1:9333/devtools/page/native";
    const client = await connectCDP(endpoint);
    const events = [];
    client.onEvent((event) => events.push(event));
    let breakpoint,
      closed = false;
    try {
      await client.send("Runtime.enable");
      await client.send("DOM.getDocument", { depth: -1 });
      await client.send("Debugger.enable");
      const script = events.find(
        (e) =>
          e.method === "Debugger.scriptParsed" &&
          e.params.url.endsWith("/demo/macos/main.swift"),
      )?.params;
      assert.ok(script, "LLDB must publish the actual Swift source file");
      const { scriptSource } = await client.send("Debugger.getScriptSource", {
        scriptId: script.scriptId,
      });
      const lines = scriptSource.split("\n");
      const lineNumber = lines.findIndex(
        (line) => line.trim() === "incrementCount()",
      );
      const incrementLine = lines.findIndex(
        (line) => line.trim() === "actionCount += 1",
      );
      assert.ok(lineNumber > 0);
      await client.send("Runtime.evaluate", {
        expression: '$("#reset-button").click()',
      });
      breakpoint = (
        await client.send("Debugger.setBreakpointByUrl", {
          url: script.url,
          lineNumber,
        })
      ).breakpointId;
      const click = client.send("Runtime.evaluate", {
        expression: '$("#count-button").click()',
      });
      await observed(() => events.some((e) => e.method === "Debugger.paused"));
      const paused = events
        .filter((e) => e.method === "Debugger.paused")
        .at(-1).params;
      assert.ok(paused.hitBreakpoints.includes(breakpoint));
      assert.equal(paused.callFrames[0].location.scriptId, script.scriptId);
      assert.equal(paused.callFrames[0].location.lineNumber, lineNumber);
      const value = await client.send("Debugger.evaluateOnCallFrame", {
        callFrameId: paused.callFrames[0].callFrameId,
        expression: "self.actionCount",
      });
      assert.equal(
        value.exceptionDetails,
        undefined,
        JSON.stringify(value.exceptionDetails),
      );
      assert.equal(value.result.value, 0);
      const properties = await client.send("Runtime.getProperties", {
        objectId: paused.callFrames[0].scopeChain[0].object.objectId,
      });
      assert.ok(properties.result.some((p) => p.name === "self"));
      const { nodeId } = await client.send("DOM.querySelector", {
        nodeId: 1,
        selector: "#animated-tile",
      });
      assert.ok(
        !(
          await client.send("DOM.getAttributes", { nodeId })
        ).attributes.includes("style"),
      );
      assert.ok(
        (await client.send("CSS.getInlineStylesForNode", { nodeId }))
          .inlineStyle.cssProperties.length > 0,
      );
      let count = events.filter((e) => e.method === "Debugger.paused").length;
      await client.send("Debugger.stepInto");
      await observed(
        () =>
          events.filter((e) => e.method === "Debugger.paused").length > count,
      );
      let entered = events
        .filter((e) => e.method === "Debugger.paused")
        .at(-1).params;
      assert.match(entered.callFrames[0].functionName, /incrementCount/);
      assert.equal(entered.callFrames[0].location.scriptId, script.scriptId);
      // LLDB can stop at the function's opening brace before its first statement.
      if (entered.callFrames[0].location.lineNumber < incrementLine) {
        count = events.filter((e) => e.method === "Debugger.paused").length;
        await client.send("Debugger.stepOver");
        await observed(
          () =>
            events.filter((e) => e.method === "Debugger.paused").length > count,
        );
        entered = events
          .filter((e) => e.method === "Debugger.paused")
          .at(-1).params;
      }
      assert.equal(entered.callFrames[0].location.lineNumber, incrementLine);
      count = events.filter((e) => e.method === "Debugger.paused").length;
      await client.send("Debugger.stepOver");
      await observed(
        () =>
          events.filter((e) => e.method === "Debugger.paused").length > count,
      );
      const stepped = events
        .filter((e) => e.method === "Debugger.paused")
        .at(-1).params;
      assert.notEqual(stepped.callFrames[0].location.lineNumber, incrementLine);
      const updated = await client.send("Debugger.evaluateOnCallFrame", {
        callFrameId: stepped.callFrames[0].callFrameId,
        expression: "self.actionCount",
      });
      assert.equal(updated.result.value, 1);
      assert.equal(updated.result.description, "1");
      const stale = await client.send("Debugger.evaluateOnCallFrame", {
        callFrameId: paused.callFrames[0].callFrameId,
        expression: "self.actionCount",
      });
      assert.ok(stale.exceptionDetails);
      count = events.filter((e) => e.method === "Debugger.paused").length;
      await client.send("Debugger.stepOut");
      await observed(
        () =>
          events.filter((e) => e.method === "Debugger.paused").length > count,
      );
      const returned = events
        .filter((e) => e.method === "Debugger.paused")
        .at(-1).params;
      assert.match(
        returned.callFrames[0].functionName,
        /AppDelegate.increment\(\)/,
      );
      // Closing the only inspector removes its breakpoint and resumes the app.
      client.close();
      closed = true;
      await click;
      const restored = await connectCDP(endpoint);
      try {
        await observed(async () => {
          const state = await restored.send("Runtime.evaluate", {
            expression: '$("#action-counter").textContent',
            returnByValue: true,
          });
          return state.result.value === "Actions: 1";
        });
        const result = await restored.send("Runtime.evaluate", {
          expression: '$("#action-counter").textContent',
          returnByValue: true,
        });
        assert.equal(result.result.value, "Actions: 1");
        await restored.send("Runtime.evaluate", {
          expression: '$("#reset-button").click()',
        });
      } finally {
        restored.close();
      }
    } finally {
      if (!closed) {
        await client.send("Debugger.resume").catch(() => {});
        if (breakpoint)
          await client
            .send("Debugger.removeBreakpoint", { breakpointId: breakpoint })
            .catch(() => {});
      }
      client.close();
    }
  },
);
