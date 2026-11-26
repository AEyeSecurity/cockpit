import { useCallback, useEffect, useRef, useState } from "react";
import type { HistoryDispatcher } from "./index";
import "./styles.css";

interface HistoryEvent {
  sequence: number;
  robot: string;
  timestamp: string;
  patrol_id: string | null;
  category: string;
  severity: number;
  component: string;
  code: string;
  details: Record<string, string>;
}
interface Patrol {
  id: string;
  robot: string;
  started_at: string;
  ended_at: string | null;
  status: string;
  duration_s: number;
  circuit_s: number;
  incomplete: boolean;
}
interface Page<T> { items: T[]; next: number | null }
interface HistoryPage extends Page<HistoryEvent | Patrol> { robot: string; degraded: boolean }
interface PatrolPage extends Page<HistoryEvent> { patrol: Patrol; through: number; schema_version: number }

const categories: Record<string, string> = {
  mode: "Control", patrol: "Patrulla", stop: "Freno y detención", fault: "Incidentes", navigation: "Navegación"
};
const statuses: Record<string, string> = {
  active: "En curso", paused: "En pausa", home: "Llegó a HOME", cancelled: "Cancelada",
  held: "Retenida en HOME", failed: "Fallida", replaced: "Reemplazada", interrupted: "Registro interrumpido"
};
const events: Record<string, string> = {
  OPERATOR_LEASE_ACQUIRED: "Permiso de operación tomado",
  OPERATOR_LEASE_RELEASED: "Permiso de operación liberado",
  RC_CONTROL_ACTIVE: "Control RC activo",
  RC_CONTROL_RELEASED: "Control RC liberado",
  PATROL_MISSION_STARTED: "Patrulla iniciada",
  PATROL_MISSION_REJECTED: "Intento de patrulla rechazado",
  PATROL_PHASE_FAILED: "Fallo al iniciar una fase de patrulla",
  PATROL_LOOP_JOINED: "Entrada al circuito",
  PATROL_ROUTE_PAUSED: "Patrulla en pausa",
  PATROL_AT_HOME: "Patrulla en HOME",
  PATROL_MISSION_CANCELLED: "Patrulla cancelada",
  PATROL_HELD_AT_HOME_LOW_BATTERY: "Patrulla retenida por batería baja",
  RETURN_HOME_REQUESTED: "Retorno a HOME solicitado",
  BATTERY_RETURN_HOME_REQUESTED: "Retorno a HOME por batería",
  BATTERY_RETURN_LATCHED: "Retorno por batería activado",
  BATTERY_RETURN_RECOMMENDED: "Retorno recomendado por batería",
  BATTERY_RETURN_RECOMMENDATION_CLEARED: "Se quitó la recomendación de retorno por batería",
  BRAKE_REQUESTED: "Orden de freno",
  BRAKE_APPLIED: "Freno aplicado según el controlador",
  BRAKE_RELEASED: "Freno liberado",
  ESTOP_ACTIVE: "Parada de emergencia activa",
  ESTOP_CLEARED: "Parada de emergencia liberada",
  VEHICLE_STOP_OBSERVED: "Detención medida",
  NAVIGATION_BLOCK_CLEARED: "Bloqueo de navegación liberado",
  COLLISION_STOP: "Monitor de colisión en parada",
  PATH_HEALTH_STOP: "Parada por datos de ruta no disponibles",
  SAFETY_SCAN_STALE: "Parada por datos vencidos del LiDAR",
  MANUAL_WATCHDOG_STOP: "Parada por pérdida de mando manual",
  CONTROLLER_TELEMETRY_STALE: "Telemetría del controlador vencida",
  CONTROLLER_TELEMETRY_RECOVERED: "Telemetría del controlador recuperada",
  CAPABILITY_UNAVAILABLE: "Subsistema no disponible",
  CAPABILITY_INVALID: "Datos de subsistema inválidos",
  CAPABILITY_STALE: "Datos de subsistema vencidos",
  CAPABILITY_FAILED: "Fallo de subsistema",
  CAPABILITY_READY: "Subsistema recuperado",
  GOAL_CANCEL_REQUESTED: "Cancelación de objetivo solicitada",
  GOAL_RESULT_SUCCEEDED: "Objetivo de navegación alcanzado",
  GOAL_CANCELLED: "Objetivo de navegación cancelado",
  GOAL_RESULT_ABORTED: "Objetivo de navegación abortado",
  GOAL_REJECTED: "Objetivo de navegación rechazado",
  ROUTE_BLOCKED_WAITING: "Ruta bloqueada",
  ROUTE_BLOCKED_CLEARED: "Ruta desbloqueada",
  ROUTE_BLOCKED_NEEDS_OPERATOR: "Ruta bloqueada, requiere intervención"
};
const phases: Record<string, string> = {
  DEPART_HOME: "Salida de HOME", JOIN_LOOP: "Ingreso al circuito", PATROL: "Circuito de patrulla",
  EXIT_LOOP: "Salida del circuito", RETURN_HOME: "Regreso a HOME", AT_HOME: "En HOME"
};
const reasons: Record<string, string> = {
  ROUTE_EXECUTOR_UNAVAILABLE: "Ejecutor de rutas no disponible",
  ROUTE_DISPATCH_FAILED: "El ejecutor no pudo iniciar la fase",
  RETURN_EXIT_CANCEL_FAILED: "Fallo al cerrar el tramo antes del regreso",
  ABORTED: "El ejecutor abortó la ruta", CANCELLED: "El ejecutor canceló la ruta",
  PAUSED: "El ejecutor pausó la ruta", MANUAL_TAKEOVER: "Toma de control manual",
  OPERATOR_CANCEL: "Cancelación del operador", NO_VALID_PATH: "El planificador no encontró un camino válido",
  PLANNER_U_TURN: "El planificador propuso un giro en U",
  PLANNER_LOOP: "El planificador propuso un recorrido en bucle",
  MANEUVER_GEOMETRY_INVALID: "El planificador propuso una maniobra inválida",
  NAV_ABORTED: "La navegación se interrumpió",
  UI_CLIENT_DISCONNECTED: "Cockpit se desconectó", UI_HEARTBEAT_TIMEOUT: "Se perdió la señal de Cockpit",
};

