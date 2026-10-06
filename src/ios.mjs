// SPDX-License-Identifier: MIT
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readdir, mkdir, copyFile, readFile } from "node:fs/promises";
import path from "node:path";
import { readConnection, connectDiscovered } from "./discovery.mjs";
import { attachSimulatorPointer } from "./simulator-pointer.mjs";

const execute = promisify(execFile);
const bundleId = "com.dashersw.macinspector.iosshowcase";

async function command(args) {
  return (
    await execute("xcrun", args, { maxBuffer: 4 * 1024 * 1024 })
  ).stdout.trim();
}

async function build(args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn("xcrun", args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(Error(`iOS build exited ${code}`)),
    );
  });
}

export function chooseSimulator(devices, selector) {
  const available = Object.entries(devices).flatMap(([runtime, entries]) =>
    runtime.includes(".iOS-")
      ? entries
          .filter((device) => device.isAvailable)
          .map((device) => ({ ...device, runtime }))
      : [],
  );
  const matches = selector
    ? available.filter(
        (device) =>
          device.udid.toLowerCase() === selector.toLowerCase() ||
          device.name.toLowerCase() === selector.toLowerCase(),
      )
    : available.filter((device) => device.state === "Booted");
  if (matches.length > 1)
    throw Error(
      "Multiple iOS simulators match; choose a device UDID with --simulator",
    );
  if (matches.length === 1) return matches[0];
  if (selector) throw Error(`No available iOS simulator matches ${selector}`);
  const version = (device) =>
    device.runtime
      .match(/iOS-(\d+)-(\d+)/)
      ?.slice(1)
      .map(Number) || [0, 0];
  available.sort(
    (a, b) =>
      version(b)[0] - version(a)[0] ||
      version(b)[1] - version(a)[1] ||
      Number(b.name.startsWith("iPhone")) -
        Number(a.name.startsWith("iPhone")) ||
      a.name.localeCompare(b.name),
  );
  if (!available.length)
    throw Error(
      "Install an iOS Simulator runtime in Xcode before using --platform ios",
    );
  return available[0];
}

export async function simulator(selector) {
  const version = Number(
    (await command(["--sdk", "iphonesimulator", "--show-sdk-version"])).split(
      ".",
    )[0],
  );
  const devices = JSON.parse(
    await command(["simctl", "list", "devices", "available", "--json"]),
  ).devices;
  // Prefer runtimes supported by the active SDK; newer beta runtimes can require
  // a different LLDB and simulator shared cache than the selected Xcode provides.
  const compatible = Object.fromEntries(
    Object.entries(devices).filter(
      ([runtime]) => Number(runtime.match(/iOS-(\d+)/)?.[1]) <= version,
    ),
  );
  const device = chooseSimulator(selector ? devices : compatible, selector);
  if (device.state !== "Booted") {
    console.log(`Booting ${device.name}…`);
    await command(["simctl", "boot", device.udid]);
  }
  await command(["simctl", "bootstatus", device.udid, "-b"]);
  return device;
}

