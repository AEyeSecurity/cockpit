import { useEffect, useMemo, useState } from "react";
import "./styles.css";
import type { CockpitModule, ModuleContext } from "../../../../../core/types/module";
import { ShellCommands } from "../../../../../app/shellCommands";
import { MissionDispatcher } from "../dispatcher/impl/MissionDispatcher";
import { MissionService } from "../service/impl/MissionService";
import type { MissionJsonRecord, MissionSessionFileInfo } from "../service/impl/MissionService";
import type { RosbagStatus } from "../dispatcher/impl/MissionDispatcher";
import { NavigationCommands } from "../../navigation/commands";
import type { ConnectionService } from "../../navigation/service/impl/ConnectionService";
import { generateMissionReport } from "../report/MissionReportGenerator";

const TRANSPORT_ID = "transport.ws.core";
const DISPATCHER_ID = "dispatcher.mission";
const SERVICE_ID = "service.mission";
const CONNECTION_SERVICE_ID = "service.connection";
const OPEN_RECORD_MODAL_COMMAND_ID = "nav2.debug.openRecordModal";
const OPEN_SESSIONS_WORKSPACE_COMMAND_ID = "nav2.debug.openSessionsWorkspace";
const SESSION_PAGE_SIZE = 7;

type MissionSessionStatus = "completed" | "aborted" | "manual";
type MissionEventType = "cmd" | "nav" | "telemetry" | "error" | "warning";
type MissionEventSeverity = "info" | "warning" | "error";

interface MissionEvent {
  atMs: number;
  timestamp: string;
  type: MissionEventType;
  description: string;
  severity: MissionEventSeverity;
  raw: string;
}