function eventTitle(event: HistoryEvent) {
  if (event.code === "MANUAL_MODE_CHANGED") {
    return event.details.enabled?.toLowerCase() === "true" ? "Modo manual confirmado" : "Modo manual desactivado";
  }
  if (event.code === "PATROL_PHASE_DISPATCHED") {
    return phases[event.details.phase] ?? "Fase de patrulla iniciada";
  }
  return events[event.code] ?? (event.severity >= 2 ? "Fallo reportado" : "Evento de operación");
}
function eventContext(event: HistoryEvent) {
  const reason = event.details.reason_code || event.details.failure_code;
  if (reason && (reasons[reason] || events[reason])) return reasons[reason] ?? events[reason];
  if (event.code === "PATROL_ROUTE_PAUSED") return reasons[event.details.route_status] ?? "Motivo no disponible";
  if (event.code === "VEHICLE_STOP_OBSERVED" || event.code === "BRAKE_REQUESTED") return "Motivo no disponible";
  if (event.code.startsWith("CAPABILITY_") || !events[event.code] && event.severity >= 2) return event.component;
  return "";
}
function localDay() {
  const now = new Date();
  return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
}
const dateTime = new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeStyle: "medium", hourCycle: "h23" });
const time = new Intl.DateTimeFormat("es-AR", { timeStyle: "medium", hourCycle: "h23" });
function duration(seconds: number) {
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total % 3600 / 60);
  return [hours && `${hours} h`, minutes && `${minutes} min`, `${total % 60} s`].filter(Boolean).join(" ");
}
function Timeline({ items, fullDate = false, onPatrol }: {
  items: HistoryEvent[]; fullDate?: boolean; onPatrol?: (id: string) => void;
}) {
  return <ol className="history-timeline">
    {items.map(event => <li key={event.sequence}>
      <time dateTime={event.timestamp}>{(fullDate ? dateTime : time).format(new Date(event.timestamp))}</time>
      <div className="history-event">
        <div className="history-event-heading">
          <strong>{eventTitle(event)}</strong>
          <span className="history-tag" data-tone={event.severity >= 2 ? "error" : event.severity >= 1 ? "warn" : "normal"}>
            {event.category === "stop" ? "Detención" : event.severity >= 2 ? "Fallo" : categories[event.category] ?? "Operación"}
          </span>
        </div>
        {eventContext(event) && <p className="muted">{eventContext(event)}</p>}
        <details><summary>Detalles técnicos</summary>
          <p>{event.component} · <code>{event.code}</code></p>
          {Object.entries(event.details).map(([key, value]) => <div key={key}><code>{key}</code> · {value}</div>)}
        </details>
        {event.code === "PATROL_MISSION_STARTED" && event.patrol_id && onPatrol &&
          <button type="button" className="button-secondary history-related"
            onClick={() => onPatrol(event.patrol_id!)}>Ver patrulla</button>}
      </div>
    </li>)}
  </ol>;
}

