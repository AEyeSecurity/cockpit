import { batteryChargeWarning } from "../../../shared/batteryCharge";
import { NavigationCommands } from "../../navigation/commands";
import { useEffect, useRef, useState } from "react";
import "./styles.css";
import type { CockpitModule, ModuleContext } from "../../../../../core/types/module";
import type { RobotDispatcher } from "../../navigation/dispatcher/impl/RobotDispatcher";
import type { ConnectionService } from "../../navigation/service/impl/ConnectionService";
import type { SensorInfoService, SensorInfoState } from "../../navigation/service/impl/SensorInfoService";
import { TelemetryService, type TelemetrySnapshot } from "../service/impl/TelemetryService";
import { LidarPreviewService, type LidarPreviewState } from "../service/impl/LidarPreviewService";

const SERVICE_ID = "service.telemetry";
const LIDAR_PREVIEW_SERVICE_ID = "service.lidar-preview";
const DISPATCHER_ID = "dispatcher.robot";
const CONNECTION_SERVICE_ID = "service.connection";
const SENSOR_INFO_SERVICE_ID = "service.sensor-info";

function resolveOptionalServices(runtime: ModuleContext): {
  connection: ConnectionService | null;
  sensorInfo: SensorInfoService | null;
} {
  const hasStateApi = (service: unknown): service is { getState: () => unknown; subscribe: (listener: (state: never) => void) => () => void } =>
    !!service &&
    typeof service === "object" &&
    typeof (service as { getState?: unknown }).getState === "function" &&
    typeof (service as { subscribe?: unknown }).subscribe === "function";
  try {
    const connection = runtime.services.getService<ConnectionService>(CONNECTION_SERVICE_ID);
    const sensorInfo = runtime.services.getService<SensorInfoService>(SENSOR_INFO_SERVICE_ID);
    return {
      connection: hasStateApi(connection) ? connection : null,
      sensorInfo: hasStateApi(sensorInfo) ? sensorInfo : null
    };
  } catch {
    return { connection: null, sensorInfo: null };
  }
}

function formatInfoNumber(value: unknown, digits = 2): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "n/a";
  return numeric.toFixed(digits);
}

function formatInfoCoordinate(value: unknown): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "n/a";
  return numeric.toFixed(6);
}

function formatInfoTimestamp(value: unknown): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return "n/a";
  return new Date(numeric).toLocaleString();
}

function padTelemetryNumber(value: number): string {
  return String(value).padStart(2, "0");
}

function formatTelemetryClock(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "--:--:--";
  const date = new Date(timestamp);
  return `${padTelemetryNumber(date.getHours())}:${padTelemetryNumber(date.getMinutes())}:${padTelemetryNumber(date.getSeconds())}`;
}

function isTelemetryEventToday(timestamp: number, nowMs: number): boolean {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return false;
  const eventDate = new Date(timestamp);
  const today = new Date(nowMs);
  return (
    eventDate.getFullYear() === today.getFullYear() &&
    eventDate.getMonth() === today.getMonth() &&
    eventDate.getDate() === today.getDate()
  );
}

function telemetryEventTone(event: TelemetrySnapshot["recentEvents"][number]): "info" | "success" | "warning" | "critical" | "detection" {
  const level = event.level.trim().toLowerCase();
  const code = String(event.code ?? "").trim().toLowerCase();
  const text = event.text.trim().toLowerCase();
  if (level === "critical" || level === "error" || level === "err" || level === "fatal") return "critical";
  if (level === "warn" || level === "warning") return "warning";
  if (code.includes("detection") || text.includes("detected") || text.includes("object")) return "detection";
  if (
    code.includes("succeeded") ||
    text.includes("connected") ||
    text.includes("online") ||
    text.includes("restored") ||
    text.includes("reached")
  ) {
    return "success";
  }
  return "info";
}

function telemetryEventLevelLabel(event: TelemetrySnapshot["recentEvents"][number]): string {
  const tone = telemetryEventTone(event);
  if (tone === "warning") return "WARNING";
  if (tone === "critical") return "CRITICAL";
  if (tone === "detection") return "DETECTION";
  return "INFO";
}

