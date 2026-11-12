import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup } from "node:sqlite";
import { test } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { openVault, totpCode } from "../auth/crypto.mjs";
import { createRoverControl } from "../auth/roverControl.mjs";
import { startServer } from "../auth/server.mjs";
import { openStore, provision } from "../auth/store.mjs";

const origin = "https://pilot.example";
const listen = async (server) => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return "http://127.0.0.1:" + server.address().port;
};
const close = (server) => new Promise((resolve) => server.close(resolve));

function browser(base) {
  let csrf;
  let cookie;
  return {
    async call(path, method = "GET", body = {}, extra = {}) {
      const headers = { origin };
      if (cookie) headers.cookie = cookie;
      if (csrf) headers["x-cockpit-csrf"] = csrf;
      if (method !== "GET") headers["content-type"] = "application/json";
      Object.assign(headers, extra);
      const res = await fetch(base + path, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body) });
      const payload = await res.json();
      const setCookie = res.headers.get("set-cookie");
      if (setCookie) {
        assert.match(setCookie, /; Path=\/; Secure; HttpOnly; SameSite=Strict/);
        cookie = setCookie.split(";")[0];
      }
      if (payload.csrf) csrf = payload.csrf;
      assert.equal(res.headers.get("cache-control"), "no-store");
      return { status: res.status, ...payload, payload };
    },
    operation(path, method, body) {
      return fetch(base + path, { method, headers: { origin, cookie }, body });
    },
    connect(path = "/operation/navigation") {
      return new WebSocket(base.replace("http:", "ws:") + path, { origin, headers: cookie ? { Cookie: cookie } : {} });
    }
  };
}

test("TOTP matches RFC 6238 SHA-1 vector (last six digits)", () => {
  assert.equal(totpCode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 1), "287082");
});

