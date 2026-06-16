import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createWebZoneClient,
  realBackendDefault,
  resolveWebZoneUrl,
  type WebZoneClient,
  type WebZoneMessage,
} from '../backend/webZoneClient';
import type { CameraDetection, LatLng, RobotState, RobotStatus } from '../types';

const NOMINAL_SPEED_KMH = 5;
const MIN_DETECTION_CONFIDENCE = 0.7;
const CAMERA_STALE_MS = 2500;
const DETECTION_STALE_MS = 1500;
const ACTION_ERROR_TTL_MS = 6000;
const DEFAULT_MAP_POSITION: LatLng = { lat: -31.4201, lng: -64.1888 };

type MissionMeta = {
  active: boolean;
  paused: boolean;
  name: string;
  currentTargetIndex: number;
  inputCount: number;
} | null;

type EditableRobotState = {
  name: string;
  serial: string;
  backendConnected: boolean;
  backendConnecting: boolean;
  backendUrl: string;
  backendError: string;
  host: string;
  port: string;
  battery: number | null;
  gpsFixed: boolean;
  gpsLabel: string;
  rtk: boolean;
  connection: RobotState['connection'];
  speedKmh: number;
  steeringDeg: number;
  targetSpeedMs: number;
  mode: RobotState['mode'];
  controlLocked: boolean;
  controlLockReason: string;
  goalActive: boolean;
  lastStatus: RobotState['lastStatus'];
  position: LatLng | null;
  headingDeg: number;
  route: LatLng[];
  waypoints: LatLng[];
  selectedWaypointIndexes: number[];
  cameraFrameUrl: string | null;
  lastFrameMs: number;
  detections: CameraDetection[];
  lastDetectionMs: number;
  backendAlerts: RobotState['alerts'];
  missionMeta: MissionMeta;
};

export type RobotActions = {
  connect(): void;
  disconnect(): void;
  setManualMode(enabled: boolean): void;
  sendManualCommand(linearX: number, angularZ: number, brake?: boolean): void;
  increaseSpeed(): void;
  decreaseSpeed(): void;
  setTargetSpeed(valueMs: number): void;
  addWaypoint(point: LatLng): void;
  moveWaypoint(index: number, point: LatLng): void;
  toggleWaypointSelection(index: number): void;
  removeWaypoint(index: number): void;
  removeLastWaypoint(): void;
  removeSelectedWaypoints(): void;
  clearWaypoints(): void;
  dispatchQueuedGoal(): void;
  dispatchGoal(point: LatLng): void;
  startRoute(): void;
  pauseRoute(): void;
  cancelRoute(): void;
  panCamera(angleDeg: number): void;
  toggleCameraZoom(): void;
};

export type RobotStateWithActions = RobotState & RobotActions;

function parseHostPort(url: string): { host: string; port: string } {
  const defaults = realBackendDefault();
  try {
    const parsed = new URL(url);
    return { host: parsed.hostname || defaults.host, port: parsed.port || defaults.port };
  } catch {
    return defaults;
  }
}

const initialUrl = resolveWebZoneUrl();
const initialHostPort = parseHostPort(initialUrl);

const initialState: EditableRobotState = {
  name: 'SALUS-01',
  serial: '01-2468',
  backendConnected: false,
  backendConnecting: false,
  backendUrl: initialUrl,
  backendError: '',
  host: initialHostPort.host,
  port: initialHostPort.port,
  battery: null,
  gpsFixed: false,
  gpsLabel: '—',
  rtk: false,
  connection: 'sin_señal',
  speedKmh: 0,
  steeringDeg: 0,
  targetSpeedMs: 0.4,
  mode: 'autonomo',
  controlLocked: false,
  controlLockReason: '',
  goalActive: false,
  lastStatus: null,
  position: DEFAULT_MAP_POSITION,
  headingDeg: 0,
  route: [],
  waypoints: [],
  selectedWaypointIndexes: [],
  cameraFrameUrl: null,
  lastFrameMs: 0,
  detections: [],
  lastDetectionMs: 0,
  backendAlerts: [],
  missionMeta: null,
};

