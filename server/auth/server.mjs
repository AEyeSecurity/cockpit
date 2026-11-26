import { createSalusLink } from "./salusLink.mjs";
import { createRoverControl } from "./roverControl.mjs";
import { createHostReboot } from "./hostReboot.mjs";
import { readFileSync } from "node:fs";
import { createWeatherPreview } from "../weather/preview.ts";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { createGateway } from "./gateway.mjs";
import { createIdentity, HttpError } from "./identity.mjs";
import { openVault } from "./crypto.mjs";
import { openStore } from "./store.mjs";

function weatherKey(path) {
  try {
    return readFileSync(path, "utf8").trim();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return "";
  }
}

export function startServer({ db, vault, origin, env = {}, now = Date.now, control, weatherRequest }) {
  let salus;
  let destination;
  let reboot;
  const managedControl = env.COCKPIT_ROVER_CONTROL === "true";
  const { COCKPIT_HOST_REBOOT_SOCKET: path, COCKPIT_HOST_REBOOT_SSH_HOST: sshHost } = env;
  const destinations = managedControl || path || sshHost
    ? [env.COCKPIT_NAVIGATION_URL, ...(env.COCKPIT_NAVIGATION_ALTERNATIVES ?? "").split(",").map(value => value.trim()).filter(Boolean)]
      .map(value => {
        const url = new URL(value);
        if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.hash) {
          throw new Error("Invalid SALUS WebSocket destination");
        }
        return url;
      })
    : [];
  if (path || sshHost) {
    if (destinations.length !== 1 || (path && (sshHost || !path.startsWith("/")))) {
      throw new Error("Host reboot requires one fixed SALUS destination and one transport");
    }
    if (sshHost && sshHost.toLowerCase() !== destinations[0].hostname.toLowerCase()) {
      throw new Error("Host reboot SSH address must match the configured SALUS destination");
    }
    reboot = createHostReboot({ path, sshHost }, HttpError);
  }
  if (managedControl) {
    const describe = url => ({ host: url.hostname, port: url.port || (url.protocol === "wss:" ? "443" : "80") });
    const saved = db.prepare("SELECT url FROM rover_destination WHERE id=1").get()?.url;
    let current = destinations.find(url => url.href === saved) ?? destinations[0];
    salus = createSalusLink(current);
    control = createRoverControl({
      stop: salus.stop, canKeepRoute: salus.canKeepRoute,
      stopMs: 10000
    });
    destination = {
      read: () => ({ ...describe(current), options: destinations.map(describe) }),
      write(body) {
        const next = destinations.find(url => {
          const { host, port } = describe(url);
          return host === body?.host && port === body?.port;
        });
        if (!next) throw new HttpError(400, "La dirección y el puerto no corresponden a un destino configurado para este Rover.");
        if (next.href !== current.href) {
          if (!control.canChangeDestination()) throw new HttpError(409, "El Rover debe estar libre para cambiar la dirección.");
          db.prepare("INSERT INTO rover_destination (id, url) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET url=excluded.url").run(next.href);
          salus.setDestination(next);
          current = next;
        }
        return destination.read();
      }
    };
  }
  const nvrUrl = env.COCKPIT_NVR_CONTROL_URL;
  const nvrToken = env.COCKPIT_NVR_CONTROL_TOKEN;
  const nvrTransmission = nvrUrl && nvrToken ? async enabled => {
    try {
      const response = await fetch(nvrUrl, {
        method: enabled === undefined ? "GET" : "PUT",
        headers: { Authorization: "Bearer " + nvrToken, "Content-Type": "application/json" },
        body: enabled === undefined ? undefined : JSON.stringify({ enabled }),
        redirect: "error",
        signal: AbortSignal.timeout(12000)
      });
      if (!response.ok) throw new Error("Relay request failed");
      const state = await response.json();
      if (typeof state?.enabled !== "boolean" || !Number.isInteger(state.online) || state.online < 0 || state.online > 3 ||
          (enabled !== undefined && state.enabled !== enabled)) throw new Error("Invalid relay state");
      return { enabled: state.enabled, online: state.online };
    } catch {
      throw new HttpError(503, "No se pudo confirmar el estado de la transmisión al NVR.");
    }
  } : undefined;
  const identity = createIdentity(db, vault, origin, now, { passwordOnly: env.COCKPIT_PASSWORD_ONLY === "true", control, destination, reboot, nvrTransmission });
  const gateway = createGateway(identity, env, control, salus);
  const key = weatherKey(env.COCKPIT_WEATHER_KEY_FILE ?? "/data/weatherapi.key");
  const forecast = createWeatherPreview(key, weatherRequest);
  let weatherWindow = 0;
  let weatherRequests = 0;
  const server = createServer({ requestTimeout: 15000, headersTimeout: 10000 }, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    try {
      const url = new URL(req.url, origin);
      if (url.pathname === "/health" && req.method === "GET") {
        db.prepare("SELECT 1").get();
        return res.writeHead(204).end();
      }
      if (url.pathname === "/api/weather") {
        if (!identity.operational(req)) throw new HttpError(401, "Iniciá sesión.");
        if (req.headers["sec-fetch-site"] === "cross-site") throw new HttpError(403, "Origen no permitido.");
        if (req.method !== "GET") throw new HttpError(405, "Método no permitido.");
        if (!key) throw new HttpError(503, "Clima no disponible.");
        const minute = Math.floor(now() / 60000);
        if (minute !== weatherWindow) {
          weatherWindow = minute;
          weatherRequests = 0;
        }
        if (++weatherRequests > 30) throw new HttpError(429, "Demasiadas consultas de clima.");
        let report;
        try {
          report = await forecast(url.searchParams.get("lat"), url.searchParams.get("lon"));
        } catch (error) {
          if (error instanceof RangeError) throw new HttpError(400, "Ubicación inválida.");
          throw new HttpError(503, "Clima no disponible.");
        }
        return res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(report));
      }
      if (url.pathname.startsWith("/operation/")) return gateway.http(req, res, url);
      if (!url.pathname.startsWith("/api/")) throw new HttpError(404, "Ruta inexistente.");
      const result = await identity.api(req, res, url.pathname);
      gateway.sweep();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(result));
    } catch (error) {
      if (res.headersSent) return res.destroy();
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error("Cockpit identity request failed", error.code ?? error.name);
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" })
        .end(JSON.stringify({ error: status === 500 ? "Error interno." : error.message }));
    }
  });
  server.on("upgrade", (req, socket, head) => {
    let url;
    try { url = new URL(req.url, origin); } catch { return socket.destroy(); }
    gateway.upgrade(req, socket, head, url);
  });
  const timer = setInterval(() => {
    gateway.sweep();
    gateway.pingControlSockets();
    control?.sweep((id) => identity.isLive({ id })).catch(() => {
      console.error("Cockpit could not confirm Rover stop after session expiry");
    });
  }, 1000);
  timer.unref();
  server.on("close", () => { clearInterval(timer); gateway.close(); salus?.close(); });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  process.umask(0o077);
  const origin = new URL(env.COCKPIT_ORIGIN);
  if (origin.protocol !== "https:" || origin.origin !== env.COCKPIT_ORIGIN) {
    throw new Error("COCKPIT_ORIGIN must be an HTTPS origin without a trailing slash");
  }
  const vault = openVault(env.COCKPIT_KEYS_FILE);
  const db = openStore(env.COCKPIT_DB ?? "/data/cockpit.sqlite");
  startServer({ db, vault, origin: origin.origin, env }).listen(Number(env.PORT ?? 8080), env.HOST ?? "0.0.0.0");
}
