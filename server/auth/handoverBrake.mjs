import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

const brakeCommand = Object.freeze({ op: "set_manual_cmd", linear_x: 0, angular_z: 0, brake_pct: 100 });
const brakeDurationMs = 1000;
const manualIntervalMs = 50;

// The caller fences browser commands before starting this sequence. The send
// callback must use the robot connection that currently owns the SALUS lease.
export async function applyHandoverBrake({ send, lock, signal, now = () => performance.now(), wait = delay }) {
  try {
    signal?.throwIfAborted();
    const end = now() + brakeDurationMs;
    do {
      signal?.throwIfAborted();
      const response = await send(brakeCommand, signal);
      if (response?.ok !== true) throw new Error("SALUS no aceptó el comando de freno.");
      const remaining = end - now();
      if (remaining > 0) await wait(Math.min(manualIntervalMs, remaining), undefined, { signal });
    } while (now() < end);
  } finally {
    // Keep the lock attempt independent of the brake sequence's abort signal.
    await lock();
  }
}
