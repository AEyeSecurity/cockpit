import { applyHandoverBrake } from "../auth/handoverBrake.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { authorizeNavigationFrame } from "../auth/navigationPolicy.mjs";
import { createRoverControl } from "../auth/roverControl.mjs";

const stopped = { locked: true, stationary: true, missionQuiescent: true };

test("same-account tabs compete and only one takeover succeeds", async () => {
  let confirmStop;
  const control = createRoverControl({ stop: () => new Promise((resolve) => { confirmStop = resolve; }) });
  const first = control.open("session", "user");
  const second = control.open("session", "user");
  const third = control.open("session", "user");
  assert.equal(first.mode, "controller");
  assert.equal(second.mode, "waiting");
  assert.notEqual(first.id, second.id);
  assert.throws(() => control.status(second.id, "other"), { code: "INSTANCE_EXPIRED" });
  const handover = control.take(second.id, "session", second.revision);
  assert.equal(control.permits(first.id, "session", "drive"), false);
  assert.equal(control.permits(second.id, "session", "drive"), false);
  await assert.rejects(control.take(third.id, "session", third.revision), { code: "CONTROL_CHANGED" });
  confirmStop(stopped);
  assert.equal((await handover).mode, "controller");
  assert.equal(control.status(first.id, "session").displaced, true);
  assert.equal(control.acknowledge(first.id, "session").mode, "spectator");
  assert.equal(control.permits(first.id, "session", "unlock"), false);
  assert.equal(control.permits(first.id, "session", "stop"), true);
});

test("user can watch an administrator but cannot take their control", async () => {
  const control = createRoverControl({ stop: async () => stopped });
  control.open("admin", "admin");
  const user = control.open("user", "user");
  assert.equal(user.canTake, false);
  assert.equal(control.spectate(user.id, "user").mode, "spectator");
  await assert.rejects(control.take(user.id, "user", user.revision), { code: "ADMIN_HAS_CONTROL" });
});

test("unconfirmed stop fences commands after controller expiry", async () => {
  let now = 0;
  const control = createRoverControl({ now: () => now, stop: async () => ({ locked: true }) });
  const first = control.open("first", "user");
  now = 6000;
  const observer = control.open("observer", "admin");
  control.spectate(observer.id, "observer");
  now = 8001;
  await assert.rejects(control.sweep(() => true), { code: "STOP_UNCONFIRMED" });
  assert.throws(() => control.status(first.id, "first"), { code: "INSTANCE_EXPIRED" });
  assert.equal(control.status(observer.id, "observer").phase, "fault");
  assert.equal(control.permits(observer.id, "observer", "drive"), false);
  assert.equal(control.permits(observer.id, "observer", "stop"), true);
});

test("preserving the route requires fresh autonomous evidence and does not invoke stop", async () => {
  let autonomous = false;
  let stopCalls = 0;
  const control = createRoverControl({
    stop: async () => { stopCalls++; return stopped; },
    canKeepRoute: () => autonomous
  });
  const first = control.open("first", "user");
  const second = control.open("second", "admin");
  await assert.rejects(control.take(second.id, "second", second.revision, { keepRoute: true }), {
    code: "AUTONOMOUS_ROUTE_UNCONFIRMED"
  });
  assert.equal(control.permits(first.id, "first", "drive"), true);
  autonomous = true;
  assert.equal((await control.take(second.id, "second", second.revision, { keepRoute: true })).mode, "controller");
  assert.equal(stopCalls, 0);
  assert.equal(control.status(first.id, "first").displaced, true);
  assert.equal(control.permits(first.id, "first", "drive"), false);
});

test("spectator frames allow snapshots and a canonical emergency stop only", () => {
  const control = createRoverControl({ stop: async () => stopped });
  const owner = control.open("same-session", "admin");
  const viewer = control.open("same-session", "admin");
  control.spectate(viewer.id, "same-session");
  const filter = (message) => authorizeNavigationFrame(
    control, viewer.id, "same-session", Buffer.from(JSON.stringify(message)), false
  );
  for (const op of ["set_manual_cmd", "set_route_ll", "set_patrol_ll", "save_route", "delete_route", "control_heartbeat"]) {
    assert.equal(filter({ op }), null);
  }
  assert.equal(filter({ op: "set_control_lock", locked: false }), null);
  assert.equal(filter({ op: "set_control_lock", payload: { locked: true } }), null);
  assert.deepEqual(JSON.parse(filter({
    op: "set_control_lock", locked: true, payload: { locked: false }, client_req_id: "stop"
  })), { op: "set_control_lock", locked: true, client_req_id: "stop" });
  assert.deepEqual(JSON.parse(filter({ op: "get_nav_snapshot", payload: { op: "set_route_ll" } })), {
    op: "get_nav_snapshot"
  });
  assert.equal(authorizeNavigationFrame(control, owner.id, "same-session", Buffer.from("{}"), true), null);
});

test("handover braking repeats the spacebar command for one second, then locks", async () => {
  let time = 0;
  const commands = [];
  await applyHandoverBrake({
    now: () => time,
    wait: async (ms) => { time += ms; },
    send: async (command) => { commands.push({ time, command }); return { ok: true }; },
    lock: async () => { commands.push({ time, command: { op: "set_control_lock", locked: true } }); }
  });
  assert.deepEqual(commands.slice(0, -1).map(({ time }) => time), Array.from({ length: 20 }, (_, i) => i * 50));
  for (const { command } of commands.slice(0, -1)) {
    assert.deepEqual(command, { op: "set_manual_cmd", linear_x: 0, angular_z: 0, brake_pct: 100 });
  }
  assert.deepEqual(commands.at(-1), { time: 1000, command: { op: "set_control_lock", locked: true } });
});

test("handover braking attempts the lock even when the brake command is rejected", async () => {
  let locked = false;
  await assert.rejects(applyHandoverBrake({
    send: async () => ({ ok: false }),
    lock: async () => { locked = true; }
  }), /no aceptó/);
  assert.equal(locked, true);
});