function telemetryEventDetail(event: TelemetrySnapshot["recentEvents"][number]): string {
  if (event.code?.trim()) return event.code.trim().replace(/_/g, " ");
  const tone = telemetryEventTone(event);
  if (tone === "success") return "Estado normal";
  if (tone === "warning") return "Revision requerida";
  if (tone === "critical") return "Atencion inmediata";
  if (tone === "detection") return "Evento de percepcion";
  return "Evento del sistema";
}

function TelemetryIcon({
  kind,
  className = ""
}: {
  kind: "pulse" | "warning" | "critical" | "clock" | "list" | "bell" | "camera" | "check" | "info" | "battery" | "position";
  className?: string;
}): JSX.Element {
  const props = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className
  };

  if (kind === "battery") {
    return <svg {...props}><rect x="3" y="7" width="16" height="10" rx="2" /><path d="M22 10v4M7 10v4m4-4v4" /></svg>;
  }

  if (kind === "position") {
    return <svg {...props}><circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="2" /><path d="M12 2v3m0 14v3M2 12h3m14 0h3" /></svg>;
  }

  if (kind === "warning") {
    return (
      <svg {...props}>
        <path d="M10.3 4.2 2.9 17a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z" />
        <path d="M12 9v4" />
        <path d="M12 17h.01" />
      </svg>
    );
  }

  if (kind === "critical") {
    return (
      <svg {...props}>
        <path d="M12 3 5 6v5c0 4.1 2.8 7.8 7 9 4.2-1.2 7-4.9 7-9V6l-7-3Z" />
        <path d="M12 8v5" />
        <path d="M12 16h.01" />
      </svg>
    );
  }

  if (kind === "clock") {
    return (
      <svg {...props}>
        <circle cx="12" cy="12" r="8" />
        <path d="M12 8v5l3 2" />
      </svg>
    );
  }

  if (kind === "list") {
    return (
      <svg {...props}>
        <path d="M8 6h12" />
        <path d="M8 12h12" />
        <path d="M8 18h12" />
        <path d="M4 6h.01" />
        <path d="M4 12h.01" />
        <path d="M4 18h.01" />
      </svg>
    );
  }

  if (kind === "bell") {
    return (
      <svg {...props}>
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
        <path d="M10 21h4" />
      </svg>
    );
  }

  if (kind === "camera") {
    return (
      <svg {...props}>
        <rect x="4" y="7" width="12" height="10" rx="2" />
        <path d="m16 10 4-2v8l-4-2" />
        <circle cx="10" cy="12" r="2" />
      </svg>
    );
  }

  if (kind === "check") {
    return (
      <svg {...props}>
        <circle cx="12" cy="12" r="9" />
        <path d="m8 12 2.5 2.5L16 9" />
      </svg>
    );
  }

  if (kind === "info") {
    return (
      <svg {...props}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v5" />
        <path d="M12 8h.01" />
      </svg>
    );
  }

  return (
    <svg {...props}>
      <path d="M4 12h4l2-5 4 10 2-5h4" />
    </svg>
  );
}

function StatusChip({
  label,
  tone = "neutral"
}: {
  label: string;
  tone?: "neutral" | "ok" | "warn" | "off";
}): JSX.Element {
  return <span className={`telemetry-chip telemetry-chip-${tone}`}>{label}</span>;
}

