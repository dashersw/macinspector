// SPDX-License-Identifier: MIT
import * as UI from "../ui/legacy/legacy.js";
import * as SDK from "../core/sdk/sdk.js";
import { parseCssDeclarations } from "./css.js";

async function command(method, params = {}) {
  const response = await fetch("/native/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || "Native inspector unavailable");
  return result;
}
function element(tag, text, parent) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  parent?.append(node);
  return node;
}
function download(name, text, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = element("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
class NativePanel extends UI.Widget.VBox {
  constructor() {
    super();
    element(
      "style",
      `
      .native-body{padding:12px;font:12px/1.5 system-ui;color:var(--sys-color-on-surface);overflow:auto;--native-muted:var(--sys-color-on-surface-subtle);--native-line:var(--sys-color-divider);--native-accent:var(--sys-color-primary)}
      .native-body h3{margin:4px 0 10px;font-size:14px}.native-body h4{margin:8px 0}
      .native-body p{margin:6px 0}.native-body button,.native-body input{font:inherit;color:inherit;background:var(--sys-color-surface);border:1px solid var(--sys-color-outline);border-radius:4px;padding:4px 7px}
      .native-body button{cursor:pointer}.native-body button:disabled{opacity:.5;cursor:default}
      .native-toolbar{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}
      .native-row{border-top:1px solid var(--sys-color-outline-variant);padding:10px 0}
      .native-fields{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px}
      .native-fields label{display:flex;gap:5px;align-items:center}.native-fields input[type=number]{width:70px}
      .native-body code,.native-body pre{font:11px/1.5 monospace;white-space:pre-wrap;overflow-wrap:anywhere}
      .native-body .error{color:var(--sys-color-error);white-space:pre-wrap}.native-body .muted{opacity:.7}
      .native-before{color:var(--sys-color-error)}.native-after{color:var(--sys-color-primary)}
      .native-body .error:empty{display:none}.native-body button:hover{background:var(--sys-color-state-hover-on-subtle)}
      .native-body :is(button,input,summary):focus-visible{outline:2px solid var(--native-accent);outline-offset:2px}
      .layout-header{display:flex;gap:8px;align-items:flex-start;margin-bottom:12px}.layout-header .identity{min-width:0;flex:1}
      .layout-header .eyebrow{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--native-muted)}
      .layout-header h3{font-size:13px;margin:2px 0;overflow-wrap:anywhere}.layout-state{display:inline-flex;font-size:10px;line-height:20px;padding:0 6px;border-radius:3px;background:var(--sys-color-surface-variant);white-space:nowrap}
      .layout-state.warning{color:var(--sys-color-error)}.layout-metrics{display:grid;grid-template-columns:1fr 1fr;border:1px solid var(--native-line);border-radius:5px;overflow:hidden;margin-bottom:14px}
      .layout-metric{padding:8px 10px}.layout-metric+.layout-metric{border-left:1px solid var(--native-line)}.layout-metric span{display:block;color:var(--native-muted);font-size:10px}
      .layout-metric strong{font-size:18px;font-weight:500;font-variant-numeric:tabular-nums;line-height:1.5}.layout-metric small{font-size:11px;color:var(--native-muted);margin-left:4px}
      .layout-section-title{font-size:11px;font-weight:600;margin:12px 0 6px;display:flex;justify-content:space-between;align-items:center}
      .layout-priorities{display:grid;grid-template-columns:minmax(105px,1fr) 64px 64px;gap:5px 8px;align-items:center}.layout-priorities .axis{font-size:10px;text-align:center;color:var(--native-muted)}
      .layout-priorities input{width:100%;box-sizing:border-box;padding:3px 5px;text-align:right;font-variant-numeric:tabular-nums}.layout-priorities .priority-label{color:var(--native-muted)}
      .layout-note{font-size:10px;color:var(--native-muted);margin:8px 0 14px!important}.layout-tools{display:flex;gap:6px;margin:14px 0 10px;align-items:center}
      .layout-tools button{padding:3px 7px;border-color:var(--native-line);white-space:nowrap}.layout-tools button[aria-pressed=true]{background:var(--sys-color-tonal-container);color:var(--native-accent);border-color:transparent}
      .layout-group-title{color:var(--native-muted);font-size:10px;text-transform:uppercase;letter-spacing:.06em;margin:14px 0 5px;display:flex;justify-content:space-between}
      .layout-constraint{border:1px solid var(--native-line);border-radius:4px;margin:5px 0;background:var(--sys-color-surface)}.layout-constraint.inactive{opacity:.65}.layout-constraint[open]{border-color:var(--sys-color-outline)}
      .layout-constraint summary{cursor:pointer;list-style:none;padding:8px 10px}.layout-constraint summary::-webkit-details-marker{display:none}.layout-summary{display:flex;gap:7px;align-items:center}
      .layout-chevron{color:var(--native-muted);font-size:10px;transition:transform .12s}.layout-constraint[open] .layout-chevron{transform:rotate(90deg)}
      .layout-attribute{font-weight:600;flex:1;min-width:0}.layout-value{font-variant-numeric:tabular-nums}.layout-priority{color:var(--native-muted);font-size:10px;border-left:1px solid var(--native-line);padding-left:7px;white-space:nowrap}
      .layout-relationship{margin:5px 0 0 16px;font-size:11px;color:var(--native-muted);overflow-wrap:anywhere}.layout-relationship .relation{color:var(--native-accent);padding:0 4px}
      .layout-editor{border-top:1px solid var(--native-line);padding:9px 10px}.layout-editor .native-fields{margin:0;gap:10px}.layout-editor label{color:var(--native-muted);font-size:11px}.layout-editor input[type=number]{width:65px;font-variant-numeric:tabular-nums}.layout-editor input[type=checkbox]{padding:0;accent-color:var(--native-accent)}
      .layout-editor .constraint-id{font-size:10px;color:var(--native-muted);margin:8px 0 0;overflow-wrap:anywhere}.layout-editor .native-toolbar{margin:8px 0 0;gap:6px}.layout-editor button{font-size:11px;padding:3px 7px}
      @media(prefers-reduced-motion:reduce){.layout-chevron{transition:none}}
    `,
      this.contentElement,
    );
    this.body = element("div", undefined, this.contentElement);
    this.body.className = "native-body";
    this.error = element("p", undefined, this.body);
    this.error.className = "error";
    this.error.setAttribute("role", "status");
    this.main = element("div", undefined, this.body);
    this.generation = 0;
  }
  async act(action) {
    this.error.textContent = "";
    try {
      await action();
    } catch (error) {
      this.error.textContent = error.message;
    }
  }
  button(parent, title, action) {
    const button = element("button", title, parent);
    button.addEventListener("click", () => this.act(action));
    return button;
  }
  wasShown() {
    this.refresh();
    this.timer = setInterval(() => {
      let focused =
        this.main.getRootNode().activeElement || document.activeElement;
      while (focused?.shadowRoot?.activeElement)
        focused = focused.shadowRoot.activeElement;
      if (!this.main.contains(focused)) this.refresh();
    }, 1500);
  }
  willHide() {
    clearInterval(this.timer);
    this.generation++;
  }
  wasHidden() {
    this.willHide();
  }
}
class LayoutPanel extends NativePanel {
  constructor() {
    super();
    this.expanded = new Set();
    this.onlyDirect = true;
  }
  wasShown() {
    super.wasShown();
    UI.Context.Context.instance().addFlavorChangeListener(
      SDK.DOMModel.DOMNode,
      this.selection,
      this,
    );
  }
  willHide() {
    super.willHide();
    UI.Context.Context.instance().removeFlavorChangeListener(
      SDK.DOMModel.DOMNode,
      this.selection,
      this,
    );
    command("highlightConstraint").catch(() => {});
  }
  selection() {
    this.lastLayout = "";
    this.refresh();
  }
  field(parent, name, value, update, visibleLabel = true) {
    const label = element("label", visibleLabel ? name : undefined, parent);
    const input = element("input", undefined, label);
    input.type = "number";
    input.value = value;
    input.step = "any";
    if (/Priority|Hugging|Compression/.test(name)) {
      input.min = "1";
      input.max = "1000";
    }
    input.setAttribute("aria-label", name);
    let saved = String(value),
      busy = false;
    const commit = () =>
      this.act(async () => {
        if (busy || input.value === saved) return;
        if (!input.value.trim() || !input.checkValidity())
          throw Error("Enter a finite numeric value");
        busy = true;
        try {
          await update(Number(input.value));
          saved = input.value;
          this.lastLayout = "";
          await this.refresh();
        } finally {
          busy = false;
        }
      });
    input.addEventListener("change", commit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commit();
      }
    });
    return input;
  }
  async refresh() {
    const selected = UI.Context.Context.instance().flavor(SDK.DOMModel.DOMNode);
    const node = selected?.id;
    const generation = ++this.generation;
    if (!node || node < 3) {
      this.main.replaceChildren();
      element("p", "Select a native view in Elements.", this.main);
      return;
    }
    try {
      const layout = await command("getLayout", { node });
      if (generation !== this.generation) return;
      if (this.node !== node) {
        this.node = node;
        this.expanded.clear();
        const first = layout.constraints.find((c) => c.direct);
        if (first) this.expanded.add(first.id);
      }
      const fingerprint = JSON.stringify([node, layout, this.onlyDirect]);
      if (fingerprint === this.lastLayout) return;
      this.lastLayout = fingerprint;
      this.error.textContent = "";
      this.main.replaceChildren();
      const header = element("div", undefined, this.main);
      header.className = "layout-header";
      const identity = element("div", undefined, header);
      identity.className = "identity";
      element("div", "Auto Layout", identity).className = "eyebrow";
      element("h3", layout.name || selected.nodeName(), identity);
      element(
        "span",
        layout.ambiguous ? "Ambiguous" : "Resolved",
        header,
      ).className = `layout-state${layout.ambiguous ? " warning" : ""}`;
      const metrics = element("div", undefined, this.main);
      metrics.className = "layout-metrics";
      for (const [key, title] of [
        ["width", "Intrinsic width"],
        ["height", "Intrinsic height"],
      ]) {
        const metric = element("div", undefined, metrics);
        metric.className = "layout-metric";
        element("span", title, metric);
        const value = layout.intrinsic[key];
        element(
          "strong",
          value === -1 ? "—" : `${Math.round(value * 100) / 100}`,
          metric,
        );
        element("small", value === -1 ? "not defined" : "pt", metric);
      }
      element("div", "Content priorities", this.main).className =
        "layout-section-title";
      const priorities = element("div", undefined, this.main);
      priorities.className = "layout-priorities";
      element("span", undefined, priorities);
      element("span", "Horizontal", priorities).className = "axis";
      element("span", "Vertical", priorities).className = "axis";
      for (const [key, title] of [
        ["hugging", "Hugging"],
        ["compression", "Compression"],
      ]) {
        element("span", title, priorities).className = "priority-label";
        for (const axis of ["Horizontal", "Vertical"]) {
          this.field(
            priorities,
            `${title} ${axis}`,
            layout[key + axis],
            (value) => command("setLayout", { node, [key + axis]: value }),
            false,
          ).title =
            key === "hugging"
              ? "Resists growing beyond intrinsic size"
              : "Resists shrinking below intrinsic size";
        }
      }
      element(
        "p",
        layout.translatesAutoresizingMask
          ? "Autoresizing mask generates additional constraints."
          : "Hover a relationship to highlight its native views. Enter or blur saves an edit.",
        this.main,
      ).className = "layout-note";
      const tools = element("div", undefined, this.main);
      tools.className = "layout-tools";
      for (const [direct, title] of [
        [true, "This view"],
        [false, "All affecting"],
      ]) {
        const button = this.button(tools, title, async () => {
          this.onlyDirect = direct;
          await this.refresh();
        });
        button.setAttribute("aria-pressed", String(this.onlyDirect === direct));
      }
      const groups = new Map([
        ["Size", []],
        ["Horizontal", []],
        ["Vertical", []],
        ["Other", []],
      ]);
      for (const c of layout.constraints.filter(
        (c) => !this.onlyDirect || c.direct,
      )) {
        const group = c.firstAttribute.startsWith("native attribute")
          ? "Other"
          : ["width", "height"].includes(c.firstAttribute)
            ? "Size"
            : ["left", "right", "leading", "trailing", "centerX"].includes(
                  c.firstAttribute,
                )
              ? "Horizontal"
              : "Vertical";
        groups.get(group).push(c);
      }
      const number = (value) => `${Math.round(value * 100) / 100}`;
      const attribute = (value) =>
        ({
          centerX: "Center X",
          centerY: "Center Y",
          firstBaseline: "First baseline",
          lastBaseline: "Last baseline",
        })[value] || value[0].toUpperCase() + value.slice(1);
      for (const [group, constraints] of groups) {
        if (!constraints.length) continue;
        const title = element("div", group, this.main);
        title.className = "layout-group-title";
        element("span", String(constraints.length), title);
        for (const constraint of constraints) {
          const row = element("details", undefined, this.main);
          row.className = `layout-constraint${constraint.active ? "" : " inactive"}`;
          row.open = this.expanded.has(constraint.id);
          row.addEventListener("toggle", () => {
            if (!row.isConnected) return;
            if (row.open) this.expanded.add(constraint.id);
            else this.expanded.delete(constraint.id);
          });
          row.addEventListener("mouseenter", () =>
            command("highlightConstraint", { constraint: constraint.id }).catch(
              () => {},
            ),
          );
          row.addEventListener("mouseleave", () =>
            command("highlightConstraint").catch(() => {}),
          );
          const summary = element("summary", undefined, row);
          const line = element("div", undefined, summary);
          line.className = "layout-summary";
          element("span", "▶", line).className = "layout-chevron";
          element(
            "span",
            attribute(constraint.firstAttribute),
            line,
          ).className = "layout-attribute";
          element(
            "span",
            `${constraint.relation} ${constraint.second ? `${constraint.multiplier === 1 ? "" : `${number(constraint.multiplier)} × `}${attribute(constraint.secondAttribute)}${constraint.constant === 0 ? "" : ` ${constraint.constant > 0 ? "+" : "−"} ${number(Math.abs(constraint.constant))} pt`}` : `${number(constraint.constant)} pt`}`,
            line,
          ).className = "layout-value";
          const priority = element(
            "span",
            constraint.active
              ? constraint.priority === 1000
                ? "Required"
                : `${number(constraint.priority)}`
              : "Inactive",
            line,
          );
          priority.className = "layout-priority";
          priority.title = `Priority ${constraint.priority} / 1000`;
          const relation = element("div", undefined, summary);
          relation.className = "layout-relationship";
          const itemName = (id, name, guide) =>
            id === node ? `This view${guide ? ` / ${guide}` : ""}` : name;
          element(
            "span",
            itemName(
              constraint.first,
              constraint.firstLabel,
              constraint.firstGuide,
            ),
            relation,
          );
          if (constraint.second) {
            element("span", constraint.relation, relation).className =
              "relation";
            element(
              "span",
              `${constraint.multiplier === 1 ? "" : `${number(constraint.multiplier)} × `}${itemName(constraint.second, constraint.secondLabel, constraint.secondGuide)} · ${attribute(constraint.secondAttribute)}`,
              relation,
            );
          }
          const editor = element("div", undefined, row);
          editor.className = "layout-editor";
          const fields = element("div", undefined, editor);
          fields.className = "native-fields";
          for (const [key, title] of [
            ["constant", "Constant"],
            ["priority", "Priority"],
          ])
            this.field(fields, title, constraint[key], (value) =>
              command("setLayout", {
                node,
                constraint: constraint.id,
                [key]: value,
              }),
            );
          const label = element("label", "Active", fields),
            input = element("input", undefined, label);
          input.type = "checkbox";
          input.setAttribute("aria-label", "Active");
          input.checked = constraint.active;
          input.addEventListener("change", () =>
            this.act(async () => {
              await command("setLayout", {
                node,
                constraint: constraint.id,
                active: input.checked,
              });
              this.lastLayout = "";
              await this.refresh();
            }),
          );
          const actions = element("div", undefined, editor);
          actions.className = "native-toolbar";
          this.button(actions, "Highlight relationship", () =>
            command("highlightConstraint", { constraint: constraint.id }),
          );
          if (constraint.identifier)
            element("p", constraint.identifier, editor).className =
              "constraint-id";
        }
      }
    } catch (error) {
      if (generation === this.generation) {
        this.main.replaceChildren();
        this.error.textContent = error.message;
      }
    }
  }
}
function styleDiff(entry) {
  const declarations = (text) =>
    new Map(
      parseCssDeclarations(text).map((p) => [
        p.name,
        `${p.disabled ? "disabled " : ""}${p.name}: ${p.value};`,
      ]),
    );
  const before = declarations(entry.before.text),
    after = declarations(entry.after.text);
  const lines = [];
  for (const key of new Set([...before.keys(), ...after.keys()]))
    if (before.get(key) !== after.get(key)) {
      if (before.has(key))
        lines.push(["native-before", "− " + before.get(key)]);
      if (after.has(key)) lines.push(["native-after", "+ " + after.get(key)]);
    }
  return lines;
}
class ChangesPanel extends NativePanel {
  async refresh() {
    const generation = ++this.generation;
    try {
      const changes = await command("getChanges");
      if (generation !== this.generation) return;
      this.main.replaceChildren();
      element("h3", "Native Changes", this.main);
      const tools = element("div", undefined, this.main);
      tools.className = "native-toolbar";
      this.button(tools, "Undo", async () => {
        await command("undo");
        await this.refresh();
      }).disabled = !changes.canUndo;
      this.button(tools, "Redo", async () => {
        await command("redo");
        await this.refresh();
      }).disabled = !changes.canRedo;
      this.button(tools, "Save overrides", async () =>
        download(
          "macinspector-overrides.json",
          JSON.stringify(await command("exportOverrides"), null, 2) + "\n",
        ),
      );
      this.button(tools, "Export Swift", async () =>
        download(
          "MacInspectorOverrides.swift",
          (await command("exportSwift")).source,
          "text/plain",
        ),
      );
      const file = element("input", undefined, tools);
      file.type = "file";
      file.accept = ".json,application/json";
      file.hidden = true;
      file.addEventListener("change", () =>
        this.act(async () => {
          if (!file.files[0]) return;
          if (file.files[0].size > 1_048_576)
            throw Error("Overrides file exceeds 1 MiB");
          await command("applyOverrides", {
            document: JSON.parse(await file.files[0].text()),
          });
          await this.refresh();
        }),
      );
      this.button(tools, "Load overrides", () => file.click());
      element(
        "p",
        "Styles, native values and constraints share this history. Saved overrides use native identifiers or checked hierarchy paths.",
        this.main,
      ).className = "muted";
      if (!changes.entries.length)
        element(
          "p",
          "No native edits yet. Edit Styles, a native value, or a constraint to start.",
          this.main,
        );
      for (const entry of changes.entries.toReversed()) {
        const row = element("div", undefined, this.main);
        row.className = "native-row";
        element(
          "strong",
          `${entry.target.tag}${entry.target.id ? "#" + entry.target.id : ""} · ${entry.kind}${entry.applied ? "" : " · undone"}`,
          row,
        );
        const lines =
          entry.kind === "style"
            ? styleDiff(entry)
            : [
                ["native-before", "− " + JSON.stringify(entry.before)],
                ["native-after", "+ " + JSON.stringify(entry.after)],
              ];
        for (const [className, text] of lines)
          element("pre", text, row).className = className;
        this.button(row, "Undo this change", async () => {
          await command("revert", { id: entry.id });
          await this.refresh();
        }).disabled = !entry.applied;
      }
    } catch (error) {
      if (generation === this.generation)
        this.error.textContent = error.message;
    }
  }
}
UI.ViewManager.registerViewExtension({
  location: "elements-sidebar",
  id: "macinspector.layout",
  title: () => "Native Layout",
  commandPrompt: () => "Show Native Layout",
  order: 3.5,
  persistence: "permanent",
  async loadView() {
    return new LayoutPanel();
  },
});
UI.ViewManager.registerViewExtension({
  location: "panel",
  id: "macinspector.changes",
  title: () => "Native Changes",
  commandPrompt: () => "Show Native Changes",
  order: 11,
  persistence: "permanent",
  async loadView() {
    return new ChangesPanel();
  },
});
