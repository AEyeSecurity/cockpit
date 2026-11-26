import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createSocketServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { backup } from "node:sqlite";
import { test } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { openVault, totpCode } from "../auth/crypto.mjs";
import { createRoverControl } from "../auth/roverControl.mjs";
import { startServer } from "../auth/server.mjs";
import { createSshRebootExchange } from "../auth/hostReboot.mjs";
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

test("remote maintenance uses a pinned host key and sends the request on stdin", async () => {
  const bootId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const exchange = createSshRebootExchange("rover.private", (file, args, options, done) => {
    assert.equal(file, "/usr/bin/ssh");
    assert.equal(args.includes("StrictHostKeyChecking=yes"), true);
    assert.deepEqual(args.slice(-2), ["salus-reboot@rover.private", "maintenance"]);
    assert.equal(options.timeout, 9000);
    return { stdin: new Writable({
      write(chunk, encoding, callback) {
        assert.equal(chunk.toString(), "reboot " + bootId + "\n");
        callback();
      },
      final(callback) {
        done(null, JSON.stringify({ state: "requested", boot_id: bootId }));
        callback();
      }
    }) };
  });
  assert.deepEqual(await exchange("reboot " + bootId), { state: "requested", boot_id: bootId });
  assert.throws(() => createSshRebootExchange("-oProxyCommand=unexpected"), /Invalid host/);
});