test("pilot identity, account lifecycle, operational revocation and backup", { timeout: 30000 }, async (t) => {
  const folder = mkdtempSync(join(tmpdir(), "cockpit-auth-"));
  t.after(() => rmSync(folder, { force: true, recursive: true }));
  const file = join(folder, "keyring.json");
  writeFileSync(file, JSON.stringify({ active: "v1", keys: { v1: randomBytes(32).toString("base64") } }));
  const vault = openVault(file);
  const database = join(folder, "identity.sqlite");
  const db = openStore(database);
  const first = provision(db, vault, { username: "operator", name: "Pilot operator", role: "admin" });
  let now = Date.now();
  const tick = () => { now += 30000; };
  let cameraClosed = false;
  const peer = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/cam3/whep") {
      res.writeHead(201, { "Content-Type": "application/sdp", Location: "/cam3/whep/test-session" });
      return res.end("fake SDP");
    }
    if (req.method === "DELETE" && req.url === "/cam3/whep/test-session") {
      cameraClosed = true;
      return res.writeHead(204).end();
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ path: req.url, cookie: req.headers.cookie ?? null }));
  });
  const peerWs = new WebSocketServer({ server: peer });
  peerWs.on("connection", (ws) => ws.on("message", (data) => ws.send(data.toString())));
  const peerBase = await listen(peer);
  const server = startServer({ db, vault, origin, now: () => now, env: {
    COCKPIT_NAVIGATION_URL: peerBase.replace("http:", "ws:") + "/fixed",
    COCKPIT_VISION_URL: peerBase + "/vision",
    COCKPIT_CAMERA_URL: peerBase
  } });
  const base = await listen(server);
  try {
    const admin = browser(base);
    const user = browser(base);
    const anonymous = browser(base);
    assert.equal((await anonymous.call("/api/users")).status, 401);
    assert.equal((await anonymous.call("/operation/vision")).status, 401);
    await assert.rejects(once(anonymous.connect(), "open"), /401/);
    const login = await admin.call("/api/session/login", "POST", { username: "operator", password: first.password });
    assert.equal(login.stage, "password");
    assert.equal((await anonymous.call("/api/session/login", "POST", { username: "operator", password: first.password })).status, 401);
    assert.equal((await admin.call("/operation/vision")).status, 401);
    assert.equal((await admin.call("/api/users")).status, 403);
    const adminPassword = "Pilot administrator passphrase 14";
    const changed = await admin.call("/api/session/password", "POST", { currentPassword: first.password, password: adminPassword });
    assert.equal(changed.stage, "totp");
    const setup = await admin.call("/api/session/totp", "POST");
    const code = () => totpCode(setup.secret, Math.floor(now / 30000));
    assert.equal((await admin.call("/api/session/totp", "POST", { code: code() })).stage, "ready");
    assert.equal((await admin.call("/api/users", "POST", {}, { origin: "https://wrong.example" })).status, 403);
    assert.equal((await admin.call("/api/users", "POST", {}, { "x-cockpit-csrf": "wrong" })).status, 403);
    assert.equal((await admin.call("/api/users/" + first.id, "DELETE")).status, 409);

    const created = await admin.call("/api/users", "POST", { username: "pilot-user", name: "Pilot user", role: "user" });
    const userPath = "/api/users/" + created.account.id;
    assert.equal((await admin.call(userPath, "PATCH", { name: "Pilot user updated" })).account.name, "Pilot user updated");
    assert.equal((await user.call("/api/session/login", "POST", { username: "pilot-user", password: created.password })).stage, "password");
    const userPassword = "Piloto contraseña fuerte año 26";
    assert.equal((await user.call("/api/session/password", "POST", { currentPassword: created.password, password: userPassword })).stage, "ready");
    assert.equal((await user.call("/api/users")).status, 403);
    assert.equal((await user.call(userPath, "POST")).status, 403);
    const vision = await user.call("/operation/vision?time=1");
    assert.equal(vision.path, "/vision?time=1");
    assert.equal(vision.cookie, null);

    assert.equal((await admin.call(userPath + "/reveal", "POST", { password: adminPassword, code: code() })).status, 403);
    tick();
    const reveal = await admin.call(userPath + "/reveal", "POST", { password: adminPassword, code: code() });
    assert.equal(reveal.password, userPassword);
    assert.equal((await admin.call(userPath + "/reveal", "POST", { password: adminPassword, code: code() })).status, 403);
    assert.equal(db.prepare("SELECT password_copy FROM accounts WHERE id=?").get(first.id).password_copy, null);
    const row = db.prepare("SELECT hash,password_copy FROM accounts WHERE id=?").get(created.account.id);
    assert.ok(!row.hash.includes(userPassword) && !row.password_copy.includes(userPassword));
    assert.deepEqual(db.prepare("SELECT outcome FROM audit WHERE action='password.reveal' ORDER BY id").all().map((r) => r.outcome), ["denied", "ok", "denied"]);

    const ws = user.connect();
    await once(ws, "open");
    const echo = once(ws, "message");
    ws.send("ping");
    assert.equal(String((await echo)[0]), "ping");
    const offer = await user.operation("/operation/camera/cam3/whep", "POST", "fake SDP");
    assert.equal(offer.status, 201);
    const location = offer.headers.get("location");
    assert.equal(location, "/operation/camera/cam3/whep/test-session");
    await offer.text();
    assert.equal((await admin.operation(location, "DELETE")).status, 404);
    const revoked = once(ws, "close");
    assert.equal((await admin.call(userPath, "PATCH", { status: "suspended" })).account.status, "suspended");
    await revoked;
    for (let i = 0; i < 20 && !cameraClosed; i++) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(cameraClosed, "revocation closes the upstream camera session");
    assert.equal((await user.call("/api/session")).status, 401);
    assert.equal((await user.call("/operation/vision")).status, 401);
    assert.equal((await admin.call(userPath, "PATCH", { status: "active" })).account.status, "active");

    tick();
    const reset = await admin.call(userPath + "/reset", "POST", { password: adminPassword, code: code() });
    assert.equal((await user.call("/api/session/login", "POST", { username: "pilot-user", password: userPassword })).status, 401);
    assert.equal((await user.call("/api/session/login", "POST", { username: "pilot-user", password: reset.password })).stage, "password");

    const snapshot = join(folder, "restore.sqlite");
    await backup(db, snapshot);
    const restored = openStore(snapshot);
    try {
      assert.equal(restored.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      const saved = restored.prepare("SELECT password_copy FROM accounts WHERE id=?").get(created.account.id);
      assert.equal(vault.unseal(saved.password_copy, "password:" + created.account.id), reset.password);
    } finally {
      restored.close();
    }
    assert.equal((await admin.call(userPath, "DELETE")).status, 200);
    assert.equal(db.prepare("SELECT id FROM accounts WHERE id=?").get(created.account.id), undefined);

    now += 31 * 60 * 1000;
    assert.equal((await admin.call("/api/session")).status, 401);
    assert.equal((await admin.call("/api/session/login", "POST", { username: "operator", password: adminPassword })).status, 401);
    assert.equal((await admin.call("/api/session/login", "POST", { username: "operator", password: adminPassword, code: code() })).stage, "ready");
    assert.equal((await admin.call("/api/session/logout", "POST")).status, 200);
    assert.equal((await admin.call("/api/session")).status, 401);
  } finally {
    await close(server);
    await close(peer);
    peerWs.close();
    db.close();
  }
});