// ---------- helpers de parsing ----------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function asNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isUsableLatLng(lat: number, lng: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(Math.abs(lat) < 0.0001 && Math.abs(lng) < 0.0001);
}

function sanitizeSelection(selection: number[], max: number): number[] {
  return Array.from(
    new Set(selection.filter((index) => Number.isInteger(index) && index >= 0 && index < max)),
  ).sort((a, b) => a - b);
}

function waypointToWire(point: LatLng): { lat: number; lon: number; yaw_deg?: number } {
  const waypoint: { lat: number; lon: number; yaw_deg?: number } = { lat: point.lat, lon: point.lng };
  if (Number.isFinite(Number(point.yawDeg))) {
    waypoint.yaw_deg = Number(point.yawDeg);
  }
  return waypoint;
}

function messagePayload(message: WebZoneMessage): Record<string, unknown> {
  const payload = readRecord(message.payload);
  return payload ? { ...message, ...payload } : message;
}

function normalizeBackendAlert(raw: unknown, index: number): RobotState['alerts'][number] | null {
  if (!isRecord(raw)) {
    return null;
  }
  const text = String(raw.text ?? raw.message ?? raw.msg ?? '').trim();
  if (!text) {
    return null;
  }
  const rawLevel = String(raw.level ?? raw.severity ?? 'info').toLowerCase();
  const level = rawLevel === '2' || rawLevel === 'error' || rawLevel === 'critical'
    ? 'critical'
    : rawLevel === '1' || rawLevel === 'warn' || rawLevel === 'warning'
      ? 'warning'
      : 'info';
  return { id: String(raw.id ?? raw.code ?? raw.event_id ?? `backend-alert-${index}`), level, text };
}

function gpsFromStatus(raw: unknown): { fixed: boolean; label: string; rtk: boolean } | null {
  const gps = readRecord(raw);
  if (!gps) {
    return null;
  }
  const normalized = String(gps.normalized ?? '').toLowerCase();
  const label = String(gps.label ?? gps.normalized ?? '—') || '—';
  const text = `${normalized} ${label}`.toLowerCase();
  const fixed = Boolean(normalized) && !normalized.includes('no_fix') && !normalized.includes('waiting') && !normalized.includes('unavailable');
  return { fixed, label, rtk: text.includes('rtk') };
}

function isExplicitFalse(value: unknown): boolean {
  if (value === false || value === 0) {
    return true;
  }
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    return text === 'false' || text === '0' || text === 'no';
  }
  return false;
}

function driveTelemetryFromPayload(payload: Record<string, unknown>): { hasTelemetry: boolean; speedKmh: number | null; steeringDeg: number | null } {
  const controllerTelemetry = readRecord(payload.controller_telemetry);
  const candidates = [
    readRecord(payload.drive_telemetry),
    payload.speed_mps_measured !== undefined || payload.speed_mps !== undefined ? payload : null,
    readRecord(payload.telemetry),
    readRecord(controllerTelemetry?.telemetry),
  ].filter((entry): entry is Record<string, unknown> => entry !== null);

  for (const candidate of candidates) {
    if (isExplicitFalse(candidate.available)) {
      continue;
    }

    const fresh = !isExplicitFalse(candidate.fresh);
    const speedRaw = candidate.speed_mps_measured ?? candidate.speed_mps ?? candidate.linear_x_mps;
    const steerRaw = candidate.steer_deg_measured ?? candidate.steer_deg ?? candidate.steering_deg;
    const speedValid = fresh && !isExplicitFalse(candidate.speed_valid) && speedRaw !== undefined;
    const steerValid = fresh && !isExplicitFalse(candidate.steer_valid) && steerRaw !== undefined;

    return {
      hasTelemetry: true,
      speedKmh: speedValid ? Math.abs(asNumber(speedRaw, 0)) * 3.6 : 0,
      steeringDeg: steerValid ? Math.max(-30, Math.min(30, asNumber(steerRaw, 0))) : 0,
    };
  }

  return { hasTelemetry: false, speedKmh: null, steeringDeg: null };
}

