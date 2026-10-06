// SPDX-License-Identifier: MIT
// Declaration text is the inspector's source. Engine snapshots are projections:
// a shorthand may expand to several properties without authoring any of them.
export function cssRange(text, start = 0, end = text.length) {
  const position = (offset) => {
    const before = text.slice(0, offset).split("\n");
    return [before.length - 1, before.at(-1).length];
  };
  const [startLine, startColumn] = position(start);
  const [endLine, endColumn] = position(end);
  return { startLine, startColumn, endLine, endColumn };
}

export function replaceCssRange(text, range, replacement) {
  const offset = (line, column) => {
    const lines = text.split("\n");
    if (
      !Number.isInteger(line) ||
      !Number.isInteger(column) ||
      line < 0 ||
      line >= lines.length ||
      column < 0 ||
      column > lines[line].length
    )
      throw new Error(
        "Invalid or outdated style range; refresh the style and retry",
      );
    return (
      lines.slice(0, line).reduce((n, part) => n + part.length + 1, 0) + column
    );
  };
  const start = offset(range.startLine, range.startColumn);
  const end = offset(range.endLine, range.endColumn);
  if (end < start)
    throw new Error(
      "Invalid or outdated style range; refresh the style and retry",
    );
  return text.slice(0, start) + replacement + text.slice(end);
}

export function parseCssDeclarations(text) {
  const properties = [];
  const add = (start, end, disabled = false) => {
    while (/\s/.test(text[start] || "") && start < end) start++;
    const source = text.slice(start, end);
    const declaration = disabled ? source.slice(2, -2).trim() : source;
    const match =
      /^\s*(--[\w-]+|[a-zA-Z][\w-]*)\s*:\s*([\s\S]*?)\s*;?\s*$/.exec(
        declaration,
      );
    if (!match) return;
    const name = match[1].startsWith("--") ? match[1] : match[1].toLowerCase();
    const value = match[2].trim();
    properties.push({
      name,
      value,
      text: source,
      important: /!\s*important\s*$/i.test(value),
      implicit: false,
      parsedOk: !!value,
      disabled,
      range: cssRange(text, start, end),
      start,
      end,
    });
  };
  let start = 0,
    quote = "",
    depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      if (close < 0) break;
      if (!text.slice(start, i).trim() && depth === 0) {
        add(i, close + 2, true);
        start = close + 2;
      }
      i = close + 1;
    } else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
    else if (c === ";" && depth === 0) {
      add(start, i + 1);
      start = i + 1;
    }
  }
  add(start, text.length);
  return properties;
}

export function cssStyle(text, styleSheetId) {
  return {
    styleSheetId,
    cssText: text,
    range: cssRange(text),
    shorthandEntries: [],
    cssProperties: parseCssDeclarations(text).map(
      ({ start, end, ...property }) => property,
    ),
  };
}

export function cssValues(text) {
  const values = {};
  for (const property of parseCssDeclarations(text))
    if (!property.disabled && property.parsedOk)
      values[property.name] = property.value;
  return values;
}

export function serializeCss(values) {
  return Object.entries(values)
    .filter(([, value]) => value !== "")
    .map(([name, value]) => `${name}: ${value};`)
    .join(" ");
}

export function setCssProperty(text, name, value) {
  const matches = parseCssDeclarations(text).filter((p) => p.name === name);
  if (!matches.length)
    return value
      ? `${text}${text && !/\s$/.test(text) ? " " : ""}${name}: ${value};`
      : text;
  const last = matches.at(-1);
  for (const property of matches.reverse())
    text =
      text.slice(0, property.start) +
      (property === last && value ? `${name}: ${value};` : "") +
      text.slice(property.end);
  return text;
}

export function reconcileCss(document, projection) {
  projection = Object.fromEntries(
    Object.entries(projection).filter(([, value]) => value !== ""),
  );
  if (!document) return { text: serializeCss(projection), projection };
  if (document.editing) return document;
  let text = document.text;
  for (const key of new Set([
    ...Object.keys(document.projection),
    ...Object.keys(projection),
  ]))
    if (document.projection[key] !== projection[key])
      text = setCssProperty(text, key, projection[key] || "");
  return { ...document, text, projection };
}

export function cssMutations(previous, projection, next) {
  const active = (text) =>
    parseCssDeclarations(text)
      .filter((p) => !p.disabled && p.parsedOk)
      .map((p) => [p.name, p.value]);
  if (JSON.stringify(active(previous)) === JSON.stringify(active(next)))
    return [];
  const operations = [
    ...new Set([
      ...Object.keys(projection),
      ...Object.keys(cssValues(previous)),
    ]),
  ].map((key) => ({ key, value: "" }));
  for (const property of parseCssDeclarations(next))
    if (!property.disabled && property.parsedOk)
      operations.push({ key: property.name, value: property.value });
  return operations;
}
