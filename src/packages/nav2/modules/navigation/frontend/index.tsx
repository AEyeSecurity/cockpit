import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode, type WheelEvent } from "react";
import "./styles.css";
import { PanelCollapsibleSection, PanelSection } from "../../../../core";
import { CORE_EVENTS, NAV_EVENTS } from "../../../../../core/events/topics";
import type { CockpitModule, ModuleContext } from "../../../../../core/types/module";
import { RobotDispatcher } from "../dispatcher/impl/RobotDispatcher";
import { ConnectionService, type ConnectionState } from "../service/impl/ConnectionService";
import { DIALOG_SERVICE_ID, type DialogService } from "../../../../core/modules/runtime/service/impl/DialogService";
import { MapService, type DatumProfilesState, type MapWorkspaceState } from "../../map/service/impl/MapService";
import { SensorInfoService, type SensorInfoTab } from "../service/impl/SensorInfoService";
import type { RtkSourceDraft, TelemetrySnapshot } from "../../telemetry/service/impl/TelemetryService";
import { NavigationService, type NavigationState, type SnapshotData } from "../service/impl/NavigationService";
import { getPatrolProfileReadiness } from "../patrolProfileReadiness";
import {
  getRouteMissionActivityState,
  getRouteRecoveryPresentation,
  normalizeRouteMissionStatus
} from "../routeMissionActivity";
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
  rtk_default_source_id?: unknown;
  rtk_default_source_label?: unknown;
  manual_linear_speed_min?: unknown;
  manual_linear_speed_max?: unknown;
  manual_linear_speed_default?: unknown;
  manual_steering_angle_min_deg?: unknown;
  manual_steering_angle_max_deg?: unknown;
  manual_steering_angle_default_deg?: unknown;
  manual_loop_interval_ms?: unknown;
}

interface ManualSpeedLimits {
  linearMin: number;
  linearMax: number;
  steeringAngleMinDeg: number;
  steeringAngleMaxDeg: number;
}

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

function parseManualSpeedLimits(config: Nav2RuntimeConfig): ManualSpeedLimits {
  const linearMinCandidate = Number(config.manual_linear_speed_min);
  const linearMaxCandidate = Number(config.manual_linear_speed_max);
  const steeringAngleMinCandidate = Number(config.manual_steering_angle_min_deg);
  const steeringAngleMaxCandidate = Number(config.manual_steering_angle_max_deg);
  const linearMin = Number.isFinite(linearMinCandidate) ? linearMinCandidate : 1.0;
  const linearMax = Number.isFinite(linearMaxCandidate) ? linearMaxCandidate : 4.0;
  const steeringAngleMin = Number.isFinite(steeringAngleMinCandidate) ? steeringAngleMinCandidate : 1.0;
  const steeringAngleMax = Number.isFinite(steeringAngleMaxCandidate) ? steeringAngleMaxCandidate : 30.0;
  return {
    linearMin: linearMax > linearMin ? linearMin : 1.0,
    linearMax: linearMax > linearMin ? linearMax : 4.0,
    steeringAngleMinDeg: steeringAngleMax > steeringAngleMin ? steeringAngleMin : 1.0,
    steeringAngleMaxDeg: steeringAngleMax > steeringAngleMin ? steeringAngleMax : 30.0
  };
}

function buildConnectionPresetDefaults(ctx: ModuleContext, config: Nav2RuntimeConfig): {
  real: { host: string; port: string };
  sim: { host: string; port: string };
} {
  const wsRealHostFallback = ctx.env.wsRealHost ?? "localhost";
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
  selectRtkSource: (sourceId: string) => Promise<void>;
  upsertRtkSource: (source: RtkSourceDraft) => Promise<void>;
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

function formatRouteStatus(status: string): string {
  const normalized = normalizeRouteMissionStatus(status);
  if (!normalized || normalized === "idle") return "Idle";
  if (normalized === "route starting") return "Starting route";
  if (normalized.startsWith("route active")) return "Following route";
  if (normalized === "route completed") return "Route complete";
  if (normalized === "route cancelled") return "Route cancelled";
  if (normalized === "route paused by manual takeover") return "Paused by manual";
  if (normalized.startsWith("route failed")) return "Route error";
  return status.trim();
}

function routeTone(
  routeMission: NavigationState["routeMission"],
  goalActive = false
): "active" | "paused" | "done" | "error" | "idle" {
  const activity = getRouteMissionActivityState(routeMission, goalActive);
  const recovery = getRouteRecoveryPresentation(routeMission.blockedState);
  if (routeMission.returnHomeActive) return "active";
  if (routeMission.returnHomeRequested) return "paused";
  if (recovery.active) return recovery.tone;
  const status = normalizeRouteMissionStatus(routeMission.status);
  if (routeMission.paused || status.includes("paused")) return "paused";
  if (status.includes("failed") || status.includes("abort")) return "error";
  if (status.includes("completed")) return "done";
  if (status.includes("cancelled")) return "idle";
  if (activity.running || status.includes("active") || status.includes("starting")) return "active";
  return "idle";
}

function formatBlockedStatusTitle(routeMission: NavigationState["routeMission"]): string {
  return getRouteRecoveryPresentation(routeMission.blockedState).title;
}

function formatBlockedStatusDetail(routeMission: NavigationState["routeMission"]): string {
  const reason = routeMission.blockedReasonText || routeMission.blockedReasonCode || "obstacle or path blockage";
  const retryMax = Math.max(0, Math.round(routeMission.blockedRetryMaxAttempts));
  const retryAttempt = Math.max(0, Math.round(routeMission.blockedRetryAttempt));
  const retryText = retryMax > 0 ? `retry ${Math.min(retryAttempt + 1, retryMax)}/${retryMax}` : "";
  const wait = Math.max(0, Number(routeMission.blockedWaitRemainingS));
  const waitText = routeMission.blockedState === "WAITING_RETRY" && wait > 0 ? `${Math.ceil(wait)}s` : "";
  return [reason, retryText, waitText].filter((entry) => entry.length > 0).join(" · ");
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
  const activity = getRouteMissionActivityState(routeMission, telemetry?.goalActive === true);
  const tone = routeTone(routeMission, telemetry?.goalActive === true);
  const expandedCount = Math.max(0, Math.round(routeMission.expandedWaypointCount));
  const status = normalizeRouteMissionStatus(routeMission.status);
  const startIndex = Math.max(0, Math.round(routeMission.currentStartIndex));
  const routeProgressCount =
    expandedCount > 0
      ? status.includes("completed")
        ? expandedCount
        : Math.min(expandedCount, startIndex)
      : 0;
  const progressPct = expandedCount > 0 ? Math.min(100, Math.max(0, (routeProgressCount / expandedCount) * 100)) : 0;
  const hasRouteHistory = activity.hasHistory;
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

  if (routeMission.returnHomeActive) {
    return {
      title: "Returning HOME",
      detail: routeMission.lowBatteryActive ? "Low battery latched" : "Return-home mission",
      tone,
      progressPct,
      showProgress: expandedCount > 0,
      segmentText,
      routeMetaText
    };
  }

  if (routeMission.returnHomeRequested) {
    return {
      title: "Return HOME requested",
      detail: routeMission.homeAvailable ? "Finishing current segment before HOME" : "HOME unavailable",
      tone,
      progressPct,
      showProgress: expandedCount > 0,
      segmentText,
      routeMetaText
    };
  }

  if (getRouteRecoveryPresentation(routeMission.blockedState).active) {
    return {
      title: formatBlockedStatusTitle(routeMission) || formatRouteStatus(routeMission.status),
      detail: formatBlockedStatusDetail(routeMission),
      tone,
      progressPct,
      showProgress: expandedCount > 0,
      segmentText,
      routeMetaText
    };
  }

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
      title: tone === "paused" ? "Route paused" : activity.running && tone === "active" ? "Following route" : formatRouteStatus(routeMission.status),
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

function joinClassNames(...values: Array<string | false | undefined>): string {
  return values.filter(Boolean).join(" ");
}

type NavGlyphKind =
  | "connect"
  | "disconnect"
  | "goal"
  | "manual"
  | "addWaypoint"
  | "undo"
  | "clear"
  | "remove"
  | "dispatch"
  | "route"
  | "cancel"
  | "save"
  | "load"
  | "snapshot"
  | "gpsFix"
  | "pin"
  | "home"
  | "refresh";

function NavGlyph({ kind }: { kind: NavGlyphKind }): JSX.Element {
  const baseProps = {
    viewBox: "0 0 24 24",
    width: 15,
    height: 15,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const
  };

  switch (kind) {
    case "connect":
      return (
        <svg {...baseProps}>
          <path d="M8 8V4" />
          <path d="M16 8V4" />
          <path d="M7 12h10" />
          <path d="M9 12v2a3 3 0 0 0 6 0v-2" />
          <path d="M12 17v3" />
        </svg>
      );
    case "disconnect":
      return (
        <svg {...baseProps}>
          <path d="M8 8V4" />
          <path d="M16 8V4" />
          <path d="M7 12h10" />
          <path d="M9 12v2a3 3 0 0 0 6 0v-2" />
          <path d="M5 19 19 5" />
        </svg>
      );
    case "goal":
      return (
        <svg {...baseProps}>
          <circle cx="12" cy="12" r="6.5" />
          <circle cx="12" cy="12" r="2.5" />
          <path d="M12 3v2.5" />
        </svg>
      );
    case "manual":
      return (
        <svg {...baseProps}>
          <path d="M12 4v5" />
          <path d="M12 15v5" />
          <path d="M4 12h5" />
          <path d="M15 12h5" />
          <circle cx="12" cy="12" r="2.2" />
        </svg>
      );
    case "addWaypoint":
      return (
        <svg {...baseProps}>
          <path d="M12 5v14" />
          <path d="M5 12h14" />
          <circle cx="12" cy="12" r="7" opacity="0.35" />
        </svg>
      );
    case "undo":
      return (
        <svg {...baseProps}>
          <path d="M9 8 5 12l4 4" />
          <path d="M6 12h7a5 5 0 1 1 0 10" />
        </svg>
      );
    case "clear":
      return (
        <svg {...baseProps}>
          <path d="M4 7h16" />
          <path d="M9 7V5.5h6V7" />
          <path d="m7 7 1 11h8l1-11" />
        </svg>
      );
    case "remove":
      return (
        <svg {...baseProps}>
          <path d="M7 7l10 10" />
          <path d="M17 7 7 17" />
        </svg>
      );
    case "dispatch":
      return (
        <svg {...baseProps}>
          <path d="M5 12h12" />
          <path d="m13 6 6 6-6 6" />
        </svg>
      );
    case "route":
      return (
        <svg {...baseProps}>
          <circle cx="6" cy="17" r="1.8" />
          <circle cx="12" cy="7" r="1.8" />
          <circle cx="18" cy="13" r="1.8" />
          <path d="M7.5 15.8 10.5 8.4" />
          <path d="m13.5 8.2 3 3.6" />
        </svg>
      );
    case "cancel":
      return (
        <svg {...baseProps}>
          <circle cx="12" cy="12" r="7" />
          <path d="M9 9l6 6" />
          <path d="M15 9 9 15" />
        </svg>
      );
    case "save":
      return (
        <svg {...baseProps}>
          <path d="M12 4v10" />
          <path d="m8.5 10.5 3.5 3.5 3.5-3.5" />
          <path d="M5 17.5h14v2H5z" />
        </svg>
      );
    case "load":
      return (
        <svg {...baseProps}>
          <path d="M12 20V10" />
          <path d="m8.5 13.5 3.5-3.5 3.5 3.5" />
          <path d="M5 4.5h14v2H5z" />
        </svg>
      );
    case "snapshot":
      return (
        <svg {...baseProps}>
          <rect x="4" y="7" width="16" height="10" rx="2.5" />
          <circle cx="12" cy="12" r="3" />
          <path d="M8 7 9.5 5.5h5L16 7" />
        </svg>
      );
    case "gpsFix":
      return (
        <svg {...baseProps}>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v3" />
          <path d="M12 19v3" />
          <path d="M2 12h3" />
          <path d="M19 12h3" />
        </svg>
      );
    case "pin":
      return (
        <svg {...baseProps}>
          <path d="M12 21s6-5.3 6-10a6 6 0 1 0-12 0c0 4.7 6 10 6 10z" />
          <circle cx="12" cy="11" r="2.2" />
        </svg>
      );
    case "home":
      return (
        <svg {...baseProps}>
          <path d="M3.5 11 12 4l8.5 7" />
          <path d="M6.5 10.5V20h11v-9.5" />
          <path d="M10 20v-5h4v5" />
        </svg>
      );
    case "refresh":
      return (
        <svg {...baseProps}>
          <path d="M20 11a8 8 0 0 0-14-4.5L4 9" />
          <path d="M4 5v4h4" />
          <path d="M4 13a8 8 0 0 0 14 4.5L20 15" />
          <path d="M20 19v-4h-4" />
        </svg>
      );
  }
}

function ButtonFace({
  icon,
  label,
  meta,
  compact = false
}: {
  icon: ReactNode;
  label: string;
  meta?: string;
  compact?: boolean;
}): JSX.Element {
  return (
    <span className={joinClassNames("button-face bf", compact && "button-face-compact")}>
      <span className="button-face-icon bf-ico" aria-hidden="true">
        {icon}
      </span>
      <span className="button-face-copy bf-copy">
        <span className="button-face-label bf-label">{label}</span>
        {meta ? <span className="button-face-meta bf-meta">{meta}</span> : null}
      </span>
    </span>
  );
}

function NavSidebarSectionIcon({ title }: { title: string }): JSX.Element {
  const baseProps = {
    viewBox: "0 0 24 24",
    width: 16,
    height: 16,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.9,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const
  };

  switch (title) {
    case "CONNECTION":
      return (
        <svg {...baseProps}>
          <path d="M5 12.5a10 10 0 0 1 14 0" />
          <path d="M8.5 16a5.2 5.2 0 0 1 7 0" />
          <circle cx="12" cy="19" r="1" fill="currentColor" stroke="none" />
        </svg>
      );
    case "CONTROL MODE":
    case "MANUAL CONTROL":
      return (
        <svg {...baseProps}>
          <path d="m4 7 5 5-5 5" />
          <path d="M12 17h8" />
        </svg>
      );
    case "AUTOMATIC ROUTE":
      return (
        <svg {...baseProps}>
          <path d="m4 11 16-7-7 16-2-7-7-2Z" />
          <path d="M5 19h6" />
          <path d="M8 16v6" />
        </svg>
      );
    case "WAYPOINTS":
      return (
        <svg {...baseProps}>
          <path d="M12 21s6-5.1 6-11a6 6 0 0 0-12 0c0 5.9 6 11 6 11Z" />
          <circle cx="12" cy="10" r="2" />
        </svg>
      );
    case "NAVIGATION ACTIONS":
      return (
        <svg {...baseProps}>
          <path d="m4 11 16-7-7 16-2-7-7-2Z" />
        </svg>
      );
    case "FILE OPERATIONS":
      return (
        <svg {...baseProps}>
          <path d="M3.5 7.5h6l1.7 2H20.5v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" />
          <path d="M3.5 7.5V5.5a1.5 1.5 0 0 1 1.5-1.5h4l1.5 2H19a1.5 1.5 0 0 1 1.5 1.5v2" />
        </svg>
      );
    case "RECORDING":
      return (
        <svg {...baseProps}>
          <rect x="4" y="7" width="11" height="10" rx="2" />
          <path d="m15 10 5-2.5v9L15 14" />
        </svg>
      );
    default:
      return <NavGlyph kind="route" />;
  }
}

function rangeFillPct(value: number, min: number, max: number): number {
  return max > min ? Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100)) : 0;
}