async function connection(device, bundle, pid) {
  const container = await command([
    "simctl",
    "get_app_container",
    device.udid,
    bundle,
    "data",
  ]);
  const directory = path.join(
    container,
    "Library/Application Support/MacInspector/Connections",
  );
  let files;
  try {
    files = await readdir(directory);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  for (const file of files) {
    if (!/^\d+\.json$/.test(file)) continue;
    const current = Number(file.slice(0, -5));
    if (pid && current !== pid) continue;
    const record = await readConnection(path.join(directory, file), current);
    if (record && record.bundleId === bundle) return record;
  }
  return null;
}

async function simulatorChrome(device) {
  const types = JSON.parse(
    await command(["simctl", "list", "devicetypes", "--json"]),
  ).devicetypes;
  const type = types.find(
    (type) => type.identifier === device.deviceTypeIdentifier,
  );
  if (!type)
    throw Error("Xcode did not provide this simulator's device profile");
  const profile = JSON.parse(
    (
      await execute("plutil", [
        "-convert",
        "json",
        "-o",
        "-",
        path.join(type.bundlePath, "Contents/Resources/profile.plist"),
      ])
    ).stdout,
  );
  const name = profile.chromeIdentifier?.split(".").pop();
  if (!name || !/^[\w-]+$/.test(name))
    throw Error("The simulator has no device bezel metadata");
  const chrome = JSON.parse(
    await readFile(
      `/Library/Developer/DeviceKit/Chrome/${name}.devicechrome/Contents/Resources/chrome.json`,
      "utf8",
    ),
  );
  const sizing = chrome.images.sizing,
    padding = chrome.images.devicePadding;
  const insets = {
    top:
      sizing.topHeight + (padding?.top ?? chrome.images.padding?.height ?? 0),
    right:
      sizing.rightWidth + (padding?.right ?? chrome.images.padding?.width ?? 0),
    bottom:
      sizing.bottomHeight +
      (padding?.bottom ?? chrome.images.padding?.height ?? 0),
    left:
      sizing.leftWidth + (padding?.left ?? chrome.images.padding?.width ?? 0),
  };
  if (
    !Object.values(insets).every(
      (value) => Number.isFinite(value) && value >= 0 && value <= 1000,
    )
  )
    throw Error("Xcode's device bezel geometry is unsupported");
  return insets;
}

export async function prepareIOS({
  root,
  demo,
  ui = "native",
  selector,
  deviceSelector,
  nativePort = 0,
  pid = 0,
}) {
  const device = await simulator(deviceSelector);
  console.log(`Simulator: ${device.name} · ${device.udid}`);
  const swiftUI = ui === "swiftui";
  const product = swiftUI ? "SwiftUIShowcase" : "UIKitShowcase";
  const name = swiftUI ? "SwiftUI Showcase" : "UIKit Showcase";
  const bundle = demo
    ? swiftUI
      ? "com.dashersw.macinspector.swiftuiiosshowcase"
      : bundleId
    : selector;
  if (!bundle || !/^[\w.-]+$/.test(bundle))
    throw Error("iOS attachment requires the installed app's bundle ID");
  let app, executable;
  if (demo) {
    console.log(`Building ${name} and SDK…`);
    const output = path.join(root, ".build/ios");
    const contents = path.join(output, `${name}.app`);
    executable = path.join(contents, product);
    await mkdir(contents, { recursive: true });
    const sdk = await command(["--sdk", "iphonesimulator", "--show-sdk-path"]);
    const target = `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-ios16.0-simulator`;
    const files = (await readdir(path.join(root, "Sources/MacInspector")))
      .filter((file) => file.endsWith(".swift"))
      .map((file) => path.join(root, "Sources/MacInspector", file));
    const object = path.join(output, `${product}.o`);
    await build(
      [
        "--sdk",
        "iphonesimulator",
        "swiftc",
        "-sdk",
        sdk,
        "-target",
        target,
        "-g",
        "-Onone",
        "-D",
        "DEBUG",
        "-emit-library",
        "-static",
        "-emit-module",
        "-module-name",
        "MacInspector",
        ...files,
        "-o",
        path.join(output, "libMacInspector.a"),
        "-emit-module-path",
        path.join(output, "MacInspector.swiftmodule"),
      ],
      root,
    );
    await build(
      [
        "--sdk",
        "iphonesimulator",
        "swiftc",
        "-sdk",
        sdk,
        "-target",
        target,
        "-g",
        "-Onone",
        "-D",
        "DEBUG",
        "-parse-as-library",
        "-whole-module-optimization",
        "-emit-object",
        "-emit-module",
        "-emit-module-path",
        path.join(output, `${product}.swiftmodule`),
        "-module-name",
        product,
        "-I",
        output,
        ...(swiftUI
          ? [
              path.join(root, "demo/swiftui/Showcase.swift"),
              path.join(root, "demo/swiftui/ios/App.swift"),
            ]
          : [path.join(root, "demo/ios/Showcase.swift")]),
        "-o",
        object,
      ],
      root,
    );
    await build(
      [
        "--sdk",
        "iphonesimulator",
        "swiftc",
        "-sdk",
        sdk,
        "-target",
        target,
        "-g",
        object,
        "-L",
        output,
        "-lMacInspector",
        "-Xlinker",
        "-add_ast_path",
        "-Xlinker",
        path.join(output, `${product}.swiftmodule`),
        "-Xlinker",
        "-syslibroot",
        "-Xlinker",
        sdk,
        "-o",
        path.join(contents, product),
      ],
      root,
    );
    await build(["dsymutil", path.join(contents, product)], root);
    await copyFile(
      path.join(
        root,
        swiftUI ? "demo/swiftui/ios/Info.plist" : "demo/ios/Info.plist",
      ),
      path.join(contents, "Info.plist"),
    );
    console.log(`Installing and launching ${name}…`);
    await command(["simctl", "install", device.udid, contents]);
    const launch = await execute(
      "xcrun",
      ["simctl", "launch", device.udid, bundle],
      {
        env: {
          ...process.env,
          SIMCTL_CHILD_MACINSPECTOR_NATIVE_PORT: String(nativePort),
        },
      },
    );
    pid = Number(launch.stdout.match(/:\s*(\d+)\s*$/)?.[1]);
    if (!pid) throw Error("Simulator launch did not report the app PID");
    app = {
      pid,
      kill() {
        try {
          process.kill(pid, "SIGTERM");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      },
    };
  }
  try {
    const deadline = Date.now() + (demo ? 30000 : 1000);
    let record;
    do {
      record = await connection(device, bundle, pid);
      if (record) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    } while (Date.now() < deadline);
    if (!record)
      throw Error(
        "No UIKit SDK connection found. Run this app with MacInspector initialized in its Debug build. iOS has no Accessibility attachment fallback.",
      );
    if (!executable) {
      const container = await command([
        "simctl",
        "get_app_container",
        device.udid,
        bundle,
        "app",
      ]);
      const name = (
        await execute("plutil", [
          "-extract",
          "CFBundleExecutable",
          "raw",
          "-o",
          "-",
          path.join(container, "Info.plist"),
        ])
      ).stdout.trim();
      executable = path.join(container, name);
    }
    const sdkRoot = await command([
      "simctl",
      "getenv",
      device.udid,
      "SIMULATOR_ROOT",
    ]);
    await new Promise((resolve, reject) => {
      const child = spawn(
        "swift",
        ["build", "--product", "SimulatorPointer", "--jobs", "1"],
        {
          cwd: root,
          stdio: ["ignore", 2, "inherit"],
        },
      );
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0
          ? resolve()
          : reject(Error(`Pointer helper build exited ${code}`)),
      );
    });
    let chrome;
    try {
      chrome = await simulatorChrome(device);
    } catch (error) {
      console.error(
        `Simulator pointer hover: ${error.message}. Touch picking remains available.`,
      );
    }
    const backend = await connectDiscovered(record);
    if (chrome)
      attachSimulatorPointer(backend, {
        executable: path.join(root, ".build/debug/SimulatorPointer"),
        device,
        chrome,
      });
    return {
      backend,
      pid: record.pid,
      app,
      device,
      executable,
      sdkRoot,
    };
  } catch (error) {
    app?.kill();
    throw error;
  }
}
