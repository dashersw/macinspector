// SPDX-License-Identifier: MIT
export function installHostedZoom(host, win = globalThis.window) {
  if (!win?.document || !host.isHostedMode()) return;

  const steps = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
  const preference = "macinspector-ui-zoom";
  let factor = 1;
  try {
    const saved = Number(win.localStorage.getItem(preference));
    if (steps.includes(saved)) factor = saved;
  } catch {}

  win.document.documentElement.style.zoom = String(factor);
  const apply = (next) => {
    if (next === factor) return;
    factor = next;
    win.document.documentElement.style.zoom = String(factor);
    try {
      win.localStorage.setItem(preference, String(factor));
    } catch {}
    // DevTools recalculates panel sizes and overlay coordinates on resize.
    win.dispatchEvent(new win.Event("resize"));
  };
  host.zoomFactor = () => factor;
  host.zoomIn = () =>
    apply(steps[Math.min(steps.indexOf(factor) + 1, steps.length - 1)]);
  host.zoomOut = () => apply(steps[Math.max(steps.indexOf(factor) - 1, 0)]);
  host.resetZoom = () => apply(1);

  // Capture before the standalone host's document listener swallows zoom keys.
  win.addEventListener(
    "keydown",
    (event) => {
      const modified =
        host.platform() === "mac"
          ? event.metaKey && !event.ctrlKey
          : event.ctrlKey && !event.metaKey;
      if (!modified || event.altKey || event.defaultPrevented) return;

      let action;
      if (["+", "="].includes(event.key) || event.code === "NumpadAdd")
        action = host.zoomIn;
      else if (
        ["-", "_"].includes(event.key) ||
        event.code === "NumpadSubtract"
      )
        action = host.zoomOut;
      else if (
        !event.shiftKey &&
        (event.key === "0" || event.code === "Numpad0")
      )
        action = host.resetZoom;
      if (!action) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      action();
    },
    true,
  );
}
