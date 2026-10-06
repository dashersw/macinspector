// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { chooseSimulator } from "../src/ios.mjs";
import {
  simulatorPoint,
  simulatorViewport,
} from "../src/simulator-pointer.mjs";

test("Simulator pointer maps display coordinates across zoom, rotation and window movement", () => {
  const chrome = { top: 18, right: 27, bottom: 18, left: 27 };
  const viewport = { width: 440, height: 956 };
  const window = { x: 2457, y: 30, width: 494, height: 1054 };
  assert.deepEqual(simulatorViewport(window, viewport, chrome), {
    x: 2484,
    y: 110,
    width: 440,
    height: 956,
    scale: 1,
  });
  assert.deepEqual(
    simulatorPoint(
      { inside: true, window, pointer: { x: 2704, y: 405 } },
      viewport,
      chrome,
    ),
    {
      inside: true,
      x: 220,
      y: 295,
    },
  );
  const smaller = { x: -500, y: -100, width: 247, height: 551 };
  assert.deepEqual(
    simulatorPoint(
      { inside: true, window: smaller, pointer: { x: -376.5, y: 111.5 } },
      viewport,
      chrome,
    ),
    {
      inside: true,
      x: 220,
      y: 295,
    },
  );
  const landscape = { width: 956, height: 440 };
  assert.deepEqual(
    simulatorViewport(
      { x: 50, y: 0, width: 992, height: 546 },
      landscape,
      chrome,
    ),
    {
      x: 68,
      y: 79,
      width: 956,
      height: 440,
      scale: 1,
    },
  );
  for (const pointer of [
    { x: 2460, y: 110 },
    { x: 2704, y: 50 },
    { x: 2924, y: 405 },
  ])
    assert.deepEqual(
      simulatorPoint({ inside: true, window, pointer }, viewport, chrome),
      { inside: false },
    );
  assert.deepEqual(simulatorPoint({ inside: false }, viewport, chrome), {
    inside: false,
  });
  const shell = { layer: 20, x: 0, y: 0, width: 3200, height: 1800 };
  const sample = {
    inside: true,
    window,
    pointer: { x: 2704, y: 405 },
    foreground: [shell],
  };
  assert.equal(
    simulatorPoint(sample, viewport, chrome).inside,
    true,
    "A full-display Dock surface must not suppress all Simulator hover",
  );
  sample.foreground.push({ ...shell, layer: 0 });
  assert.equal(
    simulatorPoint(sample, viewport, chrome).inside,
    false,
    "An ordinary app window in front must still block hover",
  );
  assert.equal(
    simulatorViewport(window, { width: 0, height: 956 }, chrome),
    null,
  );
});

test("iOS simulator selection respects booted devices, names, UDIDs and ambiguity", () => {
  const devices = {
    "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
      { name: "iPhone Demo", udid: "A", isAvailable: true, state: "Shutdown" },
      { name: "iPad Demo", udid: "B", isAvailable: true, state: "Booted" },
    ],
    "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [
      { name: "iPhone Demo", udid: "C", isAvailable: true, state: "Shutdown" },
      { name: "Unavailable", udid: "D", isAvailable: false, state: "Shutdown" },
    ],
    "com.apple.CoreSimulator.SimRuntime.watchOS-26-0": [
      { name: "Watch", udid: "W", isAvailable: true, state: "Booted" },
    ],
  };
  assert.equal(chooseSimulator(devices).udid, "B");
  assert.equal(chooseSimulator(devices, "a").udid, "A");
  assert.equal(chooseSimulator(devices, "IPAD DEMO").udid, "B");
  assert.throws(() => chooseSimulator(devices, "iPhone Demo"), /Multiple/);
  assert.throws(() => chooseSimulator(devices, "Unavailable"), /No available/);
  devices["com.apple.CoreSimulator.SimRuntime.iOS-26-5"][1].state = "Shutdown";
  assert.equal(chooseSimulator(devices).udid, "C");
  assert.throws(() => chooseSimulator({}), /Install an iOS/);
});