test("Rover password-only mode accepts eight letters and digits and skips TOTP", async () => {
  const db = openStore(":memory:");
  const vault = { seal: (value) => value, unseal: (value) => value };
  const admin = provision(db, vault, { username: "operator", name: "Operator", role: "admin", initialPassword: "admin234" });
  const server = startServer({ db, vault, origin, env: { COCKPIT_PASSWORD_ONLY: "true" } });
  const base = await listen(server);
  try {
    const session = browser(base);
    assert.equal((await session.call("/api/session/login", "POST", { username: "operator", password: "admin234" })).stage, "ready");
    const profile = { username: "pilot-user", name: "Pilot User", role: "user" };
    for (const initialPassword of ["abc1234", "abcdefgh", "12345678"]) {
      assert.equal((await session.call("/api/users", "POST", { ...profile, initialPassword })).status, 400);
    }
    const created = await session.call("/api/users", "POST", { ...profile, initialPassword: "pilot234" });
    assert.equal(created.status, 200);
    assert.equal((await session.call("/api/users/" + created.account.id + "/reveal", "POST", { password: "admin234" })).password, "pilot234");
    assert.equal(db.prepare("SELECT totp FROM accounts WHERE id=?").get(admin.id).totp, null);
  } finally {
    await close(server);
    db.close();
  }
});

test("authenticated tabs negotiate control with both handover options", async () => {
  const db = openStore(":memory:");
  const vault = { seal: (value) => value, unseal: (value) => value };
  provision(db, vault, { username: "operator", name: "Operator", role: "admin", initialPassword: "admin234" });
  let stops = 0;
  const control = createRoverControl({
    stop: async () => {
      stops++;
      return { locked: true, stationary: true, missionQuiescent: true };
    },
    canKeepRoute: () => true
  });
  const server = startServer({ db, vault, origin, control, env: { COCKPIT_PASSWORD_ONLY: "true" } });
  const base = await listen(server);
  const path = "/api/rover/control/";
  try {
    const session = browser(base);
    assert.equal((await session.call(path + "open", "POST")).status, 401);
    await session.call("/api/session/login", "POST", { username: "operator", password: "admin234" });
    assert.equal((await session.call(path + "open", "POST", {}, { "x-cockpit-csrf": "invalid" })).status, 403);
    const first = await session.call(path + "open", "POST");
    const second = await session.call(path + "open", "POST");
    assert.equal(first.mode, "controller");
    assert.equal(second.mode, "waiting");
    const afterStop = await session.call(path + "take", "POST", { instanceId: second.id, revision: second.revision });
    assert.equal(afterStop.mode, "controller");
    assert.equal(stops, 1);
    const previous = await session.call(path + "heartbeat", "POST", { instanceId: first.id });
    assert.equal(previous.displaced, true);
    assert.equal(previous.mode, "spectator");
    const preserved = await session.call(path + "take", "POST", { instanceId: first.id, revision: previous.revision, keepRoute: true });
    assert.equal(preserved.mode, "controller");
    assert.equal(stops, 1);
  } finally {
    await close(server);
    db.close();
  }
});