function LidarPreviewCard({ service }: { service: LidarPreviewService | null }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<LidarPreviewState>(() => service?.getState() ?? {
    status: "waiting",
    frameId: "",
    sourceStamp: null,
    receivedAtMs: 0,
    angleMin: 0,
    angleIncrement: 0,
    rangeMin: 0,
    rangeMax: 0,
    ranges: [],
    validCount: 0
  });
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => service?.subscribe(setState), [service]);
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);

  const stale = state.status === "live" && nowMs - state.receivedAtMs > 1500;
  const visualStatus = state.status === "waiting" ? "waiting" : stale ? "stale" : "live";

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const pixelRatio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * pixelRatio));
    canvas.height = Math.max(1, Math.round(rect.height * pixelRatio));
    const context = canvas.getContext("2d");
    if (!context) return;
    context.scale(pixelRatio, pixelRatio);
    const width = rect.width;
    const height = rect.height;
    const originX = width / 2;
    const originY = height - 12;
    const radius = Math.min(width / 2 - 12, height - 22);
    context.clearRect(0, 0, width, height);
    context.strokeStyle = "#dbe5ef";
    context.lineWidth = 1;
    for (const meters of [4, 8, 12]) {
      const ringRadius = radius * meters / 12;
      context.beginPath();
      context.arc(originX, originY, ringRadius, Math.PI, 2 * Math.PI);
      context.stroke();
    }
    context.beginPath();
    context.moveTo(originX - radius, originY);
    context.lineTo(originX + radius, originY);
    context.moveTo(originX, originY);
    context.lineTo(originX, originY - radius);
    context.stroke();
    if (visualStatus === "waiting") return;
    context.fillStyle = stale ? "#94a3b8" : "#0ea5e9";
    state.ranges.forEach((range, index) => {
      if (range === null) return;
      const angle = state.angleMin + state.angleIncrement * index;
      const scaledRange = Math.min(range, 12) / 12 * radius;
      const x = originX - Math.sin(angle) * scaledRange;
      const y = originY - Math.cos(angle) * scaledRange;
      context.beginPath();
      context.arc(x, y, 1.7, 0, Math.PI * 2);
      context.fill();
    });
  }, [state, visualStatus]);

  return (
    <section className="telemetry-status-section">
      <h3 className="telemetry-status-heading">
        <TelemetryIcon kind="pulse" /> Vista LiDAR
        <StatusChip label={visualStatus === "live" ? "En vivo" : visualStatus === "stale" ? "Sin actualizar" : "Sin datos"}
          tone={visualStatus === "live" ? "ok" : visualStatus === "stale" ? "warn" : "neutral"} />
      </h3>
      {visualStatus === "waiting" ? <div className="telemetry-status-details"><p>Esperando lecturas del LiDAR.</p></div> :
        <div className="telemetry-lidar-preview">
          <canvas ref={canvasRef} className="telemetry-lidar-canvas" aria-label="Vista del LiDAR desde el rover" />
          <div className="telemetry-lidar-legend">
            <span>Frente ↑</span>
            <span>{state.validCount} {state.validCount === 1 ? "punto" : "puntos"}</span>
            <span>{state.rangeMax > 0 ? `${Math.min(state.rangeMax, 12).toFixed(0)} m` : "12 m"}</span>
          </div>
        </div>}
    </section>
  );
}

function TelemetryMetricCard({
  label,
  value,
  detail,
  icon,
  tone
}: {
  label: string;
  value: string;
  detail: string;
  icon: "pulse" | "warning" | "critical" | "clock";
  tone: "info" | "warning" | "critical" | "success";
}): JSX.Element {
  return (
    <div className={`telemetry-console-metric telemetry-console-metric-${tone}`}>
      <span className="telemetry-console-metric-icon" aria-hidden="true">
        <TelemetryIcon kind={icon} />
      </span>
      <span className="telemetry-console-metric-copy">
        <span className="telemetry-console-metric-label">{label}</span>
        <strong className="telemetry-console-metric-value">{value}</strong>
        <span className="telemetry-console-metric-detail">{detail}</span>
      </span>
    </div>
  );
}

function TelemetryEventIcon({ tone }: { tone: ReturnType<typeof telemetryEventTone> }): JSX.Element {
  const icon =
    tone === "warning" ? "warning" :
    tone === "critical" ? "critical" :
    tone === "success" ? "check" :
    tone === "detection" ? "camera" :
    "info";
  return <TelemetryIcon kind={icon} />;
}

