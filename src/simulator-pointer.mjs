// SPDX-License-Identifier: MIT
import { spawn } from "node:child_process";
import readline from "node:readline";

export function simulatorViewport(window, viewport, chrome) {
  let { top, right, bottom, left } = chrome;
  if (viewport.width > viewport.height)
    [top, right, bottom, left] = [right, bottom, left, top];
  const scale = window.width / (viewport.width + left + right);
  if (
    ![scale, window.x, window.y, viewport.height].every(Number.isFinite) ||
    scale <= 0 ||
    viewport.width <= 0 ||
    viewport.height <= 0 ||
    (viewport.height + top + bottom) * scale > window.height
  )
    return null;
  // The device body is bottom aligned beneath Simulator's own toolbar. Read
  // its bezel insets from Xcode, rather than assuming a toolbar height or zoom.
  return {
    x: window.x + left * scale,
    y: window.y + window.height - (viewport.height + bottom) * scale,
    width: viewport.width * scale,
    height: viewport.height * scale,
    scale,
  };
}

export function simulatorPoint(sample, viewport, chrome) {
  if (!sample.inside) return { inside: false };
  // Only ordinary app windows block this target. macOS shell surfaces may report
  // an opaque full-display rectangle even when only a small part is drawn.
  if (
    sample.foreground?.some(
      (window) =>
        window.layer === 0 &&
        sample.pointer.x >= window.x &&
        sample.pointer.x < window.x + window.width &&
        sample.pointer.y >= window.y &&
        sample.pointer.y < window.y + window.height,
    )
  )
    return { inside: false };
  const rect = simulatorViewport(sample.window, viewport, chrome);
  if (!rect || !sample.pointer) return { inside: false };
  const x = (sample.pointer.x - rect.x) / rect.scale;
  const y = (sample.pointer.y - rect.y) / rect.scale;
  return Number.isFinite(x) &&
    Number.isFinite(y) &&
    x >= 0 &&
    y >= 0 &&
    x < viewport.width &&
    y < viewport.height
    ? { inside: true, x, y }
    : { inside: false };
}

export function attachSimulatorPointer(
  backend,
  { executable, device, chrome, launch = spawn },
) {
  const child = launch(executable, [], { stdio: ["pipe", "pipe", "inherit"] });
  const request = backend.request.bind(backend);
  const shutdown = backend.shutdown;
  let owner,
    viewport,
    latest,
    forwarding = false,
    generation = 0;
  const warnings = new Set();
  const warn = (reason) => {
    if (warnings.has(reason)) return;
    warnings.add(reason);
    console.error(
      `Simulator pointer hover: ${reason} Touch picking remains available.`,
    );
  };
  const configure = (enabled) => {
    if (!child.stdin.destroyed)
      child.stdin.write(
        JSON.stringify({ enabled, device: device.name }) + "\n",
      );
  };
  const stop = () => {
    owner = null;
    latest = null;
    generation++;
    configure(false);
  };
  const forward = async () => {
    if (
      forwarding ||
      !owner ||
      !viewport ||
      backend.suspended ||
      backend.closed
    )
      return;
    forwarding = true;
    try {
      while (latest && owner && !backend.suspended && !backend.closed) {
        const point = latest;
        latest = null;
        await request("hover", { ...point, owner });
      }
    } catch (error) {
      if (owner && !backend.suspended && !backend.closed) warn(error.message);
    } finally {
      forwarding = false;
    }
  };
  readline
    .createInterface({ input: child.stdout, crlfDelay: Infinity })
    .on("line", (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (!owner || backend.suspended) return;
      if (event.method === "unavailable") warn(event.params.reason);
      if (event.method !== "pointer" || !viewport) return;
      latest = simulatorPoint(event.params, viewport, chrome);
      void forward();
    });
  child.on("error", (error) => {
    stop();
    warn(error.message);
  });
  child.stdin.on("error", (error) => {
    stop();
    warn(error.message);
  });
  child.on("exit", (code, signal) => {
    if (!backend.closed && signal !== "SIGINT")
      warn(`Pointer helper exited (${signal || code}).`);
    owner = null;
    latest = null;
  });
  backend.on("event", (event) => {
    if (
      ["picked", "inspectCanceled"].includes(event.method) &&
      event.params?.owner === owner
    )
      stop();
  });
  backend.on("disconnected", stop);
  backend.request = async (method, params = {}) => {
    if (method === "inspect" && (params.enabled || params.owner === owner))
      stop();
    const current = generation;
    const result = await request(method, params);
    if (method === "snapshot")
      viewport = { width: result.width, height: result.height };
    if (method === "inspect" && params.enabled && generation === current) {
      owner = params.owner;
      configure(true);
    }
    return result;
  };
  backend.shutdown = () => {
    child.kill("SIGTERM");
    shutdown();
  };
  const suspend = backend.suspend.bind(backend);
  backend.suspend = (paused) => {
    if (paused) stop();
    suspend(paused);
  };
  return backend;
}