function ManualRangeControl({
  label,
  value,
  min,
  max,
  step,
  unit,
  digits,
  onChange
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  digits: number;
  onChange: (value: number) => void;
}): JSX.Element {
  const midpoint = (min + max) / 2;
  return (
    <label className="nav-manual-range">
      <span className="nav-manual-range-head">
        <span>{label}</span>
        <strong>{value.toFixed(digits)}</strong>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        style={{ "--range-fill": `${rangeFillPct(value, min, max)}%` } as CSSProperties}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="nav-manual-range-scale" aria-hidden="true">
        <span>{min.toFixed(1)}</span>
        <span>{midpoint.toFixed(1)}</span>
        <span>{max.toFixed(1)}</span>
      </span>
      <span className="nav-manual-range-unit">{unit}</span>
    </label>
  );
}

function NavSidebarCollapsibleSection({
  title,
  badge,
  className,
  defaultCollapsed = true,
  children
}: {
  title: string;
  badge?: ReactNode;
  className?: string;
  defaultCollapsed?: boolean;
  children: ReactNode;
}): JSX.Element {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [contentHeight, setContentHeight] = useState(500);
  const bodyId = useId();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const accordionState = collapsed ? "closed" : "open";
  const accordionStyle = {
    "--nav-accordion-open-height": `${Math.max(contentHeight, 1)}px`
  } as CSSProperties;
  const handleHeaderWheel = (event: WheelEvent<HTMLButtonElement>): void => {
    if (Math.abs(event.deltaY) < 4) return;
    event.preventDefault();
    event.stopPropagation();
    setCollapsed(event.deltaY > 0);
  };

  useEffect(() => {
    const contentElement = contentRef.current;
    if (!contentElement) return;

    let animationFrameId = 0;
    const measureContentHeight = (): void => {
      window.cancelAnimationFrame(animationFrameId);
      animationFrameId = window.requestAnimationFrame(() => {
        const nextHeight = Math.ceil(contentElement.scrollHeight);
        setContentHeight((currentHeight) => (currentHeight === nextHeight ? currentHeight : nextHeight));
      });
    };

    measureContentHeight();
    const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measureContentHeight) : null;
    resizeObserver?.observe(contentElement);
    window.addEventListener("resize", measureContentHeight);

    return () => {
      window.cancelAnimationFrame(animationFrameId);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", measureContentHeight);
    };
  }, []);

  return (
    <section
      className={joinClassNames(
        "ps",
        "nav-sidebar-collapsible-section",
        collapsed ? "collapsed" : "open",
        className
      )}
      data-state={accordionState}
      style={accordionStyle}
    >
      <button
        type="button"
        className="nav-sidebar-section-header"
        aria-expanded={!collapsed}
        aria-controls={bodyId}
        onClick={() => setCollapsed((current) => !current)}
        onWheel={handleHeaderWheel}
      >
        <span className="nav-sidebar-section-title-row">
          <span className="nav-sidebar-section-icon" aria-hidden="true">
            <NavSidebarSectionIcon title={title} />
          </span>
          <span className="ps-title">{title}</span>
          {badge ? <span className="nav-sidebar-section-badge">{badge}</span> : null}
        </span>
        <span className="nav-sidebar-section-chevron" aria-hidden="true" />
      </button>
      <div id={bodyId} className="nav-sidebar-section-body" data-state={accordionState} aria-hidden={collapsed}>
        <div ref={contentRef} className="nav-sidebar-section-content" data-state={accordionState}>
          {children}
        </div>
      </div>
    </section>
  );
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
              className="button-primary button-tile"
              disabled={state.connecting}
              onClick={async () => {
                try {
                  await service.connect();
                } catch {
                  // The service keeps the latest error in state.
                }
              }}
            >
              <ButtonFace
                icon={<NavGlyph kind="connect" />}
                label={state.connecting ? "Connecting" : "Connect"}
                meta={state.connecting ? "Opening backend session" : "Open backend session"}
              />
            </button>
            <button
              type="button"
              className="button-secondary button-tile"
              onClick={async () => {
                try {
                  await service.disconnect();
                } catch {
                  // The service keeps the latest error in state.
                }
              }}
            >
              <ButtonFace icon={<NavGlyph kind="disconnect" />} label="Disconnect" meta="Close current session" />
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
    <span className={`connection-footer-status-badge ${state.connected ? "connected" : "disconnected"} ${state.connected && state.preset === "real" ? "real-robot" : ""}`}>
      <span className="connection-state-label">
        {state.connected
          ? state.preset === "real" ? "Real Robot" : "Simulation"
          : "Desconectado"}
      </span>
    </span>
  );
}

function describeWaypointActions(waypoint: NavigationState["waypoints"][number]): string[] {
  return (waypoint.actions ?? []).map((action) => {
    if (action.type === "brake_hold") return `Brake ${action.duration_s}s`;
    return action.profile === "rural" ? "Rural" : "Urban";
  });
}

function describePatrolWaypointTags(
  waypoint: NavigationState["waypoints"][number],
  profile: NavigationState["patrolMissionProfile"]
): string[] {
  const id = waypoint.localId;
  if (!id) return waypoint.role === "home" ? ["HOME"] : [];
  const tags: string[] = [];
  if (waypoint.role === "home" || profile.homeWaypoint?.localId === id) tags.push("HOME");
  const loopIndex = profile.loopWaypoints.findIndex((entry) => entry.localId === id);
  if (loopIndex >= 0) tags.push("LOOP");
  if (profile.returnWaypoints.some((entry) => entry.localId === id)) tags.push("RETURN");
  if (profile.departWaypoints.some((entry) => entry.localId === id)) tags.push("DEPART");
  if (loopIndex >= 0 && profile.departEntryLoopIndex === loopIndex) tags.push("ENTRY");
  return tags;
}