function routeFromMission(raw: unknown): LatLng[] {
  const mission = readRecord(raw);
  const candidates = [mission?.active_chunk_waypoints, mission?.mission_waypoints];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) {
      continue;
    }
    const route = candidate
      .map((entry) => {
        const value = readRecord(entry);
        if (!value) {
          return null;
        }
        const lat = Number(value.lat);
        const lng = Number(value.lon ?? value.lng);
        return isUsableLatLng(lat, lng) ? { lat, lng } : null;
      })
      .filter((entry): entry is LatLng => entry !== null);
    if (route.length > 0) {
      return route;
    }
  }
  return [];
}

function missionMetaFromBackend(raw: unknown, current: MissionMeta): MissionMeta {
  const mission = readRecord(raw);
  if (!mission) {
    return current;
  }
  const active = mission.active === true || String(mission.status ?? '').toLowerCase().includes('active');
  const paused = mission.paused === true;
  if (!active && !paused) {
    return null;
  }
  return {
    active,
    paused,
    name: current?.name ?? 'Misión de ruta',
    currentTargetIndex: Math.max(0, asNumber(mission.current_target_index, 0)),
    inputCount: Math.max(1, asNumber(mission.input_waypoint_count, current?.inputCount ?? 1)),
  };
}

// ACKs que se muestran al operador (los demás —heartbeat, get_state, lock— son ruido).
const ACK_LABELS: Record<string, string> = {
  set_goal_ll: 'Destino enviado',
  set_route_ll: 'Ruta iniciada',
  cancel_goal: 'Destino cancelado',
  cancel_route: 'Ruta cancelada',
  brake: 'Frenado',
  set_manual_mode: 'Modo cambiado',
  camera_pan: 'Cámara movida',
  camera_zoom_toggle: 'Zoom de cámara cambiado',
};

function parseDetections(raw: unknown): CameraDetection[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((entry, index): CameraDetection | null => {
      const det = readRecord(entry);
      if (!det) {
        return null;
      }
      const score = Math.max(0, Math.min(1, asNumber(det.confidence ?? det.score, 0)));
      if (score < MIN_DETECTION_CONFIDENCE) {
        return null;
      }
      const box = det.bbox;
      let x = 0;
      let y = 0;
      let w = 0;
      let h = 0;
      if (Array.isArray(box) && box.length === 4) {
        // [left, top, right, bottom] normalizado
        const [left, top, right, bottom] = box.map(Number);
        x = left;
        y = top;
        w = right - left;
        h = bottom - top;
      } else {
        const b = readRecord(box);
        if (!b) {
          return null;
        }
        x = asNumber(b.x ?? b.left, 0);
        y = asNumber(b.y ?? b.top, 0);
        w = asNumber(b.w ?? b.width, 0);
        h = asNumber(b.h ?? b.height, 0);
      }
      if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) {
        return null;
      }
      return {
        id: String(det.id ?? `${det.class ?? det.label ?? 'obj'}-${index}`),
        label: String(det.class ?? det.label ?? 'objeto'),
        score,
        bbox: {
          x: Math.max(0, Math.min(1, x)),
          y: Math.max(0, Math.min(1, y)),
          w: Math.max(0, Math.min(1, w)),
          h: Math.max(0, Math.min(1, h)),
        },
      };
    })
    .filter((det): det is CameraDetection => det !== null);
}

// ---------- geometría de misión ----------

function metersBetween(a: LatLng, b: LatLng): number {
  const earthRadiusM = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * earthRadiusM * Math.asin(Math.min(1, Math.sqrt(h)));
}

function routeLengthMeters(points: LatLng[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += metersBetween(points[index - 1], points[index]);
  }
  return total;
}

