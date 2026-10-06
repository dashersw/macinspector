// SPDX-License-Identifier: MIT
import { createHash } from "node:crypto";
import { installHostedZoom } from "./hosted-zoom.mjs";

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");
function replaceOnce(source, old, replacement) {
  if (source.split(old).length !== 2)
    throw Error("Pinned DevTools patch no longer matches: " + old);
  return source.replace(old, replacement);
}
export function patchFrontend(file, data, pin) {
  if (!pin.patches[file]) return data;
  if (sha256(data) !== pin.patches[file])
    throw Error("Pinned DevTools integrity mismatch: " + file);
  let source = data.toString("utf8");
  if (file === "entrypoints/devtools_app/devtools_app.js") {
    source = 'import "../../native/panels.js";\n' + source;
  } else if (file === "core/host/host.js") {
    source = replaceOnce(
      source,
      "gn(globalThis.InspectorFrontendHost??new k),globalThis.InspectorFrontendAPI=new ze",
      "gn(globalThis.InspectorFrontendHost??new k),(" +
        installHostedZoom.toString() +
        ")(c),globalThis.InspectorFrontendAPI=new ze",
    );
  } else if (file === "entrypoints/main/main.js") {
    source = replaceOnce(
      source,
      'if(i.InspectorFrontendHost.InspectorFrontendHostInstance.isHostedMode())return!1;switch(t){case"main.zoom-in":',
      'switch(t){case"main.zoom-in":',
    );
  } else if (file === "panels/event_listeners/event_listeners.js") {
    source = replaceOnce(
      source,
      "async function _(C){",
      'async function _(C){if(C.runtimeModel().target().inspectedURL().startsWith("macos://"))return{eventListeners:[],internalHandlers:null};',
    );
    source = replaceOnce(
      source,
      "async onpopulate(){let t=[],e=this.#e,n=e.domDebuggerModel().runtimeModel();",
      'async onpopulate(){let t=[],e=this.#e,n=e.domDebuggerModel().runtimeModel();if(e.handler()?.className==="NativeAction"){let p=await e.handler().getOwnProperties(!1);for(let v of p.properties||[])t.push(new R.ObjectPropertiesSection.ObjectTreeNode(v,void 0,{readOnly:!0,propertiesMode:1}));R.ObjectPropertiesSection.ObjectPropertyTreeElement.populateWithProperties(this,{properties:t},!0,!0,void 0);return;}',
    );
  } else if (file === "core/sdk/sdk.js") {
    source = replaceOnce(
      source,
      "canRemove(){return!!this.#u",
      'canRemove(){if(this.#a?.objectId?.startsWith("native-handler-"))return!1;return!!this.#u',
    );
    source = replaceOnce(
      source,
      "canTogglePassive(){return this.#g",
      'canTogglePassive(){if(this.#a?.objectId?.startsWith("native-handler-"))return!1;return this.#g',
    );
    source = replaceOnce(
      source,
      'new xt.ContentData.ContentData(o,!1,"text/javascript")',
      'new xt.ContentData.ContentData(o,!1,/\\.swift(?:[?#]|$)/i.test(this.sourceURL)?"text/x-swift":"text/javascript")',
    );
  } else if (file === "models/bindings/bindings.js") {
    for (const variable of ["t", "e"])
      source = replaceOnce(
        source,
        variable + '.isWasm()?"application/wasm":"text/javascript"',
        variable +
          '.isWasm()?"application/wasm":/\\.swift(?:[?#]|$)/i.test(' +
          variable +
          '.sourceURL)?"text/x-swift":"text/javascript"',
      );
  } else if (file === "core/common/common.js") {
    source = replaceOnce(
      source,
      '["ts","text/typescript"]',
      '["swift","text/x-swift"],["ts","text/typescript"]',
    );
  } else if (file === "ui/components/code_highlighter/code_highlighter.js") {
    source =
      'import {swift as nativeSwift} from "../../../native/swift.js";\n' +
      source;
    source = replaceOnce(
      source,
      'case"text/x-kotlin":',
      'case"text/x-swift":return new e.LanguageSupport(e.StreamLanguage.define(nativeSwift));case"text/x-kotlin":',
    );
  }
  return Buffer.from(source);
}
