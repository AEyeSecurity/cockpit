import assert from "node:assert/strict";
import { test } from "node:test";
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
