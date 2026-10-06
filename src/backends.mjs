// SPDX-License-Identifier: MIT
import net from "node:net";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

export class NativeBackend extends EventEmitter {
  constructor(write, close) {
    super();
    this.write = write;
    this.shutdown = close;
    this.nextID = 0;
    this.pending = new Map();
  }
  receive(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.fail(new Error("Invalid native response"));
      return;
    }
    if (message.id !== undefined) {
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error));
      else request.resolve(message.result);
    } else this.emit("event", message);
  }
  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.emit("disconnected", error);
  }
  request(method, params = {}) {
    if (this.suspended)
      return Promise.reject(
        new Error("Native app is paused; resume before operating the UI"),
      );
    if (this.closed)
      return Promise.reject(new Error("Native app disconnected"));
    if (this.pending.size >= 64)
      return Promise.reject(new Error("Native request limit exceeded"));
    return new Promise((resolve, reject) => {
      const id = ++this.nextID;
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          reject(new Error(`Native operation timed out: ${method}`));
        },
        method === "snapshot" || method === "screenshot" ? 20000 : 10000,
      );
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  suspend(paused) {
    this.suspended = paused;
    if (paused) {
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(
          new Error(
            "Native app paused during a UI operation; resume to finish it",
          ),
        );
      }
      this.pending.clear();
    }
  }
  close() {
    this.fail(new Error("Inspector closed"));
    this.shutdown();
  }
}
export async function connectAppKit({ port, token }) {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  const backend = new NativeBackend(
    (message) => socket.write(JSON.stringify({ ...message, token }) + "\n"),
    () => socket.destroy(),
  );
  readline
    .createInterface({ input: socket, crlfDelay: Infinity })
    .on("line", (line) => backend.receive(line))
    .on("error", (error) => backend.fail(error));
  socket.on("error", (error) => backend.fail(error));
  socket.on("close", () => backend.fail(new Error("Native app disconnected")));
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return backend;
}
export function connectAccessibility({ executable, pid }) {
  const child = spawn(executable, [String(pid)], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const backend = new NativeBackend(
    (message) => child.stdin.write(JSON.stringify(message) + "\n"),
    () => child.kill("SIGTERM"),
  );
  readline
    .createInterface({ input: child.stdout, crlfDelay: Infinity })
    .on("line", (line) => backend.receive(line));
  child.on("error", (error) => backend.fail(error));
  child.on("exit", () =>
    backend.fail(new Error("Accessibility helper exited")),
  );
  backend.child = child;
  return backend;
}