function TelemetryEventRow({
  event,
  variant,
  recent
}: {
  event: TelemetrySnapshot["recentEvents"][number];
  variant: "events" | "alerts";
  recent: boolean;
}): JSX.Element {
  const tone = telemetryEventTone(event);
  return (
    <div className={`telemetry-console-row telemetry-console-row-${variant} telemetry-console-row-${tone} ${recent ? "is-recent" : ""}`}>
      <span className="telemetry-console-row-time">
        <span className="telemetry-console-row-dot" aria-hidden="true" />
        {formatTelemetryClock(event.timestamp)}
      </span>
      <span className="telemetry-console-row-icon" aria-hidden="true">
        <TelemetryEventIcon tone={tone} />
      </span>
      <span className="telemetry-console-row-copy">
        <strong>{event.text}</strong>
        <span>{telemetryEventDetail(event)}</span>
      </span>
      <span className={`telemetry-console-row-chip telemetry-console-row-chip-${tone}`}>
        {telemetryEventLevelLabel(event)}
      </span>
    </div>
  );
}

function TelemetryEmptyState({ label }: { label: string }): JSX.Element {
  return (
    <div className="telemetry-console-empty">
      <span className="telemetry-console-empty-icon" aria-hidden="true">
        <TelemetryIcon kind="info" />
      </span>
      <span>{label}</span>
    </div>
  );
}

