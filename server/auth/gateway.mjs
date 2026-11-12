import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { pipeline } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { HttpError } from "./identity.mjs";
import { authorizeNavigationFrame } from "./navigationPolicy.mjs";

const routes = {
  navigation: ["ws", "COCKPIT_NAVIGATION_URL"],
  simulation: ["ws", "COCKPIT_SIMULATION_URL"],
  rosbridge: ["ws", "COCKPIT_ROSBRIDGE_URL"],
  dispatch: ["http", "COCKPIT_DISPATCH_URL"],
  vision: ["http", "COCKPIT_VISION_URL"],
  person: ["http", "COCKPIT_PERSON_URL"],
  mjpeg: ["http", "COCKPIT_MJPEG_URL"],
  camera: ["http", "COCKPIT_CAMERA_URL"],
  recordings: ["http", "COCKPIT_RECORDINGS_URL"]
};

const requestHeaders = ["accept", "content-type", "content-length", "range", "if-match"];
const responseHeaders = ["content-type", "content-length", "content-range", "accept-ranges", "etag", "link"];
const safeType = /^(application\/(json|sdp|trickle-ice-sdpfrag|octet-stream)(;|$)|(?:video|audio)\/|image\/(jpeg|png|webp)(;|$)|multipart\/x-mixed-replace(;|$))/i;

