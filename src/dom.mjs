// SPDX-License-Identifier: MIT

// Keep the CDP presentation separate from native identities and override paths.
// Native IDs are positive; each text child uses its owner's negated ID.
export function projectNativeDOM(nativeNodes) {
  const modes = new Map(
    [...nativeNodes].map(([id, node]) => [
      id,
      node.textMode ??
        (Object.hasOwn(node.attributes, "value")
          ? "value"
          : node.text
            ? "content"
            : "none"),
    ]),
  );
  const hasTextDescendant = (node) => {
    if (!node.text) return false;
    const pending = [...node.children],
      seen = new Set([node.id]);
    while (pending.length) {
      const id = pending.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      const child = nativeNodes.get(id);
      if (modes.get(id) === "content" && child.text === node.text) return true;
      pending.push(...child.children);
    }
    return false;
  };
  const nodes = new Map();
  for (const [id, node] of nativeNodes) {
    const content = modes.get(id) === "content";
    const attributes = { ...node.attributes };
    delete attributes.style;
    if (content) {
      delete attributes.text;
      if (attributes.value === node.text) delete attributes.value;
    }
    const textChild = content && !hasTextDescendant(node);
    nodes.set(id, {
      ...node,
      nodeType: 1,
      attributes,
      children: [...(textChild ? [-id] : []), ...node.children],
    });
    if (textChild)
      nodes.set(-id, {
        ...node,
        id: -id,
        parent: id,
        owner: id,
        textOwner: node.textOwner || id,
        nodeType: 3,
        tag: "#text",
        attributes: {},
        children: [],
        styles: {},
      });
  }
  return nodes;
}

export function outerHTML(nodes, id) {
  const escape = (text) =>
    String(text ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;");
  const visit = (id, seen) => {
    if (seen.has(id)) throw Error("Cyclic native tree");
    const node = nodes.get(id);
    if (!node) throw Error("Stale native element");
    if (node.nodeType === 3) return escape(node.text);
    const path = new Set([...seen, id]);
    const attributes = Object.entries(node.attributes)
      .map(([key, value]) => ` ${key}="${escape(value)}"`)
      .join("");
    return `<${node.tag}${attributes}>${node.children.map((child) => visit(child, path)).join("")}</${node.tag}>`;
  };
  return visit(id, new Set());
}