export function TelemetrySidebarPanel({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const services = resolveOptionalServices(runtime);
  let telemetryService: TelemetryService | null = null;
  try {
    telemetryService = runtime.services.getService<TelemetryService>(SERVICE_ID);
  } catch {
    telemetryService = null;
  }
  let lidarPreviewService: LidarPreviewService | null = null;
  try {
    lidarPreviewService = runtime.services.getService<LidarPreviewService>(LIDAR_PREVIEW_SERVICE_ID);
  } catch {
    lidarPreviewService = null;
  }
  const [sensorInfoState, setSensorInfoState] = useState<SensorInfoState | null>(
    services.sensorInfo ? services.sensorInfo.getState() : null
  );
  const [connectionState, setConnectionState] = useState(
    services.connection ? services.connection.getState() : null
  );
  const [telemetrySnapshot, setTelemetrySnapshot] = useState<TelemetrySnapshot>(
    telemetryService
      ? telemetryService.getSnapshot()
      : {
          robotStatus: {
            batteryPct: null,
            batteryVoltageV: null,
            batteryState: "",
            batteryMissionState: "",
            batteryReturnHomeRecommended: null,
            batteryRecoveredVoltageV: null,
            batteryLoadedVoltageV: null,
            batteryPresent: null,
            batteryUpdatedAgeS: null,
            mode: "disconnected",
            connected: false
          },
          robotPose: null,
          cmdVelSafe: "n/a",
          goalActive: false,
          currentWaypoint: 0,
          totalWaypoints: 0,
          loopTotalWaypoints: 0,
          navResultStatus: 0,
          navResultText: "",
          navResultEventId: 0,
          controlLocked: false,
          controlLockReason: "",
          recentEvents: [],
          alerts: [],
          rtkSourceState: null,
          rtkSources: [],
          datum: null,
          gpsStatus: null
        }
  );
  const pixhawkPayload = sensorInfoState?.payloads.pixhawk_gps as Record<string, unknown> | undefined;
  const pixhawkSnapshot = (pixhawkPayload?.snapshot ?? {}) as Record<string, unknown>;

  useEffect(() => {
    if (!services.sensorInfo) return;
    return services.sensorInfo.subscribe((next) => setSensorInfoState(next));
  }, [services.sensorInfo]);

  useEffect(() => {
    if (!services.connection) return;
    return services.connection.subscribe((next) => setConnectionState(next));
  }, [services.connection]);

  useEffect(() => {
    if (!telemetryService) return undefined;
    return telemetryService.subscribeTelemetry((next) => setTelemetrySnapshot(next));
  }, [telemetryService]);

  useEffect(() => {
    if (!services.sensorInfo) return;
    void services.sensorInfo.setActiveTab("general");
    void services.sensorInfo.open();
    return () => {
      void services.sensorInfo!.close();
    };
  }, [services.sensorInfo]);

  const generalPayload = sensorInfoState?.payloads.general as Record<string, unknown> | undefined;
  const generalSnapshot = (generalPayload?.snapshot ?? {}) as Record<string, unknown>;
  const datumState = telemetrySnapshot.datum ?? (generalSnapshot.datum as Record<string, unknown> | undefined) ?? {};
  const rtkState =
    telemetrySnapshot.rtkSourceState ?? (generalSnapshot.rtk_source_state as Record<string, unknown> | undefined) ?? {};
  const gpsStatus = telemetrySnapshot.gpsStatus ?? (generalSnapshot.gps_status as Record<string, unknown> | undefined) ?? {};
  const yawDiagnostics =
    (pixhawkSnapshot.diagnostics as Record<string, unknown> | undefined) ??
    (generalSnapshot.diagnostics as Record<string, unknown> | undefined) ??
    {};
  const connected = connectionState?.connected === true;
  const { batteryPct, batteryPresent, batteryState } = telemetrySnapshot.robotStatus;
  const charge = connected && batteryPresent !== false &&
    !["UNAVAILABLE", "STALE", "LINK_STALE", "SUSPECT"].includes(batteryState.trim().toUpperCase()) &&
    typeof batteryPct === "number" && Number.isFinite(batteryPct) && batteryPct >= 0 && batteryPct <= 100
    ? batteryPct : null;
  const chargeLevel = batteryChargeWarning(charge);
  const fixQuality = String(gpsStatus.fix_quality ?? "");
  const fixLabels: Record<string, string> = {
    no_fix: "Sin posición", autonomous: "GPS autónomo", dgps: "GPS diferencial",
    rtk_float: "RTK flotante", rtk_fixed: "RTK fijo"
  };
  const gpsLabel = !connected || gpsStatus.available !== true ? "Sin datos"
    : fixLabels[fixQuality] ?? "Precisión sin confirmar";
  const gpsTone = !connected ? "neutral" : fixQuality === "no_fix" ? "warn"
    : fixQuality === "rtk_fixed" ? "ok" : "neutral";
  const datumSet = datumState.already_set === true;
  const hasRtk = connected && typeof rtkState.connected === "boolean";

  return (
    <div className="telemetry-status-sidebar">
      <section className="telemetry-status-section" aria-label="Resumen del rover">
        <div className="telemetry-status-row">
          <TelemetryIcon kind="pulse" />
          <strong>Conexión</strong>
          <StatusChip label={connected ? "Conectado" : "Desconectado"} tone={connected ? "ok" : "off"} />
        </div>
        <div className="telemetry-status-row">
          <TelemetryIcon kind="battery" />
          <strong>Batería</strong>
          <StatusChip label={charge === null ? "Sin datos" : `${Math.round(charge)} %`}
            tone={charge === null ? "neutral" : chargeLevel === "critical" ? "off" : chargeLevel === "warn" ? "warn" : "ok"} />
        </div>
        <div className="telemetry-status-row">
          <TelemetryIcon kind="position" />
          <strong>GPS</strong>
          <StatusChip label={gpsLabel}
            tone={gpsTone} />
        </div>
        {hasRtk && <div className="telemetry-status-row">
          <TelemetryIcon kind="check" />
          <strong>Correcciones RTK</strong>
          <StatusChip label={rtkState.receiving_rtcm === true ? "Activas" : rtkState.connected === true ? "En espera" : "Sin enlace"}
            tone={rtkState.receiving_rtcm === true ? "ok" : "warn"} />
        </div>}
        <button type="button" className="telemetry-status-link"
          onClick={() => void runtime.commands.execute(NavigationCommands.openRtkModal)}>
          <TelemetryIcon kind="position" /> GPS y precisión
        </button>
      </section>

      <section className="telemetry-status-section">
        <h3 className="telemetry-status-heading"><TelemetryIcon kind="position" /> Referencia del mapa
          <StatusChip label={datumSet ? "Configurada" : "Pendiente"} tone={datumSet ? "ok" : "neutral"} />
        </h3>
        <div className="telemetry-status-details key-value-grid">
          {datumSet ? <>
            <span>Latitud</span><span>{formatInfoCoordinate(datumState.datum_lat)}</span>
            <span>Longitud</span><span>{formatInfoCoordinate(datumState.datum_lon)}</span>
            <span>Origen</span><span>{String(datumState.last_set_source ?? "Sin datos")}</span>
            <span>Último cambio</span><span>{formatInfoTimestamp(datumState.last_set_epoch_ms)}</span>
          </> : <p>El rover aún no informó la referencia.</p>}
        </div>
      </section>

      <section className="telemetry-status-section">
        <h3 className="telemetry-status-heading"><TelemetryIcon kind="info" /> Diagnóstico GPS</h3>
        <div className="telemetry-status-details key-value-grid">
          {gpsStatus.source != null && <><span>Origen GPS</span><span>{String(gpsStatus.source)}</span></>}
          {gpsStatus.raw != null && <><span>Estado GPS</span><span>{String(gpsStatus.raw)}</span></>}
          {rtkState.active_source_label != null && <><span>Fuente RTK</span><span>{String(rtkState.active_source_label)}</span></>}
          {rtkState.rtcm_age_s != null && <><span>Última corrección</span><span>{formatInfoNumber(rtkState.rtcm_age_s, 1)} s</span></>}
          {gpsStatus.received_count != null && <><span>Correcciones recibidas</span><span>{formatInfoNumber(gpsStatus.received_count, 0)}</span></>}
          {Boolean(rtkState.last_error) && <><span>Error RTK</span><span>{String(rtkState.last_error)}</span></>}
          {yawDiagnostics.yaw_delta_deg != null && <><span>Diferencia de rumbo</span><span>{formatInfoNumber(yawDiagnostics.yaw_delta_deg)}°</span></>}
          {!Object.keys(gpsStatus).length && !Object.keys(rtkState).length && yawDiagnostics.yaw_delta_deg == null &&
            <p>Sin datos de diagnóstico.</p>}
        </div>
      </section>

      {lidarPreviewService && <LidarPreviewCard service={lidarPreviewService} />}
    </div>
  );
}

function TelemetryConsoleTab({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const service = runtime.services.getService<TelemetryService>(SERVICE_ID);
  const [snapshot, setSnapshot] = useState<TelemetrySnapshot>(service.getSnapshot());
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [showAllEvents, setShowAllEvents] = useState(false);
  const [showAllAlerts, setShowAllAlerts] = useState(false);

  useEffect(() => service.subscribeTelemetry((next) => setSnapshot(next)), [service]);
  useEffect(() => {
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  const recentEventsToday = snapshot.recentEvents.filter((event) => isTelemetryEventToday(event.timestamp, nowMs));
  const alertsToday = snapshot.alerts.filter((event) => isTelemetryEventToday(event.timestamp, nowMs));
  const warningsToday = alertsToday.filter((event) => telemetryEventTone(event) === "warning").length;
  const criticalToday = alertsToday.filter((event) => telemetryEventTone(event) === "critical").length;
  const visibleEvents = showAllEvents ? snapshot.recentEvents : snapshot.recentEvents.slice(0, 5);
  const visibleAlerts = showAllAlerts ? snapshot.alerts : snapshot.alerts.slice(0, 5);
  const currentTime = formatTelemetryClock(nowMs);

  return (
    <div className="telemetry-console-dashboard">
      <div className="telemetry-console-summary" aria-label="Telemetry summary">
        <TelemetryMetricCard
          label="Events"
          value={String(recentEventsToday.length)}
          detail="Hoy"
          icon="pulse"
          tone="info"
        />
        <TelemetryMetricCard
          label="Warnings"
          value={String(warningsToday)}
          detail="Hoy"
          icon="warning"
          tone="warning"
        />
        <TelemetryMetricCard
          label="Critical"
          value={String(criticalToday)}
          detail="Hoy"
          icon="critical"
          tone="critical"
        />
        <TelemetryMetricCard
          label="Hora local"
          value={currentTime}
          detail="En vivo"
          icon="clock"
          tone="success"
        />
      </div>

      <div className="telemetry-console-panels">
        <section className="telemetry-console-card telemetry-console-card-events">
          <div className="telemetry-console-card-header">
            <div className="telemetry-console-card-title">
              <TelemetryIcon kind="list" />
              <h3>Recent Events</h3>
            </div>
            <button
              type="button"
              className="telemetry-console-more-btn"
              onClick={() => setShowAllEvents((prev) => !prev)}
            >
              {showAllEvents ? "Ver menos" : "Ver todos"}
              <span aria-hidden="true">›</span>
            </button>
          </div>
          <div className="telemetry-console-list">
            {visibleEvents.length === 0 ? (
              <TelemetryEmptyState label="Sin eventos" />
            ) : (
              visibleEvents.map((entry, index) => (
                <TelemetryEventRow
                  key={`${entry.timestamp}.${index}.event`}
                  event={entry}
                  variant="events"
                  recent={nowMs - entry.timestamp <= 5000}
                />
              ))
            )}
          </div>
          <button
            type="button"
            className="telemetry-console-footer-btn"
            onClick={() => setShowAllEvents((prev) => !prev)}
          >
            {showAllEvents ? "Ver menos eventos" : "Ver todos los eventos"}
            <span aria-hidden="true">›</span>
          </button>
        </section>

        <section className="telemetry-console-card telemetry-console-card-alerts">
          <div className="telemetry-console-card-header">
            <div className="telemetry-console-card-title">
              <TelemetryIcon kind="bell" />
              <h3>Alerts Timeline</h3>
            </div>
            <button
              type="button"
              className="telemetry-console-more-btn"
              onClick={() => setShowAllAlerts((prev) => !prev)}
            >
              {showAllAlerts ? "Ver menos" : "Ver todas"}
              <span aria-hidden="true">›</span>
            </button>
          </div>
          <div className="telemetry-console-list telemetry-console-alert-list">
            {visibleAlerts.length === 0 ? (
              <TelemetryEmptyState label="Sin alertas" />
            ) : (
              visibleAlerts.map((entry, index) => (
                <TelemetryEventRow
                  key={`${entry.timestamp}.${index}.alert`}
                  event={entry}
                  variant="alerts"
                  recent={nowMs - entry.timestamp <= 5000}
                />
              ))
            )}
          </div>
          <button
            type="button"
            className="telemetry-console-footer-btn"
            onClick={() => setShowAllAlerts((prev) => !prev)}
          >
            {showAllAlerts ? "Ver menos alertas" : "Ver todas las alertas"}
            <span aria-hidden="true">›</span>
          </button>
        </section>
      </div>
    </div>
  );
}

export function createTelemetryModule(): CockpitModule {
  return {
    id: "telemetry",
    version: "1.2.0",
    enabledByDefault: true,
    register(ctx: ModuleContext): void {
      const dispatcherDefinition = ctx.dispatchers.get(DISPATCHER_ID);
      if (!dispatcherDefinition) return;

      const robotDispatcher = dispatcherDefinition.dispatcher as RobotDispatcher;
      const telemetryService = new TelemetryService(robotDispatcher, ctx.eventBus);
      const lidarPreviewService = new LidarPreviewService(robotDispatcher);
      ctx.services.registerService({
        id: SERVICE_ID,
        service: telemetryService
      });
      ctx.services.registerService({
        id: LIDAR_PREVIEW_SERVICE_ID,
        service: lidarPreviewService
      });

      ctx.contributions.register({
        id: "sidebar.telemetry",
        slot: "sidebar",
        label: "Estado del robot",
        icon: "📡",
        render: () => <TelemetrySidebarPanel runtime={ctx} />
      });

      ctx.contributions.register({
        id: "console.telemetry",
        slot: "console",
        label: "Telemetry",
        render: () => <TelemetryConsoleTab runtime={ctx} />
      });
    }
  };
}