test("host reboot requires an authenticated administrator and visual confirmation", async () => {
  const folder = mkdtempSync(join(tmpdir(), "cockpit-reboot-"));
  const file = join(folder, "keys.json");
  writeFileSync(file, JSON.stringify({ active: "v1", keys: { v1: randomBytes(32).toString("base64") } }));
  const vault = openVault(file);
  const db = openStore(join(folder, "identity.sqlite"));
  provision(db, vault, { username: "operator", name: "Operator", role: "admin", initialPassword: "admin234" });
  provision(db, vault, { username: "driver", name: "Driver", role: "user", initialPassword: "driver234" });
  db.prepare("UPDATE accounts SET must_change=0").run();
  const socketPath = join(folder, "reboot.sock");
  const bootId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const requests = [];
  const socketServer = createSocketServer(socket => {
    socket.setEncoding("utf8").on("data", command => {
      requests.push(command);
      socket.end(JSON.stringify({ state: command === "status\n" ? "ready" : "requested", boot_id: bootId }));
    });
  });
  socketServer.listen(socketPath);
  await once(socketServer, "listening");
  const server = startServer({ db, vault, origin, env: {
    COCKPIT_PASSWORD_ONLY: "true", COCKPIT_ROVER_CONTROL: "false",
    COCKPIT_NAVIGATION_URL: "ws://127.0.0.1:1", COCKPIT_HOST_REBOOT_SOCKET: socketPath
  } });
  try {
    const base = await listen(server);
    const path = "/api/rover/maintenance/reboot";
    const confirmed = { visuallyConfirmed: true };
    const admin = browser(base);
    const driver = browser(base);
    assert.equal((await admin.call(path, "POST", confirmed)).status, 401);
    assert.equal((await driver.call("/api/session/login", "POST", { username: "driver", password: "driver234" })).stage, "ready");
    assert.equal((await driver.call(path, "POST", confirmed)).status, 403);
    assert.equal((await admin.call("/api/session/login", "POST", { username: "operator", password: "admin234" })).stage, "ready");
    assert.equal((await admin.call(path, "POST", confirmed, { "x-cockpit-csrf": "invalid" })).status, 403);
    assert.equal((await admin.call(path, "POST", {})).status, 400);
    assert.deepEqual(requests, []);
    assert.equal((await admin.call(path, "POST", confirmed)).state, "requested");
    assert.deepEqual(requests, ["status\n", "reboot " + bootId + "\n"]);
  } finally {
    await close(server);
    await close(socketServer);
    db.close();
    rmSync(folder, { force: true, recursive: true });
  }
});

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
  const weatherKeyFile = join(folder, "weatherapi.key");
  writeFileSync(weatherKeyFile, "test-weather-key");
  const weatherRequest = async (url) => {
    assert.equal(url.origin, "https://api.weatherapi.com");
    assert.equal(url.searchParams.get("q"), "-31.40,-64.18");
    assert.equal(url.searchParams.get("key"), "test-weather-key");
    return Response.json({
      location: { localtime_epoch: 1 },
      current: { last_updated_epoch: 1, condition: { text: "Soleado" }, wind_kph: 10, gust_kph: 15 },
      forecast: { forecastday: [{ hour: [
        { time_epoch: 2, time: "10:00", chance_of_rain: 0 },
        { time_epoch: 3, time: "11:00", chance_of_rain: 0 }
      ] }] }
    });
  };
  const server = startServer({ db, vault, origin, now: () => now, weatherRequest, env: {
    COCKPIT_WEATHER_KEY_FILE: weatherKeyFile,
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
    assert.equal((await anonymous.call("/api/weather?lat=-31.4&lon=-64.18")).status, 401);
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
    const weather = await user.call("/api/weather?lat=-31.401&lon=-64.179");
    assert.equal(weather.status, 200);
    assert.equal(weather.condition, "Soleado");
    assert.equal(JSON.stringify(weather).includes("test-weather-key"), false);
    assert.equal((await user.call("/api/weather?lat=100&lon=0")).status, 400);
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

test("running server keeps a single SALUS socket through both handovers", { timeout: 18000 }, async () => {
  const db = openStore(":memory:");
  const vault = { seal: (value) => value, unseal: (value) => value };
  provision(db, vault, { username: "operator", name: "Operator", role: "admin", initialPassword: "admin234" });
  provision(db, vault, { username: "driver", name: "Driver", role: "user", initialPassword: "driver234" });
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  let sockets = 0;
  let brake = 0;
  const state = {
    op: "state", control_owner: true, control_locked: false, manual_enabled: false,
    goal_active: true, route_mission: { active: true, paused: false }, patrol_mission: { active: false }
  };
  upstream.on("connection", (peer) => {
    sockets++;
    peer.send(JSON.stringify(state));
    peer.on("message", (data) => {
      const request = JSON.parse(data.toString());
      if (request.op === "set_manual_cmd") {
        assert.equal(state.manual_enabled, true);
        assert.equal(request.brake_pct, 100);
        assert.equal(request.linear_x, 0);
        assert.equal(request.angular_z, 0);
        brake++;
      }
      if (request.op === "set_manual_mode") state.manual_enabled = request.enabled;
      if (request.op === "set_control_lock") {
        assert.equal(request.locked, true);
        Object.assign(state, { control_locked: true, goal_active: false, route_mission: { active: false } });
      }
      peer.send(JSON.stringify({ op: "ack", request: request.op, ok: true,
        client_req_id: request.client_req_id, control_locked: state.control_locked }));
      if (request.op === "set_control_lock") peer.send(JSON.stringify(state));
    });
  });
  const server = startServer({ db, vault, origin, env: {
    COCKPIT_PASSWORD_ONLY: "true", COCKPIT_ROVER_CONTROL: "true",
    COCKPIT_NAVIGATION_URL: "ws://127.0.0.1:1",
    COCKPIT_NAVIGATION_ALTERNATIVES: "ws://127.0.0.1:" + upstream.address().port
  } });
  const base = await listen(server);
  const path = "/api/rover/control/";
  const clients = [];
  try {
    const session = browser(base);
    await session.call("/api/session/login", "POST", { username: "operator", password: "admin234" });
    const destination = "/api/rover/destination";
    const selected = { host: "127.0.0.1", port: String(upstream.address().port) };
    assert.equal((await session.call(destination)).port, "1");
    assert.equal((await session.call(destination, "PUT", { ...selected, host: "unconfigured.example" })).status, 400);
    assert.equal((await session.call(destination, "PUT", selected)).port, selected.port);
    const driver = browser(base);
    assert.equal((await driver.call("/api/session/login", "POST", { username: "driver", password: "driver234" })).stage, "ready");
    const first = await driver.call(path + "open", "POST");
    assert.equal(first.mode, "controller");
    assert.equal((await session.call(destination, "PUT", { ...selected, port: "1" })).status, 409);
    const firstWs = driver.connect("/operation/navigation?instance=" + first.id);
    clients.push(firstWs);
    await once(firstWs, "message");
    const second = await session.call(path + "open", "POST");
    assert.equal(second.canKeepRoute, true);
    const takeover = await session.call(path + "take", "POST", {
      instanceId: second.id, revision: second.revision, keepRoute: true
    });
    assert.equal(takeover.mode, "controller");
    assert.equal(brake, 0);
    const secondWs = session.connect("/operation/navigation?instance=" + second.id);
    clients.push(secondWs);
    await once(secondWs, "message");
    const previous = await driver.call(path + "heartbeat", "POST", { instanceId: first.id });
    assert.equal(previous.mode, "spectator");
    assert.equal(previous.displaced, true);
    assert.equal(previous.canTake, false);
    assert.equal((await driver.call(path + "take", "POST", { instanceId: first.id, revision: previous.revision })).status, 409);
    firstWs.send(JSON.stringify({ op: "set_manual_cmd", brake_pct: 0, linear_x: 2 }));

    const third = await session.call(path + "open", "POST");
    const transferred = await session.call(path + "take", "POST", { instanceId: third.id, revision: third.revision });
    assert.equal(transferred.mode, "controller");
    assert.ok(brake > 1);
    assert.equal(sockets, 1);
    assert.equal(state.control_locked, true);

    const thirdWs = session.connect("/operation/navigation?instance=" + third.id);
    clients.push(thirdWs);
    await once(thirdWs, "message");

    // None of the tabs runs the browser heartbeat while in the background.
    await new Promise((resolve) => setTimeout(resolve, 8500));
    const spectator = await session.call(path + "heartbeat", "POST", { instanceId: second.id });
    assert.equal(spectator.mode, "spectator");
    assert.equal(spectator.displaced, true);
    assert.equal(secondWs.readyState, WebSocket.OPEN);
    assert.equal(firstWs.readyState, WebSocket.OPEN);
  } finally {
    clients.forEach((client) => client.terminate());
    for (const peer of upstream.clients) peer.terminate();
    upstream.close();
    await close(server);
    db.close();
  }
});

test("signed-in operators can control NVR transmission with CSRF protection", async () => {
  const folder = mkdtempSync(join(tmpdir(), "cockpit-nvr-"));
  const file = join(folder, "keys.json");
  writeFileSync(file, JSON.stringify({ active: "v1", keys: { v1: randomBytes(32).toString("base64") } }));
  const vault = openVault(file);
  const db = openStore(join(folder, "identity.sqlite"));
  provision(db, vault, { username: "driver", name: "Driver", role: "user", initialPassword: "driver234" });
  db.prepare("UPDATE accounts SET must_change=0").run();
  let enabled = false;
  const relay = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer test-token");
    if (req.method === "PUT") {
      let body = "";
      for await (const part of req) body += part;
      enabled = JSON.parse(body).enabled;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ enabled, online: enabled ? 3 : 0 }));
  });
  const relayUrl = await listen(relay);
  const server = startServer({ db, vault, origin, env: {
    COCKPIT_PASSWORD_ONLY: "true",
    COCKPIT_NVR_CONTROL_URL: relayUrl + "/transmission",
    COCKPIT_NVR_CONTROL_TOKEN: "test-token"
  } });
  try {
    const operator = browser(await listen(server));
    const path = "/api/rover/nvr-transmission";
    assert.equal((await operator.call(path)).status, 401);
    assert.equal((await operator.call("/api/session/login", "POST", { username: "driver", password: "driver234" })).stage, "ready");
    assert.deepEqual((await operator.call(path)).payload, { enabled: false, online: 0 });
    assert.equal((await operator.call(path, "PUT", { enabled: true }, { "x-cockpit-csrf": "invalid" })).status, 403);
    assert.equal((await operator.call(path, "PUT", { enabled: "true" })).status, 400);
    assert.deepEqual((await operator.call(path, "PUT", { enabled: true })).payload, { enabled: true, online: 3 });
    assert.deepEqual((await operator.call(path, "PUT", { enabled: false })).payload, { enabled: false, online: 0 });
  } finally {
    await close(server);
    await close(relay);
    db.close();
    rmSync(folder, { force: true, recursive: true });
  }
});
