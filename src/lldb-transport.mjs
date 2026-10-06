// SPDX-License-Identifier: MIT
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

export class LldbTransport {
  constructor({ env = process.env } = {}) {
    const pythonPath = execFileSync("xcrun", ["lldb", "-P"], {
      env,
      encoding: "utf8",
    }).trim();
    const python = execFileSync("xcrun", ["--find", "python3"], {
      env,
      encoding: "utf8",
    }).trim();
    this.process = spawn(
      python,
      [fileURLToPath(new URL("../native/lldb_worker.py", import.meta.url))],
      {
        // The CLI owns shutdown. Terminal Ctrl-C must not tear down LLDB before
        // it has resumed and detached its target.
        detached: true,
        env: {
          ...env,
          PYTHONPATH: [pythonPath, env.PYTHONPATH]
            .filter(Boolean)
            .join(path.delimiter),
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.pending = new Map();
    this.listeners = new Set();
    this.sequence = 0;
    this.stderr = "";
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.ready.catch(() => {});
    this.startupTimer = setTimeout(
      () =>
        this.fail(new Error("LLDB initialization timed out: " + this.stderr)),
      60000,
    );
    let input = "";
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk) => {
      input += chunk;
      if (input.length > 16 * 1024 * 1024)
        return this.fail(new Error("LLDB response exceeded limit"));
      let newline;
      while ((newline = input.indexOf("\n")) >= 0) {
        const line = input.slice(0, newline);
        input = input.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          if (message.event) {
            if (message.event === "ready") {
              this.initialized = true;
              clearTimeout(this.startupTimer);
              this.resolveReady();
            }
            for (const listener of this.listeners) listener(message);
          } else {
            const request = this.pending.get(message.id);
            if (!request) continue;
            clearTimeout(request.timer);
            this.pending.delete(message.id);
            if (message.error) request.reject(new Error(message.error));
            else request.resolve(message.result);
          }
        } catch (error) {
          this.fail(error);
        }
      }
    });
    this.process.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-4000);
    });
    this.process.on("error", (error) => this.fail(error));
    this.process.stdin.on("error", (error) => this.fail(error));
    this.process.on("exit", (code) =>
      this.fail(new Error(`LLDB exited (${code}): ${this.stderr}`)),
    );
  }
  fail(error) {
    if (this.failure) return;
    this.failure = error;
    clearTimeout(this.startupTimer);
    this.rejectReady(error);
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    for (const listener of this.listeners) listener({ event: "closed", error });
  }
  async request(method, params = {}, timeout = 15000) {
    await this.ready;
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            "LLDB timeout: " + method + (this.stderr ? "\n" + this.stderr : ""),
          ),
        );
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async close(options = {}) {
    try {
      if (this.initialized) await this.request("close", options, 5000);
    } catch {}
    clearTimeout(this.startupTimer);
    this.process.stdin.end();
    if (this.process.exitCode !== null || this.process.signalCode !== null)
      return;
    await new Promise((resolve) => {
      const finish = () => {
        clearTimeout(terminate);
        clearTimeout(force);
        resolve();
      };
      const terminate = setTimeout(() => {
        if (!this.process.kill("SIGTERM")) finish();
      }, 1000);
      const force = setTimeout(() => {
        this.process.kill("SIGKILL");
        finish();
      }, 2000);
      this.process.once("exit", finish);
    });
  }
}
