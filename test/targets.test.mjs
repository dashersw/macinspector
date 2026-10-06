// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  findApplication,
  formatApplications,
  runningApplications,
} from "../src/targets.mjs";

const apps = [
  {
    name: "Native Mac Showcase",
    bundleId: "com.example.showcase",
    executable: "NativeShowcase",
    pid: 101,
  },
  {
    name: "Editor",
    bundleId: "com.example.editor",
    executable: "Editor",
    pid: 102,
  },
  {
    name: "Editor",
    bundleId: "com.example.other-editor",
    executable: "OtherEditor",
    pid: 103,
  },
];

test("app lookup accepts names, bundle IDs and executable names with exact case-insensitive matching", () => {
  for (const selector of [
    "native mac showcase",
    "com.example.showcase",
    " NativeShowcase ",
  ])
    assert.equal(findApplication(apps, selector).pid, 101);
  assert.equal(findApplication(apps, "com.example.other-editor").pid, 103);
  assert.throws(
    () => findApplication(apps, "native"),
    /No running app matches/,
  );
  assert.throws(() => findApplication(apps, "  "), /must not be empty/);
});

test("duplicate app names and multiple instances never silently pick a process", () => {
  assert.throws(
    () => findApplication(apps, "Editor"),
    (error) =>
      /More than one/.test(error.message) &&
      /102/.test(error.message) &&
      /103/.test(error.message),
  );
  assert.throws(
    () =>
      findApplication(
        [...apps, { ...apps[0], pid: 104 }],
        "com.example.showcase",
      ),
    /More than one/,
  );
  assert.equal(
    findApplication(
      [...apps, { ...apps[0], name: "com.example.editor", pid: 105 }],
      "com.example.editor",
    ).pid,
    102,
  );
});

test("running-app table identifies processes and picker choices", () => {
  const table = formatApplications(apps, { numbered: true });
  assert.match(table, /PID\s+APP\s+BUNDLE ID/);
  assert.match(table, /1\.\s+101\s+Native Mac Showcase\s+com.example.showcase/);
  assert.match(formatApplications([{ ...apps[0], bundleId: "" }]), /—/);
});

test(
  "macOS app discovery produces scriptable JSON without starting a debugger",
  {
    skip: process.platform !== "darwin",
  },
  async () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["bin/macinspector.mjs", "apps", "--json"],
      { cwd: root, timeout: 30000 },
    );
    assert.ok(Array.isArray(JSON.parse(stdout)));
    const discovered = await runningApplications(
      fileURLToPath(
        new URL("../.build/debug/AccessibilityBridge", import.meta.url),
      ),
    );
    assert.ok(
      discovered.length > 0,
      "The desktop should contain a running GUI app",
    );
    assert.equal(
      new Set(discovered.map((app) => app.pid)).size,
      discovered.length,
    );
    await assert.rejects(
      promisify(execFile)(
        process.execPath,
        ["bin/macinspector.mjs", "attach", "--no-open"],
        { cwd: root, timeout: 30000 },
      ),
      (error) =>
        /app picker requires an interactive terminal/.test(error.stderr),
    );
  },
);
