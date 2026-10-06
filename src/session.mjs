// SPDX-License-Identifier: MIT
import vm from "node:vm";
import { createConsole } from "./console.mjs";
import { outerHTML } from "./dom.mjs";
import { randomUUID } from "node:crypto";
import {
  cssRange,
  cssStyle,
  cssValues,
  setCssProperty,
  replaceCssRange,
  parseCssDeclarations,
} from "./css.mjs";

const canonical = (key) => (key === "background" ? "background-color" : key);
export class Session {
  constructor(relay, emit) {
    this.relay = relay;
    this.emit = emit;
    this.owner = randomUUID();
    this.published = new Set();
    this.objects = new Map();
    this.nextObject = 0;
    this.selected = 0;
    this.pending = [];
    this.listenerScripts = new Map();
    const console = createConsole(this);
    this.context = console.context;
    this.wrapNative = console.wrap;
  }
  get nodes() {
    return this.relay.nodes;
  }
  get(id) {
    const node = this.nodes.get(id);
    if (!node) throw Error("Stale native element");
    return node;
  }
  domGet(id) {
    const node = this.relay.domNodes.get(id);
    if (!node) throw Error("Stale native element");
    return node;
  }
  nativeId(id) {
    return this.domGet(id).owner || id;
  }
  textId(id) {
    const node = this.domGet(id);
    return node.textOwner || node.owner || id;
  }
  query(selector, root = this.relay.snapshot.root) {
    if (typeof selector !== "string") throw Error("Selector must be a string");
    const tag = selector.replace(
      /\\([0-9a-f]{1,6})[\t\n\r\f ]?|\\([^\n\r\f])/gi,
      (_, hex, literal) => {
        if (literal) return literal;
        const point = Number.parseInt(hex, 16);
        return String.fromCodePoint(
          point === 0 ||
            point > 0x10ffff ||
            (point >= 0xd800 && point <= 0xdfff)
            ? 0xfffd
            : point,
        );
      },
    );
    const found = [],
      seen = new Set();
    const visit = (id) => {
      if (seen.has(id)) return;
      seen.add(id);
      const n = this.nodes.get(id);
      if (!n) return;
      if (
        selector === "*" ||
        tag === n.tag ||
        (selector.startsWith("#") && n.attributes.id === selector.slice(1)) ||
        (selector.startsWith(".") &&
          (n.attributes.class || "").split(/\s+/).includes(selector.slice(1)))
      )
        found.push(id);
      n.children.forEach(visit);
    };
    visit(root);
    return found;
  }
  node(id, depth = 0) {
    if (id === 1)
      return {
        nodeId: 1,
        backendNodeId: 1,
        nodeType: 9,
        nodeName: "#document",
        localName: "",
        nodeValue: "",
        documentURL: "macos://native/",
        baseURL: "macos://native/",
        xmlVersion: "",
        childNodeCount: 1,
        ...(depth !== 0
          ? {
              children: [
                this.node(this.relay.snapshot.root, depth < 0 ? -1 : depth - 1),
              ],
            }
          : {}),
      };
    const n = this.domGet(id);
    if (n.nodeType === 3)
      return {
        nodeId: id,
        backendNodeId: id,
        nodeType: 3,
        nodeName: "#text",
        localName: "",
        nodeValue: n.text,
      };
    return {
      nodeId: id,
      backendNodeId: id,
      nodeType: 1,
      nodeName: n.tag,
      localName: n.tag,
      nodeValue: "",
      attributes: Object.entries(n.attributes).flat(),
      childNodeCount: n.children.length,
      ...(depth !== 0
        ? {
            children: n.children.map((id) =>
              this.node(id, depth < 0 ? -1 : depth - 1),
            ),
          }
        : {}),
    };
  }
  publish(node) {
    if (node.children) {
      this.published.add(node.nodeId);
      node.children.forEach((node) => this.publish(node));
    }
    return node;
  }
  knownNodes(nodes = this.relay.domNodes) {
    const known = new Set(this.published);
    if (this.published.has(1)) known.add(this.relay.snapshot.root);
    for (const id of this.published)
      for (const child of nodes.get(id)?.children || []) known.add(child);
    return known;
  }
  children(id, depth = 1) {
    const n = this.node(id, 1);
    if (n.nodeType === 3) return;
    if (!this.published.has(id)) {
      this.publish(n);
      this.emit("DOM.setChildNodes", { parentId: id, nodes: n.children });
    }
    if (depth !== 1)
      n.children.forEach((child) =>
        this.children(child.nodeId, depth < 0 ? -1 : depth - 1),
      );
  }
  path(id) {
    const path = [],
      seen = new Set();
    for (
      let current = id;
      current !== 1 && this.relay.domNodes.has(current) && !seen.has(current);
      current = this.domGet(current).parent
    ) {
      path.push(current);
      seen.add(current);
    }
    this.children(1);
    path.reverse().forEach((id) => this.children(id));
  }
  pick(id) {
    if (this.relay.domNodes.has(id)) {
      this.selected = id;
      this.path(id);
      this.emit("Overlay.inspectNodeRequested", { backendNodeId: id });
    }
  }
  changed(previous, previousDOM) {
    if (this.closed) return;
    if (this.domEnabled) {
      const root = this.relay.snapshot.root;
      if (previousDOM.get(root)?.tag !== this.domGet(root).tag) {
        this.published.clear();
        this.emit("DOM.documentUpdated", {});
      } else {
        const known = this.knownNodes(previousDOM),
          edges = [];
        const forget = (id) => {
          if (!this.published.delete(id)) return;
          for (const child of previousDOM.get(id)?.children || [])
            forget(child);
        };
        for (const [id, current] of this.relay.domNodes) {
          const old = previousDOM.get(id);
          if (
            current.nodeType !== 1 ||
            !old ||
            !known.has(id) ||
            JSON.stringify(old.children) === JSON.stringify(current.children)
          )
            continue;
          const retained = new Set();
          let cursor = 0;
          for (const child of old.children) {
            const index = current.children.indexOf(child);
            if (index >= cursor) {
              retained.add(child);
              cursor = index + 1;
            }
          }
          edges.push({ id, current, old, retained });
        }
        // Remove old edges before inserting new ones, including reparented views.
        for (const { id, old, retained } of edges)
          if (this.published.has(id))
            for (const child of old.children)
              if (!retained.has(child)) {
                this.emit("DOM.childNodeRemoved", {
                  parentNodeId: id,
                  nodeId: child,
                });
                forget(child);
              }
        for (const { id, current, retained } of edges) {
          if (this.published.has(id))
            current.children.forEach((child, index) => {
              if (!retained.has(child))
                this.emit("DOM.childNodeInserted", {
                  parentNodeId: id,
                  previousNodeId: current.children[index - 1] || 0,
                  node: this.publish(this.node(child, -1)),
                });
            });
          else if (known.has(id))
            this.emit("DOM.childNodeCountUpdated", {
              nodeId: id,
              childNodeCount: current.children.length,
            });
        }
        const visible = this.knownNodes();
        for (const [id, n] of this.nodes) {
          const current = this.domGet(id),
            old = previousDOM.get(id);
          if (!old || !visible.has(id)) continue;
          for (const name of Object.keys(old.attributes))
            if (!(name in current.attributes))
              this.emit("DOM.attributeRemoved", { nodeId: id, name });
          for (const [name, value] of Object.entries(current.attributes))
            if (old.attributes[name] !== value)
              this.emit("DOM.attributeModified", { nodeId: id, name, value });
          const text = this.relay.domNodes.get(-id),
            oldText = previousDOM.get(-id);
          if (
            text &&
            oldText &&
            text.text !== oldText.text &&
            this.published.has(id)
          )
            this.emit("DOM.characterDataModified", {
              nodeId: -id,
              characterData: text.text,
            });
        }
      }
    }
    if (this.cssEnabled) {
      for (const id of this.nodes.keys())
        if (!previous.has(id))
          this.emit("CSS.styleSheetAdded", { header: this.sheet(id) });
      for (const id of previous.keys())
        if (!this.nodes.has(id))
          this.emit("CSS.styleSheetRemoved", { styleSheetId: `native-${id}` });
      const ids = [...this.nodes]
        .filter(
          ([id, n]) =>
            JSON.stringify(
              Object.entries(previous.get(id)?.styles || {}).sort(),
            ) !== JSON.stringify(Object.entries(n.styles).sort()),
        )
        .map(([id]) => id);
      if (ids.length) {
        this.emit("DOM.inlineStyleInvalidated", { nodeIds: ids });
        // Styles are mutable CDP stylesheets, without DOM style attributes.
        // Invalidate CSS caches directly when the native app changes them.
        for (const id of ids)
          this.emit("CSS.styleSheetChanged", { styleSheetId: `native-${id}` });
      }
    }
  }
  queue(operation) {
    if (this.pending.length >= 64)
      throw Error("Console mutation limit exceeded");
    this.pending.push(operation);
  }
  wrap(id) {
    return this.wrapNative(id);
  }
  remote(value, group = "", byValue = false) {
    if (value === null) return { type: "object", subtype: "null", value: null };
    const type = typeof value;
    if (type === "undefined") return { type };
    if (["string", "boolean", "number"].includes(type))
      return type !== "number" || Number.isFinite(value)
        ? { type, value }
        : { type, unserializableValue: String(value) };
    if (byValue) return { type, value: JSON.parse(JSON.stringify(value)) };
    const objectId = "object-" + ++this.nextObject;
    this.objects.set(objectId, { value, group });
    return {
      type,
      objectId,
      ...(Array.isArray(value) ? { subtype: "array" } : {}),
      ...(value?.__nativeID
        ? {
            subtype: "node",
            className:
              this.domGet(value.__nativeID).nodeType === 3
                ? "Text"
                : this.get(value.__nativeID).tag,
            description:
              this.domGet(value.__nativeID).nodeType === 3
                ? this.domGet(value.__nativeID).text
                : `<${this.get(value.__nativeID).tag}>`,
          }
        : {
            description: Array.isArray(value)
              ? `Array(${value.length})`
              : "Object",
          }),
    };
  }
  object(id) {
    const o = this.objects.get(id);
    if (!o) throw Error("Released console object");
    return o.value;
  }
  listenerScript(info) {
    const name = `${info.target}.${info.selector}`;
    const reason = !this.relay.sourceDebugger
      ? "disabled"
      : !info.address
        ? "unresolved"
        : "unavailable";
    const key = JSON.stringify([name, reason]);
    let entry = this.listenerScripts.get(key);
    if (!entry) {
      const scriptId = `native-action-${this.listenerScripts.size + 1}`;
      const explanation = {
        disabled: [
          "Native source debugging is disabled for this attachment.",
          "Reattach with --source-debug and a Debug build with debug symbols and local source files.",
        ],
        unresolved: [
          "Native source debugging is enabled, but this registration has no resolved implementation address.",
          "Source lookup needs a resolved native target and method.",
        ],
        unavailable: [
          "Native source debugging is enabled, but no readable source location was found for this handler.",
          "System/framework handlers may have no available source.",
          "For your app's handler, check matching debug symbols and local source files.",
        ],
      }[reason];
      const source = [
        `Native ${info.kind}: ${name}`,
        `Dispatch: ${info.dispatch}`,
        ...explanation,
        "This is handler metadata, not executable JavaScript.",
      ]
        .map((line) => `// ${line}\n`)
        .join("");
      entry = {
        source,
        script: {
          scriptId,
          url: `macos://actions/${encodeURIComponent(name)}?source=${reason}`,
          startLine: 0,
          startColumn: 0,
          endLine: source.split("\n").length - 1,
          endColumn: 0,
          executionContextId: 1,
          length: source.length,
          hash: "",
        },
      };
      this.listenerScripts.set(key, entry);
      this.emit("Debugger.scriptParsed", entry.script);
    }
    return { scriptId: entry.script.scriptId, lineNumber: 0, columnNumber: 0 };
  }
  async eventListeners(p) {
    const object = this.object(p.objectId);
    const root = object?.__nativeID;
    if (
      !root ||
      root < 3 ||
      !this.relay.snapshot.capabilities.includes("event-listeners")
    )
      return { listeners: [] };
    this.get(root);
    const depth = p.depth ?? 1;
    if (!Number.isInteger(depth) || depth < -1)
      throw Error("Invalid event listener depth");
    const entries = [],
      seen = new Set();
    const visit = async (node, remaining) => {
      if (seen.has(node) || seen.size >= 4096) return;
      seen.add(node);
      const current = this.get(node);
      // Snapshots provide descendant metadata; query the selected object live.
      const listeners =
        node === root && !this.relay.sourceDebugger?.paused
          ? (await this.relay.backend.request("event-listeners", { node }))
              .listeners
          : current.listeners || [];
      for (const info of listeners || []) entries.push({ ...info, node });
      if (remaining === -1 || remaining > 1)
        for (const child of current.children || [])
          await visit(child, remaining === -1 ? -1 : remaining - 1);
    };
    await visit(root, depth);
    let locations = {};
    const addresses = entries.map((info) => info.address).filter(Boolean);
    if (this.relay.sourceDebugger && addresses.length)
      locations = await this.relay.sourceDebugger.handlerLocations(addresses);
    const group = this.objects.get(p.objectId).group;
    return {
      listeners: entries.map((info) => {
        const registeredSource =
          info.file && this.relay.sourceDebugger?.addSource(info.file);
        const location =
          locations[info.address] ||
          (registeredSource && Number.isInteger(info.line) && info.line > 0
            ? {
                scriptId: registeredSource,
                lineNumber: info.line - 1,
                columnNumber: 0,
              }
            : this.listenerScript(info));
        const objectId = `native-handler-${++this.nextObject}`;
        const metadata = Object.fromEntries(
          Object.entries(info).filter(
            ([key]) => !["address", "node"].includes(key),
          ),
        );
        const value = vm.runInContext(
          `Object.freeze(JSON.parse(${JSON.stringify(JSON.stringify(metadata))}))`,
          this.context,
        );
        this.objects.set(objectId, { value, group, handlerLocation: location });
        const handler = {
          type: "function",
          objectId,
          className: "NativeAction",
          description: `${info.target}.${info.selector}`,
        };
        return {
          type: info.type,
          useCapture: false,
          passive: false,
          once: false,
          ...location,
          handler,
          originalHandler: handler,
          backendNodeId: info.node,
        };
      }),
    };
  }
  async flush() {
    for (const operation of this.pending.splice(0)) {
      operation.node =
        operation.method === "attribute" && operation.key === "text"
          ? this.textId(operation.node)
          : this.nativeId(operation.node);
      if (operation.method === "css" || operation.method === "cssText") {
        const previous = this.relay.styles.get(operation.node)?.text || "";
        await this.editStyle(
          operation.node,
          operation.method === "cssText"
            ? operation.value
            : setCssProperty(previous, operation.key, operation.value),
        );
      } else {
        const { method, ...params } = operation;
        if (method === "attribute")
          await this.relay.changes.attribute(
            params.node,
            params.key,
            params.value,
          );
        else await this.relay.backend.request(method, params);
      }
    }
    await this.relay.refresh();
  }
  editStyle(id, text) {
    return this.relay.changes.editStyle(this, id, text);
  }
  async applyStyle(id, text, restore) {
    const doc = this.relay.styles.get(id);
    if (!doc || !this.relay.snapshot.capabilities.includes("styles"))
      throw Error(
        "Accessibility cannot edit native appearance; link the MacInspector library",
      );
    const next = parseCssDeclarations(text).filter(
        (p) => !p.disabled && p.parsedOk,
      ),
      before = cssValues(doc.text),
      values = cssValues(text);
    // Native backends declare their supported mappings; older SDKs retain the
    // original appearance subset. The relay does not maintain another registry.
    const supported = this.relay.snapshot.styleProperties || [
      "background",
      "background-color",
      "color",
      "opacity",
      "border-radius",
      "border-width",
      "border-color",
      "visibility",
      "font-size",
      "font-family",
      "text-align",
    ];
    if (next.length > 128)
      throw Error("Native style declaration limit exceeded");
    for (const p of next)
      if (!supported.includes(p.name))
        throw Error(`Unsupported native style: ${p.name}`);
    const oldOverrides = new Set(doc.overrides || []);
    const overrides = new Set(restore?.overrides || doc.overrides || []);
    const authored = new Set(restore?.authored || doc.authored || []);
    if (!restore) {
      for (const p of parseCssDeclarations(text))
        if (
          before[p.name] !== p.value ||
          p.disabled ||
          canonical(p.name) !== p.name
        )
          authored.add(p.name);
      for (const p of next)
        if (before[p.name] !== p.value || canonical(p.name) !== p.name)
          overrides.add(p.name);
    }
    const activeOverrides = new Set(
      [...overrides].filter((name) => name in values),
    );
    const removedOverrides = new Set(
      [...oldOverrides].filter((name) => !activeOverrides.has(name)),
    );
    doc.editing = true;
    try {
      const operations = [];
      // A projected longhand is not an override. Reset removed declarations
      // before replaying the remaining overrides, including their aliases.
      for (const key of new Set([...Object.keys(before), ...oldOverrides]))
        if (
          removedOverrides.has(key) ||
          (!(key in values) &&
            !Object.keys(values).some((k) => canonical(k) === canonical(key)))
        )
          operations.push({ key, reset: true });
      for (const p of next)
        if (overrides.has(p.name))
          operations.push({
            key: p.name,
            value: p.value.replace(/\s*!important\s*$/, ""),
          });
      await this.relay.backend.request("styles", { node: id, operations });
      doc.text = text;
      doc.overrides = [...activeOverrides];
      doc.authored = [...authored].filter((name) =>
        parseCssDeclarations(text).some((p) => p.name === name),
      );
      const snapshot = await this.relay.backend.request("snapshot");
      doc.projection = snapshot.nodes.find((n) => n.id === id)?.styles || {};
      if (restore || removedOverrides.size) {
        const protectedKeys = new Set(doc.authored.map(canonical));
        const restoredKeys = new Set([...removedOverrides].map(canonical));
        for (const [key, value] of Object.entries(doc.projection))
          if (
            !protectedKeys.has(canonical(key)) &&
            (restore || restoredKeys.has(canonical(key)))
          )
            doc.text = setCssProperty(doc.text, key, value);
      }
      this.relay.apply(snapshot);
      this.emit("CSS.styleSheetChanged", { styleSheetId: `native-${id}` });
    } finally {
      doc.editing = false;
    }
  }
  sheet(id) {
    const text = this.relay.styles.get(id)?.text || "",
      { endLine, endColumn } = cssRange(text);
    return {
      styleSheetId: `native-${id}`,
      frameId: "native",
      sourceURL: "",
      origin: "regular",
      title: "",
      disabled: false,
      isInline: true,
      isMutable: true,
      ownerNode: id,
      startLine: 0,
      startColumn: 0,
      length: text.length,
      endLine,
      endColumn,
    };
  }
  async handle(method, p = {}) {
    if (method === "DOMDebugger.getEventListeners")
      return this.eventListeners(p);
    if (method === "Debugger.getScriptSource") {
      const entry = [...this.listenerScripts.values()].find(
        (e) => e.script.scriptId === p.scriptId,
      );
      if (entry) return { scriptSource: entry.source };
    }
    if (
      method === "Debugger.getPossibleBreakpoints" &&
      p.start?.scriptId?.startsWith("native-action-")
    )
      return { locations: [] };
    if (method === "Debugger.enable" && !this.relay.sourceDebugger) {
      for (const entry of this.listenerScripts.values())
        this.emit("Debugger.scriptParsed", entry.script);
      return { debuggerId: this.owner };
    }
    if (method === "Debugger.disable" && !this.relay.sourceDebugger) return {};
    if (method.startsWith("MacInspector."))
      return this.relay.changes.command(
        method.slice(13),
        p.node ? { ...p, node: this.nativeId(p.node) } : p,
      );
    if (method === "DOM.undo") {
      await this.relay.changes.undo();
      return {};
    }
    if (method === "DOM.redo") {
      await this.relay.changes.redo();
      return {};
    }
    if (
      method.startsWith("Debugger.") ||
      (method === "Runtime.getProperties" && p.objectId?.startsWith("lldb-"))
    ) {
      if (!this.relay.sourceDebugger)
        throw Error(
          "Native stepping is disabled; use --source-debug with a debuggable app",
        );
      return this.relay.sourceDebugger.handle(this.owner, this.emit, method, p);
    }
    if (method === "DOM.enable") {
      this.domEnabled = true;
      return {};
    }
    if (method === "DOM.disable") {
      this.domEnabled = false;
      return {};
    }
    if (method === "CSS.enable") {
      this.cssEnabled = true;
      for (const id of this.nodes.keys())
        this.emit("CSS.styleSheetAdded", { header: this.sheet(id) });
      return {};
    }
    if (method === "CSS.disable") {
      this.cssEnabled = false;
      return {};
    }
    if (method === "DOM.getDocument") {
      await this.relay.refresh();
      this.domEnabled = true;
      this.published.clear();
      return { root: this.publish(this.node(1, p.depth ?? 2)) };
    }
    if (method === "DOM.requestChildNodes") {
      this.children(p.nodeId, p.depth ?? 1);
      return {};
    }
    if (method === "DOM.describeNode")
      return {
        node: this.node(
          p.nodeId || p.backendNodeId || this.object(p.objectId).__nativeID,
          p.depth ?? 0,
        ),
      };
    if (method === "DOM.getAttributes")
      return { attributes: this.node(p.nodeId).attributes || [] };
    if (method === "DOM.querySelector" || method === "DOM.querySelectorAll") {
      const ids = this.query(p.selector, p.nodeId === 1 ? undefined : p.nodeId);
      return method.endsWith("All")
        ? { nodeIds: ids }
        : { nodeId: ids[0] || 0 };
    }
    if (method === "DOM.pushNodesByBackendIdsToFrontend")
      return {
        nodeIds: p.backendNodeIds.map((id) => {
          if (!this.relay.domNodes.has(id)) return 0;
          this.path(id);
          return id;
        }),
      };
    if (method === "DOM.resolveNode")
      return {
        object: this.remote(
          this.wrap(p.nodeId || p.backendNodeId),
          p.objectGroup,
        ),
      };
    if (method === "DOM.requestNode")
      return { nodeId: this.object(p.objectId).__nativeID };
    if (method === "DOM.setInspectedNode") {
      this.selected = p.nodeId;
      return {};
    }
    if (method === "DOM.setAttributeValue" || method === "DOM.setNodeValue") {
      await this.relay.changes.attribute(
        method === "DOM.setNodeValue"
          ? this.textId(p.nodeId)
          : this.nativeId(p.nodeId),
        p.name || "text",
        p.value,
      );
      await this.relay.refresh();
      return {};
    }
    if (method === "DOM.setAttributesAsText") {
      const matches = [
        ...p.text.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g),
      ];
      if (!matches.length) throw Error("Use a quoted native attribute value");
      for (const [, key, double, single] of matches)
        await this.relay.changes.attribute(
          this.nativeId(p.nodeId),
          key,
          double ?? single,
        );
      await this.relay.refresh();
      return {};
    }
    if (method === "DOM.getOuterHTML") {
      return {
        outerHTML: outerHTML(this.relay.domNodes, p.nodeId || p.backendNodeId),
      };
    }
    if (method === "DOM.getBoxModel" || method === "DOM.getContentQuads") {
      const n = this.get(
          this.nativeId(
            p.nodeId || p.backendNodeId || this.object(p.objectId).__nativeID,
          ),
        ),
        q = [
          n.x,
          n.y,
          n.x + n.width,
          n.y,
          n.x + n.width,
          n.y + n.height,
          n.x,
          n.y + n.height,
        ];
      return method.endsWith("Quads")
        ? { quads: [q] }
        : {
            model: {
              content: q,
              padding: q,
              border: q,
              margin: q,
              width: n.width,
              height: n.height,
            },
          };
    }
    if (method === "DOM.getNodeForLocation") {
      const { node } = await this.relay.backend.request("locate", {
        x: p.x,
        y: p.y,
      });
      this.path(node);
      return { nodeId: node, backendNodeId: node, frameId: "native" };
    }
    if (method === "DOM.focus" || method === "DOM.scrollIntoViewIfNeeded") {
      if (method === "DOM.focus")
        await this.relay.backend.request("action", {
          node: this.nativeId(p.nodeId || p.backendNodeId),
          key: "focus",
        });
      return {};
    }
    if (method === "Overlay.setInspectMode") {
      if (!["none", "searchForNode", "searchForUAShadowDOM"].includes(p.mode))
        throw Error("Unsupported native inspect mode");
      await this.relay.inspect(this, p.mode !== "none");
      return {};
    }
    if (method === "Overlay.highlightNode" || method === "DOM.highlightNode") {
      await this.relay.backend.request("highlight", {
        node: this.nativeId(
          p.nodeId ||
            p.backendNodeId ||
            (p.objectId ? this.object(p.objectId).__nativeID : 0),
        ),
      });
      return {};
    }
    if (
      [
        "Overlay.hideHighlight",
        "DOM.hideHighlight",
        "Overlay.disable",
      ].includes(method)
    ) {
      if (method === "Overlay.disable") await this.relay.inspect(this, false);
      await this.relay.backend.request("highlight", { node: 0 });
      return {};
    }
    if (
      method === "CSS.getMatchedStylesForNode" ||
      method === "CSS.getInlineStylesForNode"
    ) {
      const id = this.nativeId(p.nodeId);
      const style = cssStyle(
        this.relay.styles.get(id)?.text || "",
        `native-${id}`,
      );
      if (
        method === "CSS.getMatchedStylesForNode" &&
        this.domGet(p.nodeId).nodeType === 3
      )
        return {
          matchedCSSRules: [],
          inherited: [{ inlineStyle: style, matchedCSSRules: [] }],
          pseudoElements: [],
        };
      return {
        inlineStyle: style,
        ...(method === "CSS.getMatchedStylesForNode"
          ? { matchedCSSRules: [], inherited: [], pseudoElements: [] }
          : {}),
      };
    }
    if (method === "CSS.getComputedStyleForNode") {
      const n = this.get(this.nativeId(p.nodeId));
      return {
        computedStyle: Object.entries({
          display: "block",
          position: "absolute",
          ...n.styles,
          width: `${n.width}px`,
          height: `${n.height}px`,
          left: `${n.x}px`,
          top: `${n.y}px`,
        }).map(([name, value]) => ({ name, value })),
      };
    }
    if (method === "CSS.getStyleSheetText") {
      const doc = this.relay.styles.get(Number(p.styleSheetId.slice(7)));
      if (!doc) throw Error("Stale native stylesheet");
      return { text: doc.text };
    }
    if (method === "CSS.setStyleTexts") {
      const styles = [];
      for (const edit of p.edits) {
        const id = Number(edit.styleSheetId.slice(7)),
          doc = this.relay.styles.get(id);
        if (!doc) throw Error("Stale stylesheet");
        await this.editStyle(id, (text) =>
          replaceCssRange(text, edit.range, edit.text),
        );
        styles.push(
          cssStyle(this.relay.styles.get(id).text, edit.styleSheetId),
        );
      }
      return { styles };
    }
    if (method === "CSS.setStyleSheetText") {
      await this.editStyle(Number(p.styleSheetId.slice(7)), p.text);
      return {};
    }
    if (method === "CSS.getMediaQueries") return { medias: [] };
    if (method === "CSS.getPlatformFontsForNode") return { fonts: [] };
    if (method === "CSS.getEnvironmentVariables")
      return { environmentVariables: {} };
    if (method === "CSS.getLayersForNode")
      return { rootLayer: { name: "", order: 0 } };
    if (method === "CSS.getBackgroundColors") return {};
    if (method === "Runtime.enable") {
      this.emit("Runtime.executionContextCreated", {
        context: {
          id: 1,
          origin: "macos://native",
          name: "Native UI bridge (host JavaScript)",
          auxData: { isDefault: true, type: "default", frameId: "native" },
        },
      });
      return {};
    }
    if (method === "Runtime.evaluate" || method === "Runtime.callFunctionOn") {
      this.pending = [];
      try {
        if (p.throwOnSideEffect)
          throw new EvalError(
            "Possible side-effect in debug-evaluate: native UI bridge cannot guarantee a pure evaluation",
          );
        let value;
        if (method === "Runtime.evaluate")
          value = vm.runInContext(p.expression, this.context, {
            timeout: 1000,
          });
        else {
          this.context.__target = p.objectId ? this.object(p.objectId) : null;
          this.context.__args = vm.runInContext("[]", this.context);
          for (const argument of p.arguments || []) {
            const value = argument.objectId
              ? this.object(argument.objectId)
              : vm.runInContext(
                  `JSON.parse(${JSON.stringify(JSON.stringify(argument.value ?? null))})`,
                  this.context,
                );
            this.context.__args.push(value);
          }
          value = vm.runInContext(
            `(${p.functionDeclaration}).apply(__target,__args)`,
            this.context,
            { timeout: 1000 },
          );
        }
        if (value && typeof value.then === "function")
          value = await Promise.race([
            value,
            new Promise((_, reject) => {
              const timer = setTimeout(
                () => reject(Error("Console promise timed out")),
                2000,
              );
              timer.unref();
            }),
          ]);
        await this.flush();
        return { result: this.remote(value, p.objectGroup, p.returnByValue) };
      } catch (error) {
        this.pending = [];
        return {
          result: {
            type: "object",
            subtype: "error",
            description:
              error instanceof EvalError ? String(error) : error.message,
          },
          exceptionDetails: {
            exceptionId: 1,
            text: error.message,
            lineNumber: 0,
            columnNumber: 0,
            exception: {
              type: "object",
              subtype: "error",
              description:
                error instanceof EvalError ? String(error) : error.message,
            },
          },
        };
      } finally {
        delete this.context.__target;
        delete this.context.__args;
      }
    }
    if (method === "Runtime.getProperties") {
      const descriptors = Object.getOwnPropertyDescriptors(
        this.object(p.objectId),
      );
      return {
        result: Object.entries(descriptors)
          .filter(([key]) => !key.startsWith("__"))
          .map(([name, d]) => ({
            name,
            enumerable: !!d.enumerable,
            configurable: !!d.configurable,
            isOwn: true,
            ...(Object.hasOwn(d, "value")
              ? { value: this.remote(d.value), writable: !!d.writable }
              : {
                  get: {
                    type: "function",
                    description: "native property getter",
                  },
                }),
          })),
        internalProperties: this.objects.get(p.objectId).handlerLocation
          ? [
              {
                name: "[[FunctionLocation]]",
                value: {
                  type: "object",
                  subtype: "internal#location",
                  value: this.objects.get(p.objectId).handlerLocation,
                },
              },
            ]
          : [],
      };
    }
    if (method === "Runtime.releaseObject") {
      this.objects.delete(p.objectId);
      return {};
    }
    if (method === "Runtime.releaseObjectGroup") {
      for (const [id, o] of this.objects)
        if (o.group === p.objectGroup) this.objects.delete(id);
      return {};
    }
    if (method === "Runtime.globalLexicalScopeNames") return { names: [] };
    if (method === "Page.getResourceTree" || method === "Page.getFrameTree") {
      const frame = {
        id: "native",
        loaderId: "native",
        url: "macos://native/",
        securityOrigin: "macos://native",
        mimeType: "text/html",
        domainAndRegistry: "",
        secureContextType: "Secure",
        crossOriginIsolatedContextType: "NotIsolated",
        gatedAPIFeatures: [],
      };
      return method.endsWith("ResourceTree")
        ? { frameTree: { frame, resources: [] } }
        : { frameTree: { frame } };
    }
    if (method === "Page.getLayoutMetrics") {
      const { width, height } = this.relay.snapshot,
        viewport = {
          pageX: 0,
          pageY: 0,
          clientWidth: width,
          clientHeight: height,
        };
      return {
        contentSize: { x: 0, y: 0, width, height },
        cssContentSize: { x: 0, y: 0, width, height },
        layoutViewport: viewport,
        cssLayoutViewport: viewport,
        visualViewport: { ...viewport, offsetX: 0, offsetY: 0, scale: 1 },
        cssVisualViewport: { ...viewport, offsetX: 0, offsetY: 0, scale: 1 },
      };
    }
    if (method === "Page.captureScreenshot")
      return this.relay.backend.request("screenshot");
    if (method === "Browser.getVersion")
      return {
        protocolVersion: "1.3",
        product: "MacInspector/0.1",
        revision: "",
        userAgent: "AppKit",
        jsVersion: "Host bridge",
      };
    if (method === "Accessibility.getPartialAXTree") return { nodes: [] };
    if (
      [
        "Page.enable",
        "Page.disable",
        "Page.setLifecycleEventsEnabled",
        "Runtime.disable",
        "Runtime.runIfWaitingForDebugger",
        "Runtime.discardConsoleEntries",
        "Runtime.setCustomObjectFormatterEnabled",
        "Log.enable",
        "Log.disable",
        "Inspector.enable",
        "Inspector.disable",
        "DOM.markUndoableState",
        "Overlay.enable",
        "Overlay.setShowViewportSizeOnResize",
        "Overlay.setShowGridOverlays",
        "Overlay.setShowFlexOverlays",
        "Overlay.setShowScrollSnapOverlays",
        "Overlay.setShowContainerQueryOverlays",
        "Overlay.setShowIsolatedElements",
        "Overlay.setShowAdHighlights",
        "CSS.forcePseudoState",
        "CSS.trackComputedStyleUpdates",
        "CSS.trackComputedStyleUpdatesForNode",
        "Emulation.setEmulatedMedia",
      ].includes(method)
    )
      return {};
    throw Error(`Unsupported native protocol method: ${method}`);
  }
}
