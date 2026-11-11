import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { createGateway } from "./gateway.mjs";
import { createIdentity, HttpError } from "./identity.mjs";
import { openVault } from "./crypto.mjs";
import { openStore } from "./store.mjs";

export function startServer({ db, vault, origin, env = {}, now = Date.now }) {
  const identity = createIdentity(db, vault, origin, now, { passwordOnly: env.COCKPIT_PASSWORD_ONLY === "true" });
  const gateway = createGateway(identity, env);
  const server = createServer({ requestTimeout: 15000, headersTimeout: 10000 }, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    try {
      const url = new URL(req.url, origin);
      if (url.pathname === "/health" && req.method === "GET") {
        db.prepare("SELECT 1").get();
        return res.writeHead(204).end();
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
  const timer = setInterval(() => gateway.sweep(), 1000);
  timer.unref();
  server.on("close", () => { clearInterval(timer); gateway.close(); });
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
