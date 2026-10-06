// SPDX-License-Identifier: MIT
import { execFile } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);

export async function runningApplications(executable) {
  const { stdout } = await execute(executable, ["--list-apps"], {
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  });
  const { apps } = JSON.parse(stdout);
  if (
    !Array.isArray(apps) ||
    apps.some(
      (app) =>
        !Number.isInteger(app.pid) ||
        app.pid <= 0 ||
        typeof app.name !== "string" ||
        typeof app.bundleId !== "string" ||
        typeof app.executable !== "string",
    )
  )
    throw Error("Invalid running-app response from AccessibilityBridge");
  return apps;
}

export function formatApplications(apps, { numbered = false } = {}) {
  const rows = [
    ["PID", "APP", "BUNDLE ID"],
    ...apps.map((app) => [String(app.pid), app.name, app.bundleId || "—"]),
  ];
  if (numbered)
    rows.forEach((row, index) => row.unshift(index ? `${index}.` : ""));
  const widths = rows[0].map((_, column) =>
    Math.max(...rows.map((row) => row[column].length)),
  );
  return rows
    .map((row) =>
      row
        .map((cell, column) =>
          column === row.length - 1 ? cell : cell.padEnd(widths[column]),
        )
        .join("  "),
    )
    .join("\n");
}

export function findApplication(apps, selector) {
  const query = selector.trim().toLowerCase();
  if (!query) throw Error("App name or bundle ID must not be empty");
  let matches = apps.filter((app) => app.bundleId.toLowerCase() === query);
  if (!matches.length)
    matches = apps.filter((app) =>
      [app.name, app.executable].some((value) => value.toLowerCase() === query),
    );
  if (!matches.length)
    throw Error(
      `No running app matches ${JSON.stringify(selector)}. Run macinspector apps to see available targets.`,
    );
  if (matches.length > 1)
    throw Error(
      `More than one running app matches ${JSON.stringify(selector)}. Choose a bundle ID or --pid:\n${formatApplications(matches)}`,
    );
  return matches[0];
}

export async function pickApplication(apps) {
  if (!apps.length) throw Error("No running GUI apps are available to inspect");
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw Error(
      "Supply an app name, bundle ID or --pid. Run macinspector apps to list targets; the app picker requires an interactive terminal.",
    );
  console.log(formatApplications(apps, { numbered: true }));
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  terminal.once("close", cancel);
  try {
    while (true) {
      const answer = (
        await terminal.question("\nChoose an app number (q to cancel): ", {
          signal: controller.signal,
        })
      ).trim();
      if (answer.toLowerCase() === "q") throw Error("App selection canceled");
      const index = /^\d+$/.test(answer) ? Number(answer) - 1 : -1;
      if (Number.isSafeInteger(index) && apps[index]) return apps[index];
      console.log(`Choose a number between 1 and ${apps.length}.`);
    }
  } catch (error) {
    if (error.name === "AbortError") throw Error("App selection canceled");
    throw error;
  } finally {
    terminal.off("close", cancel);
    terminal.close();
  }
}
