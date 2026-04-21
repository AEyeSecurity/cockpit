import { useEffect, useRef, useState } from "react";
import "./styles.css";
import { PanelCollapsibleSection, PanelSection } from "../../../../core";
import { CORE_EVENTS, NAV_EVENTS } from "../../../../../core/events/topics";
import type { CockpitModule, ModuleContext } from "../../../../../core/types/module";
import { RobotDispatcher } from "../dispatcher/impl/RobotDispatcher";
import { ConnectionService, type ConnectionState } from "../service/impl/ConnectionService";
import { DIALOG_SERVICE_ID, type DialogService } from "../../../../core/modules/runtime/service/impl/DialogService";
import { MapService, type DatumProfilesState, type MapWorkspaceState } from "../../map/service/impl/MapService";
import { SensorInfoService, type SensorInfoTab } from "../service/impl/SensorInfoService";
import type { TelemetrySnapshot } from "../../telemetry/service/impl/TelemetryService";
import { NavigationService, type NavigationState, type SnapshotData } from "../service/impl/NavigationService";
import { WebSocketTransport } from "../transport/impl/WebSocketTransport";
import { NavigationCommands } from "../commands";
import { ShellCommands } from "../../../../../app/shellCommands";

const TRANSPORT_ID = "transport.ws.core";
const DISPATCHER_ID = "dispatcher.robot";
const NAVIGATION_SERVICE_ID = "service.navigation";
const CONNECTION_SERVICE_ID = "service.connection";
const MAP_SERVICE_ID = "service.map";
const TELEMETRY_SERVICE_ID = "service.telemetry";
const SENSOR_INFO_SERVICE_ID = "service.sensor-info";

interface Nav2RuntimeConfig {
  ws_real_host?: unknown;
  ws_real_port?: unknown;
  ws_sim_host?: unknown;
  ws_sim_port?: unknown;
  manual_linear_speed_min?: unknown;
  manual_linear_speed_max?: unknown;
  manual_linear_speed_default?: unknown;
  manual_steering_angle_min_deg?: unknown;
  manual_steering_angle_max_deg?: unknown;
  manual_steering_angle_default_deg?: unknown;
  manual_angular_speed_min?: unknown;
  manual_angular_speed_max?: unknown;
  manual_angular_speed_default?: unknown;
  manual_loop_interval_ms?: unknown;
}

interface ManualSpeedLimits {
  linearMin: number;
  linearMax: number;
  steeringAngleMinDeg: number;
  steeringAngleMaxDeg: number;
}

const MANUAL_ACKERMANN_WHEELBASE_M = 0.94;
const DEFAULT_MANUAL_LINEAR_SPEED = 1.2;
const DEFAULT_MANUAL_STEERING_ANGLE_MIN_DEG = 1.0;
const DEFAULT_MANUAL_STEERING_ANGLE_MAX_DEG = 30.0;
const DEFAULT_MANUAL_STEERING_ANGLE_DEG = 18.0;

function readNav2Config(ctx: ModuleContext): Nav2RuntimeConfig {
  return ctx.getPackageConfig<Record<string, unknown>>("nav2") as Nav2RuntimeConfig;
}

function parseHost(value: unknown, fallback: string): string {
  const next = String(value ?? "").trim();
  return next.length > 0 ? next : fallback;
}

function parsePort(value: unknown, fallback: string): string {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return fallback;
  return String(parsed);
}

function parseNumberInRange(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function parseLoopIntervalMs(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(20, Math.round(parsed));
}

function yawRateToSteeringDeg(angularSpeed: number, referenceSpeed: number): number {
  const angular = Number(angularSpeed);
  const speed = Math.abs(Number(referenceSpeed));
  if (!Number.isFinite(angular) || !Number.isFinite(speed) || speed <= 1.0e-6) {
    return DEFAULT_MANUAL_STEERING_ANGLE_DEG;
  }
  return (Math.atan((Math.abs(angular) * MANUAL_ACKERMANN_WHEELBASE_M) / speed) * 180.0) / Math.PI;
}

function parseManualSpeedLimits(config: Nav2RuntimeConfig): ManualSpeedLimits {
  const linearMinCandidate = Number(config.manual_linear_speed_min);
  const linearMaxCandidate = Number(config.manual_linear_speed_max);
  const linearMin = Number.isFinite(linearMinCandidate) ? linearMinCandidate : 1.0;
  const linearMax = Number.isFinite(linearMaxCandidate) ? linearMaxCandidate : 4.0;
  const defaultLinearSpeed = parseNumberInRange(
    config.manual_linear_speed_default,
    DEFAULT_MANUAL_LINEAR_SPEED,
    linearMin,
    linearMax
  );
  const steeringAngleMinCandidate = Number(config.manual_steering_angle_min_deg);
  const steeringAngleMaxCandidate = Number(config.manual_steering_angle_max_deg);
  const legacyAngularMinCandidate = Number(config.manual_angular_speed_min);
  const legacyAngularMaxCandidate = Number(config.manual_angular_speed_max);
  const steeringAngleMin = Number.isFinite(steeringAngleMinCandidate)
    ? steeringAngleMinCandidate
    : Number.isFinite(legacyAngularMinCandidate)
      ? yawRateToSteeringDeg(legacyAngularMinCandidate, defaultLinearSpeed)
      : DEFAULT_MANUAL_STEERING_ANGLE_MIN_DEG;
  const steeringAngleMax = Number.isFinite(steeringAngleMaxCandidate)
    ? steeringAngleMaxCandidate
    : Number.isFinite(legacyAngularMaxCandidate)
      ? yawRateToSteeringDeg(legacyAngularMaxCandidate, defaultLinearSpeed)
      : DEFAULT_MANUAL_STEERING_ANGLE_MAX_DEG;
  return {
    linearMin: linearMax > linearMin ? linearMin : 1.0,
    linearMax: linearMax > linearMin ? linearMax : 4.0,
    steeringAngleMinDeg:
      steeringAngleMax > steeringAngleMin ? steeringAngleMin : DEFAULT_MANUAL_STEERING_ANGLE_MIN_DEG,
    steeringAngleMaxDeg:
      steeringAngleMax > steeringAngleMin ? steeringAngleMax : DEFAULT_MANUAL_STEERING_ANGLE_MAX_DEG
  };
}

function parseDefaultSteeringAngleDeg(config: Nav2RuntimeConfig, limits: ManualSpeedLimits): number {
  const defaultLinearSpeed = parseNumberInRange(
    config.manual_linear_speed_default,
    DEFAULT_MANUAL_LINEAR_SPEED,
    limits.linearMin,
    limits.linearMax
  );
  return parseNumberInRange(
    config.manual_steering_angle_default_deg,
    Number.isFinite(Number(config.manual_angular_speed_default))
      ? yawRateToSteeringDeg(Number(config.manual_angular_speed_default), defaultLinearSpeed)
      : DEFAULT_MANUAL_STEERING_ANGLE_DEG,
    limits.steeringAngleMinDeg,
    limits.steeringAngleMaxDeg
  );
}

function buildConnectionPresetDefaults(ctx: ModuleContext, config: Nav2RuntimeConfig): {
  real: { host: string; port: string };
  sim: { host: string; port: string };
} {
  const wsRealHostFallback = ctx.env.wsRealHost ?? "100.111.4.7";
  const wsSimHostFallback = ctx.env.wsSimHost ?? "localhost";
  const wsPortFallback = ctx.env.wsDefaultPort ?? "8766";
  return {
    real: {
      host: parseHost(config.ws_real_host, wsRealHostFallback),
      port: parsePort(config.ws_real_port, wsPortFallback)
    },
    sim: {
      host: parseHost(config.ws_sim_host, wsSimHostFallback),
      port: parsePort(config.ws_sim_port, wsPortFallback)
    }
  };
}

interface TelemetryServiceLike {
  getSnapshot: () => TelemetrySnapshot;
  subscribeTelemetry: (callback: (snapshot: TelemetrySnapshot) => void) => () => void;
}

function getTelemetryService(runtime: ModuleContext): TelemetryServiceLike | null {
  try {
    return runtime.services.getService<TelemetryServiceLike>(TELEMETRY_SERVICE_ID);
  } catch {
    return null;
  }
}

function formatControlLockReason(reason: string): string {
  const normalized = reason.trim();
  if (!normalized) return "Robot bloqueado";
  const labels: Record<string, string> = {
    STARTUP_LOCKED: "Robot bloqueado al iniciar",
    UI_LOCK_REQUEST: "Robot bloqueado desde UI",
    UI_HEARTBEAT_TIMEOUT: "Robot bloqueado por heartbeat ausente",
    DISCONNECTED: "Robot bloqueado hasta confirmar backend",
    LOCKED: "Robot bloqueado"
  };
  return labels[normalized] ?? `Robot bloqueado: ${normalized}`;
}

function cleanRouteStatus(status: string): string {
  return status.replace(/\s+\[[^\]]+\]\s*$/u, "").trim().toLowerCase();
}

