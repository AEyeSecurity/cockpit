import { randomUUID } from "node:crypto";

export class ControlConflict extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

// A single coordinator represents one physical Rover. The gateway must supply
// the authenticated session and role, and keep robot command sockets private.
export function createRoverControl({ stop, canKeepRoute = () => false, startFenced = false, now = Date.now, leaseMs = 8000, stopMs = 5000, record = () => {} }) {
  const instances = new Map();
  let owner = null;
  let revision = 0;
  let phase = startFenced ? "fault" : "idle";

  function get(id, sessionId) {
    const entry = instances.get(id);
    if (!entry || entry.sessionId !== sessionId || entry.until <= now()) {
      throw new ControlConflict("INSTANCE_EXPIRED");
    }
    return entry;
  }

  function state(entry) {
    const currentOwner = owner && instances.get(owner);
    return {
      id: entry.id,
      mode: owner === entry.id && phase === "owned" ? "controller" : entry.mode,
      revision,
      phase,
      occupied: Boolean(owner),
      canTake: phase !== "stopping" && (currentOwner?.role !== "admin" || entry.role === "admin" || owner === entry.id),
      canKeepRoute: phase === "owned" && Boolean(owner) && owner !== entry.id && canKeepRoute(owner),
      displaced: entry.displaced
    };
  }

  function promote(entry) {
    owner = entry.id;
    entry.displaced = false;
    entry.mode = "spectator";
    phase = "owned";
    revision++;
    record("control.granted", entry.id);
    return state(entry);
  }

  async function stopAndFence(previous, reason) {
    phase = "stopping";
    revision++;
    const controller = new AbortController();
    let timer;
    try {
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new ControlConflict("STOP_TIMEOUT"));
        }, stopMs);
      });
      const evidence = await Promise.race([
        Promise.resolve().then(() => stop({ instanceId: previous, signal: controller.signal, reason })),
        deadline
      ]);
      if (evidence?.locked !== true || (evidence?.stationary !== true && evidence?.brakeSequenceComplete !== true) || evidence?.missionQuiescent !== true) {
        throw new ControlConflict("STOP_UNCONFIRMED");
      }
    } catch (error) {
      phase = "fault";
      revision++;
      record("control.stop_failed", previous);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function release(id, reason) {
    instances.delete(id);
    if (owner !== id) return;
    owner = null;
    if (phase === "stopping") return;
    record("control.released", id);
    await stopAndFence(id, reason);
    phase = "idle";
    revision++;
  }

  return {
    open(sessionId, role) {
      if (!sessionId || !["admin", "user"].includes(role)) throw new ControlConflict("INVALID_SESSION");
      const entry = { id: randomUUID(), sessionId, role, until: now() + leaseMs, mode: "waiting", displaced: false };
      instances.set(entry.id, entry);
      if (phase === "idle" && !owner) return promote(entry);
      return state(entry);
    },
    status(id, sessionId) {
      return state(get(id, sessionId));
    },
    heartbeat(id, sessionId) {
      const entry = get(id, sessionId);
      entry.until = now() + leaseMs;
      return state(entry);
    },
    spectate(id, sessionId) {
      const entry = get(id, sessionId);
      if (owner === id) throw new ControlConflict("RELEASE_CONTROL_FIRST");
      entry.mode = "spectator";
      return state(entry);
    },
    async take(id, sessionId, expectedRevision, { keepRoute = false } = {}) {
      const entry = get(id, sessionId);
      if (phase === "stopping" || revision !== expectedRevision) throw new ControlConflict("CONTROL_CHANGED");
      if (owner === id && phase === "owned") return state(entry);
      if (!state(entry).canTake) {
        record("control.denied", id);
        throw new ControlConflict("ADMIN_HAS_CONTROL");
      }
      if (keepRoute && (phase !== "owned" || !owner || !canKeepRoute(owner))) {
        throw new ControlConflict("AUTONOMOUS_ROUTE_UNCONFIRMED");
      }
      if (phase === "idle" && !owner) return promote(entry);
      const previous = owner;
      if (!keepRoute) await stopAndFence(previous, "takeover");
      const displaced = instances.get(previous);
      if (displaced) {
        displaced.mode = "spectator";
        displaced.displaced = true;
      }
      owner = null;
      phase = "idle";
      revision++;
      return promote(get(id, sessionId));
    },
    acknowledge(id, sessionId) {
      const entry = get(id, sessionId);
      entry.displaced = false;
      return state(entry);
    },
    close(id, sessionId) {
      get(id, sessionId);
      return release(id, "disconnect");
    },
    async sweep(isLive) {
      for (const entry of instances.values()) {
        if (entry.until <= now() || !isLive(entry.sessionId)) await release(entry.id, "lease_lost");
      }
    },
    permits(id, sessionId, operation) {
      const entry = get(id, sessionId);
      if (operation === "stop") return entry.mode === "spectator";
      return owner === id && phase === "owned";
    }
  };
}
