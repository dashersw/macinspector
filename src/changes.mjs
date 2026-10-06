// SPDX-License-Identifier: MIT
import { Session } from "./session.mjs";
import { parseCssDeclarations, setCssProperty } from "./css.mjs";

const clone = (value) => structuredClone(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const priorityKeys = [
  "huggingHorizontal",
  "huggingVertical",
  "compressionHorizontal",
  "compressionVertical",
];

export class Changes {
  constructor(relay) {
    this.relay = relay;
    this.entries = [];
    this.cursor = 0;
    this.next = 0;
    this.targets = new Map();
    this.baselines = new Map();
    this.currentEdits = new Map();
    this.queue = Promise.resolve();
    this.queued = 0;
    this.session = new Session(relay, (method, params) => {
      for (const session of relay.sessions) session.emit(method, params);
    });
  }
  run(action) {
    if (this.queued >= 256)
      return Promise.reject(Error("Native edit queue limit exceeded"));
    this.queued++;
    const pending = this.queue.then(action).finally(() => this.queued--);
    this.queue = pending.catch(() => {});
    return pending;
  }
  target(node) {
    if (this.targets.has(node)) return this.targets.get(node);
    const n = this.session.get(node);
    const target = { tag: n.tag };
    const identifier = n.attributes.id;
    if (
      identifier &&
      [...this.relay.nodes.values()].filter(
        (n) => n.attributes.id === identifier,
      ).length === 1
    )
      target.id = identifier;
    else {
      const path = [];
      let current = n;
      while (current.id !== this.relay.snapshot.root) {
        const parent = this.session.get(current.parent);
        path.unshift(parent.children.indexOf(current.id));
        current = parent;
        if (path.length > 128) throw Error("Native tree path exceeds limit");
      }
      target.path = path;
    }
    this.targets.set(node, target);
    return target;
  }
  resolve(target) {
    if (!target || typeof target.tag !== "string")
      throw Error("Invalid override target");
    let id;
    if (typeof target.id === "string" && target.id) {
      const matches = [...this.relay.nodes.values()].filter(
        (n) => n.attributes.id === target.id,
      );
      if (matches.length !== 1)
        throw Error(`Missing or ambiguous native identifier: ${target.id}`);
      id = matches[0].id;
    } else if (Array.isArray(target.path) && target.path.length <= 128) {
      id = this.relay.snapshot.root;
      for (const index of target.path) {
        if (!Number.isInteger(index) || index < 0)
          throw Error("Invalid override path");
        id = this.session.get(id).children[index];
        if (!id) throw Error("Override path no longer exists");
      }
    } else throw Error("Invalid override locator");
    if (this.session.get(id).tag !== target.tag)
      throw Error("Override target class changed");
    return id;
  }
  styleState(node) {
    const doc = this.relay.styles.get(node);
    if (!doc) throw Error("Stale native stylesheet");
    return clone({
      text: doc.text,
      overrides: doc.overrides || [],
      authored: doc.authored || [],
    });
  }
  async attributeState(node, key) {
    if (this.relay.snapshot.capabilities.includes("attribute-state"))
      return this.relay.backend.request("attribute-state", { node, key });
    return { node, key, value: await this.attributeValue(node, key, true) };
  }
  async attributeValue(node, key, snapshotOnly = false) {
    if (
      !snapshotOnly &&
      this.relay.snapshot.capabilities.includes("attribute-state")
    )
      return (
        await this.relay.backend.request("attribute-state", { node, key })
      ).value;
    const n = this.session.get(node);
    return key === "text" ? n.text : (n.attributes[key] ?? "");
  }
  remember(entry) {
    if (equal(entry.before, entry.after)) return;
    entry.target = clone(this.target(entry.node));
    entry.id = ++this.next;
    const identity = `${entry.kind}:${entry.node}:${entry.key || ""}`;
    if (!this.baselines.has(identity))
      this.baselines.set(identity, clone(entry.before));
    if (entry.kind !== "style") this.currentEdits.set(identity, clone(entry));
    this.entries.splice(this.cursor);
    this.entries.push(entry);
    if (this.entries.length > 200) this.entries.shift();
    this.cursor = this.entries.length;
  }
  editStyle(session, node, text) {
    return this.run(async () => {
      this.target(node);
      const before = this.styleState(node);
      await session.applyStyle(
        node,
        typeof text === "function" ? text(before.text) : text,
      );
      this.remember({
        kind: "style",
        node,
        before,
        after: this.styleState(node),
      });
    });
  }
  attribute(node, key, value) {
    return this.run(async () => {
      const original = await this.attributeState(node, key);
      this.target(original.node);
      const before = original.value;
      await this.relay.backend.request("attribute", {
        node,
        key,
        value: String(value),
      });
      await this.relay.refresh();
      this.remember({
        kind: "attribute",
        node: original.node,
        key: original.key,
        before,
        after: await this.attributeValue(original.node, original.key),
      });
    });
  }
  async layout(node) {
    if (this.relay.snapshot.capabilities.includes("swiftui"))
      throw Error(
        "SwiftUI uses its own layout system. Register width, height or spacing bindings and edit them in Styles.",
      );
    if (!this.relay.snapshot.capabilities.includes("layout"))
      throw Error(
        "Native Auto Layout requires the MacInspector SDK; Accessibility exposes no constraints",
      );
    return this.relay.backend.request("layout", { node });
  }
  editLayout(node, params) {
    return this.run(() => this.applyLayout(node, params));
  }
  async applyLayout(node, params) {
    this.target(node);
    const layout = await this.layout(node);
    const constraint =
      params.constraint &&
      layout.constraints.find((c) => c.id === params.constraint);
    if (params.constraint && !constraint)
      throw Error("Stale native constraint");
    const keys = constraint ? ["constant", "priority", "active"] : priorityKeys;
    const before = Object.fromEntries(
      keys.map((key) => [key, (constraint || layout)[key]]),
    );
    await this.relay.backend.request("layout-edit", { ...params, node });
    await this.relay.refresh();
    const updated = await this.layout(node);
    const state = constraint
      ? updated.constraints.find((c) => c.id === constraint.id)
      : updated;
    const after = Object.fromEntries(keys.map((key) => [key, state[key]]));
    this.remember({
      kind: "layout",
      node,
      key: constraint?.id || "priorities",
      constraintKey: constraint?.key,
      before,
      after,
    });
    return updated;
  }
  async apply(entry, state) {
    if (entry.kind === "style")
      await this.session.applyStyle(entry.node, state.text, state);
    if (entry.kind === "attribute")
      await this.relay.backend.request("attribute", {
        node: entry.node,
        key: entry.key,
        value: state,
      });
    if (entry.kind === "layout")
      await this.relay.backend.request("layout-edit", {
        node: entry.node,
        ...(entry.key !== "priorities" ? { constraint: entry.key } : {}),
        ...state,
      });
    await this.relay.refresh();
    if (entry.kind !== "style")
      this.currentEdits.set(`${entry.kind}:${entry.node}:${entry.key}`, {
        ...clone(entry),
        after: clone(state),
      });
  }
  undo() {
    return this.run(async () => {
      if (!this.cursor) return this.list();
      await this.apply(
        this.entries[this.cursor - 1],
        this.entries[this.cursor - 1].before,
      );
      this.cursor--;
      return this.list();
    });
  }
  redo() {
    return this.run(async () => {
      if (this.cursor >= this.entries.length) return this.list();
      await this.apply(
        this.entries[this.cursor],
        this.entries[this.cursor].after,
      );
      this.cursor++;
      return this.list();
    });
  }
  revert(id) {
    return this.run(async () => {
      const entry = this.entries.slice(0, this.cursor).find((e) => e.id === id);
      if (!entry) throw Error("This change is no longer applied");
      const current =
        entry.kind === "style"
          ? this.styleState(entry.node)
          : entry.kind === "attribute"
            ? await this.attributeValue(entry.node, entry.key)
            : await this.layout(entry.node).then((layout) => {
                const value =
                  entry.key === "priorities"
                    ? layout
                    : layout.constraints.find((c) => c.id === entry.key);
                if (!value) throw Error("Stale constraint");
                return Object.fromEntries(
                  Object.keys(entry.after).map((key) => [key, value[key]]),
                );
              });
      if (!equal(current, entry.after))
        throw Error("Later edits overlap this change; undo those first");
      await this.apply(entry, entry.before);
      this.remember({ ...entry, before: current, after: clone(entry.before) });
      return this.list();
    });
  }
  list() {
    return {
      canUndo: this.cursor > 0,
      canRedo: this.cursor < this.entries.length,
      entries: this.entries.map((e, i) => ({ ...e, applied: i < this.cursor })),
    };
  }
  export() {
    const groups = new Map();
    const group = (node) => {
      if (!groups.has(node))
        groups.set(node, { target: clone(this.target(node)) });
      return groups.get(node);
    };
    for (const [node, doc] of this.relay.styles) {
      const authored = new Set(doc.authored || []);
      const styles = parseCssDeclarations(doc.text)
        .filter((p) => authored.has(p.name))
        .map((p) => ({
          name: p.name,
          value: p.value,
          ...(p.disabled ? { disabled: true } : {}),
        }));
      if (styles.length) group(node).styles = styles;
    }
    for (const [identity, entry] of this.currentEdits) {
      if (
        !this.relay.nodes.has(entry.node) ||
        equal(entry.after, this.baselines.get(identity))
      )
        continue;
      const edit = group(entry.node);
      if (entry.kind === "attribute")
        (edit.attributes ||= {})[entry.key] = entry.after;
      else if (entry.key === "priorities") edit.priorities = clone(entry.after);
      else
        (edit.constraints ||= []).push({
          key: entry.constraintKey,
          ...entry.after,
        });
    }
    return {
      version: 1,
      bundleId: this.relay.snapshot.bundleId || "",
      edits: [...groups.values()],
    };
  }
  swift() {
    const json = JSON.stringify(this.export(), null, 2);
    let delimiter = "#";
    while (json.includes('"""' + delimiter)) delimiter += "#";
    return `#if DEBUG\nlet overrides = ${delimiter}"""\n${json}\n"""${delimiter}\ntry inspector.applyOverrides(Data(overrides.utf8))\n#endif\n`;
  }
  import(document) {
    return this.run(async () => {
      if (
        document?.version !== 1 ||
        !Array.isArray(document.edits) ||
        document.edits.length > 256
      )
        throw Error("Invalid overrides file");
      if (
        document.bundleId &&
        document.bundleId !== this.relay.snapshot.bundleId
      )
        throw Error("Overrides belong to a different app");
      const resolved = document.edits.map((edit) => ({
        ...edit,
        node: this.resolve(edit.target),
      }));
      const applied = [];
      const currentEdits = new Map(this.currentEdits);
      try {
        for (const edit of resolved) {
          this.target(edit.node);
          if (edit.styles) {
            if (!Array.isArray(edit.styles) || edit.styles.length > 128)
              throw Error("Invalid override styles");
            let text = this.relay.styles.get(edit.node).text;
            for (const p of edit.styles) {
              if (
                typeof p.name !== "string" ||
                typeof p.value !== "string" ||
                !/^-?[a-z][\w-]*$/.test(p.name)
              )
                throw Error("Invalid override declaration");
              text = setCssProperty(text, p.name, p.value);
              if (p.disabled) {
                const declaration = parseCssDeclarations(text).findLast(
                  (value) => value.name === p.name,
                );
                text =
                  text.slice(0, declaration.start) +
                  `/* ${declaration.text} */` +
                  text.slice(declaration.end);
              }
            }
            const before = this.styleState(edit.node);
            const names = edit.styles.map((p) => p.name);
            const active = edit.styles
              .filter((p) => !p.disabled)
              .map((p) => p.name);
            await this.session.applyStyle(edit.node, text, {
              overrides: [...new Set([...before.overrides, ...active])],
              authored: [...new Set([...before.authored, ...names])],
            });
            const entry = {
              kind: "style",
              node: edit.node,
              before,
              after: this.styleState(edit.node),
            };
            applied.push(entry);
          }
          for (const [key, value] of Object.entries(edit.attributes || {})) {
            if (typeof value !== "string")
              throw Error("Invalid override attribute");
            const original = await this.attributeState(edit.node, key);
            this.target(original.node);
            const before = original.value;
            await this.relay.backend.request("attribute", {
              node: edit.node,
              key,
              value,
            });
            await this.relay.refresh();
            applied.push({
              kind: "attribute",
              node: original.node,
              key: original.key,
              before,
              after: await this.attributeValue(original.node, original.key),
            });
          }
          for (const values of [
            ...(edit.constraints || []),
            ...(edit.priorities ? [edit.priorities] : []),
          ]) {
            const layout = await this.layout(edit.node);
            const constraint = values.key
              ? (
                  await this.relay.backend.request("layout-resolve", {
                    node: edit.node,
                    key: values.key,
                  })
                ).constraint
              : undefined;
            const source = constraint
              ? layout.constraints.find((c) => c.id === constraint)
              : layout;
            const keys = constraint
              ? ["constant", "priority", "active"]
              : priorityKeys;
            const before = Object.fromEntries(
              keys.map((key) => [key, source[key]]),
            );
            await this.relay.backend.request("layout-edit", {
              node: edit.node,
              constraint,
              ...values,
            });
            await this.relay.refresh();
            const next = await this.layout(edit.node);
            const state = constraint
              ? next.constraints.find((c) => c.id === constraint)
              : next;
            applied.push({
              kind: "layout",
              node: edit.node,
              key: constraint || "priorities",
              constraintKey: values.key,
              before,
              after: Object.fromEntries(keys.map((key) => [key, state[key]])),
            });
          }
        }
      } catch (error) {
        let rollbackError;
        for (const entry of applied.reverse()) {
          try {
            await this.apply(entry, entry.before);
          } catch (failure) {
            rollbackError ||= failure;
          }
        }
        this.currentEdits = currentEdits;
        if (rollbackError)
          throw Error(
            `${error.message}; rollback failed: ${rollbackError.message}`,
          );
        throw error;
      }
      applied.forEach((entry) => this.remember(entry));
      return this.list();
    });
  }
  async command(method, params = {}) {
    if (method === "getLayout") return this.layout(params.node);
    if (method === "setLayout") return this.editLayout(params.node, params);
    if (method === "highlightConstraint") {
      await this.relay.backend.request("layout-highlight", {
        constraint: params.constraint || "",
      });
      return {};
    }
    if (method === "getChanges") return this.list();
    if (method === "undo") return this.undo();
    if (method === "redo") return this.redo();
    if (method === "revert") return this.revert(params.id);
    if (method === "exportOverrides") return this.export();
    if (method === "applyOverrides") return this.import(params.document);
    if (method === "exportSwift") return { source: this.swift() };
    throw Error("Unsupported native inspector command");
  }
}