interface MissionSession {
  id: string;
  filename?: string;
  status: MissionSessionStatus;
  startedAt: string;
  endedAt: string;
  durationSec: number;
  commandCount: number;
  errorCount: number;
  warningCount: number;
  sizeKb: number;
  events: MissionEvent[];
  records?: MissionJsonRecord[];
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function pad3(value: number): string {
  return String(value).padStart(3, "0");
}

function severityForType(type: MissionEventType): MissionEventSeverity {
  if (type === "error") return "error";
  if (type === "warning") return "warning";
  return "info";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toText(value: unknown, fallback = ""): string {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function toFiniteNumber(value: unknown, fallback = 0): number {
  const next = typeof value === "number" ? value : Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function toOptionalNumber(value: unknown): number | null {
  const next = typeof value === "number" ? value : Number(value);
  return Number.isFinite(next) ? next : null;
}

function toBool(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function missionIdFromFilename(filename: string): string {
  return filename.replace(/^mission_/, "").replace(/\.jsonl$/i, "");
}

function epochFromMissionFilename(filename: string): number | null {
  const match = filename.match(/^mission_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\.jsonl$/i);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const epochMs = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  );
  return Number.isFinite(epochMs) ? epochMs / 1000 : null;
}

function sessionFallbackEpoch(info: MissionSessionFileInfo): number {
  const fromName = epochFromMissionFilename(info.filename);
  if (fromName !== null) return fromName;
  if (Number.isFinite(info.mtimeEpochMs) && info.mtimeEpochMs > 0) return info.mtimeEpochMs / 1000;
  return Date.now() / 1000;
}

function dateTimeFromEpoch(epochSec: number): string {
  const date = new Date(epochSec * 1000);
  if (Number.isNaN(date.getTime())) return "n/a";
  return date.toISOString().slice(0, 19);
}

function clockTimeFromDateTime(value: string): string {
  const timePart = value.split("T")[1] ?? "";
  return timePart.slice(0, 8) || "n/a";
}

function timestampFromTimelineOffset(atMs: number): string {
  const safeMs = Math.max(0, Math.round(atMs));
  const hours = Math.floor(safeMs / 3600000);
  const minutes = Math.floor((safeMs % 3600000) / 60000);
  const seconds = Math.floor((safeMs % 60000) / 1000);
  const ms = safeMs % 1000;
  if (hours > 0) {
    return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}.${pad3(ms)}`;
  }
  return `${pad2(minutes)}:${pad2(seconds)}.${pad3(ms)}`;
}

function recordTopic(record: MissionJsonRecord): string {
  return toText(record.topic);
}

function recordData(record: MissionJsonRecord): Record<string, unknown> {
  return isRecord(record.data) ? record.data : {};
}

function recordTime(record: MissionJsonRecord): number | null {
  return toOptionalNumber(record.t);
}

function isSystemMissionRecord(record: MissionJsonRecord): boolean {
  return recordTopic(record).startsWith("system/");
}

function visibleMissionRecords(records: MissionJsonRecord[]): MissionJsonRecord[] {
  const visible = records.filter((record) => !isSystemMissionRecord(record));
  return visible.length > 0 ? visible : records;
}

function meaningfulTimes(records: MissionJsonRecord[]): number[] {
  return records
    .map(recordTime)
    .filter((value): value is number => value !== null && Number.isFinite(value) && value > 0);
}

function hasMixedClockSources(times: number[]): boolean {
  if (times.length < 2) return false;
  return Math.max(...times) - Math.min(...times) > 6 * 3600;
}

function navEventSeverity(data: Record<string, unknown>): MissionEventSeverity {
  const code = toText(data.code).toUpperCase();
  const severity = toFiniteNumber(data.severity, 0);
  if (
    severity >= 40 ||
    severity >= 2 ||
    code.includes("FAILED") ||
    code.includes("LOST") ||
    code.includes("ESTOP") ||
    code.includes("CANCELLED") ||
    code.includes("ABORTED") ||
    code.includes("ERROR")
  ) {
    return "error";
  }
  if (severity >= 30 || severity === 1 || code.includes("WARN") || code.includes("WATCHDOG_STOP")) {
    return "warning";
  }
  return "info";
}

function missionRecordSeverity(record: MissionJsonRecord): MissionEventSeverity {
  const topic = recordTopic(record);
  const data = recordData(record);
  if (topic === "/rosout") {
    return toFiniteNumber(data.level, 0) >= 40 ? "error" : "warning";
  }
  if (topic === "/diagnostics") {
    const level = toFiniteNumber(data.level, 0);
    if (level >= 2) return "error";
    if (level >= 1) return "warning";
    return "info";
  }
  if (topic === "/behavior_tree_log") {
    return "error";
  }
  if (topic === "/controller/drive_telemetry") {
    return toBool(data.estop) ? "error" : "info";
  }
  if (topic === "/controller/telemetry") {
    const telemetry = isRecord(data.telemetry) ? data.telemetry : {};
    const command = isRecord(data.requested_auto_command) ? data.requested_auto_command : {};
    if (toBool(telemetry.estop_active) || toBool(command.estop)) return "error";
    if (toBool(telemetry.failsafe_active)) return "warning";
    return "info";
  }
  if (topic === "/controller/status") {
    if (toBool(data.estop_active)) return "error";
    if (toBool(data.failsafe_active) || toBool(data.overspeed_active)) return "warning";
    return "info";
  }
  if (topic === "/nav_command_server/events") {
    return navEventSeverity(data);
  }
  return severityForType("telemetry");
}

function missionRecordType(record: MissionJsonRecord): MissionEventType {
  const severity = missionRecordSeverity(record);
  if (severity === "error") return "error";
  if (severity === "warning") return "warning";

  const topic = recordTopic(record);
  if (topic === "/nav_command_server/events") {
    const code = toText(recordData(record).code).toUpperCase();
    return code.includes("CMD") || code.includes("COMMAND") || code.startsWith("SET_") ? "cmd" : "nav";
  }
  if (
    topic === "/nav_command_server/telemetry" ||
    topic === "/controller/drive_telemetry" ||
    topic === "/controller/telemetry" ||
    topic === "/diagnostics"
  ) {
    return "telemetry";
  }
  return "nav";
}

function describeNavTelemetry(data: Record<string, unknown>): string {
  const parts: string[] = [];
  const action = toText(data.active_action);
  const mode = toText(data.auto_mode);
  const totalWaypoints = toFiniteNumber(data.total_waypoints, 0);
  const failureCode = toText(data.failure_code);
  const resultText = toText(data.nav_result_text);
  if (action) parts.push(`Action ${action}`);
  if (mode) parts.push(`Mode ${mode}`);
  if (totalWaypoints > 0) {
    parts.push(`Waypoint ${toFiniteNumber(data.current_waypoint, 0)}/${totalWaypoints}`);
  }
  if (data.gps_fix_available !== undefined) {
    parts.push(`GPS ${toBool(data.gps_fix_available) ? "fix" : "lost"}`);
  }
  if (failureCode) parts.push(`Failure ${failureCode}`);
  if (resultText) parts.push(resultText);
  return parts.join(" | ") || "Navigation telemetry changed";
}

function describeDriveTelemetry(data: Record<string, unknown>): string {
  const drive = toBool(data.drive_enabled) ? "enabled" : "disabled";
  const estop = toBool(data.estop) ? "ESTOP active" : "ESTOP clear";
  return `Drive ${drive} | ${estop} | speed ${toFiniteNumber(data.speed_mps_measured, 0).toFixed(2)} m/s | steer ${toFiniteNumber(
    data.steer_deg_measured,
    0
  ).toFixed(1)} deg | brake ${toFiniteNumber(data.brake_applied_pct, 0)}%`;
}

function describeControllerTelemetry(data: Record<string, unknown>): string {
  if (data.raw !== undefined) return toText(data.raw, "Controller telemetry changed");
  const telemetry = isRecord(data.telemetry) ? data.telemetry : {};
  const command = isRecord(data.requested_auto_command) ? data.requested_auto_command : {};
  const parts: string[] = [];
  const source = toText(data.source);
  const controlSource = toText(telemetry.control_source);
  if (source) parts.push(source);
  if (controlSource) parts.push(`control ${controlSource}`);
  parts.push(toBool(telemetry.ready) ? "ready" : "not ready");
  if (toBool(telemetry.estop_active) || toBool(command.estop)) parts.push("ESTOP active");
  if (toBool(telemetry.failsafe_active)) parts.push("failsafe active");
  parts.push(`speed ${toFiniteNumber(telemetry.speed_mps, 0).toFixed(2)} m/s`);
  parts.push(`steer ${toFiniteNumber(telemetry.steer_deg, 0).toFixed(1)} deg`);
  parts.push(`brake ${toFiniteNumber(telemetry.brake_applied_pct ?? command.brake_pct, 0)}%`);
  return parts.join(" | ");
}

function describeBehaviorTreeLog(data: Record<string, unknown>): string {
  const events = Array.isArray(data.events) ? data.events : [];
  const names = events
    .filter((event): event is Record<string, unknown> => isRecord(event))
    .map((event) => toText(event.node_name))
    .filter((name) => name.length > 0);
  return names.length > 0 ? `Behavior tree failure: ${names.join(", ")}` : "Behavior tree failure";
}

function navCancelReasonText(reason: string): string {
  const normalized = reason.toLowerCase();
  if (normalized.includes("manual")) return "el operador pasó a modo manual";
  if (normalized.includes("cancel_goal")) return "cancelación pedida por el usuario";
  if (normalized.includes("set_goal")) return "un nuevo goal reemplazó al anterior";
  if (normalized.includes("estop")) return "se activó la parada de emergencia";
  return reason;
}

function navEventDetailsSuffix(details: Record<string, unknown>, omit: string[]): string {
  const parts = Object.entries(details)
    .filter(([key, value]) => !omit.includes(key) && toText(value).length > 0)
    .map(([key, value]) => `${key}=${toText(value)}`);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

function describeNavEvent(data: Record<string, unknown>): string {
  const code = toText(data.code);
  const message = toText(data.message);
  const details = isRecord(data.details) ? data.details : {};
  const reason = toText(details.reason);
  const error = toText(details.error);
  const upper = code.toUpperCase();

  if (upper === "GOAL_CANCELLED") {
    const cause = reason ? navCancelReasonText(reason) : message || "sin motivo informado";
    return `Goal cancelado: ${cause}${error ? ` — error: ${error}` : ""}${navEventDetailsSuffix(details, ["reason", "error"])}`;
  }
  if (upper === "GOAL_RESULT_ABORTED") {
    const cause = error || reason || message || "Nav2 abortó la navegación";
    return `Goal abortado: ${cause}${navEventDetailsSuffix(details, ["reason", "error"])}`;
  }
  if (upper === "GOAL_REJECTED") {
    const cause = error || reason || message || "rechazado por Nav2";
    return `Goal rechazado: ${cause}${navEventDetailsSuffix(details, ["reason", "error"])}`;
  }
  if (upper === "GOAL_RESULT_SUCCEEDED") {
    return `Goal completado con éxito${navEventDetailsSuffix(details, [])}`;
  }
  if (upper === "GOAL_REQUESTED" || upper === "GOAL_ACCEPTED") {
    const base = upper === "GOAL_REQUESTED" ? "Goal solicitado" : "Goal aceptado";
    return `${base}${navEventDetailsSuffix(details, [])}`;
  }
  const headline = code && message && code !== message ? `${code}: ${message}` : code || message || "Navigation event";
  return `${headline}${navEventDetailsSuffix(details, [])}`;
}

const DIAGNOSTIC_EXPLANATIONS: Array<{ match: (name: string, message: string) => boolean; text: string }> = [
  {
    match: (name, message) => name.includes("collision_monitor") && message.includes("no collision monitor state"),
    text: "Collision monitor sin datos: hay un goal activo pero el nodo collision_monitor no publica estado (¿no está corriendo o perdió sensores?)"
  },
  {
    match: (_name, message) => message.includes("rtcm stale"),
    text: "Correcciones RTK (RTCM) viejas: el GPS perdió la fuente de correcciones, la precisión puede degradarse"
  },
  {
    match: (name, _message) => name.includes("watchdog"),
    text: "Watchdog detuvo el robot: dejó de recibir comandos frescos dentro del tiempo límite"
  }
];

function describeDiagnosticRecord(data: Record<string, unknown>): string {
  const name = toText(data.name, "diagnostic");
  const message = toText(data.message, "state changed");
  const lowerName = name.toLowerCase();
  const lowerMessage = message.toLowerCase();
  const known = DIAGNOSTIC_EXPLANATIONS.find((entry) => entry.match(lowerName, lowerMessage));
  if (known) return `${known.text} [${name}: ${message}]`;
  return `${name}: ${message}`;
}

function describeMissionRecord(record: MissionJsonRecord): string {
  const topic = recordTopic(record);
  const data = recordData(record);
  if (topic === "/nav_command_server/events") {
    return describeNavEvent(data);
  }
  if (topic === "/nav_command_server/telemetry") return describeNavTelemetry(data);
  if (topic === "/controller/drive_telemetry") return describeDriveTelemetry(data);
  if (topic === "/controller/telemetry") return describeControllerTelemetry(data);
  if (topic === "/controller/status") {
    const parts: string[] = [];
    const source = toText(data.control_source);
    if (source) parts.push(`source ${source}`);
    parts.push(toBool(data.ready) ? "ready" : "not ready");
    if (toBool(data.estop_active)) parts.push("ESTOP active");
    if (toBool(data.failsafe_active)) parts.push("failsafe active");
    if (toBool(data.overspeed_active)) parts.push("overspeed active");
    parts.push(`speed ${toFiniteNumber(data.speed_mps, 0).toFixed(2)} m/s`);
    parts.push(`steer ${toFiniteNumber(data.steer_deg, 0).toFixed(1)} deg`);
    parts.push(`brake ${toFiniteNumber(data.brake_applied_pct, 0)}%`);
    return parts.join(" | ") || "Controller status changed";
  }
  if (topic === "/diagnostics") {
    return describeDiagnosticRecord(data);
  }
  if (topic === "/rosout") {
    const name = toText(data.name, "rosout");
    const message = toText(data.msg, "log message");
    return `${name}: ${message}`;
  }
  if (topic === "/behavior_tree_log") return describeBehaviorTreeLog(data);
  return topic || "Mission record";
}

function missionStatusFromRecords(records: MissionJsonRecord[]): MissionSessionStatus {
  let reached = false;
  let manual = false;
  for (const record of records) {
    if (recordTopic(record) !== "/nav_command_server/events") continue;
    const code = toText(recordData(record).code).toUpperCase();
    if (code.includes("FAILED") || code.includes("CANCELLED") || code.includes("ESTOP") || code.includes("LOST") || code.includes("ABORTED") || code.includes("WATCHDOG_STOP")) {
      return "aborted";
    }
    if (code.includes("MANUAL")) manual = true;
    if (code.includes("REACHED")) reached = true;
  }
  if (manual) return "manual";
  return reached || records.length > 0 ? "completed" : "manual";
}

function estimateSessionSizeBytes(records: MissionJsonRecord[]): number {
  if (records.length === 0) return 0;
  return records.reduce((total, record) => total + JSON.stringify(record).length + 1, 0);
}

function infoFromNewSession(filename: string, records: MissionJsonRecord[]): MissionSessionFileInfo {
  return {
    filename,
    sizeBytes: estimateSessionSizeBytes(records),
    lineCount: records.length,
    mtimeEpochMs: Date.now()
  };
}

function buildRecordedMissionSession(info: MissionSessionFileInfo, records: MissionJsonRecord[]): MissionSession {
  const displayRecords = visibleMissionRecords(records);
  const times = meaningfulTimes(displayRecords);
  const fallbackEpoch = sessionFallbackEpoch(info);
  const firstRecordTime = times[0] ?? fallbackEpoch;
  const mixedClockSources = hasMixedClockSources(times);
  const startEpoch = mixedClockSources ? firstRecordTime : times.length > 0 ? Math.min(...times) : fallbackEpoch;
  const endEpoch = mixedClockSources ? firstRecordTime + Math.max(0, displayRecords.length - 1) : times.length > 0 ? Math.max(...times) : startEpoch;
  const events = displayRecords
    .map((record, index): MissionEvent => {
      const t = recordTime(record) ?? firstRecordTime;
      const atMs = mixedClockSources ? index * 1000 : Math.max(0, Math.round((t - startEpoch) * 1000));
      const type = missionRecordType(record);
      return {
        atMs,
        timestamp: timestampFromTimelineOffset(atMs),
        type,
        description: describeMissionRecord(record),
        severity: missionRecordSeverity(record),
        raw: JSON.stringify(record)
      };
    })
    .sort((left, right) => left.atMs - right.atMs);

  return {
    id: missionIdFromFilename(info.filename),
    filename: info.filename,
    status: missionStatusFromRecords(records),
    startedAt: dateTimeFromEpoch(firstRecordTime),
    endedAt: dateTimeFromEpoch(endEpoch),
    durationSec: Math.max(0, endEpoch - startEpoch),
    commandCount: Math.max(info.lineCount, records.length),
    errorCount: events.filter((event) => event.severity === "error").length,
    warningCount: events.filter((event) => event.severity === "warning").length,
    sizeKb: Math.max(info.sizeBytes, estimateSessionSizeBytes(records)) / 1024,
    events,
    records
  };
}

function buildRecordedMissionSessions(
  files: MissionSessionFileInfo[],
  recordsByFilename: Map<string, MissionJsonRecord[]>
): MissionSession[] {
  return files.map((file) => buildRecordedMissionSession(file, recordsByFilename.get(file.filename) ?? []));
}

function formatDateTime(value: string): string {
  const [datePart, timePart = ""] = value.split("T");
  return `${datePart} ${timePart}`.trim();
}

function formatDuration(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    return `${hours}h ${pad2(remainder)}m`;
  }
  return `${pad2(minutes)}m ${pad2(seconds)}s`;
}

function formatTimelineTime(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${pad2(minutes)}:${pad2(seconds)}`;
}

function formatBytes(sizeKb: number): string {
  if (sizeKb >= 1024) {
    return `${(sizeKb / 1024).toFixed(1)} MB`;
  }
  return `${Math.round(sizeKb)} KB`;
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function RecordModal({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const missionService = runtime.services.getService<MissionService>(SERVICE_ID);
  let connectionService: ConnectionService | null = null;
  try {
    connectionService = runtime.services.getService<ConnectionService>(CONNECTION_SERVICE_ID);
  } catch {
    connectionService = null;
  }
  const [connected, setConnected] = useState(connectionService?.getState().connected ?? false);
  const [status, setStatus] = useState<RosbagStatus>({
    active: false,
    profile: "core",
    outputPath: "n/a",
    logPath: "n/a"
  });
  const [error, setError] = useState("");

  useEffect(() => {
    if (!connectionService) return;
    return connectionService.subscribe((next) => setConnected(next.connected));
  }, [connectionService]);

  useEffect(() => {
    const unsubscribe = missionService.subscribeRosbagStatus((next) => {
      setStatus(next);
    });
    void missionService
      .getRosbagStatus()
      .then((next) => {
        setStatus(next);
      })
      .catch(() => {
        // Optional backend capability.
      });
    return unsubscribe;
  }, [missionService]);

  const stateText = status.active ? "grabando" : "detenido";
  const stateClassName = status.active ? "record-toggle-btn recording" : "record-toggle-btn stopped";

  return (
    <div className="record-modal">
      <div className="record-modal-copy">
        <span className="record-modal-kicker">Mission Recorder</span>
        <h3 className="record-modal-title">Rosbag Capture</h3>
        <p className="record-modal-subtitle">
          Iniciá o detené la grabación operativa sin salir del cockpit.
        </p>
      </div>
      <div className="record-modal-status-card">
        <span className={`record-status-dot ${status.active ? "recording" : "stopped"}`} aria-hidden="true" />
        <div className="record-modal-status-copy">
          <strong>{status.active ? "Recording active" : "Recorder idle"}</strong>
          <span>Profile {status.profile}</span>
        </div>
      </div>
      <button
        type="button"
        className={stateClassName}
        disabled={!connected}
        onClick={async () => {
          setError("");
          if (!connected) {
            setError("Backend no conectado");
            return;
          }
          try {
            const next = status.active ? await missionService.stopRosbag() : await missionService.startRosbag();
            setStatus(next);
            runtime.eventBus.emit("console.event", {
              level: status.active ? "warn" : "info",
              text: status.active ? "Grabación detenida" : "Grabación iniciada",
              timestamp: Date.now()
            });
          } catch (cause) {
            const msg = String(cause);
            setError(msg.includes("disconnected") ? "Backend no conectado" : msg);
          }
        }}
      >
        <span className="record-toggle-btn-copy">
          <span className="record-toggle-btn-label">{status.active ? "Detener grabación" : "Iniciar grabación"}</span>
          <span className="record-toggle-btn-meta">{status.active ? "Cerrar rosbag actual" : "Crear nueva captura"}</span>
        </span>
        {!connected ? (
          <span className="record-toggle-lock" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none">
              <rect x="6" y="10" width="12" height="10" rx="2" />
              <path d="M8.5 10V7.5a3.5 3.5 0 0 1 7 0V10" />
              <path d="M12 14v2" />
            </svg>
          </span>
        ) : null}
      </button>
      <p className={`record-status-legend ${status.active ? "recording" : "stopped"}`}>
        Estado: {stateText}
      </p>
      <div className="record-modal-meta">
        <div className="record-meta-card">
          <span className="record-meta-label">Output</span>
          <strong className="record-meta-value">{status.outputPath || "n/a"}</strong>
        </div>
        <div className="record-meta-card">
          <span className="record-meta-label">Log</span>
          <strong className="record-meta-value">{status.logPath || "n/a"}</strong>
        </div>
      </div>
      {error ? <p className="muted">Error: {error}</p> : null}
    </div>
  );
}

function DebugSidebarPanel({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const missionService = runtime.services.getService<MissionService>(SERVICE_ID);
  const [status, setStatus] = useState<RosbagStatus>({
    active: false,
    profile: "core",
    outputPath: "n/a",
    logPath: "n/a"
  });

  useEffect(() => {
    const unsubscribe = missionService.subscribeRosbagStatus((next) => {
      setStatus(next);
    });
    void missionService
      .getRosbagStatus()
      .then((next) => {
        setStatus(next);
      })
      .catch(() => {
        // Optional backend capability.
      });
    return unsubscribe;
  }, [missionService]);

  return (
    <div className="stack debug-sidebar-panel">
      <div className="panel-card debug-sidebar-hero">
        <span className="debug-sidebar-kicker">Diagnostics</span>
        <div className="debug-sidebar-header">
          <h3>Debug</h3>
          <span className={`status-pill ${status.active ? "ok" : ""}`}>
            {status.active ? "Recording" : "Idle"}
          </span>
        </div>
        <p className="muted debug-sidebar-copy">
          Accedé a captura operativa y diagnóstico del stack sin salir del panel lateral.
        </p>
        <div className="debug-sidebar-actions">
          <button
            type="button"
            aria-label="Open Recorder"
            className="button-primary button-tile"
            onClick={() => {
              void runtime.commands.execute(OPEN_RECORD_MODAL_COMMAND_ID);
            }}
          >
            <span className="button-face">
              <span className="button-face-icon" aria-hidden="true">
                ⏺
              </span>
              <span className="button-face-copy">
                <span className="button-face-label">Recorder</span>
                <span className="button-face-meta">Open rosbag capture controls</span>
              </span>
            </span>
          </button>
          <button
            type="button"
            aria-label="Open Debug Info"
            className="button-secondary button-tile"
            onClick={() => {
              void runtime.commands.execute(NavigationCommands.openInfoModal);
            }}
          >
            <span className="button-face">
              <span className="button-face-icon" aria-hidden="true">
                ℹ
              </span>
              <span className="button-face-copy">
                <span className="button-face-label">Info</span>
                <span className="button-face-meta">Open navigation diagnostics</span>
              </span>
            </span>
          </button>
          <button
            type="button"
            aria-label="Open Mission Sessions"
            className="button-secondary button-tile"
            onClick={() => {
              void runtime.commands.execute(OPEN_SESSIONS_WORKSPACE_COMMAND_ID);
            }}
          >
            <span className="button-face">
              <span className="button-face-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none">
                  <path d="M8 6h11" />
                  <path d="M8 12h11" />
                  <path d="M8 18h11" />
                  <path d="M4 6h.01" />
                  <path d="M4 12h.01" />
                  <path d="M4 18h.01" />
                </svg>
              </span>
              <span className="button-face-copy">
                <span className="button-face-label">Sessions</span>
                <span className="button-face-meta">Review mission recordings</span>
              </span>
            </span>
          </button>
        </div>
      </div>
      <div className="panel-card debug-sidebar-status-grid">
        <div className="debug-sidebar-stat">
          <span className="debug-sidebar-stat-label">Profile</span>
          <strong className="debug-sidebar-stat-value">{status.profile}</strong>
        </div>
        <div className="debug-sidebar-stat">
          <span className="debug-sidebar-stat-label">Recorder</span>
          <strong className="debug-sidebar-stat-value">{status.active ? "Active" : "Stopped"}</strong>
        </div>
      </div>
      <div className="panel-card debug-sidebar-paths">
        <div className="debug-sidebar-path">
          <span className="debug-sidebar-path-label">Output</span>
          <strong className="debug-sidebar-path-value">{status.outputPath || "n/a"}</strong>
        </div>
        <div className="debug-sidebar-path">
          <span className="debug-sidebar-path-label">Log</span>
          <strong className="debug-sidebar-path-value">{status.logPath || "n/a"}</strong>
        </div>
      </div>
    </div>
  );
}

function MissionSessionsWorkspace({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const missionService = runtime.services.getService<MissionService>(SERVICE_ID);
  let connectionService: ConnectionService | null = null;
  try {
    connectionService = runtime.services.getService<ConnectionService>(CONNECTION_SERVICE_ID);
  } catch {
    connectionService = null;
  }

  const [connected, setConnected] = useState(connectionService?.getState().connected ?? false);
  const [status, setStatus] = useState<RosbagStatus>({
    active: false,
    profile: "core",
    outputPath: "n/a",
    logPath: "n/a"
  });
  const [error, setError] = useState("");
  const [sessions, setSessions] = useState<MissionSession[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [page, setPage] = useState(0);

  useEffect(() => {
    if (!connectionService) return;
    return connectionService.subscribe((next) => {
      setConnected(next.connected);
      if (next.connected) setError("");
    });
  }, [connectionService]);

  useEffect(() => {
    const unsubscribe = missionService.subscribeRosbagStatus((next) => {
      setStatus(next);
    });
    void missionService
      .getRosbagStatus()
      .then((next) => {
        setStatus(next);
      })
      .catch(() => {
        // Optional backend capability.
      });
    return unsubscribe;
  }, [missionService]);

  useEffect(() => {
    let disposed = false;

    const applySessions = (nextSessions: MissionSession[]): void => {
      if (disposed) return;
      setSessions(nextSessions);
      setSelectedSessionId((current) => {
        if (nextSessions.some((session) => session.id === current)) return current;
        return nextSessions[0]?.id ?? "";
      });
      setPage((current) => Math.min(current, Math.max(0, Math.ceil(nextSessions.length / SESSION_PAGE_SIZE) - 1)));
    };

    const loadRecords = async (files: MissionSessionFileInfo[]): Promise<MissionSession[]> => {
      const recordsByFilename = new Map<string, MissionJsonRecord[]>();
      await Promise.all(
        files.map(async (file) => {
          try {
            recordsByFilename.set(file.filename, await missionService.getMissionSession(file.filename));
          } catch {
            recordsByFilename.set(file.filename, []);
          }
        })
      );
      return buildRecordedMissionSessions(files, recordsByFilename);
    };

    const refreshSessions = async (): Promise<void> => {
      setLoadingSessions(true);
      try {
        const files = await missionService.listMissionSessions();
        applySessions(await loadRecords(files));
        setError("");
      } catch (cause) {
        if (!disposed) setError(String(cause).includes("disconnected") ? "Backend no conectado" : String(cause));
      } finally {
        if (!disposed) setLoadingSessions(false);
      }
    };

    const unsubscribeConnect = missionService.subscribeMissionSessionsOnConnect((files) => {
      void loadRecords(files).then(applySessions).finally(() => {
        if (!disposed) setLoadingSessions(false);
      });
    });
    const unsubscribeNewSession = missionService.subscribeMissionNewSession((filename, records) => {
      if (!filename) return;
      const session = buildRecordedMissionSession(infoFromNewSession(filename, records), records);
      setSessions((current) => [session, ...current.filter((item) => item.filename !== filename)]);
      setSelectedSessionId(session.id);
      setPage(0);
    });

    if (connected) {
      void refreshSessions();
    } else {
      setLoadingSessions(false);
    }
    return () => {
      disposed = true;
      unsubscribeConnect();
      unsubscribeNewSession();
    };
  }, [missionService, connected]);

  const totalPages = Math.max(1, Math.ceil(sessions.length / SESSION_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages - 1);
  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId) ?? sessions[0] ?? null,
    [selectedSessionId, sessions]
  );
  const pageSessions = useMemo(
    () => sessions.slice(currentPage * SESSION_PAGE_SIZE, currentPage * SESSION_PAGE_SIZE + SESSION_PAGE_SIZE),
    [currentPage, sessions]
  );
  const timelineEvents =
    selectedSession?.events.filter((event) => event.severity === "error" || event.severity === "warning") ?? [];
  const timelineTicks = [0, 0.2, 0.4, 0.6, 0.8, 1];
  const selectedStatus = selectedSession?.status ?? "manual";
  const selectedDurationSec = selectedSession?.durationSec ?? 0;
  const pageStart = sessions.length === 0 ? 0 : currentPage * SESSION_PAGE_SIZE + 1;
  const pageEnd = Math.min(sessions.length, (currentPage + 1) * SESSION_PAGE_SIZE);

  const goToPage = (nextPage: number): void => {
    const clamped = Math.max(0, Math.min(totalPages - 1, nextPage));
    setPage(clamped);
    const firstSession = sessions[clamped * SESSION_PAGE_SIZE];
    if (firstSession) {
      setSelectedSessionId(firstSession.id);
    }
  };

  const toggleRecording = async (): Promise<void> => {
    setError("");
    if (!connected) {
      setError("Backend no conectado");
      return;
    }
    try {
      const next = status.active ? await missionService.stopRosbag() : await missionService.startRosbag();
      setStatus(next);
      runtime.eventBus.emit("console.event", {
        level: status.active ? "warn" : "info",
        text: status.active ? "Grabacion detenida" : "Grabacion manual iniciada",
        timestamp: Date.now()
      });
    } catch (cause) {
      const msg = String(cause);
      setError(msg.includes("disconnected") ? "Backend no conectado" : msg);
    }
  };

  const exportSelectedSession = async (): Promise<void> => {
    if (!selectedSession) return;
    const filename = selectedSession.filename ?? `${selectedSession.id}.jsonl`;
    let records = selectedSession.records ?? [];
    try {
      records = await missionService.downloadMissionSession(filename);
    } catch {
      // Keep the already loaded session records if the backend download op is unavailable.
    }
    const body = records.length > 0 ? `${records.map((record) => JSON.stringify(record)).join("\n")}\n` : "";
    const blob = new Blob([body], { type: "application/x-ndjson" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    runtime.eventBus.emit("console.event", {
      level: "info",
      text: `Exported session ${selectedSession.id}`,
      timestamp: Date.now()
    });
  };

  const exportSessionPDF = (): void => {
    if (!selectedSession) return;
    const blob = generateMissionReport(selectedSession);
    const filename = selectedSession.filename
      ? selectedSession.filename.replace(/\.jsonl$/i, "_report.pdf")
      : `${selectedSession.id}_report.pdf`;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    runtime.eventBus.emit("console.event", {
      level: "info",
      text: `PDF report generated: ${filename}`,
      timestamp: Date.now()
    });
  };

  const copySessionId = (): void => {
    if (!selectedSession) return;
    if (!navigator.clipboard) return;
    void navigator.clipboard.writeText(selectedSession.id).catch(() => undefined);
  };

  return (
    <div className="mission-sessions-root">
      <aside className="mission-sessions-list-panel" aria-label="Mission sessions">
        <div className="mission-sessions-list-header">
          <h2>Mission Sessions</h2>
          <button
            type="button"
            className={`mission-record-btn ${status.active ? "recording" : "idle"}`}
            disabled={!connected}
            onClick={() => {
              void toggleRecording();
            }}
          >
            <span className="mission-record-dot" aria-hidden="true" />
            <span>{status.active ? "Stop Recording" : "Start Manual Recording"}</span>
          </button>
        </div>
        {error ? <div className="mission-sessions-error">{error}</div> : null}
        <div className="mission-session-list">
          {loadingSessions ? <div className="mission-sessions-empty">Loading mission sessions...</div> : null}
          {!loadingSessions && sessions.length === 0 ? (
            <div className="mission-sessions-empty">No mission sessions found in /tmp/mission_sessions.</div>
          ) : null}
          {pageSessions.map((session) => (
            <button
              key={session.id}
              type="button"
              className={`mission-session-card ${session.id === selectedSession?.id ? "active" : ""}`}
              onClick={() => setSelectedSessionId(session.id)}
            >
              <span className="mission-session-row">
                <span className={`mission-session-status status-${session.status}`}>{session.status}</span>
                <span className="mission-session-start">{formatDateTime(session.startedAt)}</span>
              </span>
              <span className="mission-session-meta-row">
                <span className="mission-session-meta">
                  <span className="mission-session-meta-icon" aria-hidden="true">clock</span>
                  {formatDuration(session.durationSec)}
                </span>
                <span className="mission-session-meta">
                  <span className="mission-session-meta-icon" aria-hidden="true">warn</span>
                  {session.errorCount} {session.errorCount === 1 ? "error" : "errors"}
                </span>
                <span className="mission-session-meta">
                  <span className="mission-session-meta-icon" aria-hidden="true">file</span>
                  {formatBytes(session.sizeKb)}
                </span>
                <span className="mission-session-chevron" aria-hidden="true">&gt;</span>
              </span>
            </button>
          ))}
        </div>
        <div className="mission-session-pagination">
          <span>
            {pageStart}-{pageEnd} of {sessions.length} sessions
          </span>
          <div className="mission-session-page-controls">
            <button type="button" onClick={() => goToPage(0)} disabled={currentPage === 0 || sessions.length === 0} aria-label="First page">
              |&lt;
            </button>
            <button
              type="button"
              onClick={() => goToPage(currentPage - 1)}
              disabled={currentPage === 0 || sessions.length === 0}
              aria-label="Previous page"
            >
              &lt;
            </button>
            {Array.from({ length: totalPages }, (_, index) => (
              <button
                key={index}
                type="button"
                className={index === currentPage ? "active" : ""}
                disabled={sessions.length === 0}
                onClick={() => goToPage(index)}
              >
                {index + 1}
              </button>
            ))}
            <button
              type="button"
              onClick={() => goToPage(currentPage + 1)}
              disabled={currentPage >= totalPages - 1 || sessions.length === 0}
              aria-label="Next page"
            >
              &gt;
            </button>
            <button
              type="button"
              onClick={() => goToPage(totalPages - 1)}
              disabled={currentPage >= totalPages - 1 || sessions.length === 0}
              aria-label="Last page"
            >
              &gt;|
            </button>
          </div>
        </div>
      </aside>

      <section className="mission-session-detail-panel" aria-label="Session detail">
        <div className="mission-detail-header">
          <h2>Session Detail</h2>
          <div className="mission-detail-session-id">
            <span>Session ID: {selectedSession?.id ?? "n/a"}</span>
            <button type="button" onClick={copySessionId} disabled={!selectedSession} aria-label="Copy session id">
              <svg viewBox="0 0 24 24" fill="none">
                <rect x="9" y="9" width="10" height="10" rx="2" />
                <path d="M5 15V7a2 2 0 0 1 2-2h8" />
              </svg>
            </button>
          </div>
        </div>

        <div className="mission-summary-grid">
          <div className="mission-summary-item">
            <span>Total Commands</span>
            <strong>{formatInteger(selectedSession?.commandCount ?? 0)}</strong>
          </div>
          <div className="mission-summary-item">
            <span>Total Errors</span>
            <strong className="metric-error">{selectedSession?.errorCount ?? 0}</strong>
          </div>
          <div className="mission-summary-item">
            <span>Total Warnings</span>
            <strong className="metric-warning">{selectedSession?.warningCount ?? 0}</strong>
          </div>
          <div className="mission-summary-item">
            <span>Final Result</span>
            <strong className={`metric-result status-${selectedStatus}`}>{selectedSession ? selectedStatus : "n/a"}</strong>
          </div>
        </div>

        <div className="mission-timeline-panel">
          <div className="mission-section-header">
            <h3>Timeline</h3>
            <span>Duration {formatDuration(selectedDurationSec)}</span>
          </div>
          <div className="mission-timeline">
            <div className="mission-timeline-track" />
            {timelineTicks.map((tick) => (
              <span key={tick} className="mission-timeline-tick" style={{ left: `${tick * 100}%` }}>
                {formatTimelineTime(selectedDurationSec * tick)}
              </span>
            ))}
            {timelineEvents.map((event) => {
              const pct = Math.min(100, Math.max(0, (event.atMs / Math.max(1, selectedDurationSec * 1000)) * 100));
              return (
                <span
                  key={`${event.timestamp}-${event.description}`}
                  className={`mission-timeline-marker severity-${event.severity}`}
                  style={{ left: `${pct}%` }}
                  title={`${event.timestamp} ${event.description}`}
                />
              );
            })}
          </div>
          <div className="mission-timeline-legend">
            <span><i className="legend-dot error" /> Error {selectedSession?.errorCount ?? 0}</span>
            <span><i className="legend-dot warning" /> Warning {selectedSession?.warningCount ?? 0}</span>
          </div>
        </div>

        <div className="mission-event-panel">
          <div className="mission-section-header">
            <h3>Event Log</h3>
            {selectedSession ? (
              <span className="mission-event-range">
                <span>Start {clockTimeFromDateTime(selectedSession.startedAt)}</span>
                <span>End {clockTimeFromDateTime(selectedSession.endedAt)}</span>
              </span>
            ) : null}
          </div>
          <div className="mission-event-table-wrap">
            <table className="mission-event-table">
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Type</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                {!selectedSession ? (
                  <tr>
                    <td colSpan={3}>No mission session selected.</td>
                  </tr>
                ) : null}
                {selectedSession?.events.map((event) => (
                  <tr key={`${event.timestamp}-${event.type}-${event.description}`} className={`severity-${event.severity}`}>
                    <td>{event.timestamp}</td>
                    <td>
                      <span className={`mission-event-type type-${event.type}`}>{event.type}</span>
                    </td>
                    <td title={event.raw}>{event.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="mission-export-panel">
          <button
            type="button"
            className="mission-export-btn"
            disabled={!selectedSession}
            onClick={() => {
              void exportSelectedSession();
            }}
          >
            <svg viewBox="0 0 24 24" fill="none">
              <path d="M12 3v12" />
              <path d="m7 10 5 5 5-5" />
              <path d="M5 21h14" />
            </svg>
            Export
          </button>
          <button
            type="button"
            className="mission-export-btn mission-export-btn--pdf"
            disabled={!selectedSession}
            onClick={exportSessionPDF}
          >
            <svg viewBox="0 0 24 24" fill="none">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14,2 14,8 20,8" />
              <line x1="9" y1="13" x2="15" y2="13" />
              <line x1="9" y1="17" x2="15" y2="17" />
              <line x1="9" y1="9" x2="11" y2="9" />
            </svg>
            PDF Report
          </button>
        </div>
      </section>
    </div>
  );
}

export function createDebugModule(): CockpitModule {
  return {
    id: "debug",
    version: "1.1.0",
    enabledByDefault: true,
    register(ctx: ModuleContext): void {
      const dispatcher = new MissionDispatcher(DISPATCHER_ID, TRANSPORT_ID);
      ctx.dispatchers.registerDispatcher({
        id: dispatcher.id,
        dispatcher
      });

      const service = new MissionService(dispatcher);
      ctx.services.registerService({
        id: SERVICE_ID,
        service
      });

      ctx.contributions.register({
        id: "modal.record",
        slot: "modal",
        title: "Record",
        render: () => <RecordModal runtime={ctx} />
      });

      ctx.commands.register(
        { id: OPEN_RECORD_MODAL_COMMAND_ID, title: "Open Record Modal", category: "Debug" },
        () => ctx.commands.execute(ShellCommands.openModal, "modal.record")
      );

      ctx.commands.register(
        { id: OPEN_SESSIONS_WORKSPACE_COMMAND_ID, title: "Open Mission Sessions", category: "Debug" },
        () => ctx.commands.execute(ShellCommands.openWorkspace, "workspace.sessions", { focused: true, toggleFocused: true })
      );

      ctx.contributions.register({
        id: "workspace.sessions",
        slot: "workspace",
        label: "Sessions",
        hiddenFromTabs: true,
        order: 40,
        render: () => <MissionSessionsWorkspace runtime={ctx} />
      });

      ctx.contributions.register({
        id: "sidebar.debug",
        slot: "sidebar",
        label: "Debug",
        icon: "🛠️",
        order: 100,
        render: () => <DebugSidebarPanel runtime={ctx} />
      });

      ctx.contributions.register({
        id: "toolbar.debug",
        slot: "toolbar",
        label: "Debug",
        items: [
          {
            id: "debug.record",
            label: "Grabación",
            commandId: OPEN_RECORD_MODAL_COMMAND_ID
          },
          {
            id: "debug.info",
            label: "Información",
            commandId: NavigationCommands.openInfoModal
          }
        ]
      });
    }
  };
}
