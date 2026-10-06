// SPDX-License-Identifier: MIT
import { Changes } from "./changes.mjs";
import http from "node:http";
import { readFileSync } from "node:fs";
import { WebSocketServer } from "ws";
import { Session } from "./session.mjs";
import { projectNativeDOM } from "./dom.mjs";
import { reconcileCss, parseCssDeclarations } from "./css.mjs";
import { frontendManifest, serveFrontend } from "./frontend.mjs";

export async function createRelay({
  backend,
  port = 9333,
  autoPort = false,
  pollMs = 1000,
  title,
  sourceDebugger,
  frontend,
}) {
  frontend ||= await frontendManifest();
  const relay = {
    backend,
    sourceDebugger,
    nodes: new Map(),
    styles: new Map(),
    sessions: new Set(),
    inspection: null,
  };
  let refreshing,
    closing = false;
  let lastImage,
    imagePending,
    imageAt = 0;
  const capture = () => {
    if (sourceDebugger?.paused) {
      if (lastImage) return Promise.resolve(lastImage);
      return Promise.reject(
        Error("Native app is paused; resume to capture its first frame"),
      );
    }
    if (lastImage && Date.now() - imageAt < 2000)
      return Promise.resolve(lastImage);
    if (!imagePending)
      imagePending = backend
        .request("screenshot")
        .then(({ data }) => {
          lastImage = data;
          imageAt = Date.now();
          return data;
        })
        .finally(() => {
          imagePending = null;
        });
    return imagePending;
  };
  relay.apply = (snapshot) => {
    if (
      !Array.isArray(snapshot.nodes) ||
      !snapshot.nodes.length ||
      snapshot.nodes.length > 4096
    )
      throw Error("Invalid native tree");
    const previous = relay.nodes,
      previousDOM = relay.domNodes || new Map(),
      nodes = new Map(snapshot.nodes.map((n) => [n.id, n]));
    if (nodes.size !== snapshot.nodes.length || !nodes.has(snapshot.root))
      throw Error("Invalid native identities");
    for (const n of nodes.values())
      if (
        !Number.isSafeInteger(n.id) ||
        n.id < 2 ||
        !Array.isArray(n.children) ||
        n.children.some((id) => !nodes.has(id))
      )
        throw Error("Invalid native tree edges");
    relay.snapshot = snapshot;
    relay.nodes = nodes;
    for (const n of nodes.values()) {
      let projection = n.styles || {},
        doc = relay.styles.get(n.id);
      // A native background is one property; preserve the user's shorthand.
      if (
        doc &&
        !doc.editing &&
        parseCssDeclarations(doc.text).some((p) => p.name === "background") &&
        !parseCssDeclarations(doc.text).some(
          (p) => p.name === "background-color",
        )
      ) {
        const old = { ...doc.projection };
        old.background = old["background-color"];
        delete old["background-color"];
        const next = { ...projection };
        next.background = next["background-color"];
        delete next["background-color"];
        const reconciled = reconcileCss({ ...doc, projection: old }, next);
        doc = { ...reconciled, projection };
      } else doc = reconcileCss(doc, projection);
      relay.styles.set(n.id, doc);
    }
    relay.domNodes = projectNativeDOM(nodes);
    for (const id of relay.styles.keys())
      if (!nodes.has(id)) relay.styles.delete(id);
    for (const session of relay.sessions)
      session.changed(previous, previousDOM);
  };
  relay.refresh = () => {
    if (sourceDebugger?.paused) return Promise.resolve();
    if (!refreshing)
      refreshing = backend
        .request("snapshot")
        .then((snapshot) => relay.apply(snapshot))
        .finally(() => {
          refreshing = null;
        });
    return refreshing;
  };
  relay.inspect = async (session, enabled) => {
    if (enabled) {
      const previous = relay.inspection;
      if (previous && previous !== session)
        previous.emit("Overlay.inspectModeCanceled", {});
      relay.inspection = session;
      try {
        await backend.request("inspect", {
          enabled: true,
          owner: session.owner,
        });
      } catch (error) {
        if (relay.inspection === session) relay.inspection = null;
        throw error;
      }
    } else if (relay.inspection === session) {
      relay.inspection = null;
      await backend.request("inspect", {
        enabled: false,
        owner: session.owner,
      });
    }
  };
  await relay.refresh();
  relay.changes = new Changes(relay);
  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (
      ![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host) ||
      !["GET", "POST"].includes(req.method) ||
      req.headers["sec-fetch-site"] === "cross-site" ||
      (req.headers.origin &&
        req.headers.origin !== `http://127.0.0.1:${port}` &&
        req.headers.origin !== `http://localhost:${port}`)
    ) {
      res.writeHead(403);
      res.end("Local access only");
      return;
    }
    try {
      if (req.url === "/native/command" && req.method === "POST") {
        if (
          !(req.headers["content-type"] || "").startsWith("application/json")
        ) {
          res.writeHead(415);
          res.end();
          return;
        }
        let size = 0;
        const chunks = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 1_048_576) throw Error("Native command exceeds limit");
          chunks.push(chunk);
        }
        const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (typeof request.method !== "string")
          throw Error("Invalid native command");
        const result = await relay.changes.command(
          request.method,
          request.params || {},
        );
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result));
        return;
      }
      if (req.method !== "GET") {
        res.writeHead(405);
        res.end();
        return;
      }
      if (await serveFrontend(req, res, frontend)) return;
      if (req.url === "/" || req.url === "/preview") {
        res.setHeader("Content-Type", "text/html;charset=utf-8");
        res.end(readFileSync(new URL("./preview.html", import.meta.url)));
        return;
      }
      if (req.url === "/preview.png") {
        const data = await capture();
        res.setHeader("Content-Type", "image/png");
        res.end(Buffer.from(data, "base64"));
        return;
      }
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/state") {
        await relay.refresh();
        res.end(
          JSON.stringify({ ...relay.snapshot, frontend: relay.frontend }),
        );
        return;
      }
      if (["/json", "/json/list"].includes(req.url)) {
        res.end(
          JSON.stringify([
            {
              id: "native",
              type: "page",
              title: title || relay.snapshot.title,
              url: "macos://native/",
              webSocketDebuggerUrl: relay.endpoint,
              devtoolsFrontendUrl: relay.frontend,
            },
          ]),
        );
        return;
      }
      if (req.url === "/json/version") {
        res.end(
          JSON.stringify({
            Browser: "MacInspector/0.1",
            "Protocol-Version": "1.3",
            webSocketDebuggerUrl: relay.endpoint,
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end("{}");
    } catch (error) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: error.message }));
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });
  server.on("upgrade", (req, socket, head) => {
    const origin = req.headers.origin;
    if (
      req.url !== "/devtools/page/native" ||
      relay.sessions.size >= 4 ||
      ![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host) ||
      (origin &&
        !origin.startsWith("devtools://") &&
        origin !== `http://127.0.0.1:${port}`)
    ) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
  });
  wss.on("connection", (ws) => {
    const send = (message) => {
      if (ws.readyState === 1) {
        if (ws.bufferedAmount > 4 * 1024 * 1024) ws.close(1009);
        else ws.send(JSON.stringify(message));
      }
    };
    const session = new Session(relay, (method, params) =>
      send({ method, params }),
    );
    relay.sessions.add(session);
    let queue = Promise.resolve(),
      queued = 0;
    ws.on("message", (data, binary) => {
      let request;
      try {
        if (binary) throw Error();
        request = JSON.parse(data);
        if (
          !Number.isSafeInteger(request.id) ||
          typeof request.method !== "string"
        )
          throw Error();
      } catch {
        ws.close(1007);
        return;
      }
      if (queued >= 256) {
        ws.close(1008);
        return;
      }
      queued++;
      queue = queue
        .then(async () => {
          if (session.closed) return;
          try {
            send({
              id: request.id,
              result: await session.handle(
                request.method,
                request.params || {},
              ),
            });
          } catch (error) {
            if (process.env.MACINSPECTOR_TRACE === "1")
              console.error(request.method, error.message);
            send({
              id: request.id,
              error: { code: -32000, message: error.message },
            });
          }
        })
        .finally(() => queued--);
    });
    ws.on("close", () => {
      session.closed = true;
      relay.sessions.delete(session);
      session.objects.clear();
      sourceDebugger?.removeOwner(session.owner).catch(() => {});
      relay.inspect(session, false).catch(() => {});
      if (!relay.sessions.size)
        backend.request("highlight", { node: 0 }).catch(() => {});
    });
    ws.on("error", () => ws.close());
  });
  let eventQueue = Promise.resolve();
  const onEvent = (event) => {
    eventQueue = eventQueue
      .then(async () => {
        const session = relay.inspection;
        if (!session || session.closed || event.params?.owner !== session.owner)
          return;
        if (event.method === "inspectCanceled") {
          relay.inspection = null;
          session.emit("Overlay.inspectModeCanceled", {});
          return;
        }
        const node = event.params.node;
        if (!Number.isSafeInteger(node) || node <= 0) return;
        if (!relay.nodes.has(node)) await relay.refresh();
        if (!relay.nodes.has(node)) return;
        if (event.method === "hover") {
          session.path(node);
          session.emit("Overlay.nodeHighlightRequested", { nodeId: node });
        }
        if (event.method === "picked") {
          relay.inspection = null;
          session.pick(node);
        }
      })
      .catch((error) => {
        if (!closing) console.error("Native picker:", error.message);
      });
  };
  backend.on("event", onEvent);
  let canceledInspection;
  const onSourceState = (paused) => {
    backend.suspend?.(paused);
    if (paused && relay.inspection) {
      canceledInspection = relay.inspection.owner;
      relay.inspection.emit("Overlay.inspectModeCanceled", {});
      relay.inspection = null;
    } else if (!paused && canceledInspection) {
      backend
        .request("inspect", { enabled: false, owner: canceledInspection })
        .catch(() => {});
      canceledInspection = null;
    }
  };
  sourceDebugger?.on("state", onSourceState);
  backend.on("disconnected", (error) => {
    if (!closing)
      for (const ws of wss.clients) {
        ws.send(
          JSON.stringify({
            method: "Inspector.detached",
            params: { reason: error.message },
          }),
        );
        ws.close(1011);
      }
  });
  const timer = setInterval(() => {
    if (relay.sessions.size && !closing)
      relay.refresh().catch((error) => {
        if (process.env.MACINSPECTOR_TRACE === "1")
          console.error("Snapshot:", error.message);
      });
  }, pollMs);
  timer.unref();
  await new Promise((resolve, reject) => {
    const listen = (candidate) => {
      const failed = (error) => {
        if (autoPort && candidate !== 0 && error.code === "EADDRINUSE")
          listen(0);
        else reject(error);
      };
      server.once("error", failed);
      server.listen(candidate, "127.0.0.1", () => {
        server.off("error", failed);
        resolve();
      });
    };
    listen(port);
  });
  port = server.address().port;
  relay.endpoint = `ws://127.0.0.1:${port}/devtools/page/native`;
  relay.frontend = `http://127.0.0.1:${port}/devtools/devtools_app.html?ws=127.0.0.1:${port}/devtools/page/native`;
  relay.url = `http://127.0.0.1:${port}/`;
  relay.close = async () => {
    closing = true;
    clearInterval(timer);
    await sourceDebugger?.close();
    sourceDebugger?.off("state", onSourceState);
    if (relay.inspection)
      await relay.inspect(relay.inspection, false).catch(() => {});
    await backend.request("highlight", { node: 0 }).catch(() => {});
    if (relay.snapshot.capabilities.includes("layout"))
      await backend
        .request("layout-highlight", { constraint: "" })
        .catch(() => {});
    backend.off("event", onEvent);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    backend.close();
  };
  return relay;
}