// Distancia restante = se proyecta la posición sobre el tramo más cercano y se suma lo que falta
// hasta el final. Así la barra avanza suave y llega a 100% al alcanzar el destino.
function remainingRouteMeters(position: LatLng, points: LatLng[]): number {
  if (points.length === 0) {
    return 0;
  }
  if (points.length === 1) {
    return metersBetween(position, points[0]);
  }

  let best = { segIndex: 0, projected: points[0], dist: Infinity };
  for (let index = 0; index < points.length - 1; index += 1) {
    const a = points[index];
    const b = points[index + 1];
    const mPerLat = 111_320;
    const mPerLng = 111_320 * Math.max(1e-6, Math.cos((a.lat * Math.PI) / 180));
    const bx = (b.lng - a.lng) * mPerLng;
    const by = (b.lat - a.lat) * mPerLat;
    const px = (position.lng - a.lng) * mPerLng;
    const py = (position.lat - a.lat) * mPerLat;
    const len2 = bx * bx + by * by;
    const t = len2 > 0 ? Math.max(0, Math.min(1, (px * bx + py * by) / len2)) : 0;
    const cx = t * bx;
    const cy = t * by;
    const dist = Math.hypot(px - cx, py - cy);
    if (dist < best.dist) {
      best = { segIndex: index, projected: { lat: a.lat + cy / mPerLat, lng: a.lng + cx / mPerLng }, dist };
    }
  }

  let remaining = metersBetween(best.projected, points[best.segIndex + 1]);
  remaining += routeLengthMeters(points.slice(best.segIndex + 1));
  return remaining;
}

function computeMission(raw: EditableRobotState): RobotState['mission'] {
  const meta = raw.missionMeta;
  if (!meta) {
    return null;
  }

  const points = raw.route.length >= 2 ? raw.route : raw.waypoints;
  let remainingMeters = 0;
  let progress = meta.inputCount > 0 ? Math.round((meta.currentTargetIndex / meta.inputCount) * 100) : 0;
  let etaMinutes = 0;

  if (points.length >= 2 && raw.position) {
    const total = routeLengthMeters(points);
    const remaining = remainingRouteMeters(raw.position, points);
    const reference = Math.max(total, remaining, 1);
    remainingMeters = Math.round(remaining);
    progress = Math.round(Math.min(100, Math.max(0, ((reference - remaining) / reference) * 100)));
    const effectiveSpeedKmh = raw.speedKmh > 0.3 ? raw.speedKmh : NOMINAL_SPEED_KMH;
    etaMinutes = remaining > 1 ? (remaining / 1000 / effectiveSpeedKmh) * 60 : 0;
  }

  return {
    name: meta.paused ? `${meta.name} (en pausa)` : meta.name,
    active: meta.active,
    paused: meta.paused,
    progress: Math.min(100, Math.max(0, progress)),
    remainingMeters,
    etaMinutes,
    currentWaypoint: Math.min(meta.inputCount, meta.currentTargetIndex + (meta.active ? 1 : 0)),
    totalWaypoints: meta.inputCount,
  };
}

// ---------- semáforo ----------

function getStatus(raw: EditableRobotState): RobotStatus {
  if (!raw.backendConnected) {
    return raw.backendConnecting ? 'warning' : 'stopped';
  }
  if (raw.controlLocked || !raw.gpsFixed || (raw.battery !== null && raw.battery > 0 && raw.battery < 20)) {
    return 'warning';
  }
  return 'ok';
}

function getStatusLabel(raw: EditableRobotState, status: RobotStatus): string {
  if (!raw.backendConnected) {
    return raw.backendConnecting ? 'Conectando…' : 'Desconectado';
  }
  if (status === 'warning') {
    if (raw.controlLocked) return 'Controles bloqueados';
    if (!raw.gpsFixed) return 'Esperando GPS';
    return 'Batería baja';
  }
  return 'Listo para operar';
}

