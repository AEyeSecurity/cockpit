import { ControlConflict } from "./roverControl.mjs";

const messages = {
  INSTANCE_EXPIRED: "La conexión de esta pestaña venció. Volvé a conectar.",
  CONTROL_CHANGED: "Cambió la instancia que tiene el control. Volvé a consultar.",
  ADMIN_HAS_CONTROL: "Un administrador tiene el control del Rover.",
  AUTONOMOUS_ROUTE_UNCONFIRMED: "La misión autónoma ya no está confirmada.",
  STOP_TIMEOUT: "El Rover no confirmó la detención a tiempo.",
  STOP_UNCONFIRMED: "El Rover no confirmó la detención.",
  SALUS_UNAVAILABLE: "La pasarela no tiene conexión con SALUS. Volvé a intentar cuando se restablezca.",
  RELEASE_CONTROL_FIRST: "Primero liberá el control."
};

export async function handleRoverControl(control, path, session, body, HttpError) {
  if (!control) throw new HttpError(404, "Control por instancia no disponible.");
  const sessionId = session.id;
  try {
    if (path === "/api/rover/control/open") return control.open(sessionId, session.account.role);
    if (typeof body.instanceId !== "string") throw new HttpError(400, "Instancia inválida.");
    const id = body.instanceId;
    switch (path) {
      case "/api/rover/control/heartbeat": return control.heartbeat(id, sessionId);
      case "/api/rover/control/spectate": return control.spectate(id, sessionId);
      case "/api/rover/control/acknowledge": return control.acknowledge(id, sessionId);
      case "/api/rover/control/take":
        if (!Number.isSafeInteger(body.revision) || (body.keepRoute !== undefined && typeof body.keepRoute !== "boolean")) {
          throw new HttpError(400, "Solicitud de traspaso inválida.");
        }
        return await control.take(id, sessionId, body.revision, { keepRoute: body.keepRoute === true });
      case "/api/rover/control/close":
        await control.close(id, sessionId);
        return {};
      default: throw new HttpError(404, "Ruta inexistente.");
    }
  } catch (error) {
    if (error instanceof ControlConflict) {
      if (path === "/api/rover/control/take") console.warn("Cockpit Rover takeover rejected", { code: error.code });
      throw new HttpError(409, messages[error.code] ?? "El control del Rover no está disponible.");
    }
    throw error;
  }
}