function formatRouteStatus(status: string): string {
  const normalized = cleanRouteStatus(status);
  if (!normalized || normalized === "idle") return "Idle";
  if (normalized === "route starting") return "Starting route";
  if (normalized.startsWith("route active")) return "Following route";
  if (normalized === "route completed") return "Route complete";
  if (normalized === "route cancelled") return "Route cancelled";
  if (normalized === "route paused by manual takeover") return "Paused by manual";
  if (normalized.startsWith("route failed")) return "Route error";
  return status.trim();
}

function routeTone(routeMission: NavigationState["routeMission"]): "active" | "paused" | "done" | "error" | "idle" {
  const status = cleanRouteStatus(routeMission.status);
  if (routeMission.paused || status.includes("paused")) return "paused";
  if (status.includes("failed") || status.includes("abort")) return "error";
  if (status.includes("completed")) return "done";
  if (status.includes("cancelled")) return "idle";
  if (routeMission.active || status.includes("active") || status.includes("starting")) return "active";
  return "idle";
}

function buildNavigationStatus(
  state: NavigationState,
  telemetry: TelemetrySnapshot | null
): {
  title: string;
  detail: string;
  tone: "active" | "paused" | "done" | "error" | "idle" | "manual";
  progressPct: number;
  showProgress: boolean;
  segmentText: string;
  routeMetaText: string;
} {
  const routeMission = state.routeMission;
  const tone = routeTone(routeMission);
  const expandedCount = Math.max(0, Math.round(routeMission.expandedWaypointCount));
  const status = cleanRouteStatus(routeMission.status);
  const startIndex = Math.max(0, Math.round(routeMission.currentStartIndex));
  const routeProgressCount =
    expandedCount > 0
      ? status.includes("completed")
        ? expandedCount
        : Math.min(expandedCount, startIndex)
      : 0;
  const progressPct = expandedCount > 0 ? Math.min(100, Math.max(0, (routeProgressCount / expandedCount) * 100)) : 0;
  const hasRouteHistory = expandedCount > 0 || routeMission.inputWaypointCount > 0 || cleanRouteStatus(routeMission.status) !== "idle";
  const routeMetaText =
    expandedCount > 0
      ? `${routeProgressCount}/${expandedCount} route points${routeMission.loop ? " · loop" : ""}`
      : routeMission.loop
        ? "Loop route"
        : "";
  const segmentText =
    routeMission.activeChunkSize > 0
      ? `Segment ${routeMission.currentStartIndex + 1}-${routeMission.currentTargetIndex + 1} · ${routeMission.activeChunkSize} pts`
      : routeMission.currentTargetIndex > 0
        ? `Last segment ${routeMission.currentStartIndex + 1}-${routeMission.currentTargetIndex + 1}`
        : "";

  if (state.manualMode || state.manualDisablePending) {
    return {
      title: state.manualDisablePending ? "Leaving manual control" : "Manual control",
      detail: routeMission.paused ? "Route paused" : "Operator control",
      tone: "manual",
      progressPct,
      showProgress: expandedCount > 0,
      segmentText,
      routeMetaText
    };
  }

  if (tone !== "idle" || hasRouteHistory) {
    return {
      title: tone === "paused" ? "Route paused" : formatRouteStatus(routeMission.status),
      detail: routeMission.loop ? "Mission loop enabled" : tone === "done" ? "Final brake expected" : "Route mission",
      tone,
      progressPct,
      showProgress: expandedCount > 0,
      segmentText,
      routeMetaText
    };
  }

  if (telemetry?.goalActive) {
    return {
      title: state.loopRoute ? "Loop goal active" : "Goal active",
      detail: "Send navigation",
      tone: "active",
      progressPct: 0,
      showProgress: false,
      segmentText: "",
      routeMetaText: ""
    };
  }

  const lastResult = String(telemetry?.navResultText ?? state.lastStatus ?? "").trim();
  return {
    title: lastResult && lastResult !== "idle" ? formatRouteStatus(lastResult) : "Ready",
    detail: "No active navigation",
    tone: "idle",
    progressPct: 0,
    showProgress: false,
    segmentText: "",
    routeMetaText: ""
  };
}

function getMapService(runtime: ModuleContext): MapService | null {
  try {
    return runtime.services.getService<MapService>(MAP_SERVICE_ID);
  } catch {
    return null;
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

function formatDatumCoordinate(value: unknown): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "n/a";
  return numeric.toFixed(7);
}

function formatInfoTimestamp(value: unknown): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return "n/a";
  return new Date(numeric).toLocaleString();
}

