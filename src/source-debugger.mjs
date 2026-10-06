// SPDX-License-Identifier: MIT
import { EventEmitter } from "node:events";
import { readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { LldbTransport } from "./lldb-transport.mjs";

export class SourceDebugger extends EventEmitter {
  constructor(transport = new LldbTransport()) {
    super();
    this.transport = transport;
    this.clients = new Map();
    this.scripts = new Map();
    this.byFile = new Map();
    this.breakpoints = new Map();
    this.active = true;
    this.skipPauses = false;
    this.paused = false;
    this.epoch = 0;
    this.control = Promise.resolve();
    this.unsubscribe = transport.onEvent((event) => this.event(event));
  }
  async start(params) {
    this.launched = !params.pid;
    try {
      const result = await this.transport.request(
        params.pid ? "attach" : "launch",
        params,
        params.platform === "ios-simulator" ? 90000 : 30000,
      );
      this.pid = result.pid;
      for (const source of result.sources)
        this.addSource(source.file, source.lines);
      if (!this.scripts.size)
        throw Error(
          "No readable source files in this executable's debug symbols; rebuild with debug information",
        );
      return this;
    } catch (error) {
      await this.close({ terminate: this.launched });
      throw error;
    }
  }
  addSource(file, lines = []) {
    let source, canonical;
    try {
      canonical = realpathSync(file);
      if (this.byFile.has(canonical)) return this.byFile.get(canonical);
      source = readFileSync(canonical, "utf8");
      if (Buffer.byteLength(source) > 1024 * 1024) return;
    } catch {
      return;
    }
    const hash = createHash("sha256").update(source).digest("hex");
    const scriptId =
      "source-" +
      createHash("sha256").update(canonical).digest("hex").slice(0, 20);
    const script = {
      scriptId,
      url: pathToFileURL(canonical).href,
      startLine: 0,
      startColumn: 0,
      endLine: source.split("\n").length - 1,
      endColumn: 0,
      executionContextId: 1,
      hash,
      length: source.length,
      isLiveEdit: false,
    };
    this.scripts.set(scriptId, {
      script,
      source,
      file: canonical,
      lines: new Set(lines.map((n) => n - 1)),
    });
    this.byFile.set(canonical, scriptId);
    this.broadcast("Debugger.scriptParsed", script);
    return scriptId;
  }
  broadcast(method, params) {
    for (const emit of this.clients.values()) emit(method, params);
  }
  setPaused(paused) {
    this.paused = paused;
    this.emit("state", paused);
  }
  location(frame) {
    const scriptId = this.addSource(frame.file);
    if (!scriptId) {
      const id =
        "frame-" +
        createHash("sha256")
          .update(frame.file || frame.function)
          .digest("hex")
          .slice(0, 20);
      if (!this.scripts.has(id)) {
        const source =
          "// Source unavailable for native frame: " + frame.function;
        const script = {
          scriptId: id,
          url: "macos://frames/" + id,
          startLine: 0,
          startColumn: 0,
          endLine: 0,
          endColumn: source.length,
          executionContextId: 1,
          hash: createHash("sha256").update(source).digest("hex"),
          length: source.length,
          isLiveEdit: false,
        };
        this.scripts.set(id, { script, source, lines: new Set() });
        this.broadcast("Debugger.scriptParsed", script);
      }
      return { scriptId: id, lineNumber: 0, columnNumber: 0 };
    }
    return {
      scriptId,
      lineNumber: Math.max(0, frame.line - 1),
      columnNumber: 0,
    };
  }
  async handlerLocations(addresses) {
    const { locations } = await this.transport.request("locations", {
      addresses: [...new Set(addresses)].slice(0, 128),
    });
    return Object.fromEntries(
      Object.entries(locations).flatMap(([address, frame]) => {
        const scriptId = this.addSource(frame.file);
        return scriptId
          ? [
              [
                address,
                {
                  scriptId,
                  lineNumber: Math.max(0, frame.line - 1),
                  columnNumber: Math.max(0, (frame.column || 1) - 1),
                },
              ],
            ]
          : [];
      }),
    );
  }
  event(event) {
    if (this.closing) return;
    if (event.event === "progress") {
      this.emit("progress", event.text);
      return;
    }
    if (event.event === "closed" || event.event === "exited") {
      this.failure = event.error || Error("Native process exited");
      this.setPaused(false);
      this.emit("ended", this.failure);
      return;
    }
    if (event.event === "output") {
      this.emit("output", event.text);
      return;
    }
    if (event.event === "running") {
      this.setPaused(false);
      if (!this.stepping) this.broadcast("Debugger.resumed", {});
      return;
    }
    if (event.event !== "stopped") return;
    this.setPaused(true);
    this.thread = event.thread;
    this.epoch++;
    this.frames = event.frames;
    const callFrames = event.frames.map((frame) => ({
      callFrameId: `lldb-frame-${this.epoch}-${frame.level}`,
      functionName: frame.function,
      location: this.location(frame),
      url: frame.file ? pathToFileURL(frame.file).href : "",
      scopeChain: [
        {
          type: "local",
          name: "Native locals",
          object: {
            type: "object",
            objectId: `lldb-scope-${this.epoch}-${frame.level}`,
            description: "Native locals",
          },
        },
      ],
      this: { type: "undefined" },
    }));
    this.lastPaused = {
      callFrames,
      reason: this.stepping
        ? "step"
        : event.reason === "pause"
          ? "debugCommand"
          : "other",
      hitBreakpoints: event.breakpoints
        .map((id) => "lldb-" + id)
        .filter((id) => this.breakpoints.has(id)),
      data: {
        nativeReason: event.reason,
        thread: this.thread,
        description: event.description,
      },
    };
    this.stepping = false;
    this.broadcast("Debugger.paused", this.lastPaused);
  }
  frame(id, prefix = "lldb-frame-") {
    if (!this.paused || this.stepping)
      throw Error("The native app is not paused");
    const match =
      typeof id === "string" &&
      id.startsWith(prefix) &&
      /^(\d+)-(\d+)$/.exec(id.slice(prefix.length));
    if (!match || Number(match[1]) !== this.epoch)
      throw Error("Stale native frame or value");
    return Number(match[2]);
  }
  remote(value) {
    if (/^(bool|(?:Swift\.)?Bool)$/.test(value.type))
      return { type: "boolean", value: ["true", "1"].includes(value.value) };
    if (
      /^(?:(?:Swift\.)?(?:U?Int\d*|Float|Double)|(?:unsigned )?(?:int|long|short|float|double|char))$/.test(
        value.type,
      ) &&
      value.value !== null &&
      value.value !== "" &&
      Number.isFinite(Number(value.value))
    ) {
      if (
        /^-?\d+$/.test(value.value) &&
        !Number.isSafeInteger(Number(value.value))
      )
        return {
          type: "bigint",
          unserializableValue: value.value + "n",
          description: value.value,
        };
      return {
        type: "number",
        value: Number(value.value),
        description: value.value,
      };
    }
    if (/^(?:Swift\.)?String$/.test(value.type) && value.summary) {
      try {
        return { type: "string", value: JSON.parse(value.summary) };
      } catch {}
    }
    if (value.handle)
      return {
        type: "object",
        objectId: `lldb-value-${this.epoch}-${value.handle}`,
        className: value.type,
        description: value.summary || value.value || value.type,
      };
    return {
      type: "string",
      value: value.summary || value.value || "<unavailable>",
      description: value.type,
    };
  }
  handle(owner, emit, method, params = {}) {
    const result = this.control.then(() =>
      this.command(owner, emit, method, params),
    );
    this.control = result.catch(() => {});
    return result;
  }
  removeOwner(owner) {
    return this.handle(owner, () => {}, "Debugger.disable");
  }
  async command(owner, emit, method, p) {
    if (this.closing || this.failure)
      throw this.failure || Error("Native debugger is closing");
    if (method === "Debugger.enable") {
      this.clients.set(owner, emit);
      for (const { script } of this.scripts.values())
        emit("Debugger.scriptParsed", script);
      if (this.paused && this.lastPaused)
        emit("Debugger.paused", this.lastPaused);
      return { debuggerId: "macos-lldb" };
    }
    if (method === "Debugger.disable") {
      this.clients.delete(owner);
      for (const [id, breakpoint] of this.breakpoints) {
        if (breakpoint.owner !== owner) continue;
        await this.transport.request("remove", { id: breakpoint.id });
        this.breakpoints.delete(id);
      }
      if (!this.clients.size && this.paused) {
        this.stepping = false;
        await this.transport.request("resume");
      }
      return {};
    }
    if (method === "Debugger.getScriptSource") {
      const entry = this.scripts.get(p.scriptId);
      if (!entry) throw Error("Unknown native source");
      return { scriptSource: entry.source };
    }
    if (method === "Debugger.getPossibleBreakpoints") {
      const entry = this.scripts.get(p.start.scriptId);
      return {
        locations: [...(entry?.lines || [])]
          .sort((a, b) => a - b)
          .filter(
            (line) =>
              (line > p.start.lineNumber ||
                (line === p.start.lineNumber && !(p.start.columnNumber > 0))) &&
              (!p.end ||
                line < p.end.lineNumber ||
                (line === p.end.lineNumber && p.end.columnNumber > 0)),
          )
          .map((lineNumber) => ({
            scriptId: p.start.scriptId,
            lineNumber,
            columnNumber: 0,
          })),
      };
    }
    if (
      [
        "Debugger.setBreakpoint",
        "Debugger.setBreakpointByUrl",
        "Debugger.continueToLocation",
      ].includes(method)
    ) {
      let entry = p.location
        ? this.scripts.get(p.location.scriptId)
        : [...this.scripts.values()].find((e) =>
            p.url
              ? e.script.url === p.url
              : p.urlRegex
                ? new RegExp(p.urlRegex).test(e.script.url)
                : p.scriptHash === e.script.hash,
          );
      if (!entry?.file) throw Error("Choose a readable native source file");
      const requested = p.location?.lineNumber ?? p.lineNumber;
      if (!Number.isInteger(requested) || requested < 0)
        throw Error("Invalid breakpoint line");
      const line = [...entry.lines]
        .sort((a, b) => a - b)
        .find((line) => line >= requested);
      if (line === undefined)
        throw Error("No executable native operation at this source position");
      const temporary = method === "Debugger.continueToLocation";
      if (temporary && !this.paused)
        throw Error("The native app is not paused");
      const breakpoint = await this.transport.request("breakpoint", {
        file: entry.file,
        line: line + 1,
        enabled: temporary || (this.active && !this.skipPauses),
        temporary,
        condition: p.condition || "",
      });
      const id = "lldb-" + breakpoint.id;
      this.breakpoints.set(id, { id: breakpoint.id, owner });
      const location = {
        scriptId: this.addSource(breakpoint.file) || entry.script.scriptId,
        lineNumber: breakpoint.line - 1,
        columnNumber: 0,
      };
      if (temporary) {
        await this.transport.request("resume");
        return {};
      }
      return method === "Debugger.setBreakpoint"
        ? { breakpointId: id, actualLocation: location }
        : { breakpointId: id, locations: [location] };
    }
    if (method === "Debugger.removeBreakpoint") {
      const breakpoint = this.breakpoints.get(p.breakpointId);
      if (breakpoint && breakpoint.owner !== owner)
        throw Error("Breakpoint belongs to another inspector");
      if (breakpoint)
        await this.transport.request("remove", { id: breakpoint.id });
      this.breakpoints.delete(p.breakpointId);
      return {};
    }
    if (
      method === "Debugger.setBreakpointsActive" ||
      method === "Debugger.setSkipAllPauses"
    ) {
      if (method.endsWith("Active")) this.active = p.active;
      else this.skipPauses = p.skip;
      await this.transport.request("active", {
        active: this.active && !this.skipPauses,
      });
      return {};
    }
    if (method === "Debugger.pause") {
      if (!this.paused) await this.transport.request("pause");
      return {};
    }
    if (method === "Debugger.resume") {
      this.stepping = false;
      if (this.paused) await this.transport.request("resume");
      return {};
    }
    if (
      ["Debugger.stepOver", "Debugger.stepInto", "Debugger.stepOut"].includes(
        method,
      )
    ) {
      if (!this.paused || this.stepping)
        throw Error("The native app is not paused");
      this.stepping = true;
      this.broadcast("Debugger.resumed", {});
      try {
        await this.transport.request("step", {
          thread: this.thread,
          mode: {
            "Debugger.stepOver": "over",
            "Debugger.stepInto": "into",
            "Debugger.stepOut": "out",
          }[method],
        });
      } catch (error) {
        this.stepping = false;
        throw error;
      }
      return {};
    }
    if (method === "Debugger.evaluateOnCallFrame") {
      try {
        const frame = this.frame(p.callFrameId);
        const value = await this.transport.request("evaluate", {
          thread: this.thread,
          frame,
          expression: p.expression,
        });
        return { result: this.remote(value) };
      } catch (error) {
        return {
          result: { type: "undefined" },
          exceptionDetails: {
            text: error.message,
            exceptionId: 1,
            lineNumber: 0,
            columnNumber: 0,
          },
        };
      }
    }
    if (method === "Runtime.getProperties") {
      const child = p.objectId.startsWith("lldb-value-");
      const frame = this.frame(
        p.objectId,
        child ? "lldb-value-" : "lldb-scope-",
      );
      const { values } = await this.transport.request(
        child ? "children" : "variables",
        child ? { handle: frame } : { thread: this.thread, frame },
      );
      return {
        result: values.map((value) => ({
          name: value.name,
          isOwn: true,
          enumerable: true,
          configurable: false,
          value: this.remote(value),
        })),
      };
    }
    if (method === "Debugger.setPauseOnExceptions") {
      if (p.state !== "none")
        throw Error(
          "JavaScript exception pausing is unavailable for native Swift/Objective-C",
        );
      return {};
    }
    if (
      [
        "Debugger.setAsyncCallStackDepth",
        "Debugger.setBlackboxPatterns",
        "Debugger.setBlackboxedRanges",
      ].includes(method)
    )
      return {};
    throw Error("Unsupported native source debugger operation: " + method);
  }
  async close(options = {}) {
    if (this.closing) return;
    this.closing = true;
    this.clients.clear();
    this.unsubscribe();
    await this.control.catch(() => {});
    await this.transport.close(options);
    this.setPaused(false);
  }
}
