#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { discoverConnection, connectDiscovered } from "../src/discovery.mjs";
import { mkdirSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import net from "node:net";
import { connectAppKit, connectAccessibility } from "../src/backends.mjs";
import { createRelay } from "../src/relay.mjs";
import { prepareIOS } from "../src/ios.mjs";
import { SourceDebugger } from "../src/source-debugger.mjs";
import { ensureFrontend } from "../src/frontend.mjs";
import {
  runningApplications,
  formatApplications,
  findApplication,
  pickApplication,
} from "../src/targets.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const argv = process.argv.slice(2),
  command = argv.shift();
function option(name, fallback) {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw Error(`Missing ${name} value`);
  argv.splice(index, 2);
  return value;
}
function port(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535)
    throw Error("Port must be an integer between 1024 and 65535");
  return parsed;
}
function run(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(Error(`${executable} exited ${code}`)),
    );
  });
}
let app, backend, relay, sourceDebugger, saveOverrides, sourceTarget;
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  let failure;
  try {
    if (relay && saveOverrides) {
      await relay.changes.queue;
      await writeFile(
        saveOverrides,
        JSON.stringify(relay.changes.export(), null, 2) + "\n",
        { mode: 0o600 },
      );
    }
  } catch (error) {
    failure = error;
  }
  try {
    if (relay) await relay.close();
    else {
      await sourceDebugger?.close({ terminate: sourceDebugger.launched });
      backend?.close();
    }
  } finally {
    app?.kill("SIGTERM");
  }
  if (failure) throw failure;
  process.exit(0);
};
const stopFailed = (error) => {
  console.error(`Error closing inspector: ${error.message}`);
  process.exit(1);
};
process.on("SIGINT", () => stop().catch(stopFailed));
process.on("SIGTERM", () => stop().catch(stopFailed));

