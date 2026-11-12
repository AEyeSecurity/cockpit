import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { applyHandoverBrake } from "./handoverBrake.mjs";
import { ControlConflict } from "./roverControl.mjs";

export function createSalusLink(url) {
  const clients = new Map();
  const pending = new Map();
  const snapshots = new Map();
  let socket;


  function clearPending(id, response) {
    const entry = pending.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.reply(response);
    return true;
  }

  function receive(data, binary) {
    if (binary) return;
    let response;
    try { response = JSON.parse(data.toString()); } catch { return; }
    if (!response || typeof response !== "object") return;
    const id = response.client_req_id ?? response.requestId;
    if (id) {
      clearPending(id, response);
      return;
    }
    if (response.op === "state" || response.op === "nav_telemetry") {
      snapshots.set(response.op, { value: response, time: Date.now() });
    }
    for (const client of clients.values()) client.send(response);
  }

  function connect() {
    if (socket && socket.readyState <= WebSocket.OPEN) return socket;
    const next = new WebSocket(url, { handshakeTimeout: 4000, followRedirects: false, maxPayload: 16 * 1024 * 1024 });
    socket = next;
    next.on("message", receive);
    next.on("error", (error) => {
      console.warn("Cockpit SALUS WebSocket error", { code: error.code ?? error.name, message: error.message });
      next.terminate();
    });
    next.on("close", (code, reason) => {
      if (socket !== next) return;
      console.warn("Cockpit SALUS WebSocket closed", { code, reason: reason.toString().slice(0, 123) });
      snapshots.clear();

      for (const id of pending.keys()) clearPending(id, { op: "ack", ok: false, error: "SALUS_DISCONNECTED" });
      for (const client of clients.values()) client.disconnect();
    });
    return next;
  }

  function send(message, reply, timeoutMs = 2500) {
    const link = connect();
    if (pending.size >= 128 || link.bufferedAmount > 1024 * 1024) {
      reply({ op: "ack", ok: false, error: "SALUS_BUSY" });
      return;
    }
    const id = randomUUID();
    const timer = setTimeout(() => clearPending(id, { op: "ack", ok: false, error: "SALUS_TIMEOUT" }), timeoutMs);
    pending.set(id, { timer, reply });
    const write = () => {
      if (!pending.has(id)) return;
      link.send(JSON.stringify({ ...message, requestId: id, client_req_id: id }), (error) => {
        if (error) clearPending(id, { op: "ack", ok: false, error: "SALUS_SEND_FAILED" });
      });
    };
    if (link.readyState === WebSocket.OPEN) write();
    else link.once("open", write);
  }

  function command(message, signal) {
    signal?.throwIfAborted();
    return new Promise((resolve) => send(message, resolve));
  }

  function latest(after = 0) {
    if (socket?.readyState !== WebSocket.OPEN) return null;
    const threshold = Math.max(after, Date.now() - 1500);
    const current = [...snapshots.values()].filter(({ time }) => time >= threshold)
      .sort((left, right) => left.time - right.time);
    return current.length ? Object.assign({}, ...current.map(({ value }) => value)) : null;
  }

  return {
    attach(instanceId, sendToClient, disconnect) {
      clients.set(instanceId, { send: sendToClient, disconnect });
      connect();
      if (latest()) for (const { value, time } of snapshots.values()) {
        if (Date.now() - time <= 1500) sendToClient(value);
      }
      return () => clients.delete(instanceId);
    },
    forward(instanceId, authorized) {
      const message = JSON.parse(authorized);
      const requestId = message.requestId ?? message.client_req_id;
      const reply = (response) => clients.get(instanceId)?.send({ ...response, requestId, client_req_id: requestId });
      // Do not queue browser commands across a broken robot connection.
      if (socket?.readyState !== WebSocket.OPEN) {
        reply({ op: "ack", request: message.op, ok: false, error: "SALUS_DISCONNECTED" });
        return;
      }
      send(message, reply);
    },
    canKeepRoute() {
      const state = latest();
      return Boolean(state?.control_owner === true && state.control_locked === false &&
        state.manual_enabled === false && state.goal_active === true &&
        ((state.route_mission?.active === true && state.route_mission.paused === false) ||
          (state.patrol_mission?.active === true && state.patrol_mission.paused !== true)));
    },
    async stop({ signal }) {
      let locked = false;
      let lockRequestedAt = 0;
      const lock = async () => {
        lockRequestedAt = Date.now();
        const response = await command({ op: "set_control_lock", locked: true });
        locked = response.ok === true && response.control_locked === true;
      };
      // SALUS accepts manual commands only on the connection owning the lease.
      // A new SALUS socket sends its initial state after the handshake.
      // Leave time for the lock request and its confirmation within the stop deadline.
      const link = connect();
      const stateDeadline = Date.now() + 1800;
      let before = latest();
      while (!before && link.readyState <= WebSocket.OPEN && Date.now() < stateDeadline) {
        await delay(50, undefined, { signal });
        before = latest();
      }
      signal.throwIfAborted();
      if (socket !== link || link.readyState !== WebSocket.OPEN) throw new ControlConflict("SALUS_UNAVAILABLE");
      if (before?.control_owner === true && before.control_locked === false) {
        if (before.manual_enabled !== true) {
          const response = await command({ op: "set_manual_mode", enabled: true }, signal);
          if (response.ok !== true) {
            await lock();
            throw new ControlConflict("STOP_UNCONFIRMED");
          }
        }
        await applyHandoverBrake({ send: command, lock, signal });
      } else {
        await lock();
        if (before?.control_locked !== true) throw new ControlConflict("STOP_UNCONFIRMED");
      }
      if (!locked) throw new ControlConflict("STOP_UNCONFIRMED");
      while (!signal.aborted) {
        const state = latest(lockRequestedAt);
        const route = state?.route_mission;
        const patrol = state?.patrol_mission;
        if (state?.goal_active === false && (route?.active === false || route?.paused === true) &&
            (patrol?.active === false || patrol?.paused === true) && state.control_locked === true) {
          return { locked: true, brakeSequenceComplete: true, missionQuiescent: true };
        }
        await delay(100, undefined, { signal });
      }
      throw new ControlConflict("STOP_UNCONFIRMED");
    },
    close() {
      socket?.terminate();
    }
  };
}