function PatrolDetail({ id, dispatcher, close }: { id: string; dispatcher: HistoryDispatcher; close: () => void }) {
  const [page, setPage] = useState<PatrolPage>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  useEffect(() => {
    let current = true;
    dispatcher.read<PatrolPage>("history_patrol", { patrol_id: id })
      .then(result => { if (current) setPage(result); })
      .catch(failure => { if (current) setError(String(failure)); });
    return () => { current = false; };
  }, [dispatcher, id]);

  async function more() {
    if (!page?.next) return;
    setBusy(true);
    setError("");
    try {
      const result = await dispatcher.read<PatrolPage>("history_patrol", { patrol_id: id, after: page.next, through: page.through });
      setPage({ ...page, next: result.next, items: [...page.items, ...result.items] });
    } catch (failure) { setError(String(failure)); }
    finally { setBusy(false); }
  }

  async function download() {
    setExporting(true);
    setError("");
    try {
      let result = await dispatcher.read<PatrolPage>("history_patrol", { patrol_id: id });
      const lines = [
        JSON.stringify({ type: "patrol", schema_version: result.schema_version, ...result.patrol }) + "\n"
      ];
      while (true) {
        for (const event of result.items) lines.push(JSON.stringify({ type: "event", ...event }) + "\n");
        if (result.next === null) break;
        result = await dispatcher.read<PatrolPage>("history_patrol",
          { patrol_id: id, after: result.next, through: result.through });
      }
      const url = URL.createObjectURL(new Blob(lines, { type: "application/x-ndjson;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `patrulla-${id}.jsonl`;
      link.click();
      const revoke = URL.revokeObjectURL.bind(URL);
      setTimeout(() => revoke(url), 1000);
    } catch (failure) { setError(String(failure)); }
    finally { setExporting(false); }
  }

  return <section className="panel-card stack history-detail">
    <header className="history-toolbar">
      <h2>Detalle de patrulla</h2>
      <button className="button-secondary" type="button" onClick={close}>Volver al historial</button>
    </header>
    {error && <p role="alert">{error}</p>}
    {!page && !error && <p role="status">Consultando patrulla…</p>}
    {page && <>
      <div className="history-toolbar">
        <div><strong>{statuses[page.patrol.status] ?? page.patrol.status}</strong>
          <p className="muted">{dateTime.format(new Date(page.patrol.started_at))}</p>
        </div>
        <button type="button" className="button-secondary" disabled={exporting} onClick={() => void download()}>
          {exporting ? "Preparando archivo…" : "Descargar registro (.jsonl)"}
        </button>
      </div>
      <dl className="history-metrics">
        <div><dt>Tiempo total</dt><dd>{duration(page.patrol.duration_s)}</dd></div>
        <div><dt>En circuito</dt><dd>{duration(page.patrol.circuit_s)}</dd></div>
        <div><dt>Fin registrado</dt><dd>{page.patrol.ended_at ? dateTime.format(new Date(page.patrol.ended_at)) : "Sin cierre registrado"}</dd></div>
      </dl>
      {page.patrol.incomplete && <p role="status">Registro incompleto. Los tiempos reflejan el tramo registrado.</p>}
      <Timeline items={page.items} fullDate />
      {page.next !== null && <button type="button" className="button-secondary" disabled={busy} onClick={() => void more()}>
        Cargar más eventos
      </button>}
    </>}
  </section>;
}

export default function HistoryWorkspace({ dispatcher }: { dispatcher: HistoryDispatcher }) {
  const [view, setView] = useState<"activity" | "patrols">("activity");
  const [date, setDate] = useState(localDay);
  const [category, setCategory] = useState("");
  const [page, setPage] = useState<HistoryPage>();
  const [detail, setDetail] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);

  const load = useCallback(async (before?: number) => {
    if (!date) return;
    const id = ++request.current;
    setLoading(true);
    setError("");
    if (before === undefined) setPage(undefined);
    const start = new Date(`${date}T00:00:00`);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    try {
      const result = await dispatcher.read<HistoryPage>("history_list", {
        view, category: view === "activity" ? category : "", before,
        start: start.toISOString(), end: end.toISOString()
      });
      if (id === request.current) setPage(previous =>
        before === undefined || !previous ? result : { ...result, items: [...previous.items, ...result.items] });
    } catch (failure) {
      if (id === request.current) setError(String(failure));
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [category, date, dispatcher, view]);
  useEffect(() => {
    void load();
    return () => { request.current++; };
  }, [load]);

  return <div className="history-workspace stack">
    {detail ? <PatrolDetail key={detail} id={detail} dispatcher={dispatcher} close={() => setDetail(undefined)} /> : <>
      <section className="panel-card stack">
        <header className="history-toolbar">
          <div><h2>Historial</h2><p className="muted">Control, patrullas y detenciones del robot{page ? ` · ${page.robot}` : ""}</p></div>
          <button type="button" className="button-secondary" disabled={!date || loading} onClick={() => void load()}>Actualizar</button>
        </header>
        <div className="history-toolbar">
          <div className="history-switch" role="group" aria-label="Vista de historial">
            <button type="button" aria-pressed={view === "activity"} onClick={() => setView("activity")}>Actividad</button>
            <button type="button" aria-pressed={view === "patrols"} onClick={() => setView("patrols")}>Patrullas</button>
          </div>
          <div className="history-filters">
            <label>Fecha <input type="date" value={date} onChange={event => setDate(event.target.value)} /></label>
            {view === "activity" && <label>Tipo <select value={category} onChange={event => setCategory(event.target.value)}>
              <option value="">Todos</option>
              {Object.entries(categories).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select></label>}
          </div>
        </div>
      </section>
      <section className="panel-card stack">
        {!date && <p>Elegí una fecha para consultar el historial.</p>}
        {date && loading && <p role="status">Consultando historial…</p>}
        {date && error && <p role="alert">No se pudo consultar el historial. {error}</p>}
        {date && page?.degraded && <p role="status">El registro del robot tiene datos incompletos.</p>}
        {date && page?.items.length === 0 && <p>No hay {view === "activity" ? "eventos" : "patrullas"} para esta fecha y filtro.</p>}
        {date && view === "activity" && page && <Timeline items={page.items.filter((item): item is HistoryEvent => "sequence" in item)} onPatrol={setDetail} />}
        {date && view === "patrols" && page && <ul className="history-patrols">
          {page.items.filter((item): item is Patrol => "id" in item).map(patrol => <li key={patrol.id}>
            <button type="button" onClick={() => setDetail(patrol.id)}>
              <span><strong>{dateTime.format(new Date(patrol.started_at))}</strong>
                <span className="muted">{statuses[patrol.status] ?? patrol.status}{patrol.incomplete ? " · Datos incompletos" : ""}</span></span>
              <span><strong>{duration(patrol.circuit_s)}</strong><span className="muted">En circuito</span></span>
              <span className="history-patrol-open">Ver detalle <span aria-hidden="true">›</span></span>
            </button>
          </li>)}
        </ul>}
        {date && page?.next != null && <button type="button" className="button-secondary" disabled={loading}
          onClick={() => void load(page.next ?? undefined)}>Cargar más</button>}
      </section>
    </>}
  </div>;
}
