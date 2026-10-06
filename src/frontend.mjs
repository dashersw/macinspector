// SPDX-License-Identifier: MIT
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawn } from "node:child_process";

export const frontendRoot = fileURLToPath(
  new URL("../.build/devtools/", import.meta.url),
);
const pin = JSON.parse(
  await readFile(new URL("../frontend/pin.json", import.meta.url), "utf8"),
);
export async function frontendManifest() {
  const manifest = JSON.parse(
    await readFile(path.join(frontendRoot, "build.json"), "utf8"),
  );
  if (
    manifest.revision !== pin.revision ||
    manifest.patchVersion !== pin.patchVersion ||
    manifest.grammarVersion !== pin.grammarVersion ||
    !manifest.files["devtools_app.html"]
  )
    throw Error("Pinned DevTools assets are stale; run npm run build:frontend");
  return manifest;
}
export async function ensureFrontend() {
  try {
    return await frontendManifest();
  } catch {
    await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL("../frontend/build.mjs", import.meta.url))],
        { stdio: "inherit" },
      );
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0 ? resolve() : reject(Error("Pinned DevTools build failed")),
      );
    });
    return frontendManifest();
  }
}
const mime = {
  ".html": "text/html;charset=utf-8",
  ".js": "text/javascript;charset=utf-8",
  ".css": "text/css;charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".wasm": "application/wasm",
  ".txt": "text/plain;charset=utf-8",
};
export async function serveFrontend(req, res, manifest) {
  const pathname = req.url.split("?")[0];
  if (!pathname.startsWith("/devtools/")) return false;
  let file;
  try {
    file = decodeURIComponent(pathname.slice("/devtools/".length));
  } catch {
    res.writeHead(400);
    res.end("Invalid asset path");
    return true;
  }
  if (
    file.startsWith("/") ||
    file.split("/").some((p) => p === ".." || p === ".") ||
    file.includes("\\")
  ) {
    res.writeHead(403);
    res.end("Invalid asset path");
    return true;
  }
  if (!file) file = "devtools_app.html";
  if (!Object.hasOwn(manifest.files, file)) {
    res.writeHead(404);
    res.end("Unknown bundled DevTools asset");
    return true;
  }
  const data = await readFile(path.join(frontendRoot, file));
  res.setHeader(
    "Content-Type",
    mime[path.extname(file)] || "application/octet-stream",
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(data);
  return true;
}