function NavigationSidebarPanel({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const navService = runtime.services.getService<NavigationService>(NAVIGATION_SERVICE_ID);
  const connService = runtime.services.getService<ConnectionService>(CONNECTION_SERVICE_ID);
  const dialogService = runtime.services.getService<DialogService>(DIALOG_SERVICE_ID);
  const telemetryService = getTelemetryService(runtime);
  const [navState, setNavState] = useState<NavigationState>(navService.getState());
  const [connState, setConnState] = useState(connService.getState());
  const [telemetrySnapshot, setTelemetrySnapshot] = useState<TelemetrySnapshot | null>(
    telemetryService ? telemetryService.getSnapshot() : null
  );
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const [navigationProfilePending, setNavigationProfilePending] = useState(false);
  const wps = navState.waypoints.length;
  const selectedCount = navState.selectedWaypointIndexes.length;
  const selectedWaypoints = navState.selectedWaypointIndexes
    .map((index) => navState.waypoints[index])
    .filter((entry): entry is NavigationState["waypoints"][number] => Boolean(entry));
  const selectedHomeCount = selectedWaypoints.filter((waypoint) => waypoint.role === "home").length;
  const homeWaypointCount = navState.waypoints.filter((waypoint) => waypoint.role === "home").length;
  const selectedSingleHome = selectedCount === 1 && selectedHomeCount === 1;
  const selectedHasHome = selectedHomeCount > 0;
  const selectedBrakeHoldEnabled =
    selectedWaypoints.length > 0 &&
    selectedWaypoints.every((waypoint) => (waypoint.actions ?? []).some((action) => action.type === "brake_hold"));
  const selectedNavigationProfile =
    selectedWaypoints.length > 0 &&
    selectedWaypoints.every((waypoint) =>
      (waypoint.actions ?? []).some(
        (action) => action.type === "set_navigation_profile" && action.profile === "rural"
      )
    )
      ? "rural"
      : selectedWaypoints.length > 0 &&
          selectedWaypoints.every((waypoint) =>
            (waypoint.actions ?? []).some(
              (action) => action.type === "set_navigation_profile" && action.profile === "urban"
            )
          )
        ? "urban"
        : null;
  const selectedHasAnyAction = selectedWaypoints.some((waypoint) => (waypoint.actions ?? []).length > 0);
  const selectedBrakeHoldDuration =
    selectedWaypoints
      .flatMap((waypoint) => waypoint.actions ?? [])
      .find((action) => action.type === "brake_hold")?.duration_s ?? 5;
  const programmedWaypointCount = navState.waypoints.filter((waypoint) => (waypoint.actions ?? []).length > 0).length;
  const lockReasonText = formatControlLockReason(navState.controlLockReason);
  const routeMission = navState.routeMission;
  const patrolMission = navState.patrolMission;
  const patrolProfile = navState.patrolMissionProfile;
  const patrolLoopCount = patrolProfile.loopWaypoints.length;
  const patrolReturnCount = patrolProfile.returnWaypoints.length;
  const patrolDepartCount = patrolProfile.departWaypoints.length;
  const patrolReadiness = getPatrolProfileReadiness(patrolProfile);
  const patrolProfileConfigured = patrolReadiness.profileConfigured;
  const patrolReady = patrolReadiness.isReady;
  const patrolStartMeta = patrolReady
    ? patrolReadiness.summary
    : `Missing: ${patrolReadiness.missingRequirements.join(", ")}`;
  const routeStartBlockedByPatrol = patrolProfileConfigured;
  const routeStartDisabled = wps < 2 || navState.controlLocked || routeStartBlockedByPatrol;
  const routeStartMeta = wps < 2
    ? "Needs 2+ waypoints"
    : routeStartBlockedByPatrol
      ? "Structured patrol loaded: use START PATROL"
      : "Expanded route mission";
  const routeStartTitle = navState.controlLocked
    ? lockReasonText
    : routeStartBlockedByPatrol
      ? "Structured patrol configured. Use START PATROL or clear the patrol profile."
      : "Start a simple route mission from the queued waypoints";
  const routeMissionActivity = getRouteMissionActivityState(routeMission, telemetrySnapshot?.goalActive === true);
  const missionActive = routeMissionActivity.running || (telemetrySnapshot?.goalActive === true);
  const routeMissionRunning = routeMissionActivity.running;
  const navigationProfileLocked =
    navState.controlLocked ||
    navigationProfilePending ||
    missionActive ||
    routeMission.paused ||
    patrolMission.active ||
    patrolMission.phase === "depart_home" ||
    patrolMission.phase === "return_connector" ||
    patrolMission.phase === "return_pending" ||
    patrolMission.phase === "loop_main";
  const goalModeSelected = navState.goalMode;
  const manualModeSelected = navState.manualMode && !goalModeSelected;
  const connectionStatusClassName = joinClassNames(
    "status-pill",
    "nav-sidebar-status-pill",
    connState.connected && "ok",
    connState.connected && connState.preset === "real" && "real-robot",
    connState.connecting && "pending",
    Boolean(connState.lastError) && !connState.connected && !connState.connecting && "bad"
  );
  const connectionStatusText = connState.connected
    ? connState.preset === "real" ? "Connected · Real Robot" : "Connected · Simulation"
    : connState.connecting
      ? connState.preset === "real" ? "Connecting to Real Robot..." : "Connecting to Simulation..."
      : connState.lastError
        ? "Link error"
        : "Disconnected";
  useEffect(() => navService.subscribe((next) => setNavState(next)), [navService]);
  useEffect(() => connService.subscribe((next) => setConnState(next)), [connService]);
  useEffect(() => {
    if (!connState.connected) navService.resetNavigationStartProfile();
  }, [connState.connected, navService]);
  useEffect(() => {
    if (selectedCount === 0 || navState.controlLocked) {
      setActionMenuOpen(false);
    }
  }, [selectedCount, navState.controlLocked]);
  useEffect(() => {
    if (!telemetryService) return;
    return telemetryService.subscribeTelemetry((next) => setTelemetrySnapshot(next));
  }, [telemetryService]);

  const emitInfo = (text: string): void => {
    runtime.eventBus.emit("console.event", { level: "info", text, timestamp: Date.now() });
  };
  const emitError = (text: string): void => {
    runtime.eventBus.emit("console.event", { level: "error", text, timestamp: Date.now() });
  };
  const enableMapWaypointPlacement = async (): Promise<void> => {
    if (navState.controlLocked) {
      emitError(`Waypoint placement blocked: ${lockReasonText}`);
      return;
    }
    if (!goalModeSelected) {
      try {
        await navService.setGoalMode(true);
      } catch (error) {
        emitError(`Waypoint placement failed: ${String(error)}`);
        return;
      }
    }
    navService.setWaypointSelectionMode(false);
    emitInfo("Waypoint placement enabled: click and drag on the map to place it");
  };

  return (
    <div className="nav-sidebar">
      <NavSidebarCollapsibleSection title="CONNECTION" className="nav-sidebar-connection-section">
        <select
          className="connection-preset-select"
          value={connState.preset}
          onChange={(event) => connService.setPreset(event.target.value === "sim" ? "sim" : "real")}
        >
          <option value="real">Real Robot</option>
          <option value="sim">Simulation</option>
        </select>
        <div className="input-grid">
          <input
            value={connState.host}
            onChange={(event) => connService.setHost(event.target.value)}
            placeholder="Host address"
          />
          <input
            value={connState.port}
            onChange={(event) => connService.setPort(event.target.value)}
            placeholder="Port"
          />
        </div>
        <div className="action-grid">
          <button
            type="button"
            className={joinClassNames("bt prim-btn", (connState.connected || connState.connecting) && "active")}
            disabled={connState.connecting || connState.connected}
            onClick={async () => {
              try {
                await connService.connect();
              } catch {
                // error persisted in connState.lastError
              }
            }}
          >
            <ButtonFace
              icon={<NavGlyph kind="connect" />}
              label={connState.connected ? "CONNECTED" : connState.connecting ? "CONNECTING" : "CONNECT"}
              meta={
                connState.connected
                  ? connState.preset === "real" ? "Real Robot session open" : "Simulation session open"
                  : connState.connecting
                    ? "Opening backend session"
                    : "Open backend session"
              }
            />
          </button>
          <button
            type="button"
            className="bt sec-btn"
            disabled={!connState.connected && !connState.connecting}
            onClick={async () => {
              try {
                await connService.disconnect();
              } catch {
                // error persisted in connState.lastError
              }
            }}
          >
            <ButtonFace icon={<NavGlyph kind="disconnect" />} label="DISCONNECT" meta="Close session" />
          </button>
        </div>
        <div className={connectionStatusClassName}>
          <span className="status-dot" aria-hidden="true" />
          <span>{connectionStatusText}</span>
        </div>
      </NavSidebarCollapsibleSection>

      {/* ── 2. MANUAL CONTROL ─────────────────────────────────────────── */}
      <NavSidebarCollapsibleSection title="MANUAL CONTROL" className="nav-sidebar-control-section nav-sidebar-manual-section">
        <button
          type="button"
          className={joinClassNames("ncb-wide", "nav-manual-mode-btn", "send-btn", manualModeSelected && "active")}
          title={navState.controlLocked ? lockReasonText : "Manual mode (tecla F)"}
          disabled={navState.controlLocked}
          onClick={async () => {
            const next = !navState.manualMode;
            try {
              await navService.setManualMode(next);
              emitInfo(next ? "Manual mode enabled" : "Manual mode disabled");
            } catch (error) {
              emitError(`Manual mode failed: ${String(error)}`);
            }
          }}
        >
          <ButtonFace icon={<NavGlyph kind="manual" />} label="MANUAL" meta={manualModeSelected ? "Enabled" : "Disabled"} />
        </button>
        <div className="nav-manual-range-stack">
          <ManualRangeControl
            label="Linear speed"
            unit="m/s"
            value={navState.manualLinearSpeed}
            min={navState.manualLinearMin}
            max={navState.manualLinearMax}
            step={0.01}
            digits={2}
            onChange={(value) => navService.setManualLinearSpeed(value)}
          />
          <ManualRangeControl
            label="Steering angle / turn radius"
            unit="deg"
            value={navState.manualSteeringAngleDeg}
            min={navState.manualSteeringAngleMinDeg}
            max={navState.manualSteeringAngleMaxDeg}
            step={0.1}
            digits={1}
            onChange={(value) => navService.setManualSteeringAngleDeg(value)}
          />
        </div>
      </NavSidebarCollapsibleSection>

      {/* ── 3. AUTOMATIC ROUTE ─────────────────────────────────────────── */}
      <NavSidebarCollapsibleSection
        title="AUTOMATIC ROUTE"
        badge={<span className={joinClassNames("waypoint-badge", wps === 0 && "empty")}>{wps}</span>}
        className="nav-sidebar-actions-section nav-sidebar-automatic-section nav-sidebar-route-section"
        defaultCollapsed={false}
      >
        <div className="nav-route-subsection nav-navigation-profile-section">
          <div className="nav-route-subhead">
            <span>Start / manual costmap</span>
            <small>{navigationProfileLocked ? "Mission controlled" : "Apply now"}</small>
          </div>
          <div className="nav-navigation-profile-switch" role="group" aria-label="Navigation profile">
            {(["urban", "rural"] as const).map((profile) => (
              <button
                key={profile}
                type="button"
                className={joinClassNames(
                  "nav-navigation-profile-option",
                  navState.navigationStartProfile === profile && "active"
                )}
                disabled={navigationProfileLocked}
                title={
                  navigationProfileLocked
                    ? navState.controlLocked
                      ? lockReasonText
                      : "Profile changes are controlled by the active mission and its waypoints"
                    : `Apply ${profile} costmap now and use it to start the next mission`
                }
                onClick={async () => {
                  if (navState.navigationStartProfile === profile) return;
                  setNavigationProfilePending(true);
                  try {
                    await navService.setNavigationStartProfile(profile);
                    emitInfo(`Navigation profile applied: ${profile}`);
                  } catch (error) {
                    emitError(`Navigation profile failed: ${String(error)}`);
                  } finally {
                    setNavigationProfilePending(false);
                  }
                }}
              >
                <span>{profile === "urban" ? "URBAN" : "RURAL"}</span>
                <small>{profile === "urban" ? "Default margins" : "Narrow dirt road"}</small>
              </button>
            ))}
          </div>
        </div>
        <div className="nav-route-subsection nav-route-execution">
          <div className="nav-route-subhead">
            <span>Route</span>
            <small>{routeMissionRunning ? "Running" : "Ready"}</small>
          </div>
          <button
            type="button"
            className={joinClassNames("ncb-wide send-btn", routeMissionRunning && "active")}
            disabled={routeStartDisabled}
            title={routeStartTitle}
            onClick={async () => {
              try {
                const started = await navService.sendRouteMission();
                emitInfo(`Route mission started (${started.inputCount} wps, ${started.expandedCount} pts)`);
              } catch (error) {
                emitError(`Route mission failed: ${String(error)}`);
              }
            }}
          >
            <ButtonFace icon={<NavGlyph kind="route" />} label="START ROUTE" meta={routeStartMeta} />
          </button>
          <button
            type="button"
            className="ncb-wide cancel-btn"
            disabled={!(missionActive || patrolMission.active || patrolMission.phase === "depart_home" || patrolMission.phase === "return_connector" || patrolMission.phase === "return_pending" || patrolMission.phase === "loop_main")}
            onClick={async () => {
              try {
                if (routeMission.active || routeMission.paused) {
                  await navService.cancelRouteMission();
                  emitInfo("Route mission cancelled");
                } else if (
                  patrolMission.active ||
                  patrolMission.phase === "depart_home" ||
                  patrolMission.phase === "return_connector" ||
                  patrolMission.phase === "return_pending" ||
                  patrolMission.phase === "loop_main"
                ) {
                  await navService.cancelPatrolMission();
                  emitInfo("Patrol mission cancelled");
                } else {
                  await navService.cancelGoal();
                  emitInfo("Goal cancelled");
                }
              } catch (error) {
                emitError(`Cancel failed: ${String(error)}`);
              }
            }}
          >
            <ButtonFace icon={<NavGlyph kind="cancel" />} label="CANCEL" meta="Stop active navigation" />
          </button>
          <button
            type="button"
            className="ncb-wide sec-btn"
            disabled={navState.controlLocked || !(patrolMission.active || patrolMission.phase === "return_pending" || patrolMission.phase === "loop_main")}
            title={navState.controlLocked ? lockReasonText : "Solicitar retorno estructurado a HOME"}
            onClick={async () => {
              try {
                await navService.requestReturnHome();
                emitInfo("Return HOME requested");
              } catch (error) {
                emitError(`Return HOME failed: ${String(error)}`);
              }
            }}
          >
            <ButtonFace icon={<NavGlyph kind="home" />} label="RETURN HOME" meta={patrolMission.phase || "Patrol only"} />
          </button>
        </div>
        <div className="nav-route-subsection nav-route-execution">
          <div className="nav-route-subhead">
            <span>Patrol Mission</span>
            <small>{patrolMission.active ? patrolMission.phase : patrolReady ? "Ready" : "Setup needed"}</small>
          </div>
          <button
            type="button"
            className={joinClassNames("ncb-wide send-btn", patrolMission.active && "active")}
            disabled={!patrolReady || navState.controlLocked}
            onClick={async () => {
              try {
                const started = await navService.sendPatrolMission();
                emitInfo(`Patrol mission started (${started.inputCount} loop wps, ${started.expandedCount} pts)`);
              } catch (error) {
                emitError(`Patrol mission failed: ${String(error)}`);
              }
            }}
          >
            <ButtonFace
              icon={<NavGlyph kind="route" />}
              label="START PATROL"
              meta={patrolStartMeta}
            />
          </button>
        </div>
      </NavSidebarCollapsibleSection>

      <NavSidebarCollapsibleSection
        title="WAYPOINTS"
        badge={<span className={joinClassNames("waypoint-badge", wps === 0 && "empty")}>{wps}</span>}
        className="nav-sidebar-actions-section nav-sidebar-waypoints-section"
        defaultCollapsed={false}
      >
        <div className="nav-route-subsection nav-route-setup">
          <div className="nav-route-subhead">
            <span>Waypoints</span>
            <small>{wps} waypoint{wps === 1 ? "" : "s"} · {homeWaypointCount} HOME</small>
          </div>
          <div className="ncb-3-grid nav-sidebar-compact-grid nav-route-edit-grid">
            <button
              type="button"
              className="ncb sec-btn"
              disabled={wps === 0 || navState.controlLocked}
              title="Seleccionar todos los waypoints"
              onClick={() => navService.selectAllWaypoints()}
            >
              <ButtonFace icon={<NavGlyph kind="route" />} label="SELECT ALL" meta={`${wps} total`} compact />
            </button>
            <button
              type="button"
              className="ncb sec-btn"
              disabled={selectedCount === 0 || navState.controlLocked}
              title="Deseleccionar todos los waypoints (ESC en el mapa)"
              onClick={() => navService.clearWaypointSelection()}
            >
              <ButtonFace icon={<NavGlyph kind="clear" />} label="CLEAR SEL." meta={`${selectedCount} sel.`} compact />
            </button>
            <button
              type="button"
              className={joinClassNames("ncb sec-btn", navState.waypointSelectionMode && "active")}
              disabled={wps === 0 || navState.controlLocked}
              title="Arrastrá un rectángulo en el mapa. Shift suma a la selección actual. ESC sale del modo y limpia la selección."
              onClick={() => navService.setWaypointSelectionMode(!navState.waypointSelectionMode)}
            >
              <ButtonFace icon={<NavGlyph kind="goal" />} label="SELECT AREA" meta={navState.waypointSelectionMode ? "Map active" : "Draw on map"} compact />
            </button>
          </div>
          <div className="ncb-3-grid nav-sidebar-compact-grid nav-route-edit-grid">
            <button
              type="button"
              className="ncb sec-btn"
              disabled={wps < 2 || navState.controlLocked}
              title="Usar los waypoints en cola como loop principal"
              onClick={() => {
                try {
                  const count = navService.useQueuedWaypointsAsPatrolLoop();
                  emitInfo(`Patrol loop updated (${count} waypoints)`);
                } catch (error) {
                  emitError(`Patrol loop failed: ${String(error)}`);
                }
              }}
            >
              <ButtonFace icon={<NavGlyph kind="route" />} label="USE LOOP" meta={`${wps} queued`} compact />
            </button>
            <button
              type="button"
              className="ncb sec-btn"
              disabled={selectedCount !== 1 || navState.controlLocked}
              title="Usar el waypoint seleccionado como HOME de la patrulla"
              onClick={() => {
                try {
                  navService.setPatrolHomeFromSelected();
                  emitInfo("Patrol HOME updated");
                } catch (error) {
                  emitError(`Patrol HOME failed: ${String(error)}`);
                }
              }}
            >
              <ButtonFace icon={<NavGlyph kind="home" />} label="SET HOME" meta={selectedCount === 1 ? "Selected" : "Pick 1"} compact />
            </button>
            <button
              type="button"
              className="ncb danger-btn"
              disabled={navState.controlLocked}
              title="Limpiar el perfil de misión de patrulla"
              onClick={() => {
                navService.clearPatrolMissionProfile();
                emitInfo("Patrol mission profile cleared");
              }}
            >
              <ButtonFace icon={<NavGlyph kind="clear" />} label="CLEAR" meta="Patrol profile" compact />
            </button>
          </div>
          <div className="waypoint-manager-list" aria-label="Waypoint manager">
            {navState.waypoints.map((waypoint, index) => {
              const selected = navState.selectedWaypointIndexes.includes(index);
              const patrolTags = describePatrolWaypointTags(waypoint, patrolProfile);
              const actions = describeWaypointActions(waypoint);
              const yaw = Number(waypoint.yawDeg);
              return (
                <button
                  key={waypoint.localId ?? `${waypoint.x}-${waypoint.y}-${index}`}
                  type="button"
                  className={joinClassNames("waypoint-manager-row", selected && "selected")}
                  aria-pressed={selected}
                  title="Alternar selección"
                  onClick={() => navService.toggleWaypointSelection(index)}
                >
                  <span className="waypoint-manager-index">#{index + 1}</span>
                  <span className="waypoint-manager-coordinates">
                    {Number(waypoint.x).toFixed(6)}, {Number(waypoint.y).toFixed(6)}
                  </span>
                  <span className="waypoint-manager-yaw">{Number.isFinite(yaw) ? `${yaw.toFixed(1)}° manual` : "auto yaw"}</span>
                  <span className="waypoint-manager-tags">
                    {patrolTags.map((tag) => <span key={tag} className="waypoint-manager-tag">{tag}</span>)}
                    {actions.map((action) => <span key={action} className="waypoint-manager-tag action">{action}</span>)}
                  </span>
                </button>
              );
            })}
            {wps === 0 ? <p className="muted waypoint-manager-empty">No waypoints queued.</p> : null}
          </div>
          <button
            type="button"
            className={joinClassNames("ncb-wide", goalModeSelected && "active")}
            title={navState.controlLocked ? lockReasonText : "Goal mode"}
            disabled={navState.controlLocked}
            onClick={async () => {
              const next = !goalModeSelected;
              try {
                await navService.setGoalMode(next);
                if (next) navService.setWaypointSelectionMode(false);
                emitInfo(next ? "Goal mode enabled" : "Goal mode disabled");
              } catch (error) {
                emitError(`Goal mode failed: ${String(error)}`);
              }
            }}
          >
            <ButtonFace icon={<NavGlyph kind="goal" />} label="GOAL MODE" meta={goalModeSelected ? "Waypoint editing" : "Standby"} />
          </button>
          <label className="check-row nav-loop-check">
            <input
              type="checkbox"
              checked={navState.loopRoute}
              onChange={(event) => navService.setLoopRoute(event.target.checked)}
            />
            Loop route
          </label>
          <div className="ncb-3-grid nav-sidebar-compact-grid nav-route-edit-grid">
            <button
              type="button"
              className="ncb sec-btn"
              disabled={wps === 0 || navState.controlLocked}
              title={navState.controlLocked ? lockReasonText : "Deshacer último waypoint"}
              onClick={() => {
                navService.removeLastWaypoint();
                emitInfo("Last waypoint removed");
              }}
            >
              <ButtonFace icon={<NavGlyph kind="undo" />} label="UNDO" meta="Last waypoint" compact />
            </button>
            <button
              type="button"
              className="ncb danger-btn"
              disabled={wps === 0 || navState.controlLocked}
              title={navState.controlLocked ? lockReasonText : "Limpiar todos los waypoints"}
              onClick={() => {
                navService.clearWaypoints();
                emitInfo("Waypoints cleared");
              }}
            >
              <ButtonFace icon={<NavGlyph kind="clear" />} label="CLEAR" meta="All waypoints" compact />
            </button>
            <button
              type="button"
              className="ncb danger-btn"
              disabled={selectedCount === 0 || navState.controlLocked}
              title={navState.controlLocked ? lockReasonText : `${selectedCount} waypoints seleccionados`}
              onClick={() => {
                const removed = navService.removeSelectedWaypoints();
                if (removed > 0) emitInfo(`Removed ${removed} selected waypoint${removed > 1 ? "s" : ""}`);
              }}
            >
              <ButtonFace icon={<NavGlyph kind="remove" />} label="REMOVE" meta={`${selectedCount} sel.`} compact />
            </button>
          </div>
          <div className="nav-route-programming-row">
            <button
              type="button"
              className={joinClassNames(
                "ncb-wide sec-btn",
                actionMenuOpen && "active",
                (selectedHasAnyAction || selectedHasHome) && "programmed"
              )}
              disabled={selectedCount === 0 || navState.controlLocked}
              title={
                navState.controlLocked
                  ? lockReasonText
                  : selectedCount === 0
                    ? "Seleccioná uno o más waypoints"
                    : "Abrir herramientas especiales para los waypoints seleccionados"
              }
              onClick={() => {
                setActionMenuOpen((current) => !current);
              }}
            >
              <ButtonFace
                icon={<NavGlyph kind="goal" />}
                label="WAYPOINT TOOLS"
                meta={
                  selectedCount === 0
                    ? "Pick waypoint"
                    : selectedSingleHome
                      ? "1 selected · HOME"
                      : `${selectedCount} selected · tools available`
                }
              />
            </button>
            {actionMenuOpen ? (
              <div className="nav-route-action-menu">
                <div className="nav-route-action-group">
                  <div className="nav-route-action-group-label">HOME</div>
                  <button
                    type="button"
                    className={joinClassNames("nav-route-action-option", selectedSingleHome && "active")}
                    disabled={selectedCount !== 1 || navState.controlLocked}
                    title={
                      navState.controlLocked
                        ? lockReasonText
                        : selectedCount !== 1
                          ? "Select exactly one waypoint to mark HOME"
                          : "Mark selected waypoint as HOME"
                    }
                    onClick={() => {
                      try {
                        const homeIndex = navService.setHomeForSelected();
                        setActionMenuOpen(false);
                        emitInfo(`Waypoint ${homeIndex + 1} marked as HOME`);
                      } catch (error) {
                        emitError(`HOME waypoint failed: ${String(error)}`);
                      }
                    }}
                  >
                    <span>Set HOME</span>
                    <small>Selected waypoint</small>
                  </button>
                  <button
                    type="button"
                    className="nav-route-action-option"
                    disabled={selectedHomeCount === 0 || navState.controlLocked}
                    title={
                      navState.controlLocked
                        ? lockReasonText
                        : selectedHomeCount === 0
                          ? "Selected waypoints do not include HOME"
                          : "Clear HOME from selected waypoint"
                    }
                    onClick={() => {
                      try {
                        const changed = navService.clearHomeForSelected();
                        setActionMenuOpen(false);
                        if (changed > 0) emitInfo("HOME removed from selected waypoint");
                      } catch (error) {
                        emitError(`HOME waypoint failed: ${String(error)}`);
                      }
                    }}
                  >
                    <span>Clear HOME</span>
                    <small>Selected HOME</small>
                  </button>
                </div>
                <div className="nav-route-action-group">
                  <div className="nav-route-action-group-label">PATROL SEGMENTS</div>
                  <button
                    type="button"
                    className={joinClassNames("nav-route-action-option", patrolReturnCount > 0 && "active")}
                    disabled={selectedCount === 0 || navState.controlLocked}
                    title={
                      navState.controlLocked
                        ? lockReasonText
                        : selectedCount === 0
                          ? "Select one or more waypoints for the return connector"
                          : "Use selected waypoints as connector back to HOME"
                    }
                    onClick={() => {
                      try {
                        const count = navService.useSelectedWaypointsAsPatrolSegment("return");
                        setActionMenuOpen(false);
                        emitInfo(`Patrol return connector updated (${count} waypoints)`);
                      } catch (error) {
                        emitError(`Patrol return connector failed: ${String(error)}`);
                      }
                    }}
                  >
                    <span>Set RETURN</span>
                    <small>{selectedCount > 0 ? `${selectedCount} selected` : `${patrolReturnCount} saved`}</small>
                  </button>
                  <button
                    type="button"
                    className="nav-route-action-option danger"
                    disabled={patrolReturnCount === 0 || navState.controlLocked}
                    title={navState.controlLocked ? lockReasonText : "Clear the return connector"}
                    onClick={() => {
                      try {
                        navService.clearPatrolSegment("return");
                        setActionMenuOpen(false);
                        emitInfo("Patrol return connector cleared");
                      } catch (error) {
                        emitError(`Patrol return connector failed: ${String(error)}`);
                      }
                    }}
                  >
                    <span>Clear RETURN</span>
                    <small>{patrolReturnCount} waypoint{patrolReturnCount === 1 ? "" : "s"}</small>
                  </button>
                  <button
                    type="button"
                    className={joinClassNames("nav-route-action-option", patrolDepartCount > 0 && "active")}
                    disabled={selectedCount === 0 || navState.controlLocked}
                    title={
                      navState.controlLocked
                        ? lockReasonText
                        : selectedCount === 0
                          ? "Select one or more waypoints for the depart connector"
                          : "Use selected waypoints as connector from HOME back to the loop"
                    }
                    onClick={() => {
                      try {
                        const count = navService.useSelectedWaypointsAsPatrolSegment("depart");
                        setActionMenuOpen(false);
                        emitInfo(`Patrol depart connector updated (${count} waypoints)`);
                      } catch (error) {
                        emitError(`Patrol depart connector failed: ${String(error)}`);
                      }
                    }}
                  >
                    <span>Set DEPART</span>
                    <small>{selectedCount > 0 ? `${selectedCount} selected` : `${patrolDepartCount} saved`}</small>
                  </button>
                  <button
                    type="button"
                    className="nav-route-action-option danger"
                    disabled={patrolDepartCount === 0 || navState.controlLocked}
                    title={navState.controlLocked ? lockReasonText : "Clear the depart connector"}
                    onClick={() => {
                      try {
                        navService.clearPatrolSegment("depart");
                        setActionMenuOpen(false);
                        emitInfo("Patrol depart connector cleared");
                      } catch (error) {
                        emitError(`Patrol depart connector failed: ${String(error)}`);
                      }
                    }}
                  >
                    <span>Clear DEPART</span>
                    <small>{patrolDepartCount} waypoint{patrolDepartCount === 1 ? "" : "s"}</small>
                  </button>
                  <button
                    type="button"
                    className={joinClassNames(
                      "nav-route-action-option",
                      patrolProfile.departEntryLoopIndex >= 0 && "active"
                    )}
                    disabled={selectedCount !== 1 || patrolLoopCount < 2 || navState.controlLocked}
                    title={
                      navState.controlLocked
                        ? lockReasonText
                        : selectedCount !== 1
                          ? "Select exactly one loop waypoint as re-entry point"
                          : "Use selected loop waypoint as the re-entry point for DEPART"
                    }
                    onClick={() => {
                      try {
                        const index = navService.setPatrolDepartEntryFromSelected();
                        setActionMenuOpen(false);
                        emitInfo(`Patrol entry set to loop waypoint ${index + 1}`);
                      } catch (error) {
                        emitError(`Patrol entry failed: ${String(error)}`);
                      }
                    }}
                  >
                    <span>Set ENTRY</span>
                    <small>{patrolProfile.departEntryLoopIndex >= 0 ? `Loop #${patrolProfile.departEntryLoopIndex + 1}` : "Pick 1 loop wp"}</small>
                  </button>
                </div>
                <div className="nav-route-action-group">
                  <div className="nav-route-action-group-label">ACTIONS</div>
                <button
                  type="button"
                  className={joinClassNames("nav-route-action-option", selectedBrakeHoldEnabled && "active")}
                  disabled={selectedHasHome || navState.controlLocked}
                  title={
                    navState.controlLocked
                      ? lockReasonText
                      : selectedHasHome
                        ? "HOME waypoint cannot have route actions"
                        : "Set brake action for selected waypoints"
                  }
                  onClick={async () => {
                    const durationRaw = await dialogService.prompt({
                      title: "Brake action",
                      message: "Seconds to keep brake before continuing:",
                      defaultValue: String(Math.max(0.1, selectedBrakeHoldDuration)),
                      placeholder: "5",
                      confirmLabel: "Apply",
                      cancelLabel: "Cancel"
                    });
                    if (durationRaw === null) return;
                    const duration = Number(durationRaw);
                    if (!Number.isFinite(duration) || duration <= 0 || duration > 600) {
                      emitError("Brake action duration must be between 0 and 600 seconds");
                      return;
                    }
                    try {
                      const changed = navService.setBrakeHoldActionForSelected(true, duration, 100);
                      setActionMenuOpen(false);
                      emitInfo(`Brake action ${duration}s set on ${changed} waypoint${changed > 1 ? "s" : ""}`);
                    } catch (error) {
                      emitError(`Waypoint action failed: ${String(error)}`);
                    }
                  }}
                >
                  <span>Brake</span>
                  <small>{selectedBrakeHoldEnabled ? `${selectedBrakeHoldDuration}s` : "Hold before continue"}</small>
                </button>
                <button
                  type="button"
                  className={joinClassNames("nav-route-action-option", selectedNavigationProfile === "rural" && "active")}
                  disabled={selectedHasHome || navState.controlLocked}
                  title={
                    navState.controlLocked
                      ? lockReasonText
                      : selectedHasHome
                        ? "HOME waypoint cannot have route actions"
                        : "Activate rural navigation profile at selected waypoints"
                  }
                  onClick={() => {
                    try {
                      const changed = navService.setNavigationProfileActionForSelected("rural");
                      setActionMenuOpen(false);
                      emitInfo(`Rural profile set on ${changed} waypoint${changed > 1 ? "s" : ""}`);
                    } catch (error) {
                      emitError(`Waypoint action failed: ${String(error)}`);
                    }
                  }}
                >
                  <span>Rural profile</span>
                  <small>{selectedNavigationProfile === "rural" ? "Enabled" : "Narrow dirt road"}</small>
                </button>
                <button
                  type="button"
                  className={joinClassNames("nav-route-action-option", selectedNavigationProfile === "urban" && "active")}
                  disabled={selectedHasHome || navState.controlLocked}
                  title={
                    navState.controlLocked
                      ? lockReasonText
                      : selectedHasHome
                        ? "HOME waypoint cannot have route actions"
                        : "Restore urban navigation profile at selected waypoints"
                  }
                  onClick={() => {
                    try {
                      const changed = navService.setNavigationProfileActionForSelected("urban");
                      setActionMenuOpen(false);
                      emitInfo(`Urban profile set on ${changed} waypoint${changed > 1 ? "s" : ""}`);
                    } catch (error) {
                      emitError(`Waypoint action failed: ${String(error)}`);
                    }
                  }}
                >
                  <span>Urban profile</span>
                  <small>{selectedNavigationProfile === "urban" ? "Enabled" : "Default margins"}</small>
                </button>
                {selectedHasAnyAction ? (
                  <button
                    type="button"
                    className="nav-route-action-option danger"
                    onClick={() => {
                      try {
                        const changed = navService.clearWaypointActionsForSelected();
                        setActionMenuOpen(false);
                        emitInfo(`Action removed from ${changed} waypoint${changed > 1 ? "s" : ""}`);
                      } catch (error) {
                        emitError(`Waypoint action failed: ${String(error)}`);
                      }
                    }}
                  >
                    <span>Remove action</span>
                    <small>Selected waypoints</small>
                  </button>
                ) : null}
                </div>
              </div>
            ) : null}
            {routeMission.actionActive ? (
              <div className="nav-route-action-status">
                {routeMission.actionType || "action"} · {Math.ceil(Math.max(0, routeMission.actionRemainingS))}s
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className={joinClassNames("ncb-wide prim-btn", wps > 0 && !navState.controlLocked && "active")}
            disabled={navState.controlLocked}
            title={navState.controlLocked ? lockReasonText : "Activar colocación de waypoint en el mapa"}
            onClick={() => {
              void enableMapWaypointPlacement();
            }}
          >
            <ButtonFace icon={<NavGlyph kind="addWaypoint" />} label="ADD WAYPOINT" meta={goalModeSelected ? "Click map to place" : "Place on map"} />
          </button>
        </div>
      </NavSidebarCollapsibleSection>

      {/* ── 4. FILE ───────────────────────────────────────────────────── */}
      <NavSidebarCollapsibleSection
        title="GESTIÓN DE RUTAS"
        className="nav-sidebar-compact-section nav-sidebar-file-section"
        defaultCollapsed
      >
        <div className="nav-routes-tools">
          <button
            type="button"
            className="ncb-wide danger-btn"
            disabled={wps === 0 || navState.controlLocked}
            title={navState.controlLocked ? lockReasonText : "Limpiar todos los waypoints"}
            onClick={() => {
              navService.clearWaypoints();
              emitInfo("Waypoints cleared");
            }}
          >
            <ButtonFace icon={<NavGlyph kind="clear" />} label="CLEAR" meta="All waypoints" />
          </button>
        </div>

        <div className="nav-saved-routes">
          <button
            type="button"
            className="ncb sec-btn nav-saved-routes-add"
            title="Guardar la ruta actual con un nombre (se guarda en el cockpit, funciona sin conexión)"
            disabled={wps === 0}
            onClick={async () => {
              const name = await dialogService.prompt({
                title: "Guardar ruta",
                message: "Nombre para esta ruta:",
                confirmLabel: "Guardar",
                placeholder: "ej: Ronda noche"
              });
              if (name === null) return;
              try {
                const count = navService.saveNamedRoute(name);
                emitInfo(`Ruta "${name.trim()}" guardada (${count} waypoints)`);
              } catch (error) {
                emitError(`Guardar ruta falló: ${String(error)}`);
              }
            }}
          >
            <ButtonFace icon={<NavGlyph kind="save" />} label="GUARDAR RUTA" meta="Con nombre · local" compact />
          </button>

          {navState.savedRouteNames.length > 0 ? (
            <ul className="nav-saved-routes-list">
              {navState.savedRouteNames.map((routeName) => (
                <li key={routeName} className="nav-saved-route-item">
                  <button
                    type="button"
                    className="nav-saved-route-load"
                    title={`Cargar "${routeName}"`}
                    onClick={() => {
                      try {
                        const count = navService.loadNamedRoute(routeName);
                        emitInfo(`Ruta "${routeName}" cargada (${count} waypoints)`);
                      } catch (error) {
                        emitError(`Cargar ruta falló: ${String(error)}`);
                      }
                    }}
                  >
                    {routeName}
                  </button>
                  <button
                    type="button"
                    className="nav-saved-route-delete"
                    aria-label={`Eliminar "${routeName}"`}
                    title={`Eliminar "${routeName}"`}
                    onClick={async () => {
                      const ok = await dialogService.confirm({
                        title: "Eliminar ruta",
                        message: `¿Eliminar la ruta "${routeName}"?`,
                        confirmLabel: "Eliminar",
                        danger: true
                      });
                      if (!ok) return;
                      navService.deleteNamedRoute(routeName);
                      emitInfo(`Ruta "${routeName}" eliminada`);
                    }}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="nav-saved-routes-empty muted">No hay rutas guardadas todavía.</p>
          )}
        </div>
      </NavSidebarCollapsibleSection>

      <DatumSidebarSection runtime={runtime} />
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
    return mapService.subscribeDatumProfiles((next) => setDatumProfiles(next));
  }, [mapService]);

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

  if (!mapService) return null;

  const emit = (level: "info" | "warn" | "error", text: string): void => {
    runtime.eventBus.emit("console.event", { level, text, timestamp: Date.now() });
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
        yawDeg: Number.isFinite(yawDeg) ? yawDeg : undefined,
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
  const deleteDatum = (id: string): void => {
    void mapService
      .deleteDatumOnBackend(id)
      .then((next) => {
        setDatumProfiles(next);
        emit("info", "Datum eliminado");
      })
      .catch((error) => emit("error", `Delete datum failed: ${String(error)}`));
  };

  const runtimeDatum = datumProfiles?.runtime;
  const selected = datumProfiles?.datums.find((entry) => entry.id === datumProfiles.selectedId);
  const statusText = datumProfiles?.pendingRestart ? "Pendiente de restart ROS" : "Aplicado";
  const datums = datumProfiles?.datums ?? [];

  return (
    <NavSidebarCollapsibleSection
      title="DATUM"
      className="nav-sidebar-datum-section"
      badge={<span className={joinClassNames("waypoint-badge", datums.length === 0 && "empty")}>{datums.length}</span>}
    >
      <div className="datum-sidebar-status">
        <div>
          <span>Runtime</span>
          <strong>
            {formatDatumCoordinate(runtimeDatum?.lat)}, {formatDatumCoordinate(runtimeDatum?.lon)}
          </strong>
        </div>
        <div className={joinClassNames("datum-sidebar-badge", datumProfiles?.pendingRestart && "pending")}>
          {statusText}
        </div>
        <p className="muted nav-legacy-text">Seleccionado: {selected?.name ?? "n/a"}</p>
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
          inputMode="decimal"
        />
        <input
          value={form.lat}
          onChange={(event) => setForm((current) => ({ ...current, lat: event.target.value }))}
          placeholder="Lat manual"
          inputMode="decimal"
        />
        <input
          value={form.lon}
          onChange={(event) => setForm((current) => ({ ...current, lon: event.target.value }))}
          placeholder="Lon manual"
          inputMode="decimal"
        />
        <input
          value={form.notes}
          onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))}
          placeholder="Notas"
        />
      </div>
      <div className="datum-sidebar-actions">
        <button type="button" className="ncb sec-btn" onClick={captureGpsDatum}>
          <ButtonFace icon={<NavGlyph kind="gpsFix" />} label="CAPTURE" meta="Use current fix" compact />
        </button>
        <button type="button" className="ncb send-btn" onClick={saveManualDatum}>
          <ButtonFace icon={<NavGlyph kind="pin" />} label="SAVE" meta="Manual datum" compact />
        </button>
        <button
          type="button"
          className="ncb sec-btn"
          onClick={() => void refreshDatums().catch((error) => emit("warn", `Refresh datums failed: ${String(error)}`))}
        >
          <ButtonFace icon={<NavGlyph kind="refresh" />} label="REFRESH" meta="Backend list" compact />
        </button>
      </div>
      <div className="datum-sidebar-list">
        {datums.map((entry) => (
          <div key={entry.id} className={joinClassNames("datum-sidebar-row", entry.id === datumProfiles?.selectedId && "selected")}>
            <button type="button" className="datum-sidebar-select" onClick={() => selectDatum(entry.id)} title="Seleccionar para proximo launch ROS">
              {entry.id === datumProfiles?.selectedId ? "●" : "○"}
            </button>
            <span>
              <strong>{entry.name}</strong>
              <small>
                {formatDatumCoordinate(entry.lat)}, {formatDatumCoordinate(entry.lon)} · yaw {entry.yawDeg.toFixed(1)}°
              </small>
            </span>
            <button type="button" className="datum-sidebar-delete danger-btn" onClick={() => deleteDatum(entry.id)} title="Eliminar datum">
              ×
            </button>
          </div>
        ))}
      </div>
    </NavSidebarCollapsibleSection>
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
            className="button-tile button-secondary"
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
            <ButtonFace icon={<NavGlyph kind="refresh" />} label="Refresh" meta="Fetch latest zones" compact />
          </button>
          <button
            type="button"
            className="danger-btn button-tile"
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
            <ButtonFace icon={<NavGlyph kind="clear" />} label="Clear" meta="Remove all zones" compact />
          </button>
          <button
            type="button"
            className="button-primary button-tile"
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
            <ButtonFace icon={<NavGlyph kind="save" />} label="Save" meta="Push and persist" compact />
          </button>
          <button
            type="button"
            className="button-secondary button-tile"
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
            <ButtonFace icon={<NavGlyph kind="load" />} label="Load" meta="Restore saved zones" compact />
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
                  <ButtonFace icon={<NavGlyph kind="remove" />} label="Remove" meta="Delete zone" compact />
                </button>
              </li>
            ))}
          </ul>
        )}
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