async function available(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", () =>
      reject(
        Error(
          `Port ${port} is already in use; choose another --port/--native-port`,
        ),
      ),
    );
    server.listen(port, "127.0.0.1", resolve);
  });
  await new Promise((resolve) => server.close(resolve));
}
try {
  if (!["demo", "attach", "connect", "apps"].includes(command)) {
    console.log(
      "Usage:\n  macinspector demo [--ui native|swiftui] [--platform macos|ios] [--simulator <name|UDID>] [--port 9333] [--no-open] [--no-source-debug]\n  macinspector apps [--json]\n  macinspector attach [<app name | bundle ID> | --pid <pid>] [--platform macos|ios] [--simulator <name|UDID>] [--port 9333] [--source-debug]\n  macinspector connect --native-port <port> --token <secret> [--source-debug --app <name> | --pid <pid>]\n\nRun attach without a target to choose a running macOS app interactively. iOS requires an SDK-enabled simulator app's bundle ID. SDK discovery and free ports are automatic.\n  --overrides <file>       Reapply saved native edits\n  --save-overrides <file>  Save native edits on Ctrl+C",
    );
    process.exit(command ? 2 : 0);
  }
  if (process.platform !== "darwin")
    throw Error("Native inspection requires macOS");
  const platform = option("--platform", "macos");
  const ui = option("--ui", "native");
  if (!["native", "swiftui"].includes(ui))
    throw Error("Use --ui native or swiftui");
  if (ui !== "native" && command !== "demo")
    throw Error("--ui selects the demo; attach detects the SDK automatically");
  const deviceSelector = option("--simulator", undefined);
  if (!["macos", "ios"].includes(platform))
    throw Error("Use --platform macos or ios");
  if (deviceSelector && platform !== "ios")
    throw Error("--simulator requires --platform ios");
  if (command === "apps" && platform === "ios")
    throw Error(
      "Use xcrun simctl listapps <device> to list installed iOS apps",
    );
  const accessibilityBridge = path.join(
    root,
    ".build/debug/AccessibilityBridge",
  );
  if (command === "apps") {
    const json = argv.includes("--json");
    if (json) argv.splice(argv.indexOf("--json"), 1);
    if (argv.length) throw Error(`Unknown arguments: ${argv.join(" ")}`);
    await run(
      "swift",
      ["build", "--product", "AccessibilityBridge", "--jobs", "1"],
      {
        cwd: root,
        stdio: ["ignore", 2, "inherit"],
      },
    );
    const apps = await runningApplications(accessibilityBridge);
    console.log(json ? JSON.stringify(apps) : formatApplications(apps));
    process.exit(0);
  }
  const portOption = option("--port", undefined);
  const debugPort = port(portOption || "9333");
  const nativePortOption = option("--native-port", undefined);
  const nativePort =
    nativePortOption === undefined ? 0 : port(nativePortOption);
  const overridesFile = option("--overrides", undefined);
  saveOverrides = option("--save-overrides", undefined);
  let bundleId = "";
  const pidOption = option("--pid", undefined);
  let pid = pidOption === undefined ? 0 : Number(pidOption);
  if (
    pidOption !== undefined &&
    (!/^\d+$/.test(pidOption) ||
      !Number.isInteger(pid) ||
      pid <= 0 ||
      pid > 2147483647)
  )
    throw Error("--pid must be a positive process ID");
  const token = option("--token", process.env.MACINSPECTOR_TOKEN || "");
  let selector = option("--app", undefined);
  const noOpen = argv.includes("--no-open");
  if (noOpen) argv.splice(argv.indexOf("--no-open"), 1);
  const sourceFlag = argv.includes("--source-debug");
  const noSource = argv.includes("--no-source-debug");
  if (sourceFlag) argv.splice(argv.indexOf("--source-debug"), 1);
  if (noSource) argv.splice(argv.indexOf("--no-source-debug"), 1);
  if (sourceFlag && noSource)
    throw Error("Choose --source-debug or --no-source-debug");
  const sources = !noSource && (command === "demo" || sourceFlag);
  if (command === "attach" && argv.length === 1 && !argv[0].startsWith("-")) {
    if (selector !== undefined) throw Error("Choose one app target");
    selector = argv.shift();
  }
  if (argv.length) throw Error(`Unknown arguments: ${argv.join(" ")}`);
  if (selector !== undefined && pidOption !== undefined)
    throw Error("Choose an app name/bundle ID or --pid, not both");
  if (command === "demo" && (selector !== undefined || pidOption !== undefined))
    throw Error(
      "The demo launches its own app; use attach for a running target",
    );
  if (command === "connect" && selector !== undefined && !sources)
    throw Error(
      "--app selects the LLDB target and requires --source-debug with connect",
    );
  if (command === "connect" && sources && !pid && selector === undefined)
    throw Error("Native source debugging requires --app or --pid");
  if (
    platform === "macos" &&
    (command === "attach" || selector !== undefined)
  ) {
    await run(
      "swift",
      ["build", "--product", "AccessibilityBridge", "--jobs", "1"],
      {
        cwd: root,
        stdio: ["ignore", 2, "inherit"],
      },
    );
    const apps = await runningApplications(accessibilityBridge);
    if (pid) bundleId = apps.find((app) => app.pid === pid)?.bundleId || "";
    if (!pid) {
      const target =
        selector === undefined
          ? await pickApplication(apps)
          : findApplication(apps, selector);
      pid = target.pid;
      bundleId = target.bundleId;
      console.log(`Target: ${target.name} · PID ${pid}`);
    }
  }
  if (command === "demo" && nativePort === debugPort)
    throw Error("Native and CDP ports must differ");
  if (portOption !== undefined) await available(debugPort);
  const frontend = await ensureFrontend();
  if (command === "demo" && nativePort) await available(nativePort);
  if (command === "demo" && platform === "macos")
    await run("swift", ["build", "--jobs", "1"], { cwd: root });
  if (platform === "ios" && command !== "connect") {
    const ios = await prepareIOS({
      root,
      demo: command === "demo",
      ui,
      selector,
      deviceSelector,
      nativePort,
      pid,
    });
    backend = ios.backend;
    pid = ios.pid;
    app = ios.app;
    sourceTarget = {
      executable: ios.executable,
      platform: "ios-simulator",
      sdkRoot: ios.sdkRoot,
    };
  } else if (command === "demo") {
    const product = ui === "swiftui" ? "SwiftUIShowcase" : "NativeShowcase";
    const name = ui === "swiftui" ? "SwiftUI Showcase" : "Native Mac Showcase";
    const contents = path.join(root, `.build/${name}.app/Contents`);
    mkdirSync(path.join(contents, "MacOS"), { recursive: true });
    copyFileSync(
      path.join(
        root,
        ui === "swiftui"
          ? "demo/swiftui/macos/Info.plist"
          : "demo/macos/Info.plist",
      ),
      path.join(contents, "Info.plist"),
    );
    copyFileSync(
      path.join(root, `.build/debug/${product}`),
      path.join(contents, `MacOS/${product}`),
    );
    await run("codesign", [
      "--force",
      "--sign",
      "-",
      "--entitlements",
      path.join(root, "demo/macos/Debug.entitlements"),
      path.dirname(contents),
    ]);
    const executable = path.join(contents, `MacOS/${product}`);
    const env = {
      ...process.env,
      MACINSPECTOR_NATIVE_PORT: String(nativePort),
    };
    if (sources) {
      sourceDebugger = new SourceDebugger();
      sourceDebugger.on("output", (text) => process.stderr.write(text));
      await sourceDebugger.start({ executable, env, cwd: root });
      app = {
        pid: sourceDebugger.pid,
        kill(signal) {
          try {
            process.kill(this.pid, signal);
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
        },
      };
    } else {
      app = spawn(executable, [], { stdio: "inherit", env });
      app.on("error", (error) => console.error(error.message));
    }
    let lastError;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (sourceDebugger?.failure) throw sourceDebugger.failure;
      if (sourceDebugger?.paused)
        throw Error(
          "Native app stopped before its inspector was ready: " +
            (sourceDebugger.lastPaused?.data.description || "unknown stop") +
            " at " +
            (sourceDebugger.frames?.[0]?.function || "unknown native frame"),
        );
      if (app.exitCode != null)
        throw Error("Native showcase exited before its inspector was ready");
      try {
        const record = await discoverConnection(
          app.pid,
          ui === "swiftui"
            ? "com.dashersw.macinspector.swiftuishowcase"
            : "com.dashersw.macinspector.showcase",
        );
        if (!record) throw Error("Waiting for SDK connection record");
        backend = await connectDiscovered(record);
        break;
      } catch (error) {
        backend?.close();
        backend = null;
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    if (!backend)
      throw Error(
        "Native inspector was not ready within 60 seconds: " +
          lastError?.message,
      );
  } else if (command === "attach") {
    const record = await discoverConnection(pid, bundleId);
    if (record) backend = await connectDiscovered(record);
    else {
      console.log(
        "No SDK connection found; using Accessibility. Tree, supported values and actions only; native styles, constraints and screenshots require the SDK.",
      );
      backend = connectAccessibility({ executable: accessibilityBridge, pid });
    }
  } else {
    if (!nativePort)
      throw Error(
        "connect requires --native-port; use attach for automatic discovery",
      );
    if (token.length < 32)
      throw Error(
        "Supply the app’s inspector token with --token or MACINSPECTOR_TOKEN",
      );
    backend = await connectAppKit({ port: nativePort, token });
  }
  if (sources && !sourceDebugger) {
    sourceDebugger = new SourceDebugger();
    sourceDebugger.on("progress", (text) => console.log(`LLDB: ${text}`));
    await sourceDebugger.start({ pid, ...sourceTarget });
  }
  relay = await createRelay({
    backend,
    port: debugPort,
    autoPort: portOption === undefined,
    sourceDebugger,
    frontend,
  });
  if (overridesFile)
    await relay.changes.import(
      JSON.parse(await readFile(overridesFile, "utf8")),
    );
  console.log(
    `\n${relay.snapshot.title}\nBackend: ${relay.snapshot.backend} · ${relay.nodes.size} native elements${app?.pid || pid ? ` · PID ${app?.pid || pid}` : ""}\nCapabilities: ${relay.snapshot.capabilities.join(", ")}\nSources: ${sourceDebugger ? "LLDB native breakpoints and stepping" : "disabled"}\nChrome: ${relay.frontend}\nPreview: ${relay.url}\nCtrl+C closes this inspector${app ? " and its demo app" : ""}.\n`,
  );
  if (!noOpen) await run("open", ["-a", "Google Chrome", relay.frontend]);
  backend.on("disconnected", () => {
    if (!stopping) stop().catch(stopFailed);
  });
  sourceDebugger?.on("ended", () => {
    if (!stopping) stop().catch(stopFailed);
  });
  app?.on?.("exit", () => {
    if (!stopping) stop().catch(stopFailed);
  });
} catch (error) {
  console.error(`Error: ${error.message}`);
  await relay?.close().catch(() => {});
  await sourceDebugger?.close().catch(() => {});
  backend?.close();
  app?.kill("SIGTERM");
  process.exitCode = 1;
}