function getAutomaticAlerts(raw: EditableRobotState): RobotState['alerts'] {
  const alerts: RobotState['alerts'] = [];
  if (!raw.backendConnected && !raw.backendConnecting) {
    alerts.push({ id: 'backend-disconnected', level: 'critical', text: `Sin conexión con el servidor (${raw.backendUrl})` });
  }
  if (raw.backendConnected && raw.controlLocked) {
    alerts.push({ id: 'control-locked', level: 'warning', text: 'Los controles están bloqueados' });
  }
  if (raw.backendConnected && !raw.gpsFixed) {
    alerts.push({ id: 'gps-searching', level: 'warning', text: 'GPS buscando señal' });
  }
  if (raw.battery !== null && raw.battery > 0 && raw.battery < 20) {
    alerts.push({ id: 'battery-low', level: 'warning', text: 'Batería baja' });
  }
  return alerts;
}

export function useRobotState(): RobotStateWithActions {
  const [rawState, setRawState] = useState<EditableRobotState>(initialState);
  const [now, setNow] = useState(() => Date.now());
  const backendRef = useRef<WebZoneClient | null>(null);
  const stateRef = useRef(rawState);
  stateRef.current = rawState;

  useEffect(() => {
    const client = createWebZoneClient({
      onStatus(status) {
        setRawState((current) => ({
          ...current,
          backendConnected: status.connected,
          backendConnecting: status.connecting,
          backendUrl: status.url,
          backendError: status.error,
          connection: status.connected ? 'excelente' : 'sin_señal',
          // Al perder conexión, no conservamos telemetría vieja como si fuera real.
          ...(status.connected
            ? {}
            : { battery: null, gpsFixed: false, gpsLabel: '—', speedKmh: 0, steeringDeg: 0, cameraFrameUrl: null, detections: [] }),
        }));
      },
      onMessage(message) {
        const payload = messagePayload(message);
        const op = String(payload.op ?? '');

        if (op === 'camera_frame') {
          const encoding = String(payload.encoding ?? 'jpeg').toLowerCase() === 'png' ? 'png' : 'jpeg';
          const data = typeof payload.data === 'string' ? payload.data : '';
          if (!data) {
            return;
          }
          setRawState((current) => ({ ...current, cameraFrameUrl: `data:image/${encoding};base64,${data}`, lastFrameMs: Date.now() }));
          return;
        }

        if (op === 'camera_detections') {
          const detections = parseDetections(payload.detections);
          setRawState((current) => ({ ...current, detections, lastDetectionMs: Date.now() }));
          return;
        }

        // ACK del backend: misma lógica que el cockpit — confirmamos o propagamos el error.
        if (op === 'ack') {
          const request = String(payload.request ?? '');
          const ok = payload.ok !== false;
          const label = ACK_LABELS[request];
          if (!label) {
            return; // heartbeat / get_state / set_control_lock: ruido, no se muestra.
          }
          const errorText = String(payload.error ?? '').trim();
          setRawState((current) => ({
            ...current,
            lastStatus: ok
              ? { text: label, level: 'info', ts: Date.now() }
              : { text: errorText || `${label} falló`, level: 'error', ts: Date.now() },
          }));
          return;
        }

        if (op !== 'state' && op !== 'nav_telemetry' && op !== 'robot_pose' && op !== 'nav_alerts' && op !== 'drive_telemetry') {
          return;
        }

        setRawState((current) => {
          const robotPose = readRecord(payload.robot_pose) ?? readRecord(payload.pose);
          const gps = gpsFromStatus(payload.gps_status);
          const cmdVelSafe = readRecord(payload.cmd_vel_safe);
          const driveTelemetry = driveTelemetryFromPayload(payload);
          const backendAlerts = Array.isArray(payload.alerts)
            ? payload.alerts.map((entry, index) => normalizeBackendAlert(entry, index)).filter((entry): entry is RobotState['alerts'][number] => entry !== null)
            : current.backendAlerts;
          const missionRoute = routeFromMission(payload.route_mission);
          const angularZ = asNumber(cmdVelSafe?.angular_z, 0);

          const nextLat = robotPose ? asNumber(robotPose.lat, Number.NaN) : Number.NaN;
          const nextLng = robotPose ? asNumber(robotPose.lon ?? robotPose.lng, Number.NaN) : Number.NaN;
          const nextPosition = isUsableLatLng(nextLat, nextLng) ? { lat: nextLat, lng: nextLng } : current.position;

          return {
            ...current,
            battery: payload.battery_pct !== undefined ? asNumber(payload.battery_pct, current.battery ?? 0) : current.battery,
            gpsFixed: gps ? gps.fixed : current.gpsFixed,
            gpsLabel: gps ? gps.label : current.gpsLabel,
            rtk: gps ? gps.rtk : current.rtk,
            speedKmh: driveTelemetry.hasTelemetry && driveTelemetry.speedKmh !== null
              ? driveTelemetry.speedKmh
              : cmdVelSafe
                ? Math.abs(asNumber(cmdVelSafe.linear_x, 0)) * 3.6
                : current.speedKmh,
            steeringDeg: driveTelemetry.hasTelemetry && driveTelemetry.steeringDeg !== null
              ? driveTelemetry.steeringDeg
              : cmdVelSafe
                ? Math.max(-30, Math.min(30, angularZ * (180 / Math.PI) * 0.6))
                : current.steeringDeg,
            // El modo lo controla el operador (toggle/acciones), no se deriva de la telemetría,
            // para que pasar a manual no se revierta solo aunque el backend siga reportando su modo.
            mode: current.mode,
            controlLocked: payload.control_locked === true,
            controlLockReason: payload.control_locked === true ? String(payload.control_lock_reason ?? current.controlLockReason ?? '') : '',
            goalActive: payload.goal_active === true,
            position: nextPosition,
            headingDeg: robotPose ? asNumber(robotPose.heading_deg ?? robotPose.headingDeg, current.headingDeg) : current.headingDeg,
            route: missionRoute.length > 0 ? missionRoute : current.route,
            missionMeta: missionMetaFromBackend(payload.route_mission, current.missionMeta),
            backendAlerts,
          };
        });
      },
    });

    backendRef.current = client;
    // Auto-conexión inicial siempre contra el endpoint real.
    client.connect(`ws://${initialState.host}:${initialState.port}`);

    const ticker = window.setInterval(() => setNow(Date.now()), 1000);

    return () => {
      window.clearInterval(ticker);
      client.close();
      backendRef.current = null;
    };
  }, []);

  const derived = useMemo(() => {
    const status = getStatus(rawState);
    const cameraConnected = rawState.lastFrameMs > 0 && now - rawState.lastFrameMs < CAMERA_STALE_MS;
    const detectionsActive = rawState.lastDetectionMs > 0 && now - rawState.lastDetectionMs < DETECTION_STALE_MS;
    // Un ACK fallido reciente se muestra como alerta (igual que el cockpit propaga el error).
    const ackAlert =
      rawState.lastStatus && rawState.lastStatus.level === 'error' && now - rawState.lastStatus.ts < ACTION_ERROR_TTL_MS
        ? [{ id: 'action-error', level: 'critical' as const, text: rawState.lastStatus.text }]
        : [];
    return {
      status,
      statusLabel: getStatusLabel(rawState, status),
      mission: computeMission(rawState),
      cameraConnected,
      detectionsActive,
      detections: detectionsActive ? rawState.detections : [],
      alerts: [...ackAlert, ...getAutomaticAlerts(rawState), ...rawState.backendAlerts],
    };
  }, [rawState, now]);

  // ---------- acciones ----------

  function connect(): void {
    const host = stateRef.current.host.trim();
    const port = stateRef.current.port.trim();
    if (!host || !port) {
      return;
    }
    setRawState((current) => ({ ...current, backendError: '' }));
    backendRef.current?.connect(`ws://${host}:${port}`);
  }

  function disconnect(): void {
    backendRef.current?.disconnect();
  }

  // Igual que el cockpit: si los controles están bloqueados, la acción no se envía y se avisa.
  function controlsLocked(): boolean {
    if (stateRef.current.controlLocked) {
      const reason = stateRef.current.controlLockReason || 'bloqueado';
      setRawState((current) => ({ ...current, lastStatus: { text: `Los controles están bloqueados (${reason})`, level: 'error', ts: Date.now() } }));
      return true;
    }
    return false;
  }

  function setManualMode(enabled: boolean): void {
    if (enabled && controlsLocked()) {
      return;
    }
    backendRef.current?.send('set_manual_mode', { enabled });
    if (enabled) {
      backendRef.current?.send('set_manual_cmd', { linear_x: 0, angular_z: 0, brake_pct: 0 });
    }
    setRawState((current) => ({ ...current, mode: enabled ? 'manual' : 'autonomo', goalActive: enabled ? false : current.goalActive }));
  }

  function sendManualCommand(linearX: number, angularZ: number, brake = false): void {
    if (stateRef.current.controlLocked) {
      return;
    }
    backendRef.current?.send('set_manual_cmd', { linear_x: linearX, angular_z: angularZ, brake_pct: brake ? 100 : 0 });
  }

  function increaseSpeed(): void {
    setRawState((current) => ({ ...current, targetSpeedMs: Math.min(0.8, Math.round((current.targetSpeedMs + 0.1) * 10) / 10) }));
  }

  function decreaseSpeed(): void {
    setRawState((current) => ({ ...current, targetSpeedMs: Math.max(0, Math.round((current.targetSpeedMs - 0.1) * 10) / 10) }));
  }

  function setTargetSpeed(valueMs: number): void {
    const clamped = Math.max(0, Math.min(0.8, Math.round(valueMs * 20) / 20));
    setRawState((current) => ({ ...current, targetSpeedMs: clamped }));
  }

  function addWaypoint(point: LatLng): void {
    setRawState((current) => ({ ...current, waypoints: [...current.waypoints, point], selectedWaypointIndexes: [] }));
  }

  function moveWaypoint(index: number, point: LatLng): void {
    setRawState((current) => {
      if (!Number.isInteger(index) || index < 0 || index >= current.waypoints.length) {
        return current;
      }
      const previous = current.waypoints[index];
      const next = { ...point, yawDeg: Number.isFinite(Number(point.yawDeg)) ? point.yawDeg : previous.yawDeg };
      return {
        ...current,
        waypoints: current.waypoints.map((entry, entryIndex) => (entryIndex === index ? next : entry)),
      };
    });
  }

  function toggleWaypointSelection(index: number): void {
    setRawState((current) => {
      if (!Number.isInteger(index) || index < 0 || index >= current.waypoints.length) {
        return current;
      }
      const selected = new Set(current.selectedWaypointIndexes);
      if (selected.has(index)) {
        selected.delete(index);
      } else {
        selected.add(index);
      }
      return { ...current, selectedWaypointIndexes: sanitizeSelection([...selected], current.waypoints.length) };
    });
  }

  function removeWaypoint(index: number): void {
    setRawState((current) => {
      const waypoints = current.waypoints.filter((_, i) => i !== index);
      return {
        ...current,
        waypoints,
        selectedWaypointIndexes: sanitizeSelection(
          current.selectedWaypointIndexes
            .filter((selectedIndex) => selectedIndex !== index)
            .map((selectedIndex) => (selectedIndex > index ? selectedIndex - 1 : selectedIndex)),
          waypoints.length,
        ),
      };
    });
  }

  function removeLastWaypoint(): void {
    setRawState((current) => {
      const waypoints = current.waypoints.slice(0, Math.max(0, current.waypoints.length - 1));
      return { ...current, waypoints, selectedWaypointIndexes: sanitizeSelection(current.selectedWaypointIndexes, waypoints.length) };
    });
  }

  function removeSelectedWaypoints(): void {
    setRawState((current) => {
      if (current.selectedWaypointIndexes.length === 0) {
        return current;
      }
      const selected = new Set(current.selectedWaypointIndexes);
      return {
        ...current,
        waypoints: current.waypoints.filter((_, index) => !selected.has(index)),
        selectedWaypointIndexes: [],
      };
    });
  }

  function clearWaypoints(): void {
    setRawState((current) => ({ ...current, waypoints: [], selectedWaypointIndexes: [] }));
  }

  function dispatchQueuedGoal(): void {
    const waypoints = stateRef.current.waypoints;
    if (waypoints.length === 0 || controlsLocked()) {
      return;
    }
    if (stateRef.current.mode === 'manual') {
      backendRef.current?.send('set_manual_mode', { enabled: false });
    }
    backendRef.current?.send('set_goal_ll', {
      waypoints: waypoints.map(waypointToWire),
      loop: false,
    });
    setRawState((current) => ({
      ...current,
      goalActive: true,
      mode: 'autonomo',
      route: waypoints.length > 1 ? waypoints : current.position ? [current.position, waypoints[0]] : waypoints,
      missionMeta: { active: true, paused: false, name: waypoints.length > 1 ? 'Destino en cola' : 'Destino', currentTargetIndex: 0, inputCount: waypoints.length },
    }));
  }

  function dispatchGoal(point: LatLng): void {
    if (controlsLocked()) {
      return;
    }
    backendRef.current?.send('set_goal_ll', { lat: point.lat, lon: point.lng, loop: false });
    setRawState((current) => ({
      ...current,
      goalActive: true,
      mode: 'autonomo',
      waypoints: [point],
      selectedWaypointIndexes: [],
      // Ruta de 2 puntos (posición actual → destino) para que la barra de misión se complete
      // a medida que el robot llega a ESTE goal, no recién con el siguiente.
      route: current.position ? [current.position, point] : [point],
      missionMeta: { active: true, paused: false, name: 'Destino', currentTargetIndex: 0, inputCount: 1 },
    }));
  }

  function startRoute(): void {
    const waypoints = stateRef.current.waypoints;
    if (waypoints.length < 2 || controlsLocked()) {
      return;
    }
    if (stateRef.current.mode === 'manual') {
      backendRef.current?.send('set_manual_mode', { enabled: false });
    }
    backendRef.current?.send('set_route_ll', {
      waypoints: waypoints.map(waypointToWire),
      loop: false,
    });
    setRawState((current) => ({
      ...current,
      mode: 'autonomo',
      missionMeta: { active: true, paused: false, name: 'Misión de ruta', currentTargetIndex: 0, inputCount: waypoints.length },
    }));
  }

  function pauseRoute(): void {
    backendRef.current?.send('brake');
    setRawState((current) => ({
      ...current,
      speedKmh: 0,
      missionMeta: current.missionMeta ? { ...current.missionMeta, paused: true } : current.missionMeta,
    }));
  }

  function cancelRoute(): void {
    backendRef.current?.send('cancel_route');
    backendRef.current?.send('cancel_goal');
    backendRef.current?.send('brake');
    setRawState((current) => ({ ...current, speedKmh: 0, goalActive: false, missionMeta: null, route: [] }));
  }

  function panCamera(angleDeg: number): void {
    backendRef.current?.send('camera_pan', { angle: angleDeg });
  }

  function toggleCameraZoom(): void {
    backendRef.current?.send('camera_zoom_toggle');
  }

  const { lastFrameMs: _lf, lastDetectionMs: _ld, backendAlerts: _ba, missionMeta: _mm, detections: _det, ...exposed } = rawState;

  return {
    ...exposed,
    ...derived,
    connect,
    disconnect,
    setManualMode,
    sendManualCommand,
    increaseSpeed,
    decreaseSpeed,
    setTargetSpeed,
    addWaypoint,
    removeWaypoint,
    clearWaypoints,
    moveWaypoint,
    toggleWaypointSelection,
    removeLastWaypoint,
    removeSelectedWaypoints,
    dispatchQueuedGoal,
    dispatchGoal,
    startRoute,
    pauseRoute,
    cancelRoute,
    panCamera,
    toggleCameraZoom,
  };
}
