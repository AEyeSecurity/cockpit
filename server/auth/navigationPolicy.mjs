const readOperations = new Set(["get_nav_snapshot", "get_state", "get_route_state", "get_patrol_state"]);

export function authorizeNavigationFrame(control, instanceId, sessionId, frame, binary) {
  if (binary) return null;
  let message;
  try {
    message = JSON.parse(frame.toString());
  } catch {
    return null;
  }
  if (!message || typeof message !== "object" || Array.isArray(message) || typeof message.op !== "string") {
    return null;
  }
  if (control.permits(instanceId, sessionId, "drive")) return JSON.stringify(message);
  if (control.status(instanceId, sessionId).mode !== "spectator") return null;

  const ids = {};
  for (const field of ["requestId", "client_req_id"]) {
    if (typeof message[field] === "string") ids[field] = message[field];
  }
  if (message.op === "history_list") {
    const { view, start, end, category, before } = message;
    return JSON.stringify({ ...ids, op: message.op, view, start, end, category, before });
  }
  if (message.op === "history_patrol") {
    const { patrol_id, after, through } = message;
    return JSON.stringify({ ...ids, op: message.op, patrol_id, after, through });
  }
  if (message.op === "recordings_list") {
    const { camera, start, end } = message;
    if (!["main", "mobile", "rear"].includes(camera) || typeof start !== "string" ||
        typeof end !== "string" || Date.parse(end) - Date.parse(start) !== 10000) return null;
    return JSON.stringify({ ...ids, op: message.op, camera: message.camera, start: message.start, end: message.end });
  }
  if (readOperations.has(message.op)) return JSON.stringify({ ...ids, op: message.op });
  if (message.op === "set_control_lock" && message.locked === true &&
      control.permits(instanceId, sessionId, "stop")) {
    return JSON.stringify({ ...ids, op: "set_control_lock", locked: true });
  }
  return null;
}