export function createGateway(identity, env, control, salus) {
  const upstreams = new Map();
  for (const [name, [protocol, variable]] of Object.entries(routes)) {
    if (!env[variable]) continue;
    const url = new URL(env[variable]);
    const schemes = protocol === "ws" ? ["ws:", "wss:"] : ["http:", "https:"];
    if (!schemes.includes(url.protocol) || url.username || url.password || url.hash) {
      throw new Error("Invalid upstream " + variable);
    }
    upstreams.set(name, url);
  }
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  const active = new Set();
  const cameraSessions = new Map();
  const controlSockets = new Map();

  function track(session, close) {
    const entry = { session, close };
    active.add(entry);
    return () => active.delete(entry);
  }

  function sweep() {
    for (const entry of active) {
      if (!identity.isLive(entry.session)) entry.close();
    }
  }

  function target(url, protocol) {
    const match = /^\/operation\/([a-z]+)(\/.*)?$/.exec(url.pathname);
    const name = match?.[1];
    const base = upstreams.get(name);
    if (!base || routes[name][0] !== protocol) throw new HttpError(404, "Servicio no configurado.");
    const suffix = match[2] ?? "";
    if (suffix && !["camera", "recordings"].includes(name)) throw new HttpError(404, "Ruta inexistente.");
    if (suffix && (suffix.startsWith("//") || /%2f|%5c|%2e/i.test(suffix))) {
      throw new HttpError(400, "Ruta inválida.");
    }
    const upstream = new URL(base);
    if (suffix) upstream.pathname = base.pathname.replace(/\/$/, "") + suffix;
    for (const [key, value] of url.searchParams) {
      if (key !== "instance") upstream.searchParams.set(key, value);
    }
    return { upstream, base, name };
  }

  function authorize(req) {
    const session = identity.operational(req);
    if (!session) throw new HttpError(401, "Iniciá sesión.");
    if (req.headers["sec-fetch-site"] === "cross-site") throw new HttpError(403, "Origen no permitido.");
    return session;
  }

  return {
    sweep,
    pingControlSockets() {
      for (const client of controlSockets.values()) {
        if (client.readyState === WebSocket.OPEN) client.ping();
      }
    },
    close() {
      for (const entry of active) entry.close();
      wss.close();
    },
    http(req, res, url) {
      const session = authorize(req);
      const { upstream, base, name } = target(url, "http");
      if (control && name === "dispatch") throw new HttpError(403, "Usá el canal de navegación autorizado.");
      const resource = url.pathname + url.search;
      const cameraSession = cameraSessions.get(resource);
      if (name === "camera") {
        const offer = /^\/operation\/camera\/cam[345](?:_normal)?\/whep$/.test(url.pathname);
        const negotiation = ["OPTIONS", "POST"].includes(req.method) && offer;
        const control = ["PATCH", "DELETE"].includes(req.method) && cameraSession?.owner === session.id;
        if (!negotiation && !control) throw new HttpError(404, "Ruta inexistente.");
      }
      if (Number(req.headers["content-length"]) > 1024 * 1024) throw new HttpError(413, "Solicitud demasiado grande.");
      const methods = name === "dispatch" ? ["POST"] : name === "camera"
        ? ["GET", "HEAD", "OPTIONS", "POST", "PATCH", "DELETE"] : ["GET", "HEAD"];
      if (!methods.includes(req.method)) throw new HttpError(405, "Método no permitido.");
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) identity.checkOrigin(req);
      const headers = Object.fromEntries(requestHeaders.filter((key) => req.headers[key]).map((key) => [key, req.headers[key]]));
      const send = upstream.protocol === "https:" ? httpsRequest : httpRequest;
      const proxy = send(upstream, { method: req.method, headers, timeout: 30000 }, (reply) => {
        const type = reply.headers["content-type"];
        if ((type && !safeType.test(type)) || (reply.statusCode >= 300 && reply.statusCode < 400) ||
            (!type && reply.statusCode >= 200 && reply.statusCode < 300 && ![201, 204].includes(reply.statusCode) && req.method !== "HEAD" && req.method !== "OPTIONS")) {
          reply.destroy();
          res.writeHead(502).end();
          return;
        }
        if (name === "camera" && req.method === "DELETE" && reply.statusCode < 300) {
          cameraSession.release();
        }
        if (name === "camera" && req.method === "POST" && reply.statusCode === 201) {
          let location;
          try {
            location = new URL(reply.headers.location, upstream);
          } catch {
            reply.destroy();
            res.writeHead(502).end();
            return;
          }
          const prefix = base.pathname.replace(/\/$/, "");
          if (location.origin !== base.origin || !location.pathname.startsWith(prefix + "/")) {
            reply.destroy();
            res.writeHead(502).end();
            return;
          }
          const path = "/operation/camera" + location.pathname.slice(prefix.length) + location.search;
          const release = () => {
            cameraSessions.delete(path);
            untrackCamera();
          };
          const untrackCamera = track(session, () => {
            release();
            const remove = send(location, { method: "DELETE", timeout: 5000 }, (response) => response.resume());
            remove.on("error", () => console.error("Cockpit camera session cleanup failed"));
            remove.on("timeout", () => remove.destroy());
            remove.end();
          });
          cameraSessions.set(path, { owner: session.id, release });
          res.setHeader("Location", path);
        }
        for (const key of responseHeaders) {
          if (reply.headers[key] && (key !== "link" || name === "camera")) res.setHeader(key, reply.headers[key]);
        }
        res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
        if (name === "recordings") res.setHeader("Content-Disposition", "attachment");
        res.writeHead(reply.statusCode);
        pipeline(reply, res, () => {});
      });
      const untrack = track(session, () => {
        proxy.destroy();
        res.destroy();
      });
      res.once("close", () => { untrack(); proxy.destroy(); });
      proxy.on("timeout", () => proxy.destroy());
      proxy.on("error", () => {
        if (!res.headersSent) res.writeHead(502).end();
        else res.destroy();
      });
      let bytes = 0;
      req.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) proxy.destroy();
      });
      req.pipe(proxy);
    },
    upgrade(req, socket, head, url) {
      try {
        identity.checkOrigin(req);
        const session = authorize(req);
        const { upstream, name } = target(url, "ws");
        const instanceId = control ? url.searchParams.get("instance") : null;
        if (control) {
          if (name !== "navigation") throw new HttpError(403, "Canal operativo deshabilitado.");
          if (!instanceId || controlSockets.has(instanceId)) throw new HttpError(403, "Instancia inválida.");
          try {
            if (control.status(instanceId, session.id).mode === "waiting") throw new Error("Waiting");
          } catch {
            throw new HttpError(403, "Instancia sin acceso al Rover.");
          }
        }
        wss.handleUpgrade(req, socket, head, (client) => {
          if (instanceId && salus) {
            controlSockets.set(instanceId, client);
            let closeCause = "peer_closed";
            const terminate = (cause) => {
              closeCause = cause;
              client.terminate();
            };
            const releaseControl = async () => {
              try { await control.close(instanceId, session.id); } catch { /* The instance may already be gone. */ }
            };
            const detach = salus.attach(instanceId, (message) => {
              if (client.readyState === WebSocket.OPEN && client.bufferedAmount < 1024 * 1024) {
                client.send(JSON.stringify(message));
              }
            }, () => {
              closeCause = "salus_connection_lost";
              releaseControl();
              client.close(1013, "Se perdió el enlace entre Cockpit y SALUS.");
            });
            const untrack = track(session, () => terminate("session_expired_or_revoked"));
            // Browsers answer WebSocket pings even when background JavaScript timers are throttled.
            client.on("pong", () => {
              if (!identity.isLive(session)) return terminate("session_expired_or_revoked");
              try {
                control.heartbeat(instanceId, session.id);
              } catch {
                terminate("control_instance_expired");
              }
            });
            client.once("error", () => terminate("browser_socket_error"));
            client.once("close", (code) => {
              if (code !== 1000 || closeCause !== "peer_closed") {
                console.warn("Cockpit Rover browser socket closed", { code, cause: closeCause });
              }
              detach();
              untrack();
              controlSockets.delete(instanceId);
              releaseControl();
            });
            client.on("message", (data, binary) => {
              if (!identity.isLive(session)) return terminate("session_expired_or_revoked");
              let authorized;
              try {
                authorized = authorizeNavigationFrame(control, instanceId, session.id, data, binary);
              } catch {
                terminate("control_instance_expired");
                return;
              }
              if (authorized !== null) salus.forward(instanceId, authorized);
            });
            return;
          }
          if (instanceId) controlSockets.set(instanceId, client);
          const backend = new WebSocket(upstream, { handshakeTimeout: 8000, maxPayload: 16 * 1024 * 1024, followRedirects: false });
          let closed = false;
          const close = () => {
            if (closed) return;
            closed = true;
            if (instanceId) {
              controlSockets.delete(instanceId);
              Promise.resolve().then(() => control.close(instanceId, session.id)).catch(() => {
                console.error("Cockpit control session close could not be confirmed");
              });
            }
            client.terminate();
            backend.terminate();
          };
          const untrack = track(session, close);
          const queued = [];
          let queuedBytes = 0;
          backend.once("open", () => {
            if (!identity.isLive(session)) return close();
            for (const [data, binary] of queued) forward(data, binary);
            queued.length = 0;
          });
          function forward(data, binary) {
            if (!instanceId) return backend.send(data, { binary });
            let authorized;
            try {
              authorized = authorizeNavigationFrame(control, instanceId, session.id, data, binary);
            } catch {
              close();
              return;
            }
            if (authorized !== null) backend.send(authorized);
          }
          for (const [source, destination] of [[client, backend], [backend, client]]) {
            source.on("error", close);
            source.on("close", () => { untrack(); close(); });
            source.on("message", (data, binary) => {
              if (!identity.isLive(session) || destination.bufferedAmount > 16 * 1024 * 1024) return close();
              if (destination.readyState === WebSocket.OPEN) {
                if (destination === backend) forward(data, binary);
                else destination.send(data, { binary });
              }
              else if (destination === backend && destination.readyState === WebSocket.CONNECTING) {
                queuedBytes += data.length;
                if (queuedBytes > 1024 * 1024 || queued.length >= 64) return close();
                queued.push([data, binary]);
              }
            });
          }
        });
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 400;
        socket.end("HTTP/1.1 " + status + " Rejected\r\nConnection: close\r\n\r\n");
      }
    }
  };
}