function openNavLiveWindow(connectionService: ConnectionService, runtime: ModuleContext): void {
  if (typeof window === "undefined") return;
  const state = connectionService.getState();
  const url = new URL(window.location.href);
  url.searchParams.set("view", "nav-live");
  url.searchParams.set("preset", state.preset || "real");
  url.searchParams.set("host", state.host);
  url.searchParams.set("port", state.port);
  url.hash = "";
  const popup = window.open(
    url.toString(),
    "cockpit-nav-live",
    "popup,width=900,height=900,resizable=yes,scrollbars=no"
  );
  if (popup) {
    popup.focus();
    return;
  }
  runtime.eventBus.emit("console.event", {
    level: "error",
    text: "Nav Live window was blocked by the browser.",
    timestamp: Date.now()
  });
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

  const hasSnapshot = Boolean(snapshot?.imageBase64);

  return (
    <div className="snapshot-modal">
      <div className="snapshot-toolbar">
        <button
          type="button"
          className="snapshot-btn snapshot-btn-primary"
          disabled={loading}
          onClick={() => {
            void captureSnapshot();
          }}
        >
          {loading ? (
            "Loading..."
          ) : (
            <>
              <SnapshotGlyph kind="capture" />
              {hasSnapshot ? "Recapturar" : "Capturar vista"}
            </>
          )}
        </button>
        <button
          type="button"
          className="snapshot-btn snapshot-btn-secondary"
          disabled={!snapshot}
          onClick={download}
        >
          <SnapshotGlyph kind="download" />
          Descargar
        </button>
      </div>

      <div className={`snapshot-stage${hasSnapshot ? " has-image" : ""}`}>
        {snapshot?.imageBase64 ? (
          <>
            <img
              className="snapshot-image"
              src={`data:${snapshot.mime};base64,${snapshot.imageBase64}`}
              alt="Navigation snapshot"
            />
            <div className="snapshot-caption">
              <span>{snapshot.width}×{snapshot.height} px</span>
              <span className="snapshot-caption-dot" aria-hidden="true">·</span>
              <span>{formatSnapshotSize(snapshot.imageSizeBytes)}</span>
              <span className="snapshot-caption-dot" aria-hidden="true">·</span>
              <span>{new Date(snapshot.stamp).toLocaleTimeString()}</span>
            </div>
          </>
        ) : (
          <div className="snapshot-empty">
            <SnapshotGlyph kind="capture" />
            <p className="snapshot-empty-title">Sin captura todavía</p>
            <p className="snapshot-empty-subtitle">
              Presioná <strong>Capturar vista</strong> para guardar el estado actual de la ruta.
            </p>
          </div>
        )}
      </div>

      <p className="snapshot-hint">
        <kbd>Esc</kbd> cerrar
        <span className="snapshot-hint-dot" aria-hidden="true">·</span>
        <kbd>Shift</kbd>+<kbd>Esc</kbd> descargar y cerrar
      </p>
    </div>
  );
}

function formatSnapshotSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function SnapshotGlyph({ kind }: { kind: "capture" | "download" }): JSX.Element {
  if (kind === "download") {
    return (
      <svg className="snapshot-glyph" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <path d="M12 3v11m0 0 4-4m-4 4-4-4M5 19h14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg className="snapshot-glyph" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h1.7l.9-1.6A1 1 0 0 1 9 5h6a1 1 0 0 1 .9.4L16.8 7h1.7A1.5 1.5 0 0 1 20 8.5v9A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <circle cx="12" cy="12.5" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
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
      {!showDisconnected && (!state.loading[state.activeTab] || activePayload) && state.activeTab === "topics" && !state.implemented.topics ? (
        <div className="panel-card info-placeholder-card">
          <strong>Topics</strong>
          <p className="muted">Topic stream bridge not available in this backend.</p>
        </div>
      ) : null}
      {!showDisconnected && (!state.loading[state.activeTab] || activePayload) && state.activeTab === "topics" && state.implemented.topics ? (
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

function registerServices(
  ctx: ModuleContext,
  dispatcher: RobotDispatcher
): { navigationService: NavigationService; connectionService: ConnectionService } {
  const config = readNav2Config(ctx);
  const limits = parseManualSpeedLimits(config);
  const navigationService = new NavigationService(dispatcher, {
    linearMin: limits.linearMin,
    linearMax: limits.linearMax,
    steeringAngleMinDeg: limits.steeringAngleMinDeg,
    steeringAngleMaxDeg: limits.steeringAngleMaxDeg,
    linearSpeed: parseNumberInRange(config.manual_linear_speed_default, 1.2, limits.linearMin, limits.linearMax),
    steeringAngleDeg: parseNumberInRange(
      config.manual_steering_angle_default_deg,
      DEFAULT_MANUAL_STEERING_ANGLE_DEG,
      limits.steeringAngleMinDeg,
      limits.steeringAngleMaxDeg
    ),
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
  connectionService.subscribe((state) => {
    if (!state.connected) {
      navigationService.applyLocalControlLock(true, "DISCONNECTED");
      return;
    }
    if (state.preset === "sim") {
      navigationService.applyLocalControlLock(false, "SIM_BACKEND");
    }
  });
  ctx.eventBus.on<{ packageId?: unknown; config?: unknown }>(CORE_EVENTS.packageConfigUpdated, (payload) => {
    const packageId = typeof payload?.packageId === "string" ? payload.packageId : "";
    if (packageId !== "nav2") return;
    const nextConfig = (payload.config ?? {}) as Nav2RuntimeConfig;
    const nextLimits = parseManualSpeedLimits(nextConfig);
    connectionService.applyPresetDefaults(buildConnectionPresetDefaults(ctx, nextConfig));
    navigationService.applyRuntimeDefaults({
      linearMin: nextLimits.linearMin,
      linearMax: nextLimits.linearMax,
      steeringAngleMinDeg: nextLimits.steeringAngleMinDeg,
      steeringAngleMaxDeg: nextLimits.steeringAngleMaxDeg,
      linearSpeed: parseNumberInRange(nextConfig.manual_linear_speed_default, 1.2, nextLimits.linearMin, nextLimits.linearMax),
      steeringAngleDeg: parseNumberInRange(
        nextConfig.manual_steering_angle_default_deg,
        DEFAULT_MANUAL_STEERING_ANGLE_DEG,
        nextLimits.steeringAngleMinDeg,
        nextLimits.steeringAngleMaxDeg
      ),
      loopIntervalMs: parseLoopIntervalMs(nextConfig.manual_loop_interval_ms, 50)
    });
  });

  const sensorInfoService = new SensorInfoService(dispatcher);
  ctx.services.registerService({
    id: SENSOR_INFO_SERVICE_ID,
    service: sensorInfoService
  });

  return { navigationService, connectionService };
}

function RtkSourceModal({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const telemetryService = getTelemetryService(runtime);
  const nav2Config = readNav2Config(runtime);
  const [snapshot, setSnapshot] = useState<TelemetrySnapshot | null>(
    telemetryService ? telemetryService.getSnapshot() : null
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [savingSource, setSavingSource] = useState(false);
  const [sourceDraft, setSourceDraft] = useState<RtkSourceDraft>({
    id: "",
    label: "",
    host: "",
    port: 2101,
    mountpoint: "",
    username: "",
    password: "",
    activate: true
  });

  useEffect(() => {
    if (!telemetryService) return;
    return telemetryService.subscribeTelemetry((next) => setSnapshot(next));
  }, [telemetryService]);

  const rtkState = (snapshot?.rtkSourceState ?? null) as Record<string, unknown> | null;
  const sources = snapshot?.rtkSources ?? [];
  const backendActiveId = String(rtkState?.active_source_id ?? "").trim();
  const backendActiveLabel = String(rtkState?.active_source_label ?? backendActiveId).trim();
  const gpsStatus = snapshot?.gpsStatus ?? {};
  const gpsRtkText = String(
    gpsStatus.label ?? gpsStatus.normalized ?? gpsStatus.raw ?? ""
  ).trim().toLowerCase();
  const hasRtkCorrections =
    gpsStatus.available === true &&
    (gpsRtkText.includes("rtk") || gpsRtkText.includes("rtcm"));
  const fallbackId = String(nav2Config.rtk_default_source_id ?? "").trim();
  const fallbackLabel = String(nav2Config.rtk_default_source_label ?? fallbackId).trim();
  const usingConfiguredFallback =
    !backendActiveId &&
    !backendActiveLabel &&
    sources.length === 0 &&
    hasRtkCorrections &&
    Boolean(fallbackId || fallbackLabel);
  const activeId = backendActiveId || (usingConfiguredFallback ? fallbackId : "");
  const activeLabel = backendActiveLabel || (usingConfiguredFallback ? fallbackLabel : "");
  const connected = rtkState?.connected === true || usingConfiguredFallback;
  const visibleSources = sources.length > 0
    ? sources
    : usingConfiguredFallback
      ? [{ id: activeId || "configured-rtk", label: activeLabel || activeId }]
      : [];
  const statusText = usingConfiguredFallback
    ? "Correcciones activas · fuente configurada (backend sin identidad)"
    : connected
    ? "Correcciones conectadas"
    : activeId
      ? "Base seleccionada · esperando correcciones"
      : "Sin fuente activa";

  const emit = (level: string, text: string): void => {
    runtime.eventBus.emit("console.event", { level, text, timestamp: Date.now() });
  };

  const selectSource = async (sourceId: string): Promise<void> => {
    if (!telemetryService || sourceId === activeId || busyId !== null) return;
    setBusyId(sourceId);
    try {
      await telemetryService.selectRtkSource(sourceId);
      emit("info", `Cambiando a fuente RTK "${sourceId}"`);
    } catch (error) {
      emit("error", `No se pudo cambiar la fuente RTK: ${String(error)}`);
    } finally {
      setBusyId(null);
    }
  };
  const updateDraft = (key: keyof RtkSourceDraft, value: string | boolean | number): void => {
    setSourceDraft((current) => ({ ...current, [key]: value }));
  };
  const draftId = sourceDraft.id.trim();
  const draftHost = sourceDraft.host.trim();
  const draftMountpoint = sourceDraft.mountpoint.trim();
  const canSaveSource = Boolean(draftId && draftHost && draftMountpoint && Number.isFinite(sourceDraft.port) && sourceDraft.port > 0);
  const saveSource = async (): Promise<void> => {
    if (!telemetryService || !canSaveSource || savingSource) return;
    setSavingSource(true);
    try {
      await telemetryService.upsertRtkSource({
        ...sourceDraft,
        id: draftId,
        label: sourceDraft.label.trim() || draftId,
        host: draftHost,
        port: Math.trunc(Number(sourceDraft.port)),
        mountpoint: draftMountpoint,
        username: sourceDraft.username.trim(),
        password: sourceDraft.password.trim()
      });
      emit("info", `Antena RTK "${sourceDraft.label.trim() || draftId}" guardada`);
      setSourceDraft({
        id: "",
        label: "",
        host: "",
        port: 2101,
        mountpoint: "",
        username: "",
        password: "",
        activate: true
      });
      setShowAddForm(false);
    } catch (error) {
      emit("error", `No se pudo guardar la antena RTK: ${String(error)}`);
    } finally {
      setSavingSource(false);
    }
  };

  return (
    <div className="rtk-modal">
      <div className="rtk-modal-status">
        <span className={joinClassNames("rtk-status-dot", connected && "connected")} aria-hidden="true" />
        <div className="rtk-modal-status-copy">
          <strong>Fuente activa: {activeLabel || "—"}</strong>
          <span>{statusText}</span>
          {activeId ? <code>{activeId}</code> : null}
        </div>
      </div>
      {visibleSources.length > 0 ? (
        <ul className="rtk-source-list">
          {visibleSources.map((source) => {
            const isActive = source.id === activeId;
            const isBusy = busyId === source.id;
            return (
              <li key={source.id}>
                <button
                  type="button"
                  className={joinClassNames("rtk-source-btn", isActive && "active")}
                  disabled={usingConfiguredFallback || isActive || busyId !== null}
                  title={
                    usingConfiguredFallback
                      ? "Fuente configurada localmente; el backend no publica su identidad"
                      : isActive
                        ? "Antena activa"
                        : `Cambiar a ${source.label}`
                  }
                  onClick={() => void selectSource(source.id)}
                >
                  <span className="rtk-source-label">{source.label}</span>
                  <span className="rtk-source-tag">
                    {usingConfiguredFallback ? "Configurada" : isActive ? "Activa" : isBusy ? "Cambiando…" : "Usar"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="rtk-empty muted">No hay antenas configuradas (revisá rtk_sources.yaml).</p>
      )}
      <button
        type="button"
        className="rtk-add-toggle"
        onClick={() => setShowAddForm((current) => !current)}
      >
        {showAddForm ? "Cerrar formulario" : "Agregar antena"}
      </button>
      {showAddForm ? (
        <form
          className="rtk-add-form"
          onSubmit={(event) => {
            event.preventDefault();
            void saveSource();
          }}
        >
          <div className="rtk-form-grid">
            <label>
              ID
              <input
                value={sourceDraft.id}
                onChange={(event) => updateDraft("id", event.target.value)}
                placeholder="ej: base_sur"
                autoComplete="off"
              />
            </label>
            <label>
              Nombre
              <input
                value={sourceDraft.label}
                onChange={(event) => updateDraft("label", event.target.value)}
                placeholder="Base Sur"
                autoComplete="off"
              />
            </label>
            <label className="rtk-form-wide">
              Host
              <input
                value={sourceDraft.host}
                onChange={(event) => updateDraft("host", event.target.value)}
                placeholder="rtk2go.com"
                autoComplete="off"
              />
            </label>
            <label>
              Puerto
              <input
                type="number"
                min={1}
                max={65535}
                value={sourceDraft.port}
                onChange={(event) => updateDraft("port", Number(event.target.value))}
              />
            </label>
            <label>
              Mountpoint
              <input
                value={sourceDraft.mountpoint}
                onChange={(event) => updateDraft("mountpoint", event.target.value)}
                placeholder="CASISA"
                autoComplete="off"
              />
            </label>
            <label>
              Usuario
              <input
                value={sourceDraft.username}
                onChange={(event) => updateDraft("username", event.target.value)}
                placeholder="opcional"
                autoComplete="username"
              />
            </label>
            <label>
              Password
              <input
                type="password"
                value={sourceDraft.password}
                onChange={(event) => updateDraft("password", event.target.value)}
                placeholder="opcional"
                autoComplete="new-password"
              />
            </label>
          </div>
          <label className="rtk-activate-row">
            <input
              type="checkbox"
              checked={sourceDraft.activate}
              onChange={(event) => updateDraft("activate", event.target.checked)}
            />
            Activarla al guardar
          </label>
          <button type="submit" className="rtk-save-btn" disabled={!canSaveSource || savingSource}>
            {savingSource ? "Guardando..." : "Guardar antena"}
          </button>
        </form>
      ) : null}
    </div>
  );
}

function registerSidebarPanels(ctx: ModuleContext): void {
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
  ctx.contributions.register({
    id: "modal.rtk",
    slot: "modal",
    title: "RTK · Antena",
    render: () => <RtkSourceModal runtime={ctx} />
  });
}

function registerToolbar(ctx: ModuleContext): void {
  ctx.contributions.register({
    id: "toolbar.rtk",
    slot: "toolbar",
    label: "RTK",
    commandId: NavigationCommands.openRtkModal
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

function registerCommands(
  ctx: ModuleContext,
  navigationService: NavigationService,
  connectionService: ConnectionService
): void {
  ctx.commands.register(
    { id: NavigationCommands.connectionConnect, title: "Connection Connect", category: "Navigation" },
    () => {
      void connectionService.connect().catch((error: unknown) => {
        ctx.eventBus.emit("console.event", {
          level: "error",
          text: `Connection command failed: ${String(error)}`,
          timestamp: Date.now()
        });
      });
    }
  );

  ctx.commands.register(
    { id: NavigationCommands.connectionDisconnect, title: "Connection Disconnect", category: "Navigation" },
    () => {
      void connectionService.disconnect().catch((error: unknown) => {
        ctx.eventBus.emit("console.event", {
          level: "error",
          text: `Disconnect command failed: ${String(error)}`,
          timestamp: Date.now()
        });
      });
    }
  );

  ctx.commands.register(
    { id: NavigationCommands.connectionSetPreset, title: "Connection Set Preset", category: "Navigation" },
    (preset?: unknown) => {
      connectionService.setPreset(preset === "sim" ? "sim" : "real");
      const state = connectionService.getState();
      ctx.eventBus.emit("console.event", {
        level: "info",
        text: `Connection preset set to ${state.preset}`,
        timestamp: Date.now()
      });
    }
  );

  ctx.commands.register(
    { id: NavigationCommands.connectionSetHost, title: "Connection Set Host", category: "Navigation" },
    (host?: unknown) => {
      if (typeof host !== "string" || host.trim().length === 0) return;
      connectionService.setHost(host.trim());
      ctx.eventBus.emit("console.event", {
        level: "info",
        text: `Connection host set to ${host.trim()}`,
        timestamp: Date.now()
      });
    }
  );

  ctx.commands.register(
    { id: NavigationCommands.connectionSetPort, title: "Connection Set Port", category: "Navigation" },
    (port?: unknown) => {
      if (typeof port !== "string" || port.trim().length === 0) return;
      connectionService.setPort(port.trim());
      ctx.eventBus.emit("console.event", {
        level: "info",
        text: `Connection port set to ${port.trim()}`,
        timestamp: Date.now()
      });
    }
  );

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
    { id: NavigationCommands.openLiveNavWindow, title: "Open Nav Live Window", category: "Navigation" },
    () => {
      openNavLiveWindow(connectionService, ctx);
    }
  );

  ctx.commands.register(
    { id: NavigationCommands.openInfoModal, title: "Open Info Modal", category: "Navigation" },
    () => {
      void ctx.commands.execute(ShellCommands.openModal, "modal.info");
    }
  );

  ctx.commands.register(
    { id: NavigationCommands.openRtkModal, title: "Open RTK Modal", category: "Navigation" },
    () => {
      void ctx.commands.execute(ShellCommands.openModal, "modal.rtk");
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

  ctx.commands.register(
    { id: NavigationCommands.saveCurrentPoseWaypoint, title: "Save Waypoint At Robot Pose", category: "Navigation" },
    () => {
      const pose = getTelemetryService(ctx)?.getSnapshot().robotPose ?? null;
      if (!pose || !Number.isFinite(Number(pose.lat)) || !Number.isFinite(Number(pose.lon))) {
        ctx.eventBus.emit("console.event", {
          level: "error",
          text: "No hay posición del robot disponible para guardar waypoint",
          timestamp: Date.now()
        });
        return;
      }
      try {
        navigationService.queueWaypoint({ x: Number(pose.lat), y: Number(pose.lon) });
        ctx.eventBus.emit("console.event", {
          level: "info",
          text: `Waypoint guardado en posición actual (${Number(pose.lat).toFixed(7)}, ${Number(pose.lon).toFixed(7)})`,
          timestamp: Date.now()
        });
      } catch (error) {
        ctx.eventBus.emit("console.event", {
          level: "error",
          text: `No se pudo guardar el waypoint: ${String(error)}`,
          timestamp: Date.now()
        });
      }
    }
  );

  // Keybindings
  ctx.keybindings.register({ key: "q", commandId: NavigationCommands.openLiveNavWindow, source: "default" });
  ctx.keybindings.register({ key: "i", commandId: NavigationCommands.openInfoModal, source: "default", when: "!modalOpen" });
  ctx.keybindings.register({ key: "e", commandId: NavigationCommands.swapWorkspace, source: "default", when: "!modalOpen" });
  ctx.keybindings.register({ key: "f", commandId: NavigationCommands.toggleManualMode, source: "default", when: "!modalOpen" });
  ctx.keybindings.register({ key: "m", commandId: NavigationCommands.toggleManualMode, source: "default", when: "!modalOpen" });
  ctx.keybindings.register({ key: "z", commandId: NavigationCommands.saveCurrentPoseWaypoint, source: "default", when: "!modalOpen" });
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
  ctx.keybindings.register({ key: "shift+up", commandId: NavigationCommands.panCameraUp, source: "default", when: "!modalOpen" });
  ctx.keybindings.register({ key: "shift+down", commandId: NavigationCommands.panCameraDown, source: "default", when: "!modalOpen" });
  ctx.keybindings.register({ key: "shift+left", commandId: NavigationCommands.panCameraLeft, source: "default", when: "!modalOpen" });
  ctx.keybindings.register({ key: "shift+right", commandId: NavigationCommands.panCameraRight, source: "default", when: "!modalOpen" });
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
      const { navigationService, connectionService } = registerServices(ctx, dispatcher);
      registerCommands(ctx, navigationService, connectionService);
      registerSidebarPanels(ctx);
      registerModals(ctx);
      registerToolbar(ctx);
      registerFooterItems(ctx);
    }
  };
}