function ConnectionSidebarPanel({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const service = runtime.services.getService<ConnectionService>(CONNECTION_SERVICE_ID);
  const [state, setState] = useState(service.getState());

  useEffect(() => service.subscribe((next) => setState(next)), [service]);

  return (
    <div className="stack">
      <PanelSection title="Connection">
        <div className="stack">
          <select
            className="connection-preset-select"
            value={state.preset}
            onChange={(event) => service.setPreset(event.target.value === "sim" ? "sim" : "real")}
          >
            <option value="real">Real</option>
            <option value="sim">Sim</option>
          </select>
          <div className="input-grid">
            <input value={state.host} onChange={(event) => service.setHost(event.target.value)} placeholder="Host" />
            <input value={state.port} onChange={(event) => service.setPort(event.target.value)} placeholder="Port" />
          </div>
          <div className="action-grid">
            <button
              type="button"
              disabled={state.connecting}
              onClick={async () => {
                try {
                  await service.connect();
                } catch {
                  // The service keeps the latest error in state.
                }
              }}
            >
              {state.connecting ? "Connecting..." : "Connect"}
            </button>
            <button
              type="button"
              onClick={async () => {
                try {
                  await service.disconnect();
                } catch {
                  // The service keeps the latest error in state.
                }
              }}
            >
              Disconnect
            </button>
          </div>
          {state.lastError ? <p className="muted">Error: {state.lastError}</p> : null}
        </div>
      </PanelSection>
    </div>
  );
}

function ConnectionStatusFooterItem({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const service = runtime.services.getService<ConnectionService>(CONNECTION_SERVICE_ID);
  const [state, setState] = useState(service.getState());

  useEffect(() => service.subscribe((next) => setState(next)), [service]);

  return (
    <span className={`connection-footer-status-badge ${state.connected ? "connected" : "disconnected"}`}>
      {state.connected ? "Conectado" : "Desconectado"}
    </span>
  );
}

function NavigationSidebarPanel({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const service = runtime.services.getService<NavigationService>(NAVIGATION_SERVICE_ID);
  const telemetryService = getTelemetryService(runtime);
  const [state, setState] = useState<NavigationState>(service.getState());
  const [telemetrySnapshot, setTelemetrySnapshot] = useState<TelemetrySnapshot | null>(
    telemetryService ? telemetryService.getSnapshot() : null
  );
  const selectedCount = state.selectedWaypointIndexes.length;
  const lockReasonText = formatControlLockReason(state.controlLockReason);
  const routeMission = state.routeMission;
  const navigationStatus = buildNavigationStatus(state, telemetrySnapshot);

  useEffect(() => service.subscribe((next) => setState(next)), [service]);
  useEffect(() => {
    if (!telemetryService) return;
    return telemetryService.subscribeTelemetry((next) => setTelemetrySnapshot(next));
  }, [telemetryService]);

  const emitInfo = (text: string): void => {
    runtime.eventBus.emit("console.event", {
      level: "info",
      text,
      timestamp: Date.now()
    });
  };

  return (
    <div className="stack">
      <PanelSection title="Navigation">
        {state.controlLocked ? (
          <div className="nav-legacy-grid nav-lock-grid">
            <button
              type="button"
              className="nav-lock-btn"
              title="Desbloquea el robot para permitir controlarlo"
              onClick={async () => {
                try {
                  await service.unlockControls();
                  emitInfo("Controls unlocked");
                } catch (error) {
                  runtime.eventBus.emit("console.event", {
                    level: "error",
                    text: `Unlock failed: ${String(error)}`,
                    timestamp: Date.now()
                  });
                }
              }}
            >
              <span className="nav-lock-btn-label">🔒 Desbloquear robot</span>
            </button>
          </div>
        ) : (
          <div className="nav-legacy-grid">
            <button
              type="button"
              className={state.goalMode ? "active" : ""}
              onClick={() => {
                const enabled = service.toggleGoalMode();
                emitInfo(enabled ? "Goal mode enabled" : "Goal mode disabled");
              }}
              title="Modo objetivo"
            >
              📌
            </button>
            <button
              type="button"
              onClick={() => {
                service.removeLastWaypoint();
                emitInfo("Last waypoint removed");
              }}
              disabled={state.waypoints.length === 0}
              title="Deshacer"
            >
              ↩
            </button>
            <button
              type="button"
              className="danger-btn"
              onClick={() => {
                service.clearWaypoints();
                emitInfo("Waypoints cleared");
              }}
              disabled={state.waypoints.length === 0}
              title="Limpiar waypoints"
            >
              🗑
            </button>
            <button
              type="button"
              className="danger-btn"
              onClick={() => {
                const removed = service.removeSelectedWaypoints();
                if (removed > 0) {
                  emitInfo(`Removed ${removed} selected waypoint${removed > 1 ? "s" : ""}`);
                }
              }}
              disabled={selectedCount === 0}
              title="Eliminar seleccionados"
            >
              🧹
            </button>
            <button
              type="button"
              className="nav-legacy-send-btn"
              onClick={async () => {
                try {
                  const sent = await service.sendQueuedGoal();
                  const sentCount = sent.sentCount;
                  emitInfo(`Send navigation requested (${sentCount} waypoint${sentCount > 1 ? "s" : ""})`);
                } catch (error) {
                  runtime.eventBus.emit("console.event", {
                    level: "error",
                    text: `Goal failed: ${String(error)}`,
                    timestamp: Date.now()
                  });
                }
              }}
              disabled={state.waypoints.length === 0}
            >
              ➤ Send
            </button>
            <button
              type="button"
              className="nav-legacy-send-btn"
              onClick={async () => {
                try {
                  const started = await service.sendRouteMission();
                  emitInfo(
                    `Route mission started (${started.inputCount} waypoint${started.inputCount > 1 ? "s" : ""}, ${started.expandedCount} route points)`
                  );
                } catch (error) {
                  runtime.eventBus.emit("console.event", {
                    level: "error",
                    text: `Route mission failed: ${String(error)}`,
                    timestamp: Date.now()
                  });
                }
              }}
              disabled={state.waypoints.length === 0}
            >
              🛣 Route
            </button>
            <button
              type="button"
              className="danger-btn nav-legacy-cancel-btn"
              onClick={async () => {
                try {
                  await service.cancelGoal();
                  emitInfo("Navigation cancelled");
                } catch (error) {
                  runtime.eventBus.emit("console.event", {
                    level: "error",
                    text: `Cancel failed: ${String(error)}`,
                    timestamp: Date.now()
                  });
                }
              }}
            >
              ⊗ Cancel
            </button>
            <button
              type="button"
              className="danger-btn nav-legacy-cancel-btn"
              onClick={async () => {
                try {
                  await service.cancelRouteMission();
                  emitInfo("Route mission cancel requested");
                } catch (error) {
                  runtime.eventBus.emit("console.event", {
                    level: "error",
                    text: `Cancel route failed: ${String(error)}`,
                    timestamp: Date.now()
                  });
                }
              }}
              disabled={!routeMission.active && !routeMission.paused}
            >
              ⏹ Route
            </button>
            <button
              type="button"
              onClick={async () => {
                try {
                  const count = await service.saveWaypointsFile();
                  emitInfo(`Saved ${count} waypoints`);
                } catch (error) {
                  runtime.eventBus.emit("console.event", {
                    level: "error",
                    text: `Save waypoints failed: ${String(error)}`,
                    timestamp: Date.now()
                  });
                }
              }}
              title="Guardar ruta"
            >
              💾
            </button>
            <button
              type="button"
              onClick={async () => {
                try {
                  const count = await service.loadWaypointsFile();
                  emitInfo(`Loaded ${count} waypoints`);
                } catch (error) {
                  runtime.eventBus.emit("console.event", {
                    level: "error",
                    text: `Load waypoints failed: ${String(error)}`,
                    timestamp: Date.now()
                  });
                }
              }}
              title="Cargar ruta"
            >
              📂
            </button>
            <button
              type="button"
              onClick={() => {
                void runtime.commands.execute(NavigationCommands.openSnapshotModal);
              }}
              title="Snapshot"
            >
              📸
            </button>
            <button
              type="button"
              className={state.manualMode ? "active" : ""}
              onClick={async () => {
                const next = !state.manualMode;
                try {
                  await service.setManualMode(next);
                  emitInfo(next ? "Manual control enabled" : "Manual control disabled");
                } catch (error) {
                  runtime.eventBus.emit("console.event", {
                    level: "error",
                    text: `Manual mode failed: ${String(error)}`,
                    timestamp: Date.now()
                  });
                }
              }}
              title="Modo manual"
            >
              {state.manualMode ? "ON" : "OFF"}
            </button>
          </div>
        )}
        <label className="check-row nav-loop-check">
          <input
            type="checkbox"
            checked={state.loopRoute}
            onChange={(event) => service.setLoopRoute(event.target.checked)}
          />
          Loop route
        </label>
        <div className={`nav-mission-status tone-${navigationStatus.tone}`}>
          <div className="nav-mission-status-main">
            <span className="nav-mission-dot" />
            <div className="nav-mission-copy">
              <strong>{navigationStatus.title}</strong>
              <span>{navigationStatus.detail}</span>
            </div>
          </div>
          {navigationStatus.showProgress ? (
            <div className="nav-route-progress" aria-label="Route progress">
              <span style={{ width: `${navigationStatus.progressPct}%` }} />
            </div>
          ) : null}
          {navigationStatus.routeMetaText || navigationStatus.segmentText ? (
            <div className="nav-route-meta">
              {navigationStatus.routeMetaText ? <span>{navigationStatus.routeMetaText}</span> : null}
              {navigationStatus.segmentText ? <span>{navigationStatus.segmentText}</span> : null}
            </div>
          ) : null}
        </div>
        {state.controlLocked ? <p className="muted nav-legacy-text">{lockReasonText}</p> : null}
      </PanelSection>
      <ManualControlSidebarPanel runtime={runtime} />
      <DatumSidebarSection runtime={runtime} />
      <ZonesSidebarSection runtime={runtime} />
      <CameraSidebarPanel runtime={runtime} />
    </div>
  );
}

function ManualControlSidebarPanel({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const service = runtime.services.getService<NavigationService>(NAVIGATION_SERVICE_ID);
  const [state, setState] = useState<NavigationState>(service.getState());

  useEffect(() => service.subscribe((next) => setState(next)), [service]);

  return (
    <div className="stack">
      <PanelSection title="Speed limits">
        <label className="range-row">
          Linear speed (m/s): {state.manualLinearSpeed.toFixed(2)}
          <input
            type="range"
            min={state.manualLinearMin}
            max={state.manualLinearMax}
            step={0.01}
            value={state.manualLinearSpeed}
            onChange={(event) => service.setManualLinearSpeed(Number(event.target.value))}
          />
        </label>
        <label className="range-row">
          Steering angle (deg): {state.manualSteeringAngleDeg.toFixed(1)}
          <input
            type="range"
            min={state.manualSteeringAngleMinDeg}
            max={state.manualSteeringAngleMaxDeg}
            step={0.5}
            value={state.manualSteeringAngleDeg}
            onChange={(event) => service.setManualSteeringAngleDeg(Number(event.target.value))}
          />
        </label>
      </PanelSection>
    </div>
  );
}

function DatumSidebarSection({ runtime }: { runtime: ModuleContext }): JSX.Element | null {
  const mapService = getMapService(runtime);
  const [datumProfiles, setDatumProfiles] = useState<DatumProfilesState | null>(
    mapService ? mapService.getDatumProfilesState() : null
  );
  const [form, setForm] = useState({
    name: "",
    lat: "",
    lon: "",
    yawDeg: "0",
    notes: ""
  });

  useEffect(() => {
    if (!mapService) return;
    void mapService
      .getDatums()
      .then((next) => setDatumProfiles(next))
      .catch((error) => {
        runtime.eventBus.emit("console.event", {
          level: "warn",
          text: `Datums unavailable: ${String(error)}`,
          timestamp: Date.now()
        });
      });
  }, [mapService, runtime.eventBus]);
  useEffect(() => {
    if (!mapService) return;
    return mapService.subscribeDatumProfiles((next) => setDatumProfiles(next));
  }, [mapService]);

  if (!mapService) return null;

  const emit = (level: "info" | "warn" | "error", text: string): void => {
    runtime.eventBus.emit("console.event", {
      level,
      text,
      timestamp: Date.now()
    });
  };

  const refreshDatums = async (): Promise<void> => {
    const next = await mapService.getDatums();
    setDatumProfiles(next);
  };

  const captureGpsDatum = (): void => {
    const yawDeg = Number(form.yawDeg);
    void mapService
      .captureCurrentGpsDatumOnBackend({
        name: form.name.trim() || `GPS ${new Date().toLocaleString()}`,
        yawDeg: Number.isFinite(yawDeg) ? yawDeg : 0,
        notes: form.notes,
        select: true
      })
      .then((next) => {
        setDatumProfiles(next);
        emit("info", "Datum GPS guardado; reinicia el launch ROS para aplicarlo");
      })
      .catch((error) => emit("error", `Capture datum failed: ${String(error)}`));
  };

  const saveManualDatum = (): void => {
    const lat = Number(form.lat);
    const lon = Number(form.lon);
    const yawDeg = Number(form.yawDeg);
    if (!form.name.trim() || !Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(yawDeg)) {
      emit("error", "Datum manual invalido: nombre, lat, lon y yaw numericos son requeridos");
      return;
    }
    void mapService
      .saveDatumOnBackend({
        name: form.name,
        lat,
        lon,
        yawDeg,
        notes: form.notes,
        select: true
      })
      .then((next) => {
        setDatumProfiles(next);
        emit("info", "Datum manual guardado; reinicia el launch ROS para aplicarlo");
      })
      .catch((error) => emit("error", `Save datum failed: ${String(error)}`));
  };

  const selectDatum = (id: string): void => {
    void mapService
      .selectDatumOnBackend(id)
      .then((next) => {
        setDatumProfiles(next);
        emit("info", "Datum seleccionado; reinicia el launch ROS para aplicarlo");
      })
      .catch((error) => emit("error", `Select datum failed: ${String(error)}`));
  };

  const runtimeDatum = datumProfiles?.runtime;
  const selected = datumProfiles?.datums.find((entry) => entry.id === datumProfiles.selectedId);

  return (
    <div className="stack">
      <PanelCollapsibleSection title="Datums">
        <div className="datum-sidebar-status">
          <div>
            <span>Runtime</span>
            <strong>{formatDatumCoordinate(runtimeDatum?.lat)}, {formatDatumCoordinate(runtimeDatum?.lon)}</strong>
          </div>
          <div className={datumProfiles?.pendingRestart ? "datum-sidebar-badge pending" : "datum-sidebar-badge"}>
            {datumProfiles?.pendingRestart ? "Pendiente de restart ROS" : "Aplicado"}
          </div>
          <p className="muted nav-legacy-text">
            Seleccionado: {selected?.name ?? "n/a"}
          </p>
        </div>
        <div className="datum-sidebar-form">
          <input
            value={form.name}
            onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
            placeholder="Nombre"
          />
          <input
            value={form.yawDeg}
            onChange={(event) => setForm((current) => ({ ...current, yawDeg: event.target.value }))}
            placeholder="Yaw deg"
          />
          <input
            value={form.lat}
            onChange={(event) => setForm((current) => ({ ...current, lat: event.target.value }))}
            placeholder="Lat manual"
          />
          <input
            value={form.lon}
            onChange={(event) => setForm((current) => ({ ...current, lon: event.target.value }))}
            placeholder="Lon manual"
          />
          <input
            value={form.notes}
            onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))}
            placeholder="Notas"
          />
        </div>
        <div className="datum-sidebar-actions">
          <button type="button" onClick={captureGpsDatum}>
            Capturar GPS
          </button>
          <button type="button" onClick={saveManualDatum}>
            Guardar manual
          </button>
          <button type="button" onClick={() => void refreshDatums().catch((error) => emit("warn", `Refresh datums failed: ${String(error)}`))}>
            Refrescar
          </button>
        </div>
        <div className="datum-sidebar-list">
          {(datumProfiles?.datums ?? []).map((entry) => (
            <div key={entry.id} className={entry.id === datumProfiles?.selectedId ? "datum-sidebar-row selected" : "datum-sidebar-row"}>
              <button type="button" onClick={() => selectDatum(entry.id)} title="Seleccionar para proximo launch ROS">
                {entry.id === datumProfiles?.selectedId ? "●" : "○"}
              </button>
              <span>
                <strong>{entry.name}</strong>
                <small>{formatDatumCoordinate(entry.lat)}, {formatDatumCoordinate(entry.lon)} · yaw {entry.yawDeg.toFixed(1)}°</small>
              </span>
              <button
                type="button"
                className="danger-btn"
                onClick={() => {
                  void mapService
                    .deleteDatumOnBackend(entry.id)
                    .then((next) => setDatumProfiles(next))
                    .catch((error) => emit("error", `Delete datum failed: ${String(error)}`));
                }}
                title="Eliminar datum"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </PanelCollapsibleSection>
    </div>
  );
}

function ZonesSidebarSection({ runtime }: { runtime: ModuleContext }): JSX.Element | null {
  const mapService = getMapService(runtime);
  const dialogService = runtime.services.getService<DialogService>(DIALOG_SERVICE_ID);
  const [state, setState] = useState<MapWorkspaceState | null>(mapService ? mapService.getState() : null);

  useEffect(() => {
    if (!mapService) return;
    return mapService.subscribe((next) => setState(next));
  }, [mapService]);

  if (!mapService || !state) return null;

  return (
    <div className="stack">
      <PanelCollapsibleSection title="Zones">
        <div className="zones-legacy-grid">
          <button
            type="button"
            onClick={async () => {
              try {
                await mapService.loadMap("map");
                runtime.eventBus.emit("console.event", {
                  level: "info",
                  text: "Zones refreshed",
                  timestamp: Date.now()
                });
              } catch (error) {
                runtime.eventBus.emit("console.event", {
                  level: "error",
                  text: `Refresh zones failed: ${String(error)}`,
                  timestamp: Date.now()
                });
              }
            }}
          >
            Refresh
          </button>
          <button
            type="button"
            className="danger-btn"
            onClick={async () => {
              const ok = await dialogService.confirm({
                title: "Clear zones",
                message: `Clear all ${state.zones.length} no-go zones?`,
                confirmLabel: "Clear",
                cancelLabel: "Cancel",
                danger: true
              });
              if (!ok) return;
              mapService.clearZones();
              runtime.eventBus.emit("console.event", {
                level: "warn",
                text: "Zones cleared",
                timestamp: Date.now()
              });
            }}
          >
            Clear
          </button>
          <button
            type="button"
            onClick={async () => {
              try {
                await mapService.pushZonesToBackend();
                const count = mapService.persistZonesToStorage();
                runtime.eventBus.emit("console.event", {
                  level: "info",
                  text: `Zones saved (${count})`,
                  timestamp: Date.now()
                });
              } catch (error) {
                runtime.eventBus.emit("console.event", {
                  level: "error",
                  text: `Save zones failed: ${String(error)}`,
                  timestamp: Date.now()
                });
              }
            }}
          >
            Save
          </button>
          <button
            type="button"
            onClick={async () => {
              try {
                const count = mapService.loadZonesFromStorage();
                await mapService.loadZonesFromBackend();
                runtime.eventBus.emit("console.event", {
                  level: "info",
                  text: `Zones loaded (${count})`,
                  timestamp: Date.now()
                });
              } catch (error) {
                runtime.eventBus.emit("console.event", {
                  level: "error",
                  text: `Load zones failed: ${String(error)}`,
                  timestamp: Date.now()
                });
              }
            }}
          >
            Load
          </button>
        </div>
        <label className="check-row">
          <input type="checkbox" checked={state.autoSync} onChange={(event) => mapService.setAutoSync(event.target.checked)} />
          Auto-sync edits
        </label>
      </PanelCollapsibleSection>
      <PanelCollapsibleSection title="Zone List">
        {state.zones.length === 0 ? (
          <p className="muted">No zones.</p>
        ) : (
          <ul className="zone-list">
            {state.zones.map((zone) => (
              <li key={zone.id} className="zone-item">
                <div>
                  <strong>{zone.name}</strong>
                  <div className="muted">
                    vertices={zone.vertices} · {new Date(zone.updatedAt).toLocaleTimeString()}
                  </div>
                </div>
                <button type="button" className="danger-btn" onClick={() => mapService.removeZone(zone.id)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </PanelCollapsibleSection>
    </div>
  );
}

function CameraSidebarPanel({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const service = runtime.services.getService<NavigationService>(NAVIGATION_SERVICE_ID);
  let connectionService: ConnectionService | null = null;
  try {
    connectionService = runtime.services.getService<ConnectionService>(CONNECTION_SERVICE_ID);
  } catch {
    connectionService = null;
  }

  const pan = async (angleDeg: number): Promise<void> => {
    if (!connectionService?.isCameraEnabled()) {
      runtime.eventBus.emit("console.event", {
        level: "warn",
        text: "Camera disabled in current preset",
        timestamp: Date.now()
      });
      return;
    }
    try {
      await service.panCamera(angleDeg);
    } catch (error) {
      runtime.eventBus.emit("console.event", {
        level: "error",
        text: `Camera pan failed: ${String(error)}`,
        timestamp: Date.now()
      });
    }
  };

  return (
    <div className="stack">
      <PanelCollapsibleSection title="Camera PTZ">
        <div className="ptz-grid">
          <button type="button" onClick={() => void pan(45)}>
            ⇖
          </button>
          <button type="button" onClick={() => void pan(0)}>
            ⇑
          </button>
          <button type="button" onClick={() => void pan(-45)}>
            ⇗
          </button>
          <button type="button" onClick={() => void pan(90)}>
            ⇐
          </button>
          <button
            type="button"
            onClick={async () => {
              try {
                await service.toggleCameraZoom();
              } catch (error) {
                runtime.eventBus.emit("console.event", {
                  level: "error",
                  text: `Camera zoom failed: ${String(error)}`,
                  timestamp: Date.now()
                });
              }
            }}
          >
            🔍
          </button>
          <button type="button" onClick={() => void pan(-90)}>
            ⇒
          </button>
          <button type="button" onClick={() => void pan(135)}>
            ⇙
          </button>
          <button type="button" onClick={() => void pan(180)}>
            ⇓
          </button>
          <button type="button" onClick={() => void pan(-135)}>
            ⇘
          </button>
        </div>
      </PanelCollapsibleSection>
    </div>
  );
}

function snapshotExtFromMime(mime: string): string {
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("webp")) return "webp";
  return "png";
}

function isCameraDisabledPresetError(text: string): boolean {
  return text.toLowerCase().includes("camera disabled in current preset");
}

function SnapshotModal({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const service = runtime.services.getService<NavigationService>(NAVIGATION_SERVICE_ID);
  const [navigation, setNavigation] = useState<NavigationState>(service.getState());
  const [snapshot, setSnapshot] = useState<SnapshotData | null>(service.getState().lastSnapshot);
  const [loading, setLoading] = useState(false);

  useEffect(() => service.subscribe((next) => setNavigation(next)), [service]);
  useEffect(() => {
    setSnapshot(navigation.lastSnapshot);
  }, [navigation.lastSnapshot]);

  const captureSnapshot = async (): Promise<void> => {
    setLoading(true);
    try {
      const next = await service.requestSnapshot();
      setSnapshot(next);
    } catch (error) {
      const message = String(error);
      if (isCameraDisabledPresetError(message)) {
        runtime.eventBus.emit("console.event", {
          level: "info",
          text: "Snapshot no disponible para el preset de conexión actual.",
          timestamp: Date.now()
        });
        return;
      }
      runtime.eventBus.emit("console.event", {
        level: "error",
        text: `Snapshot capture failed: ${message}`,
        timestamp: Date.now()
      });
    } finally {
      setLoading(false);
    }
  };

  const download = (): void => {
    const snapshotToDownload = snapshot ?? service.getState().lastSnapshot;
    if (!snapshotToDownload || typeof window === "undefined") return;
    const mime = snapshotToDownload.mime || "image/png";
    const ext = snapshotExtFromMime(mime);
    try {
      const link = window.document.createElement("a");
      link.href = `data:${mime};base64,${snapshotToDownload.imageBase64}`;
      link.download = `nav_snapshot_${snapshotToDownload.stamp}.${ext}`;
      link.click();
      runtime.eventBus.emit(NAV_EVENTS.snapshotDownloadResult, {
        ok: true,
        text: "Captura descargada correctamente."
      });
    } catch (error) {
      runtime.eventBus.emit("console.event", {
        level: "error",
        text: `Snapshot download failed: ${String(error)}`,
        timestamp: Date.now()
      });
    }
  };

  useEffect(() => {
    const unsubscribeCapture = runtime.eventBus.on(NAV_EVENTS.snapshotCaptureRequest, () => {
      void captureSnapshot();
    });
    const unsubscribeDownload = runtime.eventBus.on(NAV_EVENTS.snapshotDownloadRequest, () => {
      download();
    });
    return () => {
      unsubscribeCapture();
      unsubscribeDownload();
    };
  }, [runtime.eventBus, service]);

  return (
    <div className="stack">
      <div className="row">
        <button
          type="button"
          disabled={loading}
          onClick={() => {
            void captureSnapshot();
          }}
        >
          {loading ? "Loading..." : "Capture snapshot"}
        </button>
        <button type="button" disabled={!snapshot} onClick={download}>
          Download
        </button>
      </div>
      {snapshot?.imageBase64 ? (
        <img
          className="snapshot-image"
          src={`data:${snapshot.mime};base64,${snapshot.imageBase64}`}
          alt="Navigation snapshot"
        />
      ) : (
        <div className="modal-preview">Snapshot preview area</div>
      )}
      <p className="muted">Esc: close · Shift+Esc: download + close</p>
    </div>
  );
}

function SnapshotModalFooter({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const [message, setMessage] = useState("");
  const hideTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const unsubscribe = runtime.eventBus.on<{ ok?: unknown; text?: unknown }>(NAV_EVENTS.snapshotDownloadResult, (event) => {
      if (event.ok !== true) return;
      const text =
        typeof event.text === "string" && event.text.trim().length > 0
          ? event.text.trim()
          : "Captura descargada correctamente.";
      setMessage(text);
      if (hideTimerRef.current != null) {
        window.clearTimeout(hideTimerRef.current);
      }
      hideTimerRef.current = window.setTimeout(() => {
        setMessage("");
      }, 5000);
    });

    return () => {
      unsubscribe();
      if (hideTimerRef.current != null) {
        window.clearTimeout(hideTimerRef.current);
      }
    };
  }, [runtime.eventBus]);

  return (
    <div className="snapshot-modal-footer">
      {message ? <span className="snapshot-modal-footer-status">{message}</span> : null}
    </div>
  );
}

function InfoModalFooter({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const sensorInfoService = runtime.services.getService<SensorInfoService>(SENSOR_INFO_SERVICE_ID);
  const [state, setState] = useState(sensorInfoService.getState());

  useEffect(() => sensorInfoService.subscribe((next) => setState(next)), [sensorInfoService]);

  const activeInterval = state.intervals[state.activeTab];
  const activeLoading = state.loading[state.activeTab];

  return (
    <div className="modal-footer-split">
      <div className="modal-footer-left">{activeLoading ? <span className="modal-footer-loading">Loading...</span> : null}</div>
      <div className="modal-footer-right">
        <label className="modal-footer-refresh">
          <span>Refresh (s)</span>
          <input
            type="number"
            min={0.1}
            max={5}
            step={0.1}
            value={activeInterval.toFixed(1)}
            onChange={(event) => {
              void sensorInfoService.setInterval(state.activeTab, Number(event.target.value));
            }}
          />
        </label>
      </div>
    </div>
  );
}

function InfoModal({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const telemetryService = getTelemetryService(runtime);
  const sensorInfoService = runtime.services.getService<SensorInfoService>(SENSOR_INFO_SERVICE_ID);
  let connectionService: ConnectionService | null = null;
  try {
    connectionService = runtime.services.getService<ConnectionService>(CONNECTION_SERVICE_ID);
  } catch {
    connectionService = null;
  }
  const [state, setState] = useState(sensorInfoService.getState());
  const [telemetry, setTelemetry] = useState<TelemetrySnapshot | null>(
    telemetryService ? telemetryService.getSnapshot() : null
  );
  const [connectionState, setConnectionState] = useState<ConnectionState | null>(
    connectionService ? connectionService.getState() : null
  );

  useEffect(() => sensorInfoService.subscribe((next) => setState(next)), [sensorInfoService]);
  useEffect(() => {
    if (!telemetryService) return;
    return telemetryService.subscribeTelemetry((next) => setTelemetry(next));
  }, [telemetryService]);
  useEffect(() => {
    if (!connectionService) return;
    return connectionService.subscribe((next) => setConnectionState(next));
  }, [connectionService]);

  useEffect(() => {
    void sensorInfoService.open();
    return () => {
      void sensorInfoService.close();
    };
  }, [sensorInfoService]);

  const changeTab = (tab: SensorInfoTab): void => {
    void sensorInfoService.setActiveTab(tab);
  };

  const activePayload = state.payloads[state.activeTab] as Record<string, unknown> | undefined;
  const activeSnapshot = (activePayload?.snapshot ?? {}) as Record<string, unknown>;
  const activeError = state.errors[state.activeTab];
  const topicRows = state.topics.catalog.filter((entry) =>
    entry.name.toLowerCase().includes(state.topics.search.trim().toLowerCase())
  );
  const selectedTopicMeta = state.topics.catalog.find((entry) => entry.name === state.topics.selectedTopic) ?? null;
  const topicsPayload = state.payloads.topics as Record<string, unknown> | undefined;
  const topicsSnapshot = (topicsPayload?.snapshot ?? {}) as Record<string, unknown>;
  const topicsSnapshotError = String(topicsSnapshot.error ?? "").trim();
  const connected = connectionState ? connectionState.connected : true;
  const showDisconnected = !connected && state.implemented[state.activeTab];

  return (
    <div className="stack info-modal-root">
      <div className="modal-tabs">
        {(["general", "topics", "pixhawk_gps", "lidar", "camera"] as SensorInfoTab[]).map((tab) => (
          <button
            key={tab}
            type="button"
            className={`modal-tab ${state.activeTab === tab ? "active" : ""}`}
            onClick={() => changeTab(tab)}
          >
            {tab === "pixhawk_gps" ? "Pixhawk/GPS" : tab[0].toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>
      {activeError ? <div className="status-pill bad">Error: {activeError}</div> : null}
      {showDisconnected ? (
        <div className="panel-card info-placeholder-card">
          <strong>{state.activeTab === "pixhawk_gps" ? "Pixhawk/GPS" : state.activeTab[0].toUpperCase() + state.activeTab.slice(1)}</strong>
          <p className="muted">Conecta el WebSocket para consultar informacion de sensores.</p>
        </div>
      ) : null}
      {!showDisconnected && state.loading[state.activeTab] && !activePayload ? (
        <div className="panel-card info-placeholder-card">
          <strong>Cargando...</strong>
          <p className="muted">Esperando datos del backend.</p>
        </div>
      ) : null}
      {!showDisconnected && (!state.loading[state.activeTab] || activePayload) && state.activeTab === "general" ? (
        <div className="info-card-grid">
          <div className="panel-card">
            <h4>General</h4>
            <div className="key-value-grid">
              <span>Robot mode</span>
              <span>{telemetry?.robotStatus.mode ?? "unknown"}</span>
              <span>Battery</span>
              <span>{telemetry ? `${Number(telemetry.robotStatus.batteryPct).toFixed(1)}%` : "n/a"}</span>
              <span>GPS fix</span>
              <span>{String((activeSnapshot.gps_meta as Record<string, unknown> | undefined)?.fix_type_name ?? "UNKNOWN")}</span>
              <span>Precision</span>
              <span>{formatInfoNumber((activeSnapshot.gps_meta as Record<string, unknown> | undefined)?.estimated_precision_m, 2)} m</span>
              <span>RTK source</span>
              <span>
                {String(
                  (activeSnapshot.rtk_source_state as Record<string, unknown> | undefined)?.active_source_label ??
                    (activeSnapshot.rtk_source_state as Record<string, unknown> | undefined)?.active_source_id ??
                    "n/a"
                )}
              </span>
            </div>
          </div>
          <div className="panel-card">
            <h4>Datum</h4>
            <div className="key-value-grid">
              <span>Status</span>
              <span>{(activeSnapshot.datum as Record<string, unknown> | undefined)?.already_set === true ? "set" : "unset"}</span>
              <span>Latitude</span>
              <span>{formatInfoCoordinate((activeSnapshot.datum as Record<string, unknown> | undefined)?.datum_lat)}</span>
              <span>Longitude</span>
              <span>{formatInfoCoordinate((activeSnapshot.datum as Record<string, unknown> | undefined)?.datum_lon)}</span>
              <span>Source</span>
              <span>{String((activeSnapshot.datum as Record<string, unknown> | undefined)?.last_set_source ?? "n/a")}</span>
              <span>Last set</span>
              <span>{formatInfoTimestamp((activeSnapshot.datum as Record<string, unknown> | undefined)?.last_set_epoch_ms)}</span>
            </div>
          </div>
          <div className="panel-card">
            <h4>RTK Source</h4>
            <div className="key-value-grid">
              <span>Connected</span>
              <span>{(activeSnapshot.rtk_source_state as Record<string, unknown> | undefined)?.connected === true ? "yes" : "no"}</span>
              <span>Label</span>
              <span>{String((activeSnapshot.rtk_source_state as Record<string, unknown> | undefined)?.active_source_label ?? "n/a")}</span>
              <span>RTCM age</span>
              <span>{formatInfoNumber((activeSnapshot.rtk_source_state as Record<string, unknown> | undefined)?.rtcm_age_s, 1)} s</span>
              <span>Received count</span>
              <span>{formatInfoNumber((activeSnapshot.rtk_source_state as Record<string, unknown> | undefined)?.received_count, 0)}</span>
              <span>Last error</span>
              <span>{String((activeSnapshot.rtk_source_state as Record<string, unknown> | undefined)?.last_error ?? "none")}</span>
            </div>
          </div>
        </div>
      ) : null}
      {!showDisconnected && (!state.loading[state.activeTab] || activePayload) && state.activeTab === "topics" ? (
        <div className="stack info-modal-topics">
          {topicsSnapshotError ? <div className="status-pill bad">{topicsSnapshotError}</div> : null}
          {state.topics.truncated ? <div className="status-pill">Historial truncado por limites de memoria.</div> : null}
          <div className="info-topics-layout">
            <div className="info-topics-sidebar">
              <input
                value={state.topics.search}
                onChange={(event) => {
                  sensorInfoService.setTopicSearch(event.target.value);
                }}
                placeholder="Buscar topic..."
              />
              <ul className="info-topics-list">
              {topicRows.map((entry) => (
                <li key={entry.name} className="feed-item">
                  <button
                    type="button"
                    className={entry.name === state.topics.selectedTopic ? "active" : ""}
                    onClick={() => {
                      void sensorInfoService.selectTopic(entry.name);
                    }}
                  >
                    {entry.name}
                  </button>
                  <div className="muted">
                    pub={entry.publisherCount} · sub={entry.subscriberCount}
                  </div>
                </li>
              ))}
              {topicRows.length === 0 ? <li className="feed-item muted">No hay topics.</li> : null}
              </ul>
            </div>
            <div className="panel-card info-topics-content">
              <div className="info-topics-content-header">
                <strong>{state.topics.selectedTopic || "Topics stream"}</strong>
                <div className="info-topics-selected-meta">
                  {state.topics.selectedType ? (
                    <span className="info-topics-selected-badge">{state.topics.selectedType}</span>
                  ) : null}
                  <span className="info-topics-selected-badge">
                    {selectedTopicMeta
                      ? `pub=${selectedTopicMeta.publisherCount} · sub=${selectedTopicMeta.subscriberCount}`
                      : "pub=n/a · sub=n/a"}
                  </span>
                </div>
              </div>
              <pre className="code-block info-topics-stream">
                {state.topics.historyText || "Selecciona un topic para ver su stream en tiempo real."}
              </pre>
              <div className="row">
                <button
                  type="button"
                  disabled={!state.topics.historyText}
                  onClick={async () => {
                    if (typeof navigator === "undefined" || !navigator.clipboard) return;
                    await navigator.clipboard.writeText(state.topics.historyText);
                    runtime.eventBus.emit("console.event", {
                      level: "info",
                      text: "Topic history copied",
                      timestamp: Date.now()
                    });
                  }}
                >
                  Copy
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
      {!showDisconnected && (!state.loading[state.activeTab] || activePayload) && state.activeTab === "pixhawk_gps" ? (
        <div className="info-card-grid info-card-grid-pixhawk selectable">
          <div className="panel-card">
            <h4>IMU (EKF)</h4>
            <div className="key-value-grid">
              <span>q.w</span>
              <span>{formatInfoNumber(((activeSnapshot.imu as Record<string, unknown> | undefined)?.orientation as Record<string, unknown> | undefined)?.w, 4)}</span>
              <span>q.x</span>
              <span>{formatInfoNumber(((activeSnapshot.imu as Record<string, unknown> | undefined)?.orientation as Record<string, unknown> | undefined)?.x, 4)}</span>
              <span>q.y</span>
              <span>{formatInfoNumber(((activeSnapshot.imu as Record<string, unknown> | undefined)?.orientation as Record<string, unknown> | undefined)?.y, 4)}</span>
              <span>q.z</span>
              <span>{formatInfoNumber(((activeSnapshot.imu as Record<string, unknown> | undefined)?.orientation as Record<string, unknown> | undefined)?.z, 4)}</span>
              <span>yaw ENU</span>
              <span>{formatInfoNumber((activeSnapshot.imu as Record<string, unknown> | undefined)?.yaw_enu_deg, 2)} deg</span>
            </div>
          </div>
          <div className="panel-card">
            <h4>GPS</h4>
            <div className="key-value-grid">
              <span>lat</span>
              <span>{formatInfoCoordinate((activeSnapshot.gps as Record<string, unknown> | undefined)?.latitude)}</span>
              <span>lon</span>
              <span>{formatInfoCoordinate((activeSnapshot.gps as Record<string, unknown> | undefined)?.longitude)}</span>
              <span>alt</span>
              <span>{formatInfoNumber((activeSnapshot.gps as Record<string, unknown> | undefined)?.altitude, 2)} m</span>
              <span>fix</span>
              <span>{String((activeSnapshot.gps_meta as Record<string, unknown> | undefined)?.fix_type_name ?? "n/a")}</span>
              <span>rtk status</span>
              <span>{String((activeSnapshot.gps_meta as Record<string, unknown> | undefined)?.rtk_status ?? "n/a")}</span>
              <span>satellites</span>
              <span>{formatInfoNumber((activeSnapshot.gps_meta as Record<string, unknown> | undefined)?.satellites_visible, 0)}</span>
            </div>
          </div>
          <div className="panel-card">
            <h4>Velocity</h4>
            <div className="key-value-grid">
              <span>vx</span>
              <span>{formatInfoNumber(((activeSnapshot.velocity as Record<string, unknown> | undefined)?.linear as Record<string, unknown> | undefined)?.x, 3)} m/s</span>
              <span>vy</span>
              <span>{formatInfoNumber(((activeSnapshot.velocity as Record<string, unknown> | undefined)?.linear as Record<string, unknown> | undefined)?.y, 3)} m/s</span>
              <span>vz</span>
              <span>{formatInfoNumber(((activeSnapshot.velocity as Record<string, unknown> | undefined)?.linear as Record<string, unknown> | undefined)?.z, 3)} m/s</span>
              <span>yaw rate</span>
              <span>{formatInfoNumber(((activeSnapshot.velocity as Record<string, unknown> | undefined)?.angular as Record<string, unknown> | undefined)?.z, 3)} rad/s</span>
            </div>
          </div>
          <div className="panel-card">
            <h4>Odometry (EKF)</h4>
            <div className="key-value-grid">
              <span>x</span>
              <span>{formatInfoNumber(((activeSnapshot.odom as Record<string, unknown> | undefined)?.position as Record<string, unknown> | undefined)?.x, 3)} m</span>
              <span>y</span>
              <span>{formatInfoNumber(((activeSnapshot.odom as Record<string, unknown> | undefined)?.position as Record<string, unknown> | undefined)?.y, 3)} m</span>
              <span>z</span>
              <span>{formatInfoNumber(((activeSnapshot.odom as Record<string, unknown> | undefined)?.position as Record<string, unknown> | undefined)?.z, 3)} m</span>
              <span>yaw ENU</span>
              <span>{formatInfoNumber((activeSnapshot.odom as Record<string, unknown> | undefined)?.yaw_enu_deg, 2)} deg</span>
            </div>
          </div>
          <div className="panel-card">
            <h4>Yaw Diagnostics</h4>
            <div className="key-value-grid">
              <span>Delta yaw</span>
              <span>{formatInfoNumber((activeSnapshot.diagnostics as Record<string, unknown> | undefined)?.yaw_delta_deg, 2)} deg</span>
              <span>Diferencias</span>
              <span>{formatInfoNumber((activeSnapshot.diagnostics as Record<string, unknown> | undefined)?.diferencias, 3)}</span>
              <span>ENU convention</span>
              <span>0°=E, 90°=N</span>
            </div>
          </div>
          <div className="panel-card">
            <h4>Topic Bindings</h4>
            <div className="key-value-grid">
              <span>IMU</span>
              <span>{String((activeSnapshot.topics as Record<string, unknown> | undefined)?.imu ?? "--")}</span>
              <span>GPS</span>
              <span>{String((activeSnapshot.topics as Record<string, unknown> | undefined)?.gps ?? "--")}</span>
              <span>Velocity</span>
              <span>{String((activeSnapshot.topics as Record<string, unknown> | undefined)?.velocity ?? "--")}</span>
              <span>Odom</span>
              <span>{String((activeSnapshot.topics as Record<string, unknown> | undefined)?.odom ?? "--")}</span>
            </div>
          </div>
        </div>
      ) : null}
      {!showDisconnected && (!state.loading[state.activeTab] || activePayload) && state.activeTab === "lidar" ? (
        <div className="panel-card">
          <strong>LiDAR</strong>
          <p className="muted">
            {state.implemented.lidar ? "LiDAR telemetry available" : "No LiDAR stream attached in this environment."}
          </p>
        </div>
      ) : null}
      {!showDisconnected && (!state.loading[state.activeTab] || activePayload) && state.activeTab === "camera" ? (
        <div className="panel-card">
          <strong>Camera</strong>
          <p className="muted">
            {state.implemented.camera
              ? "Camera telemetry stream enabled via set_sensor_info_view."
              : "PTZ control path: service.navigation → dispatcher.robot → transport.ws.core"}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function registerTransport(ctx: ModuleContext): void {
  const transport = new WebSocketTransport(TRANSPORT_ID, ({ env }) => env.wsUrl);
  ctx.transports.registerTransport({
    id: transport.id,
    transport
  });
}

function registerDispatcher(ctx: ModuleContext): RobotDispatcher {
  const dispatcher = new RobotDispatcher(DISPATCHER_ID, TRANSPORT_ID);
  ctx.dispatchers.registerDispatcher({
    id: dispatcher.id,
    dispatcher
  });
  return dispatcher;
}

function registerServices(ctx: ModuleContext, dispatcher: RobotDispatcher): NavigationService {
  const config = readNav2Config(ctx);
  const limits = parseManualSpeedLimits(config);
  const defaultSteeringAngleDeg = parseDefaultSteeringAngleDeg(config, limits);
  const navigationService = new NavigationService(dispatcher, {
    linearMin: limits.linearMin,
    linearMax: limits.linearMax,
    steeringAngleMinDeg: limits.steeringAngleMinDeg,
    steeringAngleMaxDeg: limits.steeringAngleMaxDeg,
    linearSpeed: parseNumberInRange(config.manual_linear_speed_default, 1.2, limits.linearMin, limits.linearMax),
    steeringAngleDeg: defaultSteeringAngleDeg,
    loopIntervalMs: parseLoopIntervalMs(config.manual_loop_interval_ms, 50)
  });
  ctx.services.registerService({
    id: NAVIGATION_SERVICE_ID,
    service: navigationService
  });

  const connectionService = new ConnectionService(
    ctx.transportManager,
    ctx.env,
    dispatcher.transportId,
    ctx.eventBus,
    buildConnectionPresetDefaults(ctx, config)
  );
  ctx.services.registerService({
    id: CONNECTION_SERVICE_ID,
    service: connectionService
  });
  ctx.eventBus.on<{ packageId?: unknown; config?: unknown }>(CORE_EVENTS.packageConfigUpdated, (payload) => {
    const packageId = typeof payload?.packageId === "string" ? payload.packageId : "";
    if (packageId !== "nav2") return;
    const nextConfig = (payload.config ?? {}) as Nav2RuntimeConfig;
    const nextLimits = parseManualSpeedLimits(nextConfig);
    const nextDefaultSteeringAngleDeg = parseDefaultSteeringAngleDeg(nextConfig, nextLimits);
    connectionService.applyPresetDefaults(buildConnectionPresetDefaults(ctx, nextConfig));
    navigationService.applyRuntimeDefaults({
      linearMin: nextLimits.linearMin,
      linearMax: nextLimits.linearMax,
      steeringAngleMinDeg: nextLimits.steeringAngleMinDeg,
      steeringAngleMaxDeg: nextLimits.steeringAngleMaxDeg,
      linearSpeed: parseNumberInRange(nextConfig.manual_linear_speed_default, 1.2, nextLimits.linearMin, nextLimits.linearMax),
      steeringAngleDeg: nextDefaultSteeringAngleDeg,
      loopIntervalMs: parseLoopIntervalMs(nextConfig.manual_loop_interval_ms, 50)
    });
  });

  const sensorInfoService = new SensorInfoService(dispatcher);
  ctx.services.registerService({
    id: SENSOR_INFO_SERVICE_ID,
    service: sensorInfoService
  });

  return navigationService;
}

function registerSidebarPanels(ctx: ModuleContext): void {
  ctx.contributions.register({
    id: "sidebar.connection",
    slot: "sidebar",
    label: "Connection",
    icon: "🔌",
    render: () => <ConnectionSidebarPanel runtime={ctx} />
  });
  ctx.contributions.register({
    id: "sidebar.navigation",
    slot: "sidebar",
    label: "Navigation",
    icon: "🧭",
    render: () => <NavigationSidebarPanel runtime={ctx} />
  });
}

function registerModals(ctx: ModuleContext): void {
  ctx.contributions.register({
    id: "modal.snapshot",
    slot: "modal",
    title: "Navigation Snapshot",
    render: () => <SnapshotModal runtime={ctx} />,
    renderFooter: () => <SnapshotModalFooter runtime={ctx} />
  });
  ctx.contributions.register({
    id: "modal.info",
    slot: "modal",
    title: "Info",
    render: () => <InfoModal runtime={ctx} />,
    renderFooter: () => <InfoModalFooter runtime={ctx} />
  });
}

function registerFooterItems(ctx: ModuleContext): void {
  ctx.contributions.register({
    id: "footer.connection-status",
    slot: "footer",
    beforeId: "core.footer.metrics",
    render: () => <ConnectionStatusFooterItem runtime={ctx} />
  });
}

function registerCommands(ctx: ModuleContext, navigationService: NavigationService): void {
  ctx.commands.register(
    { id: NavigationCommands.openSnapshotModal, title: "Open Snapshot Modal", category: "Navigation" },
    () => {
      void ctx.commands.execute(ShellCommands.openModal, "modal.snapshot");
    }
  );

  ctx.commands.register(
    { id: NavigationCommands.captureSnapshot, title: "Capture Snapshot", category: "Navigation" },
    () => {
      void ctx.commands.execute(ShellCommands.openModal, "modal.snapshot");
      navigationService.requestSnapshot().then(() => {
        ctx.eventBus.emit("console.event", {
          level: "info",
          text: "Snapshot captured (hotkey)",
          timestamp: Date.now()
        });
      }).catch((error: unknown) => {
        const message = String(error);
        if (message.toLowerCase().includes("camera disabled in current preset")) {
          ctx.eventBus.emit("console.event", {
            level: "info",
            text: "Snapshot no disponible para el preset de conexión actual.",
            timestamp: Date.now()
          });
          return;
        }
        ctx.eventBus.emit("console.event", {
          level: "error",
          text: `Snapshot capture failed: ${message}`,
          timestamp: Date.now()
        });
      });
    }
  );

  ctx.commands.register(
    { id: NavigationCommands.openInfoModal, title: "Open Info Modal", category: "Navigation" },
    () => {
      void ctx.commands.execute(ShellCommands.openModal, "modal.info");
    }
  );

  ctx.commands.register(
    { id: NavigationCommands.swapWorkspace, title: "Swap Workspace", category: "Navigation" },
    () => {
      ctx.eventBus.emit(NAV_EVENTS.swapWorkspaceRequest, {});
    }
  );

  ctx.commands.register(
    { id: NavigationCommands.toggleGoalMode, title: "Toggle Goal Mode", category: "Navigation" },
    () => {
      const enabled = navigationService.toggleGoalMode();
      ctx.eventBus.emit("console.event", {
        level: "info",
        text: enabled ? "Goal mode enabled (hotkey)" : "Goal mode disabled (hotkey)",
        timestamp: Date.now()
      });
    }
  );

  ctx.commands.register(
    { id: NavigationCommands.toggleManualMode, title: "Toggle Manual Mode", category: "Navigation" },
    () => {
      const current = navigationService.getState().manualMode;
      void navigationService.setManualMode(!current).then(() => {
        ctx.eventBus.emit("console.event", {
          level: "info",
          text: !current ? "Manual mode enabled (hotkey)" : "Manual mode disabled (hotkey)",
          timestamp: Date.now()
        });
      }).catch((error: unknown) => {
        ctx.eventBus.emit("console.event", {
          level: "error",
          text: `Manual mode hotkey failed: ${String(error)}`,
          timestamp: Date.now()
        });
      });
    }
  );

  ctx.commands.register(
    { id: NavigationCommands.toggleCameraZoom, title: "Toggle Camera Zoom", category: "Navigation" },
    () => { void navigationService.toggleCameraZoom(); }
  );

  const manualKeys: Array<[string, string, "w" | "a" | "s" | "d", boolean]> = [
    [NavigationCommands.manualKeyWDown, "Manual W Down", "w", true],
    [NavigationCommands.manualKeyWUp,   "Manual W Up",   "w", false],
    [NavigationCommands.manualKeyADown, "Manual A Down", "a", true],
    [NavigationCommands.manualKeyAUp,   "Manual A Up",   "a", false],
    [NavigationCommands.manualKeySDown, "Manual S Down", "s", true],
    [NavigationCommands.manualKeySUp,   "Manual S Up",   "s", false],
    [NavigationCommands.manualKeyDDown, "Manual D Down", "d", true],
    [NavigationCommands.manualKeyDUp,   "Manual D Up",   "d", false],
  ];
  for (const [id, title, key, pressed] of manualKeys) {
    ctx.commands.register({ id, title, category: "Navigation" }, () => {
      navigationService.setManualKeyState(key, pressed);
    });
  }

  ctx.commands.register(
    { id: NavigationCommands.manualBrakeDown, title: "Manual Brake Down", category: "Navigation" },
    () => { navigationService.setManualBrakeHeld(true); }
  );
  ctx.commands.register(
    { id: NavigationCommands.manualBrakeUp, title: "Manual Brake Up", category: "Navigation" },
    () => { navigationService.setManualBrakeHeld(false); }
  );

  const cameraCommands: Array<[string, string, number]> = [
    [NavigationCommands.panCameraUp,    "Pan Camera Up",    0],
    [NavigationCommands.panCameraDown,  "Pan Camera Down",  180],
    [NavigationCommands.panCameraLeft,  "Pan Camera Left",  90],
    [NavigationCommands.panCameraRight, "Pan Camera Right", -90],
  ];
  for (const [id, title, angle] of cameraCommands) {
    ctx.commands.register({ id, title, category: "Navigation" }, () => {
      void navigationService.panCamera(angle);
    });
  }

  ctx.commands.register(
    { id: NavigationCommands.dismissEscape, title: "Dismiss (Escape)", category: "Navigation" },
    () => {
      if (navigationService.getState().goalMode) {
        navigationService.toggleGoalMode();
        ctx.eventBus.emit("console.event", {
          level: "info",
          text: "Goal mode disabled (Esc)",
          timestamp: Date.now()
        });
      }
    }
  );

  ctx.commands.register(
    { id: NavigationCommands.downloadSnapshot, title: "Download Snapshot", category: "Navigation" },
    () => { ctx.eventBus.emit(NAV_EVENTS.snapshotDownloadRequest, {}); }
  );

  // Keybindings
  ctx.keybindings.register({ key: "q", commandId: NavigationCommands.captureSnapshot, source: "default" });
  ctx.keybindings.register({ key: "i", commandId: NavigationCommands.openInfoModal, source: "default", when: "!modalOpen" });
  ctx.keybindings.register({ key: "e", commandId: NavigationCommands.swapWorkspace, source: "default", when: "!modalOpen" });
  ctx.keybindings.register({ key: "f", commandId: NavigationCommands.toggleGoalMode, source: "default", when: "!modalOpen" });
  ctx.keybindings.register({ key: "m", commandId: NavigationCommands.toggleManualMode, source: "default", when: "!modalOpen" });
  ctx.keybindings.register({ key: "-", commandId: NavigationCommands.toggleCameraZoom, source: "default", when: "!modalOpen" });
  ctx.keybindings.register({ key: "w", commandId: NavigationCommands.manualKeyWDown, source: "default", when: "!modalOpen" });
  ctx.keybindings.register({ key: "a", commandId: NavigationCommands.manualKeyADown, source: "default", when: "!modalOpen" });
  ctx.keybindings.register({ key: "s", commandId: NavigationCommands.manualKeySDown, source: "default", when: "!modalOpen" });
  ctx.keybindings.register({ key: "d", commandId: NavigationCommands.manualKeyDDown, source: "default", when: "!modalOpen" });
  ctx.keybindings.register({ key: "space", commandId: NavigationCommands.manualBrakeDown, source: "default", when: "!modalOpen" });
  ctx.keybindings.register({ key: "w:up", commandId: NavigationCommands.manualKeyWUp, source: "default" });
  ctx.keybindings.register({ key: "a:up", commandId: NavigationCommands.manualKeyAUp, source: "default" });
  ctx.keybindings.register({ key: "s:up", commandId: NavigationCommands.manualKeySUp, source: "default" });
  ctx.keybindings.register({ key: "d:up", commandId: NavigationCommands.manualKeyDUp, source: "default" });
  ctx.keybindings.register({ key: "space:up", commandId: NavigationCommands.manualBrakeUp, source: "default" });
  ctx.keybindings.register({ key: "up", commandId: NavigationCommands.panCameraUp, source: "default", when: "!modalOpen" });
  ctx.keybindings.register({ key: "down", commandId: NavigationCommands.panCameraDown, source: "default", when: "!modalOpen" });
  ctx.keybindings.register({ key: "left", commandId: NavigationCommands.panCameraLeft, source: "default", when: "!modalOpen" });
  ctx.keybindings.register({ key: "right", commandId: NavigationCommands.panCameraRight, source: "default", when: "!modalOpen" });
  ctx.keybindings.register({ key: "escape", commandId: NavigationCommands.dismissEscape, source: "default", when: "!modalOpen", weight: -1 });
}

export function createNavigationModule(): CockpitModule {
  return {
    id: "navigation",
    version: "1.2.0",
    enabledByDefault: true,
    register(ctx: ModuleContext): void {
      registerTransport(ctx);
      const dispatcher = registerDispatcher(ctx);
      const navigationService = registerServices(ctx, dispatcher);
      registerCommands(ctx, navigationService);
      registerSidebarPanels(ctx);
      registerModals(ctx);
      registerFooterItems(ctx);
    }
  };
}
