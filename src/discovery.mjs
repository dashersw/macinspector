// SPDX-License-Identifier: MIT
import { open, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { connectAppKit } from "./backends.mjs";

export async function readConnection(file, pid) {
  let handle;
  try {
    const directory = await lstat(path.dirname(file));
    if (
      !directory.isDirectory() ||
      directory.uid !== process.getuid() ||
      directory.mode & 0o077
    )
      throw Error("SDK discovery directory is not private to your user");
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.uid !== process.getuid() ||
      info.mode & 0o077 ||
      info.size > 16384
    )
      throw Error("SDK connection record is not a private regular file");
    const record = JSON.parse(await handle.readFile("utf8"));
    if (
      record.version !== 1 ||
      record.pid !== pid ||
      !Number.isInteger(record.port) ||
      record.port < 1 ||
      record.port > 65535 ||
      typeof record.token !== "string" ||
      record.token.length < 32 ||
      typeof record.session !== "string" ||
      typeof record.bundleId !== "string"
    )
      throw Error("Invalid SDK connection record");
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return null;
      throw error;
    }
    return record;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function discoverConnection(pid, bundleId = "") {
  const homes = [os.homedir()];
  if (bundleId && /^[\w.-]+$/.test(bundleId))
    homes.push(path.join(os.homedir(), "Library/Containers", bundleId, "Data"));
  for (const home of homes) {
    const file = path.join(
      home,
      "Library/Application Support/MacInspector/Connections",
      `${pid}.json`,
    );
    const record = await readConnection(file, pid);
    if (record) {
      if (bundleId && record.bundleId && record.bundleId !== bundleId)
        throw Error("SDK connection belongs to a different app");
      return record;
    }
  }
  return null;
}

export async function connectDiscovered(record) {
  let backend;
  try {
    backend = await connectAppKit(record);
    const snapshot = await backend.request("snapshot");
    if (snapshot.pid !== record.pid || snapshot.session !== record.session)
      throw Error("SDK process/session identity changed; retry attach");
    return backend;
  } catch (error) {
    backend?.close();
    throw Error(
      `The SDK is advertised but cannot be attached: ${error.message}. Close any other inspector attached to this app and retry.`,
    );
  }
}
