import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet-draw";
import "leaflet-draw/dist/leaflet.draw.css";
import "./styles.css";
import { CORE_EVENTS, NAV_EVENTS } from "../../../../../core/events/topics";
import type { CockpitModule, ModuleContext } from "../../../../../core/types/module";
import { MapDispatcher } from "../dispatcher/impl/MapDispatcher";
import { ConnectionService, type ConnectionState } from "../../navigation/service/impl/ConnectionService";
import { MapService, type DatumProfilesState, type MapToolMode, type MapWorkspaceState } from "../service/impl/MapService";
import {
  NavigationService,
  type GoalInput,
  type NavigationState,
  type PatrolMissionProfile
} from "../../navigation/service/impl/NavigationService";
import {
  COVERAGE_SERVICE_ID,
  type CoverageGeoPoint,
  type CoverageService,
  type CoverageState
} from "../../navigation/service/impl/CoverageService";
import {
  getRouteMissionActivityState,
  getRouteWaypointVisualState,
  normalizeRouteMissionStatus,
  type RouteWaypointVisualState
} from "../../navigation/routeMissionActivity";
import type { SensorInfoService, SensorInfoState } from "../../navigation/service/impl/SensorInfoService";
import type { TelemetrySnapshot } from "../../telemetry/service/impl/TelemetryService";
import { getBatteryPresentation } from "./batteryPresentation";
import { getPatrolPresentation } from "./patrolPresentation";
import { calculateProtractorAngleDeg, snapToCartesianAxis } from "./protractor";
import { CameraStreamSurface, type CameraStreamStatus } from "../../../shared/CameraStreamSurface";
import { isCameraFeedConfigured, readCameraStreamConfig } from "../../../shared/cameraStreamConfig";

const TRANSPORT_ID = "transport.ws.core";
const DISPATCHER_ID = "dispatcher.map";
const SERVICE_ID = "service.map";
const NAVIGATION_SERVICE_ID = "service.navigation";
const CONNECTION_SERVICE_ID = "service.connection";
const TELEMETRY_SERVICE_ID = "service.telemetry";
const SENSOR_INFO_SERVICE_ID = "service.sensor-info";
const GPS_NATIVE_MAX_ZOOM = 19;
const GPS_DEFAULT_ZOOM = GPS_NATIVE_MAX_ZOOM - 3;
const GPS_DEFAULT_CENTER: L.LatLngTuple = [-31.4201, -64.1888];
const MAP_WHEEL_PX_PER_ZOOM_LEVEL = 160;
const MAP_WHEEL_DEBOUNCE_MS = 80;
const MAP_TOOL_COLOR = "#55ff7f";
const ROBOT_TRAIL_COLOR = "#ff4d6d";
const COVERAGE_ROUTE_COLOR = "#2f7bff";
const COVERAGE_ROUTE_UNSAFE_COLOR = "#ff9f43";
const COVERAGE_FIELD_COLOR = "#60a5fa";
const ROBOT_TRAIL_MIN_STEP_M = 0.25;
const ROBOT_TRAIL_MAX_POINTS = 20000;
const PROTRACTOR_MIN_ARM_METERS = 0.05;
const PROTRACTOR_SNAP_THRESHOLD_DEG = 12;
const VISION_DATA_URL = "http://localhost:8088/data";
const VISION_DATA_POLL_INTERVAL_MS = 200;
const MIN_DETECTION_CONFIDENCE = 0.70;
const NAV_GOAL_STATUS_SUCCEEDED = 4;

interface CameraDetectionOverlayItem {
  id: string;
  label: string;
  score: number;
  bbox: {
    x: number;
    y: number;
    w: number;
    h: number;
  };
}

type CameraRiskLevel = "normal" | "low" | "medium" | "high";

const RELEVANT_CENTER_LABELS = new Set([
  "person",
  "persona",
  "car",
  "auto",
  "vehicle",
  "vehiculo",
  "truck",
  "bus",
  "motorcycle",
  "bicycle",
  "obstacle",
  "obstaculo"
]);

interface MapViewportControlHandle {
  zoomIn: () => void;
  zoomOut: () => void;
  cancelZoneTool: () => void;
  confirmZoneTool: () => boolean;
}

interface Nav2MapConfig {
  map_default_center_lat?: unknown;
  map_default_center_lon?: unknown;
  map_default_zoom?: unknown;
}

function readNav2MapConfig(runtime: ModuleContext): Nav2MapConfig {
  return runtime.getPackageConfig<Record<string, unknown>>("nav2") as Nav2MapConfig;
}

function parseFinite(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseCenter(config: Nav2MapConfig): L.LatLngTuple {
  const lat = parseFinite(config.map_default_center_lat, GPS_DEFAULT_CENTER[0]);
  const lon = parseFinite(config.map_default_center_lon, GPS_DEFAULT_CENTER[1]);
  return [Math.max(-90, Math.min(90, lat)), Math.max(-180, Math.min(180, lon))];
}

function parseZoom(config: Nav2MapConfig): number {
  const parsed = Math.round(parseFinite(config.map_default_zoom, GPS_DEFAULT_ZOOM));
  return Math.max(0, Math.min(GPS_NATIVE_MAX_ZOOM, parsed));
}

function isNavigationGoalSucceeded(snapshot: TelemetrySnapshot | null): boolean {
  if (!snapshot) return false;
  const resultText = String(snapshot.navResultText ?? "").trim().toLowerCase();
  return Number(snapshot.navResultStatus) === NAV_GOAL_STATUS_SUCCEEDED || resultText === "succeeded" || resultText.includes("succeeded");
}

function formatBatteryPct(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "n/a";
  return `${value.toFixed(1)}%`;
}

function formatBatteryVoltage(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "Voltage unavailable";
  return `${value.toFixed(2)} V`;
}

function isReturnHomeAssistRequired(
  routeMission: NavigationState["routeMission"] | null
): boolean {
  if (!routeMission) return false;
  if (!routeMission.loop || !routeMission.lowBatteryActive) return false;
  if (routeMission.returnHomePhase === "completed") return true;
  return normalizeRouteMissionStatus(routeMission.status).includes("return home completed");
}

function parseCameraDetections(payload: unknown): CameraDetectionOverlayItem[] {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;
  const camera = root.camera && typeof root.camera === "object" ? root.camera as Record<string, unknown> : {};
  const ai = root.ai && typeof root.ai === "object" ? root.ai as Record<string, unknown> : {};
  const width = Number(camera.width ?? 0);
  const height = Number(camera.height ?? 0);
  const detections = Array.isArray(ai.detections) ? ai.detections : [];
  if (width <= 0 || height <= 0) return [];

  return detections
    .map((raw, index): CameraDetectionOverlayItem | null => {
      if (!raw || typeof raw !== "object") return null;
      const det = raw as Record<string, unknown>;
      const bbox = det.bbox && typeof det.bbox === "object" ? det.bbox as Record<string, unknown> : null;
      if (!bbox) return null;

      const score = Math.max(0, Math.min(1, Number(det.score ?? 0)));
      if (score < MIN_DETECTION_CONFIDENCE) return null;

      const cx = Number(bbox.cx);
      const cy = Number(bbox.cy);
      const boxW = Number(bbox.width);
      const boxH = Number(bbox.height);
      if (![cx, cy, boxW, boxH].every(Number.isFinite) || boxW <= 0 || boxH <= 0) return null;

      return {
        id: String(det.id ?? `${det.label ?? "obj"}-${index}`),
        label: String(det.label ?? "objeto"),
        score,
        bbox: {
          x: Math.max(0, Math.min(1, (cx - boxW / 2) / width)),
          y: Math.max(0, Math.min(1, (cy - boxH / 2) / height)),
          w: Math.max(0, Math.min(1, boxW / width)),
          h: Math.max(0, Math.min(1, boxH / height))
        }
      };
    })
    .filter((det): det is CameraDetectionOverlayItem => det !== null);
}

function cameraDetectionZone(det: CameraDetectionOverlayItem): "left" | "center" | "right" {
  const centerX = det.bbox.x + det.bbox.w / 2;
  if (centerX < 0.33) return "left";
  if (centerX > 0.66) return "right";
  return "center";
}

function cameraDetectionRisk(det: CameraDetectionOverlayItem): CameraRiskLevel {
  const zone = cameraDetectionZone(det);
  if (zone === "center" && RELEVANT_CENTER_LABELS.has(det.label.trim().toLowerCase())) return "high";
  if (zone === "center") return "medium";
  return "low";
}

function cameraRiskRank(risk: CameraRiskLevel): number {
  if (risk === "high") return 3;
  if (risk === "medium") return 2;
  if (risk === "low") return 1;
  return 0;
}

function cameraRiskFromDetections(detections: CameraDetectionOverlayItem[]): CameraRiskLevel {
  return detections.reduce<CameraRiskLevel>((current, det) => {
    const next = cameraDetectionRisk(det);
    return cameraRiskRank(next) > cameraRiskRank(current) ? next : current;
  }, "normal");
}

interface TelemetryServiceLike {
  getSnapshot: () => TelemetrySnapshot;
  subscribeTelemetry: (callback: (snapshot: TelemetrySnapshot) => void) => () => void;
}

function isEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function toolButtonClass(current: MapToolMode, target: MapToolMode): string {
  return current === target ? "active" : "";
}

function extractPolygonLatLon(layer: L.Polygon): Array<{ lat: number; lon: number }> {
  const latLngs = layer.getLatLngs();
  const ring = Array.isArray(latLngs[0]) ? (latLngs[0] as L.LatLng[]) : [];
  return ring.map((entry) => ({ lat: entry.lat, lon: entry.lng }));
}

function formatDistanceMeters(meters: number): string {
  if (!Number.isFinite(meters) || meters <= 0) return "0 m";
  return meters >= 1000 ? `${(meters / 1000).toFixed(3)} km` : `${meters.toFixed(1)} m`;
}

function formatAreaSqMeters(area: number): string {
  if (!Number.isFinite(area) || area <= 0) return "0 m²";
  return area >= 1_000_000 ? `${(area / 1_000_000).toFixed(3)} km²` : `${area.toFixed(1)} m²`;
}

function geodesicArea(points: L.LatLng[]): number {
  const geometryUtil = (L as unknown as { GeometryUtil?: { geodesicArea: (coords: L.LatLng[]) => number } }).GeometryUtil;
  if (geometryUtil?.geodesicArea) {
    return Math.abs(geometryUtil.geodesicArea(points));
  }
  if (points.length < 3) return 0;
  const projected = points.map((point) => L.CRS.EPSG3857.project(point));
  let area = 0;
  for (let index = 0; index < projected.length; index += 1) {
    const current = projected[index];
    const next = projected[(index + 1) % projected.length];
    area += current.x * next.y - next.x * current.y;
  }
  return Math.abs(area / 2);
}

function formatAngleDegrees(angleDeg: number): string {
  if (!Number.isFinite(angleDeg)) return "n/a";
  return `${angleDeg.toFixed(1)}°`;
}

function buildProtractorArcGeometry(
  vertex: L.LatLng,
  armA: L.LatLng,
  armB: L.LatLng
): { arcPoints: L.LatLng[]; labelLatLng: L.LatLng | null } {
  const origin = L.CRS.EPSG3857.project(vertex);
  const first = L.CRS.EPSG3857.project(armA);
  const second = L.CRS.EPSG3857.project(armB);

  const firstVec = { x: first.x - origin.x, y: first.y - origin.y };
  const secondVec = { x: second.x - origin.x, y: second.y - origin.y };
  const firstLen = Math.hypot(firstVec.x, firstVec.y);
  const secondLen = Math.hypot(secondVec.x, secondVec.y);
  if (firstLen < PROTRACTOR_MIN_ARM_METERS || secondLen < PROTRACTOR_MIN_ARM_METERS) {
    return { arcPoints: [], labelLatLng: null };
  }

  const startAngle = Math.atan2(firstVec.y, firstVec.x);
  const endAngle = Math.atan2(secondVec.y, secondVec.x);
  let delta = endAngle - startAngle;
  while (delta <= -Math.PI) delta += Math.PI * 2;
  while (delta > Math.PI) delta -= Math.PI * 2;

  const radius = Math.max(1, Math.min(firstLen, secondLen) * 0.45);
  const stepCount = Math.max(8, Math.ceil(Math.abs(delta) / (Math.PI / 24)));
  const arcPoints: L.LatLng[] = [];
  for (let index = 0; index <= stepCount; index += 1) {
    const angle = startAngle + (delta * index) / stepCount;
    const point = new L.Point(origin.x + Math.cos(angle) * radius, origin.y + Math.sin(angle) * radius);
    arcPoints.push(L.CRS.EPSG3857.unproject(point));
  }

  const labelAngle = startAngle + delta / 2;
  const labelRadius = Math.max(1, radius * 0.65);
  const labelPoint = new L.Point(origin.x + Math.cos(labelAngle) * labelRadius, origin.y + Math.sin(labelAngle) * labelRadius);
  return {
    arcPoints,
    labelLatLng: L.CRS.EPSG3857.unproject(labelPoint)
  };
}

function normalizeYawDeg(yawDeg: number): number {
  let yaw = Number(yawDeg || 0);
  while (yaw <= -180) yaw += 360;
  while (yaw > 180) yaw -= 360;
  return yaw;
}

function yawDegFromLatLng(origin: L.LatLng, target: L.LatLng): number {
  const vector = vectorFromLatLng(origin, target);
  if (!vector) return 0;
  return yawDegFromVector(vector);
}

function vectorFromLatLng(origin: L.LatLng, target: L.LatLng): { east: number; north: number } | null {
  const refLat = Number(origin.lat);
  const metersPerDegLat = 111320;
  const metersPerDegLon = metersPerDegLat * Math.max(1e-6, Math.abs(Math.cos((refLat * Math.PI) / 180)));
  const eastM = (Number(target.lng) - Number(origin.lng)) * metersPerDegLon;
  const northM = (Number(target.lat) - Number(origin.lat)) * metersPerDegLat;
  if (!Number.isFinite(eastM) || !Number.isFinite(northM) || Math.hypot(eastM, northM) <= 1e-6) {
    return null;
  }
  return { east: eastM, north: northM };
}

function yawDegFromVector(vector: { east: number; north: number }): number {
  return normalizeYawDeg((Math.atan2(vector.north, vector.east) * 180) / Math.PI);
}

function tangentYawDeg(
  incoming: { east: number; north: number } | null,
  outgoing: { east: number; north: number } | null
): number | null {
  if (!incoming) return outgoing ? yawDegFromVector(outgoing) : null;
  if (!outgoing) return yawDegFromVector(incoming);
  const incomingLength = Math.hypot(incoming.east, incoming.north);
  const outgoingLength = Math.hypot(outgoing.east, outgoing.north);
  if (incomingLength <= 1e-6) return yawDegFromVector(outgoing);
  if (outgoingLength <= 1e-6) return yawDegFromVector(incoming);
  const east = incoming.east / incomingLength + outgoing.east / outgoingLength;
  const north = incoming.north / incomingLength + outgoing.north / outgoingLength;
  if (Math.hypot(east, north) <= 1e-6) return yawDegFromVector(outgoing);
  return yawDegFromVector({ east, north });
}

function waypointHasManualYaw(waypoint: NavigationState["waypoints"][number]): boolean {
  return waypoint.yawDeg !== undefined && waypoint.yawDeg !== null && Number.isFinite(Number(waypoint.yawDeg));
}

function resolveWaypointPreviewYawDeg(
  points: Array<{ lat: number; lon: number; yawDeg?: number; manual: boolean }>,
  index: number,
  loopRoute: boolean,
  robotPose: TelemetrySnapshot["robotPose"]
): number {
  const point = points[index];
  if (!point) return 0;
  if (point.manual && Number.isFinite(Number(point.yawDeg))) {
    return normalizeYawDeg(Number(point.yawDeg));
  }
  const origin = L.latLng(point.lat, point.lon);
  const next = index + 1 < points.length ? points[index + 1] : loopRoute && points.length > 1 ? points[0] : null;
  const prev = index > 0 ? points[index - 1] : loopRoute && points.length > 1 ? points[points.length - 1] : null;
  const incoming = prev ? vectorFromLatLng(L.latLng(prev.lat, prev.lon), origin) : null;
  const outgoing = next ? vectorFromLatLng(origin, L.latLng(next.lat, next.lon)) : null;
  const tangent = tangentYawDeg(incoming, outgoing);
  if (tangent !== null) return tangent;

  if (next) {
    const nextVector = vectorFromLatLng(origin, L.latLng(next.lat, next.lon));
    if (nextVector) return yawDegFromVector(nextVector);
  }
  if (prev) {
    const prevVector = vectorFromLatLng(L.latLng(prev.lat, prev.lon), origin);
    if (prevVector) return yawDegFromVector(prevVector);
  }
  if (robotPose && Number.isFinite(Number(robotPose.lat)) && Number.isFinite(Number(robotPose.lon))) {
    const robotVector = vectorFromLatLng(L.latLng(robotPose.lat, robotPose.lon), origin);
    if (robotVector) return yawDegFromVector(robotVector);
    if (Number.isFinite(Number(robotPose.headingDeg))) return normalizeYawDeg(Number(robotPose.headingDeg));
  }
  return 0;
}

interface GeoPoint {
  lat: number;
  lon: number;
}

function metersPerLongitudeDegree(lat: number): number {
  return 111320 * Math.max(1e-6, Math.abs(Math.cos((Number(lat) * Math.PI) / 180)));
}

function geoDeltaMeters(origin: GeoPoint, target: GeoPoint): { eastM: number; northM: number } {
  return {
    eastM: (Number(target.lon) - Number(origin.lon)) * metersPerLongitudeDegree(origin.lat),
    northM: (Number(target.lat) - Number(origin.lat)) * 111320
  };
}

function offsetGeoPoint(origin: GeoPoint, eastM: number, northM: number): GeoPoint {
  return {
    lat: Number(origin.lat) + northM / 111320,
    lon: Number(origin.lon) + eastM / metersPerLongitudeDegree(origin.lat)
  };
}

function distanceBetweenGeoPointsMeters(a: GeoPoint, b: GeoPoint): number {
  const delta = geoDeltaMeters(a, b);
  return Math.hypot(delta.eastM, delta.northM);
}

function planarAreaSqMeters(points: GeoPoint[]): number {
  if (points.length < 3) return 0;
  const origin = points[0];
  const projected = points.map((point) => geoDeltaMeters(origin, point));
  let area = 0;
  for (let index = 0; index < projected.length; index += 1) {
    const current = projected[index];
    const next = projected[(index + 1) % projected.length];
    area += current.eastM * next.northM - next.eastM * current.northM;
  }
  return Math.abs(area / 2);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

type PatrolSegmentVisual = "loop" | "return" | "depart" | null;

interface PatrolWaypointDisplay {
  segment: PatrolSegmentVisual;
  badge: string | null;
  previewYawDeg?: number;
}

interface PreviewWaypointPoint {
  localId: string;
  lat: number;
  lon: number;
  yawDeg: number | undefined;
  manual: boolean;
}

function waypointLocalId(point: { localId?: string | null }): string {
  return typeof point.localId === "string" ? point.localId.trim() : "";
}

function buildSegmentPreviewDisplay(
  waypoints: GoalInput[],
  segment: Exclude<PatrolSegmentVisual, null>,
  prefix: "L" | "R" | "D",
  robotPose: TelemetrySnapshot["robotPose"],
  loopRoute: boolean,
  tailWaypoint?: GoalInput | null
): Map<string, PatrolWaypointDisplay> {
  const resolved = new Map<string, PatrolWaypointDisplay>();
  const points = waypoints
    .map((waypoint) => {
      const localId = waypointLocalId(waypoint);
      const lat = Number(waypoint.x);
      const lon = Number(waypoint.y);
      if (!localId || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      return {
        localId,
        lat,
        lon,
        yawDeg: waypointHasManualYaw(waypoint) ? Number(waypoint.yawDeg) : undefined,
        manual: waypointHasManualYaw(waypoint)
      };
    })
    .filter((entry): entry is PreviewWaypointPoint => entry !== null);
  const previewPoints = points.map((entry) => ({
    lat: entry.lat,
    lon: entry.lon,
    yawDeg: entry.yawDeg,
    manual: entry.manual
  }));
  if (tailWaypoint) {
    const lat = Number(tailWaypoint.x);
    const lon = Number(tailWaypoint.y);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      previewPoints.push({
        lat,
        lon,
        yawDeg: waypointHasManualYaw(tailWaypoint) ? Number(tailWaypoint.yawDeg) : undefined,
        manual: waypointHasManualYaw(tailWaypoint)
      });
    }
  }
  points.forEach((point, index) => {
    resolved.set(point.localId, {
      segment,
      badge: `${prefix}${index + 1}`,
      previewYawDeg: resolveWaypointPreviewYawDeg(previewPoints, index, loopRoute, robotPose)
    });
  });
  return resolved;
}

function buildPatrolWaypointDisplayMap(
  profile: PatrolMissionProfile,
  robotPose: TelemetrySnapshot["robotPose"]
): Map<string, PatrolWaypointDisplay> {
  const displays = new Map<string, PatrolWaypointDisplay>();
  const entryWaypoint =
    profile.departEntryLoopIndex >= 0 && profile.departEntryLoopIndex < profile.loopWaypoints.length
      ? profile.loopWaypoints[profile.departEntryLoopIndex]
      : null;
  [
    buildSegmentPreviewDisplay(profile.loopWaypoints, "loop", "L", robotPose, true),
    buildSegmentPreviewDisplay(profile.returnWaypoints, "return", "R", robotPose, false),
    buildSegmentPreviewDisplay(profile.departWaypoints, "depart", "D", robotPose, false, entryWaypoint)
  ].forEach((segmentMap) => {
    segmentMap.forEach((value, key) => {
      displays.set(key, value);
    });
  });
  const homeId = profile.homeWaypoint ? waypointLocalId(profile.homeWaypoint) : "";
  if (homeId) {
    displays.set(homeId, {
      segment: null,
      badge: "H"
    });
  }
  return displays;
}

function buildWaypointLabel(home: boolean, segment: PatrolSegmentVisual, action: boolean): string {
  if (home) return "HOME";
  if (segment === "loop") return "LOOP";
  if (segment === "return") return "RETURN";
  if (segment === "depart") return "DEPART";
  if (action) return "Action WP";
  return "WP";
}

type MissionWaypointMarkerState = RouteWaypointVisualState | "preview";

function buildWaypointIcon(
  badge: string,
  yawDeg: number,
  draft = false,
  selected = false,
  manual = true,
  action = false,
  home = false,
  patrolSegment: PatrolSegmentVisual = null,
  missionState: MissionWaypointMarkerState | null = null
): L.DivIcon {
  const yaw = normalizeYawDeg(yawDeg);
  const cssRotationDeg = normalizeYawDeg(90 - yaw);
  const cls =
    `wp-icon${draft ? " draft" : ""}${selected ? " selected" : ""}${manual ? " manual" : " auto"}${action ? " action" : ""}${home ? " home" : ""}` +
    `${patrolSegment === "return" ? " patrol-return" : patrolSegment === "depart" ? " patrol-depart" : ""}` +
    `${missionState ? ` mission-${missionState}` : ""}`;
  return L.divIcon({
    className: "",
    html:
      `<div class="${cls}" style="transform: rotate(${cssRotationDeg}deg);">` +
      (selected ? '<span class="wp-selected-halo" aria-hidden="true"></span><span class="wp-selected-badge" aria-hidden="true">✓</span>' : "") +
      `<div class="wp-arrow">${home ? '<span class="wp-home-glyph">H</span>' : ""}</div>` +
      `<div class="wp-index">${badge}</div>` +
      "</div>",
    iconSize: [30, 30],
    iconAnchor: [15, 15]
  });
}

/**
 * Tiradores del cuadrado de cobertura.
 *
 * `resize` va en cada esquina, `inicio` marca ademas la esquina de arranque de
 * las pasadas, y `rotar` cuelga fuera del lote. Son marcadores porque Leaflet no
 * arrastra poligonos; mover el lote se hace agarrando el poligono en si.
 */
/**
 * Dibujar el lote de CAMPO cuando se define por poligono.
 *
 * El contorno va relleno y las exclusiones caladas encima, para que se lea de
 * un vistazo que la exclusion es un agujero del lote y no otra figura suelta.
 * Cada vertice es un tirador: se arrastra para mover y se hace click derecho
 * para sacarlo.
 */
function dibujarBorradorDeLote(
  layer: L.LayerGroup,
  map: L.Map,
  coverageState: CoverageState,
  handlers: {
    onMove: (ringId: string | null, index: number, lat: number, lon: number) => void;
    onRemove: (ringId: string | null, index: number) => void;
    onTranslate: (deltaLat: number, deltaLon: number) => void;
    onRotate: (deltaDeg: number) => void;
    onScaleFromVertex: (index: number, lat: number, lon: number) => void;
  }
): void {
  const draft = coverageState.draft;
  const bloqueado = coverageState.sending;
  // Figura rigida: los tiradores agrandan el lote entero en vez de mover un
  // vertice. Es el mismo gesto de siempre, pero no deforma la figura.
  const rigida = draft.rigid === true;
  // El lote se manipula entero solo cuando no se esta marcando vertices: si no,
  // el poligono se come los clicks que tienen que agregar puntos.
  const manipulable =
    !bloqueado && draft.mode === "idle" && draft.outline.vertices.length >= 3;

  type Punto = { lat: number; lon: number };
  // Todo lo dibujado, con su posicion original. El gesto de mover o girar aplica
  // una transformacion sobre estas posiciones sin tocar el estado: guardar en
  // cada mousemove obligaria a rearmar la capa entera decenas de veces por
  // segundo y la figura quedaria atras del mouse.
  const formas: Array<{ forma: L.Polygon | L.Polyline; base: Punto[]; contorno: boolean }> = [];
  const marcas: Array<{ marca: L.Marker; base: Punto; contorno: boolean }> = [];

  /**
   * Aplicar una transformacion a lo dibujado.
   *
   * `soloContorno` existe porque escalar toca el contorno y deja las exclusiones
   * donde estan —marcan cosas del terreno—, y la vista previa del gesto tiene
   * que mostrar exactamente lo que se va a guardar.
   */
  const aplicar = (
    transformar: ((punto: Punto) => Punto) | null,
    soloContorno = false
  ): void => {
    const t = transformar ?? ((punto: Punto) => punto);
    for (const item of formas) {
      if (soloContorno && !item.contorno) continue;
      item.forma.setLatLngs(
        item.base.map((punto) => {
          const movido = t(punto);
          return [movido.lat, movido.lon] as L.LatLngTuple;
        })
      );
    }
    for (const item of marcas) {
      if (soloContorno && !item.contorno) continue;
      const movido = t(item.base);
      item.marca.setLatLng([movido.lat, movido.lon]);
    }
  };

  // Centro del contorno: lo usan el giro y la escala. Se calcula antes de
  // dibujar para que los dos gestos giren y escalen alrededor del mismo punto.
  const centro =
    draft.outline.vertices.length > 0
      ? {
          lat:
            draft.outline.vertices.reduce((acc, v) => acc + v.lat, 0) /
            draft.outline.vertices.length,
          lon:
            draft.outline.vertices.reduce((acc, v) => acc + v.lon, 0) /
            draft.outline.vertices.length
        }
      : { lat: 0, lon: 0 };
  const cosLat = Math.cos((centro.lat * Math.PI) / 180) || 1;
  /** Distancia al centro en un plano donde lat y lon miden lo mismo. */
  const radioDesde = (punto: { lat: number; lon: number }): number =>
    Math.hypot(punto.lat - centro.lat, (punto.lon - centro.lon) * cosLat);

  /**
   * Gesto de arrastre sobre el lote entero.
   *
   * Los movimientos se escuchan sobre el mapa y no sobre la forma: al soltar se
   * guarda y la capa se reconstruye, asi que la forma original ya no existe para
   * recibir el `mouseup`.
   */
  const gesto = (
    objetivo: L.Polygon | L.Marker,
    transformar: (inicio: L.LatLng, actual: L.LatLng) => (punto: Punto) => Punto,
    confirmar: (inicio: L.LatLng, actual: L.LatLng) => void,
    soloContorno = false
  ): void => {
    objetivo.on("mousedown", (evento: L.LeafletMouseEvent) => {
      L.DomEvent.stopPropagation(evento.originalEvent);
      L.DomEvent.preventDefault(evento.originalEvent);
      const arrastreEstaba = map.dragging.enabled();
      map.dragging.disable();
      objetivo.closeTooltip();

      const inicio = evento.latlng;
      let ultimo = inicio;
      let hubo = false;
      let activo = true;
      const paso = (movimiento: L.LeafletMouseEvent): void => {
        if (!activo) return;
        hubo = true;
        ultimo = movimiento.latlng;
        aplicar(transformar(inicio, ultimo), soloContorno);
      };
      const soltar = (): void => {
        if (!activo) return;
        activo = false;
        map.off("mousemove", paso);
        map.off("mouseup", soltar);
        map.off("unload", soltar);
        // `mouseup` sobre un panel fuera del canvas no llega al mapa. Escuchar
        // el documento evita dejar el paneo apagado y handlers viejos vivos.
        document.removeEventListener("mouseup", soltar);
        if (arrastreEstaba) map.dragging.enable();
        if (hubo) confirmar(inicio, ultimo);
        else aplicar(null);
      };
      map.on("mousemove", paso);
      map.on("mouseup", soltar);
      map.once("unload", soltar);
      document.addEventListener("mouseup", soltar);
    });
  };

  const anillo = (
    vertices: Punto[],
    ringId: string | null,
    esExclusion: boolean
  ): L.Polygon | null => {
    if (vertices.length === 0) return null;
    const base = vertices.map((v) => ({ lat: v.lat, lon: v.lon }));
    const puntos = vertices.map((v) => [v.lat, v.lon] as L.LatLngTuple);
    let poligono: L.Polygon | null = null;
    if (vertices.length >= 3) {
      // L.polygon cierra el anillo solo: por eso nunca se guarda el primer
      // vertice repetido.
      poligono = L.polygon(puntos, {
        color: esExclusion ? COVERAGE_ROUTE_UNSAFE_COLOR : COVERAGE_FIELD_COLOR,
        weight: 2.5,
        opacity: 0.95,
        fillColor: esExclusion ? COVERAGE_ROUTE_UNSAFE_COLOR : COVERAGE_FIELD_COLOR,
        fillOpacity: esExclusion ? 0.35 : 0.12,
        // El contorno se agarra en toda su superficie para mover el lote; las
        // exclusiones no, para no tapar al contorno que esta debajo.
        interactive: manipulable && !esExclusion
      }).addTo(layer);
      formas.push({ forma: poligono, base, contorno: !esExclusion });
    } else if (vertices.length === 2) {
      // Con dos puntos todavia no hay poligono; se muestra el tramo para que el
      // operador vea que el click entro.
      const linea = L.polyline(puntos, {
        color: esExclusion ? COVERAGE_ROUTE_UNSAFE_COLOR : COVERAGE_FIELD_COLOR,
        weight: 2,
        dashArray: "5 5",
        interactive: false
      }).addTo(layer);
      formas.push({ forma: linea, base, contorno: !esExclusion });
    }

    // Sobre el contorno rigido los tiradores no mueven vertices: escalan.
    const escalaRigida = rigida && ringId === null;
    vertices.forEach((vertex, index) => {
      const tirador = L.marker([vertex.lat, vertex.lon], {
        icon: buildCoverageHandleIcon("resize"),
        draggable: !bloqueado && !escalaRigida,
        interactive: true,
        keyboard: false,
        zIndexOffset: 600
      }).addTo(layer);
      tirador.bindTooltip(
        escalaRigida
          ? "Arrastrar para agrandar o achicar todo el lote"
          : `Vértice ${index + 1}: arrastrá para mover, click derecho para borrarlo`,
        { direction: "top", offset: [0, -10] }
      );
      if (escalaRigida) {
        if (manipulable) {
          const radioVertice = Math.max(1e-12, radioDesde(vertex));
          gesto(
            tirador,
            (_inicio, actual) => {
              const factor = radioDesde({ lat: actual.lat, lon: actual.lng }) / radioVertice;
              return (punto) => ({
                lat: centro.lat + (punto.lat - centro.lat) * factor,
                lon: centro.lon + (punto.lon - centro.lon) * factor
              });
            },
            (_inicio, actual) => handlers.onScaleFromVertex(index, actual.lat, actual.lng),
            true
          );
        }
      } else {
        tirador.on("dragend", () => {
          const posicion = tirador.getLatLng();
          handlers.onMove(ringId, index, posicion.lat, posicion.lng);
        });
        tirador.on("contextmenu", (evt: L.LeafletMouseEvent) => {
          L.DomEvent.stop(evt);
          handlers.onRemove(ringId, index);
        });
      }
      marcas.push({
        marca: tirador,
        base: { lat: vertex.lat, lon: vertex.lon },
        contorno: ringId === null
      });
    });
    return poligono;
  };

  const contorno = anillo(draft.outline.vertices, null, false);
  for (const exclusion of draft.exclusions) {
    anillo(exclusion.vertices, exclusion.id, true);
  }
  if (!manipulable || !contorno) return;

  // Mover: se agarra el lote en cualquier punto de su superficie y todo se corre
  // lo mismo que el mouse, asi que la figura no pega un salto al apretar.
  contorno.bindTooltip("Arrastrar para mover el lote entero", {
    direction: "center",
    className: "coverage-field-hintbox",
    opacity: 0.9
  });
  gesto(
    contorno,
    (inicio, actual) => (punto) => ({
      lat: punto.lat + (actual.lat - inicio.lat),
      lon: punto.lon + (actual.lng - inicio.lng)
    }),
    (inicio, actual) =>
      handlers.onTranslate(actual.lat - inicio.lat, actual.lng - inicio.lng)
  );

  // Girar: el tirador cuelga por encima del lote y gira con el, asi que no salta
  // de un lado a otro mientras se lo arrastra.
  const alcanceLat = Math.max(
    ...draft.outline.vertices.map((v) => Math.abs(v.lat - centro.lat))
  );
  const giroLat = centro.lat + alcanceLat * 1.22;

  const anguloDesde = (punto: L.LatLng): number =>
    // El coseno de la latitud pone la longitud en la misma escala que la
    // latitud; sin eso el angulo medido no es el angulo que se ve en pantalla.
    Math.atan2(punto.lat - centro.lat, (punto.lng - centro.lon) * cosLat);
  const rotarPunto = (rad: number) => (punto: Punto): Punto => {
    const cos = cosLat;
    const x = (punto.lon - centro.lon) * cos;
    const y = punto.lat - centro.lat;
    return {
      lat: centro.lat + (x * Math.sin(rad) + y * Math.cos(rad)),
      lon: centro.lon + (x * Math.cos(rad) - y * Math.sin(rad)) / cos
    };
  };

  const tiradorGiro = L.marker([giroLat, centro.lon], {
    icon: buildCoverageHandleIcon("rotar"),
    interactive: true,
    zIndexOffset: 700
  }).bindTooltip("Arrastrar para girar el lote", { direction: "top" });
  const lineaGiro = L.polyline(
    [
      [centro.lat, centro.lon] as L.LatLngTuple,
      [giroLat, centro.lon] as L.LatLngTuple
    ],
    {
      color: COVERAGE_FIELD_COLOR,
      weight: 1.5,
      opacity: 0.8,
      dashArray: "3 3",
      interactive: false
    }
  ).addTo(layer);
  formas.push({
    forma: lineaGiro,
    base: [
      { lat: centro.lat, lon: centro.lon },
      { lat: giroLat, lon: centro.lon }
    ],
    contorno: true
  });
  tiradorGiro.addTo(layer);
  marcas.push({
    marca: tiradorGiro,
    base: { lat: giroLat, lon: centro.lon },
    contorno: true
  });

  gesto(
    tiradorGiro,
    (inicio, actual) => rotarPunto(anguloDesde(actual) - anguloDesde(inicio)),
    (inicio, actual) =>
      handlers.onRotate(
        ((anguloDesde(actual) - anguloDesde(inicio)) * 180) / Math.PI
      )
  );
}

function buildCoverageHandleIcon(kind: "resize" | "inicio" | "rotar"): L.DivIcon {
  const glyph = kind === "rotar" ? "⟳" : "";
  const size = kind === "rotar" ? 26 : 16;
  return L.divIcon({
    className: "",
    html: `<div class="coverage-handle ${kind}" aria-hidden="true">${glyph}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2]
  });
}

function missionWaypointStateLabel(state: MissionWaypointMarkerState): string {
  if (state === "current") return "actual";
  if (state === "done") return "completado";
  if (state === "blocked") return "bloqueado";
  if (state === "preview") return "preview";
  return "pendiente";
}

function buildRobotIcon(headingDeg: number | null | undefined): L.DivIcon {
  const hasHeading = headingDeg !== null && headingDeg !== undefined && Number.isFinite(Number(headingDeg));
  const yaw = hasHeading ? normalizeYawDeg(Number(headingDeg)) : 0;
  const cssRotationDeg = normalizeYawDeg(90 - yaw);
  const classes = hasHeading ? "robot-icon" : "robot-icon no-heading";
  return L.divIcon({
    className: "",
    html: `<div class="${classes}" style="transform: rotate(${cssRotationDeg}deg);"><div class="robot-arrow"></div></div>`,
    iconSize: [40, 40],
    iconAnchor: [20, 20]
  });
}

function buildDatumIcon(): L.DivIcon {
  const datumSvg =
    '<svg class="datum-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="3.2" />' +
    '<path d="M12 4v4" />' +
    '<path d="M12 16v4" />' +
    '<path d="M4 12h4" />' +
    '<path d="M16 12h4" />' +
    "</svg>";
  return L.divIcon({
    className: "",
    html: `<div class="datum-icon">${datumSvg}</div>`,
    iconSize: [40, 40],
    iconAnchor: [20, 20]
  });
}

function isMapBackgroundPointerEvent(domEvent: MouseEvent): boolean {
  const target = domEvent.target;
  if (!(target instanceof Element)) return false;
  if (target.closest(".wp-icon")) return false;
  if (target.closest(".leaflet-marker-icon")) return false;
  if (target.closest(".leaflet-control-container")) return false;
  if (target.closest(".leaflet-popup-pane")) return false;
  if (target.closest(".leaflet-draw-tooltip")) return false;
  if (target.closest(".leaflet-interactive")) return false;
  return true;
}

function LeafletMapCanvas({
  state,
  mapService,
  runtime,
  interactive,
  goalMode,
  waypointSelectionMode,
  coverageState,
  routeMission,
  waypoints,
  patrolMissionProfile,
  selectedWaypointIndexes,
  robotPose,
  datumPose,
  centerRequestKey,
  showRobotTrail,
  onQueueWaypoint,
  onToggleWaypointSelection,
  onSetWaypointSelection,
  onMoveWaypoint,
  onCoverageFieldMove,
  onCoverageFieldResize,
  onCoverageFieldRotate,
  onCoverageFieldPreview,
  onCoverageDraftVertex,
  onCoverageDraftMoveVertex,
  onCoverageDraftRemoveVertex,
  onCoverageDraftTranslate,
  onCoverageDraftRotate,
  onCoverageDraftScale,
  onZoneToolSettled,
  onZonesChanged,
  loopRoute,
  initialCenterLat,
  initialCenterLon,
  initialZoom,
  onZoomChange,
  mapControlRef
}: {
  state: MapWorkspaceState;
  mapService: MapService;
  runtime: ModuleContext;
  interactive: boolean;
  goalMode: boolean;
  waypointSelectionMode: boolean;
  coverageState: CoverageState | null;
  routeMission: NavigationState["routeMission"] | null;
  waypoints: NavigationState["waypoints"];
  patrolMissionProfile: NavigationState["patrolMissionProfile"];
  selectedWaypointIndexes: number[];
  robotPose: TelemetrySnapshot["robotPose"];
  datumPose: { lat: number; lon: number } | null;
  centerRequestKey: number;
  showRobotTrail: boolean;
  onQueueWaypoint: (lat: number, lon: number, yawDeg?: number) => void;
  onToggleWaypointSelection: (index: number) => void;
  onSetWaypointSelection: (indexes: number[], mode: "replace" | "add") => void;
  onMoveWaypoint: (index: number, lat: number, lon: number) => void;
  onCoverageFieldMove: (lat: number, lon: number) => void;
  onCoverageFieldResize: (lat: number, lon: number, cornerIndex: number) => void;
  onCoverageFieldRotate: (lat: number, lon: number) => void;
  /** Poligono que tendria el lote con ese arrastre, sin guardarlo. */
  onCoverageFieldPreview: (
    kind: "move" | "resize" | "rotate",
    lat: number,
    lon: number,
    cornerIndex?: number
  ) => Array<{ lat: number; lon: number }> | null;
  /** Click en el mapa mientras se dibuja el lote: agrega un vertice. */
  onCoverageDraftVertex: (lat: number, lon: number) => void;
  /** Se arrastro un vertice. `ringId` null es el contorno. */
  onCoverageDraftMoveVertex: (
    ringId: string | null,
    index: number,
    lat: number,
    lon: number
  ) => void;
  /** Se pidio borrar un vertice. `ringId` null es el contorno. */
  onCoverageDraftRemoveVertex: (ringId: string | null, index: number) => void;
  /** Se arrastro el lote entero: corrimiento en grados de lat/lon. */
  onCoverageDraftTranslate: (deltaLat: number, deltaLon: number) => void;
  /** Se giro el lote entero alrededor de su centro, en grados antihorarios. */
  onCoverageDraftRotate: (deltaDeg: number) => void;
  /** Se arrastro un vertice de la figura rigida: escala todo el lote. */
  onCoverageDraftScale: (index: number, lat: number, lon: number) => void;
  onZoneToolSettled: () => void;
  /** Se dibujo, edito o borro una zona: lo que dependa de ellas quedo viejo. */
  onZonesChanged: () => void;
  loopRoute: boolean;
  initialCenterLat: number;
  initialCenterLon: number;
  initialZoom: number;
  onZoomChange?: (zoom: number) => void;
  mapControlRef?: { current: MapViewportControlHandle | null };
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const drawnItemsRef = useRef<L.FeatureGroup | null>(null);
  const waypointLayerRef = useRef<L.LayerGroup | null>(null);
  const draftLayerRef = useRef<L.LayerGroup | null>(null);
  const selectionLayerRef = useRef<L.LayerGroup | null>(null);
  const coverageLayerRef = useRef<L.LayerGroup | null>(null);
  const missionWaypointLayerRef = useRef<L.LayerGroup | null>(null);
  const missionWaypointRenderKeyRef = useRef("");
  const robotMarkerRef = useRef<L.Marker | null>(null);
  const robotTrailRef = useRef<L.Polyline | null>(null);
  const robotTrailPointsRef = useRef<L.LatLng[]>([]);
  const datumMarkerRef = useRef<L.Marker | null>(null);
  const draftMarkerRef = useRef<L.Marker | null>(null);
  const goalDraftRef = useRef<{ lat: number; lon: number; yawDeg?: number; dragYaw: boolean } | null>(null);
  const goalCreateSessionRef = useRef<{ active: boolean; hasMoved: boolean }>({ active: false, hasMoved: false });
  const waypointSelectionSessionRef = useRef<{
    start: L.LatLng;
    additive: boolean;
    rectangle: L.Rectangle;
  } | null>(null);
  const waypointDragEndMsRef = useRef(0);
  const waypointRenderKeyRef = useRef("");
  const toolDraftLayerRef = useRef<L.LayerGroup | null>(null);
  const toolDrawingsLayerRef = useRef<L.LayerGroup | null>(null);
  const measureTooltipRef = useRef<L.Tooltip | null>(null);
  const mapToolPreviewLatLngRef = useRef<L.LatLng | null>(null);
  const centerRequestHandledRef = useRef(0);
  const measurePointsRef = useRef<L.LatLng[]>([]);
  const protractorVertexRef = useRef<L.LatLng | null>(null);
  const protractorArm1Ref = useRef<L.LatLng | null>(null);
  const hasCompletedDrawingRef = useRef(false);
  const completedDrawingToolRef = useRef<"ruler" | "area" | "protractor" | null>(null);
  const inspectCopyHandlersRef = useRef<Array<() => void>>([]);
  const goalModeRef = useRef(goalMode);
  const waypointSelectionModeRef = useRef(waypointSelectionMode);
  const toolModeRef = useRef(state.toolMode);
  const interactiveRef = useRef(interactive);
  const waypointCountRef = useRef(waypoints.length);
  const waypointsRef = useRef(waypoints);
  const onQueueWaypointRef = useRef(onQueueWaypoint);
  const onToggleWaypointSelectionRef = useRef(onToggleWaypointSelection);
  const onSetWaypointSelectionRef = useRef(onSetWaypointSelection);
  const onMoveWaypointRef = useRef(onMoveWaypoint);
  const onCoverageFieldMoveRef = useRef(onCoverageFieldMove);
  const onCoverageFieldResizeRef = useRef(onCoverageFieldResize);
  const onCoverageFieldRotateRef = useRef(onCoverageFieldRotate);
  const onCoverageFieldPreviewRef = useRef(onCoverageFieldPreview);
  // El handler del click se registra una sola vez, asi que el modo tiene que
  // leerse por ref y no por closure.
  const coverageDraftModeRef = useRef<"idle" | "outline" | "exclusion">("idle");
  const onCoverageDraftVertexRef = useRef(onCoverageDraftVertex);
  const onCoverageDraftMoveVertexRef = useRef(onCoverageDraftMoveVertex);
  const onCoverageDraftRemoveVertexRef = useRef(onCoverageDraftRemoveVertex);
  const onCoverageDraftTranslateRef = useRef(onCoverageDraftTranslate);
  const onCoverageDraftRotateRef = useRef(onCoverageDraftRotate);
  const onCoverageDraftScaleRef = useRef(onCoverageDraftScale);
  const onZoneToolSettledRef = useRef(onZoneToolSettled);
  const onZonesChangedRef = useRef(onZonesChanged);
  const appliedMapOriginKeyRef = useRef<string>("");

  useEffect(() => {
    goalModeRef.current = goalMode;
  }, [goalMode]);
  useEffect(() => {
    waypointSelectionModeRef.current = waypointSelectionMode;
  }, [waypointSelectionMode]);
  useEffect(() => {
    toolModeRef.current = state.toolMode;
  }, [state.toolMode]);
  useEffect(() => {
    interactiveRef.current = interactive;
  }, [interactive]);
  useEffect(() => {
    waypointCountRef.current = waypoints.length;
  }, [waypoints.length]);
  useEffect(() => {
    waypointsRef.current = waypoints;
  }, [waypoints]);
  useEffect(() => {
    onQueueWaypointRef.current = onQueueWaypoint;
  }, [onQueueWaypoint]);
  useEffect(() => {
    onToggleWaypointSelectionRef.current = onToggleWaypointSelection;
  }, [onToggleWaypointSelection]);
  useEffect(() => {
    onSetWaypointSelectionRef.current = onSetWaypointSelection;
  }, [onSetWaypointSelection]);
  useEffect(() => {
    onMoveWaypointRef.current = onMoveWaypoint;
  }, [onMoveWaypoint]);
  useEffect(() => {
    onCoverageFieldMoveRef.current = onCoverageFieldMove;
  }, [onCoverageFieldMove]);
  useEffect(() => {
    onCoverageFieldResizeRef.current = onCoverageFieldResize;
  }, [onCoverageFieldResize]);
  useEffect(() => {
    onCoverageFieldRotateRef.current = onCoverageFieldRotate;
  }, [onCoverageFieldRotate]);
  useEffect(() => {
    onCoverageFieldPreviewRef.current = onCoverageFieldPreview;
  }, [onCoverageFieldPreview]);
  useEffect(() => {
    onCoverageDraftVertexRef.current = onCoverageDraftVertex;
  }, [onCoverageDraftVertex]);
  useEffect(() => {
    onCoverageDraftMoveVertexRef.current = onCoverageDraftMoveVertex;
  }, [onCoverageDraftMoveVertex]);
  useEffect(() => {
    onCoverageDraftTranslateRef.current = onCoverageDraftTranslate;
  }, [onCoverageDraftTranslate]);
  useEffect(() => {
    onCoverageDraftRotateRef.current = onCoverageDraftRotate;
  }, [onCoverageDraftRotate]);
  useEffect(() => {
    onCoverageDraftScaleRef.current = onCoverageDraftScale;
  }, [onCoverageDraftScale]);
  useEffect(() => {
    onCoverageDraftRemoveVertexRef.current = onCoverageDraftRemoveVertex;
  }, [onCoverageDraftRemoveVertex]);
  useEffect(() => {
    coverageDraftModeRef.current = coverageState?.draft.mode ?? "idle";
  }, [coverageState?.draft.mode]);
  useEffect(() => {
    onZoneToolSettledRef.current = onZoneToolSettled;
  }, [onZoneToolSettled]);
  useEffect(() => {
    onZonesChangedRef.current = onZonesChanged;
  }, [onZonesChanged]);

  const clearGoalDraft = (): void => {
    goalDraftRef.current = null;
    goalCreateSessionRef.current = { active: false, hasMoved: false };
    draftLayerRef.current?.clearLayers();
    draftMarkerRef.current = null;
    const map = mapRef.current;
    if (interactiveRef.current && map && !map.dragging.enabled()) {
      map.dragging.enable();
    }
  };

  const clearWaypointSelectionDraft = (): void => {
    waypointSelectionSessionRef.current = null;
    selectionLayerRef.current?.clearLayers();
    const map = mapRef.current;
    if (interactiveRef.current && map && !map.dragging.enabled()) {
      map.dragging.enable();
    }
  };

  const renderGoalDraft = (): void => {
    const layer = draftLayerRef.current;
    const draft = goalDraftRef.current;
    if (!layer || !draft) {
      layer?.clearLayers();
      draftMarkerRef.current = null;
      return;
    }
    layer.clearLayers();
    const marker = L.marker([draft.lat, draft.lon], {
      icon: buildWaypointIcon(String(waypointCountRef.current + 1), draft.yawDeg ?? 0, true, false, draft.dragYaw),
      interactive: false
    });
    marker.addTo(layer);
    draftMarkerRef.current = marker;
  };

  const clearMeasureTooltip = (): void => {
    const map = mapRef.current;
    const tooltip = measureTooltipRef.current;
    if (map && tooltip && map.hasLayer(tooltip)) {
      map.removeLayer(tooltip);
    }
    measureTooltipRef.current = null;
  };

  const setMeasureTooltip = (latLng: L.LatLng, text: string): void => {
    const map = mapRef.current;
    if (!map) return;
    if (!measureTooltipRef.current) {
      measureTooltipRef.current = L.tooltip({
        permanent: false,
        direction: "top",
        offset: [0, -8],
        className: "map-measure-tooltip"
      });
    }
    const tooltip = measureTooltipRef.current;
    tooltip.setLatLng(latLng).setContent(text);
    if (!map.hasLayer(tooltip)) {
      tooltip.addTo(map);
    }
  };

  const setToolLegend = (mode: MapToolMode): void => {
    if (mode === "ruler") {
      mapService.setToolInfo("Regla activa. Click agrega, doble click cierra.");
      return;
    }
    if (mode === "area") {
      mapService.setToolInfo("Area activa. Click agrega, doble click cierra.");
      return;
    }
    if (mode === "inspect") {
      mapService.setToolInfo("Inspeccion activa. Click inspecciona coordenadas.");
      return;
    }
    if (mode === "protractor") {
      mapService.setToolInfo("Transportador activo. Click define vertice. Shift alinea ejes.");
      return;
    }
  };

  const clearMeasureDraft = (): void => {
    mapToolPreviewLatLngRef.current = null;
    measurePointsRef.current = [];
    protractorVertexRef.current = null;
    protractorArm1Ref.current = null;
    clearMeasureTooltip();
    toolDraftLayerRef.current?.clearLayers();
  };

  const clearToolDrawings = (): void => {
    clearMeasureDraft();
    toolDrawingsLayerRef.current?.clearLayers();
    hasCompletedDrawingRef.current = false;
    completedDrawingToolRef.current = null;
  };

  const collectMeasurePoints = (closingPoint: L.LatLng | null): L.LatLng[] => {
    const map = mapRef.current;
    const next = [...measurePointsRef.current];
    if (!closingPoint) return next;
    const last = next[next.length - 1];
    if (!last || !map || map.distance(last, closingPoint) >= 0.05) {
      next.push(closingPoint);
    }
    return next;
  };

  const resolveProtractorPoint = (latLng: L.LatLng, shiftPressed: boolean): L.LatLng => {
    if (!shiftPressed) return latLng;
    const vertex = protractorVertexRef.current;
    if (!vertex) return latLng;
    return snapToCartesianAxis(vertex, latLng, PROTRACTOR_SNAP_THRESHOLD_DEG, PROTRACTOR_MIN_ARM_METERS);
  };

  const markSingleDrawing = (tool: "ruler" | "area" | "protractor"): void => {
    hasCompletedDrawingRef.current = true;
    completedDrawingToolRef.current = tool;
  };

  const finalizeRulerMeasure = (closingPoint: L.LatLng | null): void => {
    const map = mapRef.current;
    const layer = toolDrawingsLayerRef.current;
    if (!map || !layer) return;
    const points = collectMeasurePoints(closingPoint);
    if (points.length < 2) return;
    layer.clearLayers();
    points.forEach((point) => {
      layer.addLayer(
        L.circleMarker(point, {
          radius: 3,
          color: MAP_TOOL_COLOR,
          weight: 1.5,
          fillColor: MAP_TOOL_COLOR,
          fillOpacity: 0.9,
          interactive: false
        })
      );
    });
    layer.addLayer(
      L.polyline(points, {
        color: MAP_TOOL_COLOR,
        weight: 2.5,
        interactive: false
      })
    );
    markSingleDrawing("ruler");
    clearMeasureDraft();
    setToolLegend("ruler");
  };

  const finalizeAreaMeasure = (closingPoint: L.LatLng | null): void => {
    const layer = toolDrawingsLayerRef.current;
    if (!layer) return;
    const points = collectMeasurePoints(closingPoint);
    if (points.length < 3) return;
    layer.clearLayers();
    points.forEach((point) => {
      layer.addLayer(
        L.circleMarker(point, {
          radius: 3,
          color: MAP_TOOL_COLOR,
          weight: 1.5,
          fillColor: MAP_TOOL_COLOR,
          fillOpacity: 0.9,
          interactive: false
        })
      );
    });
    layer.addLayer(
      L.polygon(points, {
        color: MAP_TOOL_COLOR,
        weight: 2.5,
        fillOpacity: 0.18,
        interactive: false
      })
    );
    markSingleDrawing("area");
    clearMeasureDraft();
    setToolLegend("area");
  };

  const finalizeProtractorMeasure = (closingPoint: L.LatLng | null): void => {
    const layer = toolDrawingsLayerRef.current;
    const vertex = protractorVertexRef.current;
    const arm1 = protractorArm1Ref.current;
    if (!layer || !vertex || !arm1 || !closingPoint) return;
    const angle = calculateProtractorAngleDeg(vertex, arm1, closingPoint, PROTRACTOR_MIN_ARM_METERS);
    if (angle === null) {
      mapService.setToolInfo("Transportador invalido. Brazo demasiado corto.");
      return;
    }
    const angleText = formatAngleDegrees(angle);
    const { arcPoints, labelLatLng } = buildProtractorArcGeometry(vertex, arm1, closingPoint);
    layer.clearLayers();
    layer.addLayer(
      L.circleMarker(vertex, {
        radius: 3,
        color: MAP_TOOL_COLOR,
        weight: 1.5,
        fillColor: MAP_TOOL_COLOR,
        fillOpacity: 0.9,
        interactive: false
      })
    );
    layer.addLayer(
      L.polyline([vertex, arm1], {
        color: MAP_TOOL_COLOR,
        weight: 2.5,
        interactive: false
      })
    );
    layer.addLayer(
      L.polyline([vertex, closingPoint], {
        color: MAP_TOOL_COLOR,
        weight: 2.5,
        interactive: false
      })
    );
    if (arcPoints.length > 1) {
      layer.addLayer(
        L.polyline(arcPoints, {
          color: MAP_TOOL_COLOR,
          weight: 2,
          interactive: false
        })
      );
    }
    if (labelLatLng) {
      layer.addLayer(
        L.marker(labelLatLng, {
          interactive: false,
          icon: L.divIcon({
            className: "",
            html: `<div class="map-protractor-label">${angleText}</div>`,
            iconSize: [72, 20],
            iconAnchor: [36, 10]
          })
        })
      );
    }
    markSingleDrawing("protractor");
    protractorVertexRef.current = null;
    protractorArm1Ref.current = null;
    mapToolPreviewLatLngRef.current = null;
    clearMeasureTooltip();
    toolDraftLayerRef.current?.clearLayers();
    setToolLegend("protractor");
  };

  const renderRulerMeasure = (preview: L.LatLng | null): void => {
    const map = mapRef.current;
    const layer = toolDraftLayerRef.current;
    if (!map || !layer) return;
    const points = [...measurePointsRef.current];
    layer.clearLayers();
    points.forEach((point) => {
      L.circleMarker(point, {
        radius: 3,
        color: MAP_TOOL_COLOR,
        weight: 1.5,
        fillColor: MAP_TOOL_COLOR,
        fillOpacity: 0.9
      }).addTo(layer);
    });

    const displayPoints = preview && points.length > 0 ? [...points, preview] : points;
    if (points.length > 1) {
      L.polyline(points, { color: MAP_TOOL_COLOR, weight: 2 }).addTo(layer);
    }
    if (preview && points.length > 0) {
      L.polyline([points[points.length - 1], preview], { color: MAP_TOOL_COLOR, weight: 2, dashArray: "5 5" }).addTo(layer);
    }

    let meters = 0;
    for (let index = 1; index < displayPoints.length; index += 1) {
      meters += map.distance(displayPoints[index - 1], displayPoints[index]);
    }
    mapService.setToolInfo(`Ruler: ${formatDistanceMeters(meters)} (${displayPoints.length} puntos)`);
    if (preview && points.length > 0) {
      setMeasureTooltip(preview, formatDistanceMeters(meters));
    } else {
      clearMeasureTooltip();
    }
  };

  const renderAreaMeasure = (preview: L.LatLng | null): void => {
    const map = mapRef.current;
    const layer = toolDraftLayerRef.current;
    if (!map || !layer) return;
    const points = [...measurePointsRef.current];
    layer.clearLayers();
    points.forEach((point) => {
      L.circleMarker(point, {
        radius: 3,
        color: MAP_TOOL_COLOR,
        weight: 1.5,
        fillColor: MAP_TOOL_COLOR,
        fillOpacity: 0.9
      }).addTo(layer);
    });

    const drawPoints = preview && points.length > 0 ? [...points, preview] : points;
    if (drawPoints.length > 2) {
      L.polygon(drawPoints, { color: MAP_TOOL_COLOR, weight: 2, fillOpacity: 0.2 }).addTo(layer);
    } else if (drawPoints.length > 1) {
      L.polyline(drawPoints, { color: MAP_TOOL_COLOR, weight: 2 }).addTo(layer);
    }

    let perimeter = 0;
    for (let index = 1; index < drawPoints.length; index += 1) {
      perimeter += map.distance(drawPoints[index - 1], drawPoints[index]);
    }
    if (drawPoints.length > 2) {
      perimeter += map.distance(drawPoints[drawPoints.length - 1], drawPoints[0]);
    }
    const area = drawPoints.length > 2 ? geodesicArea(drawPoints) : 0;
    mapService.setToolInfo(`Area ${formatAreaSqMeters(area)} · Perim ${formatDistanceMeters(perimeter)}`);
    if (preview && points.length > 0) {
      setMeasureTooltip(preview, `${formatAreaSqMeters(area)} · ${formatDistanceMeters(perimeter)}`);
    } else {
      clearMeasureTooltip();
    }
  };

  const renderProtractorMeasure = (preview: L.LatLng | null): void => {
    const layer = toolDraftLayerRef.current;
    const vertex = protractorVertexRef.current;
    const arm1 = protractorArm1Ref.current;
    if (!layer) return;
    layer.clearLayers();
    clearMeasureTooltip();
    if (!vertex) {
      mapService.setToolInfo("Transportador activo. Click define vertice. Shift alinea ejes.");
      clearMeasureTooltip();
      return;
    }
    L.circleMarker(vertex, {
      radius: 3,
      color: MAP_TOOL_COLOR,
      weight: 1.5,
      fillColor: MAP_TOOL_COLOR,
      fillOpacity: 0.9
    }).addTo(layer);
    if (!arm1) {
      if (preview) {
        L.polyline([vertex, preview], { color: MAP_TOOL_COLOR, weight: 2, dashArray: "5 5" }).addTo(layer);
      }
      mapService.setToolInfo("Transportador activo. Click define brazo referencia.");
      return;
    }

    L.polyline([vertex, arm1], { color: MAP_TOOL_COLOR, weight: 2 }).addTo(layer);
    const arm2 = preview ?? mapToolPreviewLatLngRef.current;
    if (!arm2) {
      mapService.setToolInfo("Transportador activo. Click final define angulo.");
      return;
    }

    const isPreview = preview !== null;
    L.polyline([vertex, arm2], { color: MAP_TOOL_COLOR, weight: 2, dashArray: isPreview ? "5 5" : undefined }).addTo(layer);
    const angle = calculateProtractorAngleDeg(vertex, arm1, arm2, PROTRACTOR_MIN_ARM_METERS);
    if (angle === null) {
      mapService.setToolInfo("Transportador activo. Brazo final invalido.");
      return;
    }

    const angleText = formatAngleDegrees(angle);
    const { arcPoints, labelLatLng } = buildProtractorArcGeometry(vertex, arm1, arm2);
    if (arcPoints.length > 1) {
      L.polyline(arcPoints, { color: MAP_TOOL_COLOR, weight: 2 }).addTo(layer);
    }
    if (labelLatLng) {
      L.marker(labelLatLng, {
        interactive: false,
        icon: L.divIcon({
          className: "",
          html: `<div class="map-protractor-label">${angleText}</div>`,
          iconSize: [72, 20],
          iconAnchor: [36, 10]
        })
      }).addTo(layer);
    }
    mapService.setToolInfo(`Transportador ${angleText}. Click cierra. Shift alinea ejes.`);
  };

  useEffect(() => {
    if (!hostRef.current || mapRef.current) return;
    const map = L.map(hostRef.current, {
      zoomControl: true,
      wheelPxPerZoomLevel: MAP_WHEEL_PX_PER_ZOOM_LEVEL,
      wheelDebounceTime: MAP_WHEEL_DEBOUNCE_MS
    }).setView([initialCenterLat, initialCenterLon], initialZoom);
    L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      {
        maxZoom: 26,
        maxNativeZoom: 19,
        detectRetina: true,
        attribution: "Tiles © Esri"
      }
    ).addTo(map);
    L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
      {
        maxZoom: 26,
        maxNativeZoom: 19,
        opacity: 0.84,
        attribution: "Labels © Esri",
        className: "map-label-overlay"
      }
    ).addTo(map);

    const drawnItems = new L.FeatureGroup();
    const waypointLayer = L.layerGroup();
    const draftLayer = L.layerGroup();
    const selectionLayer = L.layerGroup();
    const coverageLayer = L.layerGroup();
    const missionWaypointLayer = L.layerGroup();
    const toolDraftLayer = L.layerGroup();
    const toolDrawingsLayer = L.layerGroup();
    map.addLayer(drawnItems);
    map.addLayer(waypointLayer);
    map.addLayer(draftLayer);
    map.addLayer(selectionLayer);
    map.addLayer(coverageLayer);
    map.addLayer(missionWaypointLayer);
    map.addLayer(toolDraftLayer);
    map.addLayer(toolDrawingsLayer);
    mapRef.current = map;
    drawnItemsRef.current = drawnItems;
    waypointLayerRef.current = waypointLayer;
    waypointRenderKeyRef.current = "";
    draftLayerRef.current = draftLayer;
    selectionLayerRef.current = selectionLayer;
    coverageLayerRef.current = coverageLayer;
    missionWaypointLayerRef.current = missionWaypointLayer;
    missionWaypointRenderKeyRef.current = "";
    toolDraftLayerRef.current = toolDraftLayer;
    toolDrawingsLayerRef.current = toolDrawingsLayer;
    onZoomChange?.(map.getZoom());

    const handleZoomEnd = (): void => {
      onZoomChange?.(map.getZoom());
    };
    map.on("zoomend", handleZoomEnd);

    const drawControl = new L.Control.Draw({
      edit: {
        featureGroup: drawnItems
      },
      draw: {
        polyline: false,
        // El rectangulo entra por el mismo camino que el poligono: leaflet-draw
        // emite CREATED con cuatro vertices y de ahi hereda persistencia,
        // edicion, borrado y push al backend sin nada nuevo.
        rectangle: {},
        circle: false,
        marker: false,
        circlemarker: false,
        polygon: {}
      }
    });
    map.addControl(drawControl);

    const actionLinks = (): HTMLAnchorElement[] =>
      Array.from(
        document.querySelectorAll<HTMLAnchorElement>(
          ".leaflet-draw-actions a, .leaflet-draw-actions-top a, .leaflet-draw-actions-bottom a"
        )
      );
    const clickDrawAction = (patterns: string[]): boolean => {
      const action = actionLinks().find((link) => {
        const label = `${link.textContent ?? ""} ${link.title ?? ""} ${link.getAttribute("aria-label") ?? ""}`.toLowerCase();
        return patterns.some((pattern) => label.includes(pattern));
      });
      if (!action) return false;
      action.click();
      return true;
    };
    type LeafletDrawHandler = {
      enabled?: () => boolean;
      disable?: () => void;
      save?: () => void;
      completeShape?: () => void;
    };
    const drawModeHandlers = (): LeafletDrawHandler[] => {
      const control = drawControl as L.Control.Draw & {
        _toolbars?: Record<string, { _modes?: Record<string, { handler?: LeafletDrawHandler }> }>;
      };
      return Object.values(control._toolbars ?? {}).flatMap((toolbar) =>
        Object.values(toolbar._modes ?? {})
          .map((mode) => mode.handler)
          .filter((handler): handler is LeafletDrawHandler => Boolean(handler))
      );
    };
    const disableDrawHandlers = (): void => {
      drawModeHandlers().forEach((handler) => {
        if (!handler.disable) return;
        if (handler.enabled && !handler.enabled()) return;
        handler.disable();
      });
    };
    const commitDrawHandlers = (): boolean => {
      let committed = false;
      drawModeHandlers().forEach((handler) => {
        if (handler.enabled && !handler.enabled()) return;
        let handlerCommitted = false;
        try {
          if (handler.save) {
            handler.save();
            handlerCommitted = true;
          } else if (handler.completeShape) {
            handler.completeShape();
            handlerCommitted = true;
          }
        } catch {
          // Leaflet Draw throws when a polygon cannot be completed yet.
        }
        if (handlerCommitted) {
          committed = true;
        }
        if (handlerCommitted && handler.disable) {
          handler.disable();
        }
      });
      return committed;
    };
    if (mapControlRef) {
      mapControlRef.current = {
        zoomIn: () => {
          map.zoomIn();
        },
        zoomOut: () => {
          map.zoomOut();
        },
        cancelZoneTool: () => {
          clickDrawAction(["cancel", "cancelar"]);
          disableDrawHandlers();
        },
        confirmZoneTool: () => commitDrawHandlers() || clickDrawAction(["save", "finish", "guardar", "finalizar", "terminar"])
      };
    }

    // El push ya no se puede tragar en silencio: si el backend no recibe la
    // zona, planifica sin ella y el trazado que ve el operador miente. Se avisa
    // en la consola y, pase lo que pase, se marca el preview como viejo.
    const syncZones = (): void => {
      onZonesChangedRef.current();
      if (!mapService.getState().autoSync) return;
      void mapService.pushZonesToBackend().catch((error: unknown) => {
        runtime.eventBus.emit("console.event", {
          level: "warn",
          text: `No se pudieron enviar las zonas al backend: ${
            error instanceof Error ? error.message : String(error)
          }`,
          timestamp: Date.now()
        });
      });
    };

    map.on(L.Draw.Event.CREATED, (event) => {
      if (toolModeRef.current !== "idle") return;
      const layer = event.layer;
      if (!(layer instanceof L.Polygon)) return;
      const polygon = extractPolygonLatLon(layer);
      const zone = mapService.addZoneFromPolygon(polygon);
      (layer as L.Polygon & { zoneId?: string }).zoneId = zone.id;
      drawnItems.addLayer(layer);
      syncZones();
      onZoneToolSettledRef.current();
    });

    map.on(L.Draw.Event.EDITED, (event: L.LeafletEvent) => {
      const layers = (event as unknown as { layers?: L.LayerGroup }).layers;
      if (!layers) return;
      layers.eachLayer((layer) => {
        if (!(layer instanceof L.Polygon)) return;
        const zoneId = (layer as L.Polygon & { zoneId?: string }).zoneId;
        if (!zoneId) return;
        mapService.setZonePolygon(zoneId, extractPolygonLatLon(layer));
      });
      syncZones();
      onZoneToolSettledRef.current();
    });

    map.on(L.Draw.Event.DELETED, (event: L.LeafletEvent) => {
      const layers = (event as unknown as { layers?: L.LayerGroup }).layers;
      if (!layers) return;
      layers.eachLayer((layer) => {
        if (!(layer instanceof L.Polygon)) return;
        const zoneId = (layer as L.Polygon & { zoneId?: string }).zoneId;
        if (!zoneId) return;
        mapService.removeZone(zoneId, { sync: false });
      });
      syncZones();
      onZoneToolSettledRef.current();
    });

    map.on("click", (evt: L.LeafletMouseEvent) => {
      if (!interactiveRef.current) return;
      // Dibujar el lote de CAMPO se lleva el click antes que nada: mientras se
      // marca el poligono, el mapa no tiene que encolar waypoints.
      if (coverageDraftModeRef.current !== "idle") {
        onCoverageDraftVertexRef.current(evt.latlng.lat, evt.latlng.lng);
        return;
      }
      const mode = toolModeRef.current;
      const domEvent = evt.originalEvent as MouseEvent | undefined;
      if (domEvent?.detail && domEvent.detail > 1) return;
      if (mode === "inspect") {
        mapService.setInspectCoords(evt.latlng.lat, evt.latlng.lng);
        const coordsText = `${evt.latlng.lat.toFixed(6)}, ${evt.latlng.lng.toFixed(6)}`;
        const buttonId = `inspect-copy-${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
        const popup = L.popup({
          className: "map-inspect-leaflet-popup"
        })
          .setLatLng(evt.latlng)
          .setContent(
            `<div class="map-inspect-popup"><div class="coords">${coordsText}</div><button type="button" id="${buttonId}" class="map-inspect-copy">Copy</button></div>`
          );
        popup.openOn(map);
        window.setTimeout(() => {
          const button = document.getElementById(buttonId);
          if (!button) return;
          const onClick = (): void => {
            if (typeof navigator !== "undefined" && navigator.clipboard) {
              void navigator.clipboard.writeText(coordsText);
            }
            runtime.eventBus.emit("console.event", {
              level: "info",
              text: `Inspect copied: ${coordsText}`,
              timestamp: Date.now()
            });
          };
          button.addEventListener("click", onClick, { once: true });
          inspectCopyHandlersRef.current.push(() => button.removeEventListener("click", onClick));
        }, 0);
        return;
      }
      if (mode === "ruler") {
        measurePointsRef.current = collectMeasurePoints(evt.latlng);
        mapToolPreviewLatLngRef.current = null;
        renderRulerMeasure(null);
        return;
      }
      if (mode === "area") {
        measurePointsRef.current = collectMeasurePoints(evt.latlng);
        mapToolPreviewLatLngRef.current = null;
        renderAreaMeasure(null);
        return;
      }
      if (mode === "protractor") {
        const shiftPressed = Boolean((evt.originalEvent as MouseEvent | undefined)?.shiftKey);
        if (!protractorVertexRef.current) {
          protractorVertexRef.current = evt.latlng;
          protractorArm1Ref.current = null;
          mapToolPreviewLatLngRef.current = null;
          renderProtractorMeasure(null);
          return;
        }
        const snappedLatLng = resolveProtractorPoint(evt.latlng, shiftPressed);
        if (!protractorArm1Ref.current) {
          protractorArm1Ref.current = snappedLatLng;
          mapToolPreviewLatLngRef.current = null;
          renderProtractorMeasure(null);
          return;
        }
        finalizeProtractorMeasure(snappedLatLng);
        return;
      }
    });

    map.on("dblclick", (evt: L.LeafletMouseEvent) => {
      if (!interactiveRef.current) return;
      const mode = toolModeRef.current;
      if (mode !== "ruler" && mode !== "area" && mode !== "protractor") return;
      L.DomEvent.stop(evt.originalEvent);
      if (mode === "ruler") {
        finalizeRulerMeasure(evt.latlng);
        return;
      }
      if (mode === "protractor") {
        const shiftPressed = Boolean((evt.originalEvent as MouseEvent | undefined)?.shiftKey);
        finalizeProtractorMeasure(resolveProtractorPoint(evt.latlng, shiftPressed));
        return;
      }
      finalizeAreaMeasure(evt.latlng);
    });

    map.on("mousedown", (evt: L.LeafletMouseEvent) => {
      if (!interactiveRef.current) return;
      if (toolModeRef.current !== "idle") return;
      const domEvent = evt.originalEvent as MouseEvent | undefined;
      if (!domEvent) return;
      if (typeof domEvent.button === "number" && domEvent.button !== 0) return;
      if (!isMapBackgroundPointerEvent(domEvent)) return;
      if (waypointSelectionModeRef.current) {
        const rectangle = L.rectangle(L.latLngBounds(evt.latlng, evt.latlng), {
          color: "#55ff7f",
          weight: 1.5,
          opacity: 0.95,
          fillColor: "#55ff7f",
          fillOpacity: 0.12,
          interactive: false
        });
        selectionLayerRef.current?.clearLayers();
        rectangle.addTo(selectionLayerRef.current ?? L.layerGroup());
        waypointSelectionSessionRef.current = {
          start: evt.latlng,
          additive: domEvent.shiftKey,
          rectangle
        };
        if (map.dragging.enabled()) {
          map.dragging.disable();
        }
        return;
      }
      if (!goalModeRef.current) return;
      goalCreateSessionRef.current = { active: true, hasMoved: false };
      goalDraftRef.current = {
        lat: Number(evt.latlng.lat),
        lon: Number(evt.latlng.lng),
        dragYaw: false
      };
      if (map.dragging.enabled()) {
        map.dragging.disable();
      }
      renderGoalDraft();
    });

    map.on("mousemove", (evt: L.LeafletMouseEvent) => {
      const selection = waypointSelectionSessionRef.current;
      if (selection) {
        selection.rectangle.setBounds(L.latLngBounds(selection.start, evt.latlng));
        return;
      }
      if (goalCreateSessionRef.current.active) {
        const draft = goalDraftRef.current;
        if (!draft) return;
        const origin = L.latLng(draft.lat, draft.lon);
        const distanceM = map.distance(origin, evt.latlng);
        const dragYaw = distanceM > 0.35;
        draft.dragYaw = dragYaw;
        if (dragYaw) {
          draft.yawDeg = yawDegFromLatLng(origin, evt.latlng);
          goalCreateSessionRef.current.hasMoved = true;
        }
        renderGoalDraft();
        return;
      }
      if (!interactiveRef.current) return;
      const mode = toolModeRef.current;
      if (mode === "ruler") {
        mapToolPreviewLatLngRef.current = evt.latlng;
        renderRulerMeasure(evt.latlng);
        return;
      }
      if (mode === "area") {
        mapToolPreviewLatLngRef.current = evt.latlng;
        renderAreaMeasure(evt.latlng);
        return;
      }
      if (mode === "protractor") {
        const shiftPressed = Boolean((evt.originalEvent as MouseEvent | undefined)?.shiftKey);
        const previewPoint = resolveProtractorPoint(evt.latlng, shiftPressed);
        mapToolPreviewLatLngRef.current = previewPoint;
        renderProtractorMeasure(previewPoint);
      }
    });

    map.on("mouseup", (evt: L.LeafletMouseEvent) => {
      const selection = waypointSelectionSessionRef.current;
      if (selection) {
        const bounds = L.latLngBounds(selection.start, evt.latlng);
        const indexes = waypointsRef.current
          .map((waypoint, index) => ({ index, lat: Number(waypoint.x), lon: Number(waypoint.y) }))
          .filter((waypoint) => Number.isFinite(waypoint.lat) && Number.isFinite(waypoint.lon))
          .filter((waypoint) => bounds.contains([waypoint.lat, waypoint.lon]))
          .map((waypoint) => waypoint.index);
        clearWaypointSelectionDraft();
        onSetWaypointSelectionRef.current(indexes, selection.additive ? "add" : "replace");
        return;
      }
      if (!goalCreateSessionRef.current.active) return;
      const draft = goalDraftRef.current;
      clearGoalDraft();
      clearWaypointSelectionDraft();
      if (!draft) return;
      onQueueWaypointRef.current(draft.lat, draft.lon, draft.dragYaw ? draft.yawDeg : undefined);
    });

    map.on("mouseout", () => {
      if (toolModeRef.current === "ruler" || toolModeRef.current === "area" || toolModeRef.current === "protractor") {
        clearMeasureTooltip();
      }
    });

    return () => {
      clearGoalDraft();
      clearToolDrawings();
      inspectCopyHandlersRef.current.forEach((cleanup) => cleanup());
      inspectCopyHandlersRef.current = [];
      map.off("zoomend", handleZoomEnd);
      if (mapControlRef) {
        mapControlRef.current = null;
      }
      map.remove();
      mapRef.current = null;
      drawnItemsRef.current = null;
      waypointLayerRef.current = null;
      waypointRenderKeyRef.current = "";
      draftLayerRef.current = null;
      selectionLayerRef.current = null;
      coverageLayerRef.current = null;
      missionWaypointLayerRef.current = null;
      missionWaypointRenderKeyRef.current = "";
      toolDraftLayerRef.current = null;
      toolDrawingsLayerRef.current = null;
      robotMarkerRef.current = null;
      robotTrailRef.current = null;
      robotTrailPointsRef.current = [];
      datumMarkerRef.current = null;
      draftMarkerRef.current = null;
      measurePointsRef.current = [];
      protractorVertexRef.current = null;
      protractorArm1Ref.current = null;
    };
  }, [initialCenterLat, initialCenterLon, initialZoom, mapControlRef, mapService, onZoomChange, runtime.eventBus]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (interactive) {
      map.dragging.enable();
      map.scrollWheelZoom.enable();
      map.doubleClickZoom.enable();
      map.boxZoom.enable();
      map.keyboard.enable();
      map.touchZoom.enable();
      map.zoomControl.addTo(map);
    } else {
      map.dragging.disable();
      map.scrollWheelZoom.disable();
      map.doubleClickZoom.disable();
      map.boxZoom.disable();
      map.keyboard.disable();
      map.touchZoom.disable();
      map.zoomControl.remove();
    }
    window.setTimeout(() => map.invalidateSize(), 0);
  }, [interactive]);

  useEffect(() => {
    const map = mapRef.current;
    const host = hostRef.current;
    if (!map || !host || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      map.invalidateSize();
    });
    observer.observe(host);
    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!state.map) return;
    if (!Number.isFinite(state.map.originLat) || !Number.isFinite(state.map.originLon)) return;
    if (Math.abs(state.map.originLat) < 1e-9 && Math.abs(state.map.originLon) < 1e-9) return;
    const nextKey = `${state.map.mapId}:${state.map.originLat}:${state.map.originLon}`;
    if (appliedMapOriginKeyRef.current === nextKey) return;
    appliedMapOriginKeyRef.current = nextKey;
    map.setView([state.map.originLat, state.map.originLon], map.getZoom());
  }, [state.map?.mapId, state.map?.originLat, state.map?.originLon]);

  useEffect(() => {
    const drawnItems = drawnItemsRef.current;
    if (!drawnItems) return;
    drawnItems.clearLayers();
    state.zones.forEach((zone) => {
      const polygon = Array.isArray(zone.polygon) ? zone.polygon : [];
      if (polygon.length < 3) return;
      const layer = L.polygon(
        polygon.map((entry) => [entry.lat, entry.lon]),
        {
          color: zone.enabled === false ? "#64748b" : "#f97316",
          weight: 3,
          fillOpacity: zone.enabled === false ? 0.1 : 0.25
        }
      ) as L.Polygon & { zoneId?: string };
      layer.zoneId = zone.id;
      layer.on("click", () => {
        if (toolModeRef.current !== "idle") return;
        mapService.toggleZoneEnabled(zone.id);
      });
      drawnItems.addLayer(layer);
    });
  }, [mapService, state.zones]);

  useEffect(() => {
    const layer = coverageLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    if (!coverageState) return;

    // Modo poligono: se dibuja el borrador y no el cuadrado legacy. Son dos
    // representaciones distintas del lote y no se superponen nunca.
    if (coverageState.fieldSource === "polygon" && mapRef.current) {
      dibujarBorradorDeLote(layer, mapRef.current, coverageState, {
        onMove: (ringId, index, lat, lon) =>
          onCoverageDraftMoveVertexRef.current(ringId, index, lat, lon),
        onRemove: (ringId, index) =>
          onCoverageDraftRemoveVertexRef.current(ringId, index),
        onTranslate: (deltaLat, deltaLon) =>
          onCoverageDraftTranslateRef.current(deltaLat, deltaLon),
        onRotate: (deltaDeg) => onCoverageDraftRotateRef.current(deltaDeg),
        onScaleFromVertex: (index, lat, lon) =>
          onCoverageDraftScaleRef.current(index, lat, lon)
      });
    }

    const fieldPoints =
      coverageState.fieldSource === "polygon"
        ? []
        : coverageState.fieldPolygon.filter(
            (point) => Number.isFinite(point.lat) && Number.isFinite(point.lon)
          );
    if (fieldPoints.length >= 3) {
      // El lote se dibuja firme, no punteado: es una figura que se manipula, no
      // una guia. El relleno es lo que lo hace agarrable en toda su superficie.
      const campo = L.polygon(
        fieldPoints.map((point) => [point.lat, point.lon] as L.LatLngTuple),
        {
          color: COVERAGE_FIELD_COLOR,
          weight: 2.5,
          opacity: 1,
          fillColor: COVERAGE_FIELD_COLOR,
          fillOpacity: 0.12,
          interactive: fieldPoints.length === 4 && !coverageState.sending,
          className: "coverage-field-shape"
        }
      );
      campo.addTo(layer);

      if (fieldPoints.length === 4 && !coverageState.sending) {
        const origen = fieldPoints[0]!;
        const opuesta = fieldPoints[2]!;
        const centro = {
          lat: (origen.lat + opuesta.lat) / 2,
          lon: (origen.lon + opuesta.lon) / 2
        };

        campo.bindTooltip("Arrastrar para mover · esquinas para el lado", {
          direction: "center",
          className: "coverage-field-hintbox",
          opacity: 0.9
        });

        // Formas que se mueven durante el gesto. Se guardan aca porque el
        // arrastre las corre a mano, sin volver a construir la capa.
        const tiradores: L.Marker[] = [];
        let lineaGiro: L.Polyline | null = null;
        let tiradorGiro: L.Marker | null = null;
        let marcaCentro: L.CircleMarker | null = null;

        /**
         * Dibujar un lote que todavia no se guardo.
         *
         * Mientras dura el arrastre no se toca el estado: se corren las formas de
         * Leaflet directamente. Guardar en cada `mousemove` obligaba a rearmar la
         * capa entera —poligono, cuatro tiradores, giro y trazado— decenas de
         * veces por segundo, y el cuadrado quedaba atras del mouse. Asi sigue al
         * puntero y el estado se escribe una sola vez, al soltar.
         */
        const redibujar = (poligono: Array<{ lat: number; lon: number }> | null): void => {
          if (!poligono || poligono.length !== 4) return;
          const [p0, , p2] = poligono as [
            { lat: number; lon: number },
            { lat: number; lon: number },
            { lat: number; lon: number },
            { lat: number; lon: number }
          ];
          campo.setLatLngs(poligono.map((punto) => [punto.lat, punto.lon] as L.LatLngTuple));
          poligono.forEach((esquina, indice) => {
            tiradores[indice]?.setLatLng([esquina.lat, esquina.lon]);
          });
          const centroNuevo = { lat: (p0.lat + p2.lat) / 2, lon: (p0.lon + p2.lon) / 2 };
          const giroLatNuevo = centroNuevo.lat + (p2.lat - centroNuevo.lat) * 1.22;
          const giroLonNuevo = centroNuevo.lon + (p2.lon - centroNuevo.lon) * 1.22;
          lineaGiro?.setLatLngs([
            [p2.lat, p2.lon] as L.LatLngTuple,
            [giroLatNuevo, giroLonNuevo] as L.LatLngTuple
          ]);
          tiradorGiro?.setLatLng([giroLatNuevo, giroLonNuevo]);
          marcaCentro?.setLatLng([centroNuevo.lat, centroNuevo.lon]);
        };

        /**
         * Arrastre de una forma del lote.
         *
         * Los movimientos se escuchan sobre el mapa y no sobre la forma: al soltar
         * se guarda y la capa se reconstruye, asi que la forma original ya no
         * existe para recibir el `mouseup`. `aPunto` traduce la posicion del mouse
         * a la coordenada que espera el servicio —para el poligono es el centro
         * corrido, para los tiradores el puntero mismo—. Si no hubo movimiento no
         * se guarda nada: un click suelto no tiene por que invalidar el preview.
         */
        const arrastrar = (
          objetivo: L.Marker | L.Polygon,
          aPunto: (latlng: L.LatLng, apriete: L.LatLng) => { lat: number; lon: number },
          previsualizar: (punto: { lat: number; lon: number }) => void,
          confirmar: (punto: { lat: number; lon: number }) => void
        ): void => {
          objetivo.on("mousedown", (evento: L.LeafletMouseEvent) => {
            const map = mapRef.current;
            if (!map || !interactiveRef.current) return;
            L.DomEvent.stopPropagation(evento.originalEvent);
            L.DomEvent.preventDefault(evento.originalEvent);
            map.dragging.disable();
            objetivo.closeTooltip();

            const apriete = evento.latlng;
            let ultimo = aPunto(apriete, apriete);
            let huboMovimiento = false;

            const paso = (movimiento: L.LeafletMouseEvent): void => {
              huboMovimiento = true;
              ultimo = aPunto(movimiento.latlng, apriete);
              previsualizar(ultimo);
            };
            const soltar = (): void => {
              map.off("mousemove", paso);
              map.off("mouseup", soltar);
              if (interactiveRef.current) map.dragging.enable();
              if (huboMovimiento) confirmar(ultimo);
            };
            map.on("mousemove", paso);
            map.on("mouseup", soltar);
          });
        };

        // Mover: se agarra el cuadrado en cualquier punto y el centro se corre lo
        // mismo que el mouse, para que no pegue un salto al apretar.
        arrastrar(
          campo,
          (latlng, apriete) => ({
            lat: centro.lat + (latlng.lat - apriete.lat),
            lon: centro.lon + (latlng.lng - apriete.lng)
          }),
          (punto) =>
            redibujar(onCoverageFieldPreviewRef.current("move", punto.lat, punto.lon)),
          (punto) => onCoverageFieldMoveRef.current(punto.lat, punto.lon)
        );

        // Las cuatro esquinas cambian el lado. La diagonalmente opuesta queda
        // fija, que es lo que espera cualquiera que haya redimensionado un
        // rectangulo en un editor.
        fieldPoints.forEach((esquina, indice) => {
          const tirador = L.marker([esquina.lat, esquina.lon], {
            icon: buildCoverageHandleIcon(indice === 0 ? "inicio" : "resize"),
            interactive: true,
            zIndexOffset: 600
          }).bindTooltip(
            indice === 0
              ? "Esquina de arranque · arrastrar para cambiar el lado"
              : "Arrastrar para cambiar el lado",
            { direction: "top" }
          );
          arrastrar(
            tirador,
            (latlng) => ({ lat: latlng.lat, lon: latlng.lng }),
            (punto) =>
              redibujar(
                onCoverageFieldPreviewRef.current("resize", punto.lat, punto.lon, indice)
              ),
            (punto) => onCoverageFieldResizeRef.current(punto.lat, punto.lon, indice)
          );
          tirador.addTo(layer);
          tiradores.push(tirador);
        });

        // El tirador de giro cuelga de la esquina superior derecha del lote —la
        // opuesta a la de arranque— y gira con el cuadrado, asi que nunca salta
        // de una esquina a otra mientras se lo arrastra.
        const giroLat = centro.lat + (opuesta.lat - centro.lat) * 1.22;
        const giroLon = centro.lon + (opuesta.lon - centro.lon) * 1.22;

        lineaGiro = L.polyline(
          [
            [opuesta.lat, opuesta.lon] as L.LatLngTuple,
            [giroLat, giroLon] as L.LatLngTuple
          ],
          {
            color: COVERAGE_FIELD_COLOR,
            weight: 1.5,
            opacity: 0.8,
            dashArray: "3 3",
            interactive: false
          }
        );
        lineaGiro.addTo(layer);

        const giro = L.marker([giroLat, giroLon], {
          icon: buildCoverageHandleIcon("rotar"),
          interactive: true,
          zIndexOffset: 700
        }).bindTooltip("Arrastrar para girar el cuadrado", { direction: "top" });
        arrastrar(
          giro,
          (latlng) => ({ lat: latlng.lat, lon: latlng.lng }),
          (punto) =>
            redibujar(onCoverageFieldPreviewRef.current("rotate", punto.lat, punto.lon)),
          (punto) => onCoverageFieldRotateRef.current(punto.lat, punto.lon)
        );
        giro.addTo(layer);
        tiradorGiro = giro;

        // El centro deja de ser una manija y pasa a ser una marca de referencia:
        // mover ya se hace agarrando el cuadrado entero.
        marcaCentro = L.circleMarker([centro.lat, centro.lon], {
          radius: 3,
          color: COVERAGE_FIELD_COLOR,
          weight: 2,
          fillColor: COVERAGE_FIELD_COLOR,
          fillOpacity: 1,
          interactive: false
        });
        marcaCentro.addTo(layer);
      }
    }

    // La capa azul representa la ruta que se envia, no el muestreo interno del
    // planner. Asi una cabecera reducida para el limite de route_executor no
    // promete en pantalla una curva que el vehiculo no va a seguir.
    const sampledPoints = (coverageState.preview?.executionWaypoints ?? []).filter(
      (point) => Number.isFinite(point.lat) && Number.isFinite(point.lon)
    );
    if (sampledPoints.length >= 2) {
      const routeColor = coverageState.preview?.topologySafe
        ? COVERAGE_ROUTE_COLOR
        : COVERAGE_ROUTE_UNSAFE_COLOR;
      L.polyline(
        sampledPoints.map((point) => [point.lat, point.lon] as L.LatLngTuple),
        {
          color: routeColor,
          weight: 3,
          opacity: 0.96,
          lineCap: "round",
          lineJoin: "round",
          interactive: false
        }
      ).addTo(layer);
      const start = sampledPoints[0];
      const end = sampledPoints[sampledPoints.length - 1];
      if (start) {
        L.circleMarker([start.lat, start.lon], {
          radius: 5,
          color: "#dbeafe",
          weight: 2,
          fillColor: "#f8fafc",
          fillOpacity: 1,
          interactive: false
        }).addTo(layer);
      }
      if (end) {
        L.circleMarker([end.lat, end.lon], {
          radius: 4,
          color: routeColor,
          weight: 2,
          fillColor: "#111827",
          fillOpacity: 1,
          interactive: false
        }).addTo(layer);
      }
    }
  }, [coverageState]);

  useEffect(() => {
    const layer = missionWaypointLayerRef.current;
    if (!layer) return;

    const previewPoints = (coverageState?.preview?.keyWaypoints ?? []).filter(
      (point) => Number.isFinite(point.lat) && Number.isFinite(point.lon)
    );
    const missionPoints = (routeMission?.missionWaypoints ?? [])
      .map((point, index) => ({
        index,
        lat: Number(point.x),
        lon: Number(point.y),
        yawDeg: Number(point.yawDeg ?? 0),
        preview: previewPoints[index] ?? null
      }))
      .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lon));
    const points = missionPoints.length > 0
      ? missionPoints.map((point) => ({
          ...point,
          state: routeMission
            ? getRouteWaypointVisualState(routeMission, point.index)
            : "pending" as const
        }))
      : previewPoints.map((point, index) => ({
          index,
          lat: Number(point.lat),
          lon: Number(point.lon),
          yawDeg: Number(point.yawDeg ?? 0),
          preview: point,
          state: "preview" as const
        }));
    const renderKey = points.length === 0
      ? "__empty__"
      : points
          .map((point) =>
            `${point.index}:${point.lat.toFixed(7)}:${point.lon.toFixed(7)}:${point.yawDeg.toFixed(2)}:${point.state}`
          )
          .join("|");
    if (renderKey === missionWaypointRenderKeyRef.current) return;
    missionWaypointRenderKeyRef.current = renderKey;
    layer.clearLayers();

    points.forEach((point) => {
      const rowIndex = Number(point.preview?.rowIndex ?? -1);
      const details = [
        `Waypoint ${point.index + 1}`,
        missionWaypointStateLabel(point.state),
        Number.isFinite(rowIndex) && rowIndex >= 0 ? `fila ${rowIndex + 1}` : "",
        `${point.lat.toFixed(7)}, ${point.lon.toFixed(7)}`,
        `yaw ${point.yawDeg.toFixed(1)}°`
      ].filter(Boolean);
      L.marker([point.lat, point.lon], {
        icon: buildWaypointIcon(
          String(point.index + 1),
          point.yawDeg,
          false,
          false,
          true,
          false,
          false,
          null,
          point.state
        ),
        interactive: true,
        keyboard: false,
        riseOnHover: true,
        zIndexOffset: point.state === "current" || point.state === "blocked" ? 650 : 500
      })
        .bindTooltip(details.join(" · "), {
          direction: "top",
          offset: [0, -12],
          className: "mission-waypoint-tooltip"
        })
        .addTo(layer);
    });
  }, [coverageState?.preview, routeMission]);

  useEffect(() => {
    const layer = waypointLayerRef.current;
    if (!layer) return;
    const patrolDisplayMap = buildPatrolWaypointDisplayMap(patrolMissionProfile, robotPose);
    if (!Array.isArray(waypoints) || waypoints.length === 0) {
      if (waypointRenderKeyRef.current !== "__empty__") {
        layer.clearLayers();
        waypointRenderKeyRef.current = "__empty__";
      }
      return;
    }
    const points = waypoints
      .map((waypoint, index) => {
        const patrolDisplay = patrolDisplayMap.get(waypointLocalId(waypoint));
        return {
          index,
          lat: Number(waypoint.x),
          lon: Number(waypoint.y),
          yawDeg: waypointHasManualYaw(waypoint) ? Number(waypoint.yawDeg) : undefined,
          manual: waypointHasManualYaw(waypoint),
          action: (waypoint.actions ?? []).length > 0,
          home: waypoint.role === "home" || patrolDisplay?.badge === "H",
          selected: selectedWaypointIndexes.includes(index),
          patrolDisplay
        };
      })
      .filter((entry) => Number.isFinite(entry.lat) && Number.isFinite(entry.lon));
    const previewPoints = points.map((entry) => ({
      lat: entry.lat,
      lon: entry.lon,
      yawDeg: entry.yawDeg,
      manual: entry.manual
    }));
    const displayPoints = points.map((entry, displayIndex) => ({
      ...entry,
      patrolSegment: entry.patrolDisplay?.segment ?? null,
      displayBadge: entry.home ? "H" : entry.patrolDisplay?.badge ?? String(entry.index + 1),
      displayYawDeg:
        entry.patrolDisplay?.previewYawDeg ??
        resolveWaypointPreviewYawDeg(previewPoints, displayIndex, loopRoute, robotPose)
    }));
    const renderKey =
      displayPoints.length === 0
        ? "__empty__"
        : displayPoints
            .map(
              (entry) =>
                `${entry.index}:${entry.lat.toFixed(7)}:${entry.lon.toFixed(7)}:${entry.displayYawDeg.toFixed(2)}:${entry.manual ? 1 : 0}:${entry.selected ? 1 : 0}:${entry.action ? 1 : 0}:${entry.home ? 1 : 0}:${entry.patrolSegment ?? "-"}`
                + `:${entry.displayBadge}`
            )
            .join("|");
    if (renderKey === waypointRenderKeyRef.current) return;
    waypointRenderKeyRef.current = renderKey;
    layer.clearLayers();
    if (displayPoints.length === 0) return;
      displayPoints.forEach((entry) => {
        const marker = L.marker([entry.lat, entry.lon], {
          icon: buildWaypointIcon(
            entry.displayBadge,
            entry.displayYawDeg,
            false,
            entry.selected,
            entry.manual,
            entry.action,
            entry.home,
            entry.patrolSegment
          ),
          interactive: true,
          draggable: true
        }).bindTooltip(`${buildWaypointLabel(entry.home, entry.patrolSegment, entry.action)} ${entry.displayBadge}`.trim(), { direction: "top" });
      marker.on("dragstart", () => {
        const map = mapRef.current;
        if (map?.dragging.enabled()) {
          map.dragging.disable();
        }
      });
      marker.on("dragend", () => {
        const latLng = marker.getLatLng();
        onMoveWaypointRef.current(entry.index, Number(latLng.lat), Number(latLng.lng));
        waypointDragEndMsRef.current = Date.now();
        const map = mapRef.current;
        if (interactiveRef.current && map && !map.dragging.enabled()) {
          map.dragging.enable();
        }
      });
      marker.on("click", () => {
        if (Date.now() - waypointDragEndMsRef.current < 250) return;
        onToggleWaypointSelectionRef.current(entry.index);
      });
      marker.addTo(layer);
    });
  }, [loopRoute, patrolMissionProfile, robotPose, selectedWaypointIndexes, waypoints]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!robotPose) {
      if (robotMarkerRef.current) {
        map.removeLayer(robotMarkerRef.current);
        robotMarkerRef.current = null;
      }
      return;
    }
    const latLng = L.latLng(robotPose.lat, robotPose.lon);

    if (showRobotTrail) {
      const trailPoints = robotTrailPointsRef.current;
      const lastPoint = trailPoints[trailPoints.length - 1];
      if (!lastPoint || lastPoint.distanceTo(latLng) >= ROBOT_TRAIL_MIN_STEP_M) {
        trailPoints.push(latLng);
        if (trailPoints.length > ROBOT_TRAIL_MAX_POINTS) {
          trailPoints.splice(0, trailPoints.length - ROBOT_TRAIL_MAX_POINTS);
        }
        if (!robotTrailRef.current) {
          robotTrailRef.current = L.polyline(trailPoints, {
            color: ROBOT_TRAIL_COLOR,
            weight: 2,
            opacity: 0.85,
            interactive: false
          }).addTo(map);
        } else {
          robotTrailRef.current.setLatLngs(trailPoints);
        }
      }
    }

    if (!robotMarkerRef.current) {
      robotMarkerRef.current = L.marker(latLng, {
        icon: buildRobotIcon(robotPose.headingDeg),
        interactive: false
      }).addTo(map);
      return;
    }
    robotMarkerRef.current.setLatLng(latLng);
    robotMarkerRef.current.setIcon(buildRobotIcon(robotPose.headingDeg));
  }, [robotPose, showRobotTrail]);

  useEffect(() => {
    if (showRobotTrail) return;
    const map = mapRef.current;
    if (map && robotTrailRef.current) {
      map.removeLayer(robotTrailRef.current);
    }
    robotTrailRef.current = null;
    robotTrailPointsRef.current = [];
  }, [showRobotTrail]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!datumPose) {
      if (datumMarkerRef.current) {
        map.removeLayer(datumMarkerRef.current);
        datumMarkerRef.current = null;
      }
      return;
    }
    const latLng = L.latLng(datumPose.lat, datumPose.lon);
    if (!datumMarkerRef.current) {
      datumMarkerRef.current = L.marker(latLng, {
        icon: buildDatumIcon(),
        interactive: false
      }).addTo(map);
      return;
    }
    datumMarkerRef.current.setLatLng(latLng);
    datumMarkerRef.current.setIcon(buildDatumIcon());
  }, [datumPose]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !robotPose || centerRequestKey <= 0) return;
    if (centerRequestHandledRef.current === centerRequestKey) return;
    centerRequestHandledRef.current = centerRequestKey;
    map.setView([robotPose.lat, robotPose.lon], Math.max(map.getZoom(), 17));
  }, [centerRequestKey, robotPose]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.setView([initialCenterLat, initialCenterLon], initialZoom);
  }, [initialCenterLat, initialCenterLon, initialZoom]);

  useEffect(() => {
    if (state.toolMode !== "idle") {
      clearGoalDraft();
    }
    if (state.toolMode === "idle") {
      clearToolDrawings();
      return;
    }
    clearMeasureDraft();
    setToolLegend(state.toolMode);
  }, [state.toolMode]);

  useEffect(() => {
    if (!goalMode) {
      clearGoalDraft();
    }
    if (goalMode) return;
    mapToolPreviewLatLngRef.current = null;
    clearMeasureTooltip();
  }, [goalMode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const container = map.getContainer();
    if (state.toolMode !== "idle" || goalMode) {
      container.classList.add("map-tool-pointer");
    } else {
      container.classList.remove("map-tool-pointer");
    }
    return () => {
      container.classList.remove("map-tool-pointer");
    };
  }, [goalMode, state.toolMode]);

  return <div ref={hostRef} className="leaflet-host map-host-canvas" />;
}

function CockpitMapCanvas({
  state,
  mapService,
  interactive,
  goalMode,
  waypoints,
  patrolMissionProfile,
  selectedWaypointIndexes,
  robotPose,
  datumPose,
  centerRequestKey,
  onQueueWaypoint,
  onToggleWaypointSelection,
  onMoveWaypoint,
  loopRoute,
  initialCenterLat,
  initialCenterLon,
  initialZoom,
  onZoomChange,
  mapControlRef,
  activeWaypointIndex
}: {
  state: MapWorkspaceState;
  mapService: MapService;
  interactive: boolean;
  goalMode: boolean;
  waypoints: NavigationState["waypoints"];
  patrolMissionProfile: NavigationState["patrolMissionProfile"];
  selectedWaypointIndexes: number[];
  robotPose: TelemetrySnapshot["robotPose"];
  datumPose: { lat: number; lon: number } | null;
  centerRequestKey: number;
  onQueueWaypoint: (lat: number, lon: number, yawDeg?: number) => void;
  onToggleWaypointSelection: (index: number) => void;
  onMoveWaypoint: (index: number, lat: number, lon: number) => void;
  loopRoute: boolean;
  initialCenterLat: number;
  initialCenterLon: number;
  initialZoom: number;
  onZoomChange?: (zoom: number) => void;
  mapControlRef?: { current: MapViewportControlHandle | null };
  activeWaypointIndex: number | null;
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const previousToolModeRef = useRef<MapToolMode>(state.toolMode);
  const suppressCanvasClickRef = useRef(false);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(initialZoom);
  const [previewPoint, setPreviewPoint] = useState<GeoPoint | null>(null);
  const [inspectPoint, setInspectPoint] = useState<GeoPoint | null>(null);
  const [measurePoints, setMeasurePoints] = useState<GeoPoint[]>([]);
  const [protractorVertex, setProtractorVertex] = useState<GeoPoint | null>(null);
  const [protractorArm, setProtractorArm] = useState<GeoPoint | null>(null);
  const [protractorEnd, setProtractorEnd] = useState<GeoPoint | null>(null);
  const [goalDraft, setGoalDraft] = useState<{
    pointerId: number;
    origin: GeoPoint;
    yawDeg?: number;
  } | null>(null);
  const [dragWaypoint, setDragWaypoint] = useState<{
    pointerId: number;
    index: number;
    lat: number;
    lon: number;
    startClientX: number;
    startClientY: number;
    moved: boolean;
  } | null>(null);

  const fallbackCenter = { lat: initialCenterLat, lon: initialCenterLon };
  const centerPoint: GeoPoint = robotPose
    ? { lat: robotPose.lat, lon: robotPose.lon }
    : datumPose ?? fallbackCenter;

  const geometryPoints: GeoPoint[] = [];
  if (robotPose) {
    geometryPoints.push({ lat: robotPose.lat, lon: robotPose.lon });
  }
  if (datumPose) {
    geometryPoints.push(datumPose);
  }
  waypoints.forEach((waypoint) => {
    const lat = Number(waypoint.x);
    const lon = Number(waypoint.y);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    geometryPoints.push({ lat, lon });
  });
  state.zones.forEach((zone) => {
    zone.polygon?.forEach((vertex) => geometryPoints.push(vertex));
  });

  const maxDistanceMeters = geometryPoints.reduce((currentMax, point) => {
    return Math.max(currentMax, distanceBetweenGeoPointsMeters(centerPoint, point));
  }, 0);
  const zoomFactor = Math.pow(1.26, zoom - initialZoom);
  const visibleRadiusMeters = clampNumber(
    (maxDistanceMeters > 0 ? maxDistanceMeters * 1.35 : 34) / zoomFactor,
    14,
    800
  );
  const stageWidth = viewportSize.width || 960;
  const stageHeight = viewportSize.height || 540;
  const centerX = stageWidth / 2;
  const centerY = stageHeight / 2;
  const usableRadiusPx = Math.max(120, Math.min(stageWidth, stageHeight) * 0.36);
  const pixelsPerMeter = usableRadiusPx / visibleRadiusMeters;

  const projectPoint = (point: GeoPoint): { x: number; y: number } => {
    const delta = geoDeltaMeters(centerPoint, point);
    return {
      x: centerX + delta.eastM * pixelsPerMeter,
      y: centerY - delta.northM * pixelsPerMeter
    };
  };

  const resolvePointFromClient = (clientX: number, clientY: number): GeoPoint | null => {
    const host = hostRef.current;
    if (!host) return null;
    const rect = host.getBoundingClientRect();
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    const eastM = (localX - centerX) / pixelsPerMeter;
    const northM = (centerY - localY) / pixelsPerMeter;
    return offsetGeoPoint(centerPoint, eastM, northM);
  };

  const resolveProtractorPoint = (rawPoint: GeoPoint, shiftPressed: boolean): GeoPoint => {
    if (!shiftPressed || !protractorVertex) return rawPoint;
    const snapped = snapToCartesianAxis(
      L.latLng(protractorVertex.lat, protractorVertex.lon),
      L.latLng(rawPoint.lat, rawPoint.lon),
      PROTRACTOR_SNAP_THRESHOLD_DEG,
      PROTRACTOR_MIN_ARM_METERS
    );
    return { lat: snapped.lat, lon: snapped.lng };
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const updateSize = (): void => {
      setViewportSize({
        width: host.clientWidth,
        height: host.clientHeight
      });
    };
    updateSize();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => updateSize());
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setZoom(initialZoom);
  }, [initialZoom]);

  useEffect(() => {
    onZoomChange?.(zoom);
  }, [onZoomChange, zoom]);

  useEffect(() => {
    if (!mapControlRef) return;
    mapControlRef.current = {
      zoomIn: () => setZoom((current) => clampNumber(current + 1, 0, GPS_NATIVE_MAX_ZOOM)),
      zoomOut: () => setZoom((current) => clampNumber(current - 1, 0, GPS_NATIVE_MAX_ZOOM)),
      cancelZoneTool: () => undefined,
      confirmZoneTool: () => false
    };
    return () => {
      mapControlRef.current = null;
    };
  }, [mapControlRef]);

  useEffect(() => {
    if (previousToolModeRef.current === state.toolMode) return;
    previousToolModeRef.current = state.toolMode;
    setPreviewPoint(null);
    setMeasurePoints([]);
    setProtractorVertex(null);
    setProtractorArm(null);
    setProtractorEnd(null);
  }, [state.toolMode]);

  useEffect(() => {
    if (!goalMode) {
      setGoalDraft(null);
    }
  }, [goalMode]);

  useEffect(() => {
    if (centerRequestKey <= 0) return;
    setPreviewPoint(null);
    setGoalDraft(null);
  }, [centerRequestKey]);

  useEffect(() => {
    if (state.toolMode === "ruler") {
      const displayPoints = previewPoint && measurePoints.length > 0 ? [...measurePoints, previewPoint] : measurePoints;
      let totalMeters = 0;
      for (let index = 1; index < displayPoints.length; index += 1) {
        totalMeters += distanceBetweenGeoPointsMeters(displayPoints[index - 1], displayPoints[index]);
      }
      mapService.setToolInfo(`Ruler: ${formatDistanceMeters(totalMeters)} (${displayPoints.length} puntos)`);
      return;
    }
    if (state.toolMode === "area") {
      const displayPoints = previewPoint && measurePoints.length > 0 ? [...measurePoints, previewPoint] : measurePoints;
      let perimeter = 0;
      for (let index = 1; index < displayPoints.length; index += 1) {
        perimeter += distanceBetweenGeoPointsMeters(displayPoints[index - 1], displayPoints[index]);
      }
      if (displayPoints.length > 2) {
        perimeter += distanceBetweenGeoPointsMeters(displayPoints[displayPoints.length - 1], displayPoints[0]);
      }
      mapService.setToolInfo(`Area ${formatAreaSqMeters(planarAreaSqMeters(displayPoints))} · Perim ${formatDistanceMeters(perimeter)}`);
      return;
    }
    if (state.toolMode === "protractor") {
      if (!protractorVertex) {
        mapService.setToolInfo("Transportador activo. Click define vertice. Shift alinea ejes.");
        return;
      }
      if (!protractorArm) {
        mapService.setToolInfo("Transportador activo. Click define brazo referencia.");
        return;
      }
      const endPoint = protractorEnd ?? previewPoint;
      if (!endPoint) {
        mapService.setToolInfo("Transportador activo. Click define brazo final.");
        return;
      }
      const angle = calculateProtractorAngleDeg(
        L.latLng(protractorVertex.lat, protractorVertex.lon),
        L.latLng(protractorArm.lat, protractorArm.lon),
        L.latLng(endPoint.lat, endPoint.lon),
        PROTRACTOR_MIN_ARM_METERS
      );
      if (angle === null) {
        mapService.setToolInfo("Transportador activo. Brazo final invalido.");
        return;
      }
      mapService.setToolInfo(`Transportador ${formatAngleDegrees(angle)}. Shift alinea ejes.`);
      return;
    }
    if (state.toolMode === "inspect" && inspectPoint) {
      mapService.setToolInfo(`Inspect ${inspectPoint.lat.toFixed(6)}, ${inspectPoint.lon.toFixed(6)}`);
    }
  }, [
    inspectPoint,
    mapService,
    measurePoints,
    previewPoint,
    protractorArm,
    protractorEnd,
    protractorVertex,
    state.toolMode
  ]);

  const patrolDisplayMap = buildPatrolWaypointDisplayMap(patrolMissionProfile, robotPose);
  const routePolylinePoints: Array<{
    index: number;
    lat: number;
    lon: number;
    yawDeg?: number;
    manual: boolean;
    action: boolean;
    home: boolean;
    patrolSegment: PatrolSegmentVisual;
    displayBadge: string;
    patrolPreviewYawDeg?: number;
  }> = waypoints
    .flatMap((waypoint, index) => {
      const lat = Number(waypoint.x);
      const lon = Number(waypoint.y);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
      const patrolDisplay = patrolDisplayMap.get(waypointLocalId(waypoint));
      return [{
        index,
        lat,
        lon,
        yawDeg: waypointHasManualYaw(waypoint) ? Number(waypoint.yawDeg) : undefined,
        manual: waypointHasManualYaw(waypoint),
        action: (waypoint.actions ?? []).length > 0,
        home: waypoint.role === "home" || patrolDisplay?.badge === "H",
        patrolSegment: patrolDisplay?.segment ?? null,
        displayBadge: waypoint.role === "home" || patrolDisplay?.badge === "H" ? "H" : patrolDisplay?.badge ?? String(index + 1),
        patrolPreviewYawDeg: patrolDisplay?.previewYawDeg
      }];
    });
  const waypointPreviewPoints = routePolylinePoints.map((entry) => ({
    lat: entry.lat,
    lon: entry.lon,
    yawDeg: entry.yawDeg,
    manual: entry.manual
  }));
  const displayRoutePolylinePoints = routePolylinePoints.map((entry, displayIndex) => ({
    ...entry,
    displayYawDeg:
      entry.patrolPreviewYawDeg ??
      resolveWaypointPreviewYawDeg(waypointPreviewPoints, displayIndex, loopRoute, robotPose)
  }));
  const decorativeWaypoints = routePolylinePoints.length === 0
    ? [
        { ...offsetGeoPoint(centerPoint, -14, 8), done: true },
        { ...offsetGeoPoint(centerPoint, -2, 14), done: true },
        { ...offsetGeoPoint(centerPoint, 12, 10), done: true },
        { ...offsetGeoPoint(centerPoint, 18, 0), done: true },
        { ...offsetGeoPoint(centerPoint, 10, -12), done: false },
        { ...offsetGeoPoint(centerPoint, -6, -16), done: false }
      ]
    : [];

  const zoneShapes = state.zones
    .map((zone) => {
      const polygon = Array.isArray(zone.polygon) ? zone.polygon : [];
      if (polygon.length < 3) return null;
      return {
        id: zone.id,
        enabled: zone.enabled !== false,
        points: polygon.map((vertex) => projectPoint(vertex))
      };
    })
    .filter((entry): entry is { id: string; enabled: boolean; points: Array<{ x: number; y: number }> } => entry !== null);

  const rulerDisplayPoints =
    state.toolMode === "ruler" && previewPoint && measurePoints.length > 0 ? [...measurePoints, previewPoint] : measurePoints;
  const areaDisplayPoints =
    state.toolMode === "area" && previewPoint && measurePoints.length > 0 ? [...measurePoints, previewPoint] : measurePoints;
  const protractorPreviewPoint = state.toolMode === "protractor" ? protractorEnd ?? previewPoint : null;
  const protractorArc =
    protractorVertex && protractorArm && protractorPreviewPoint
      ? buildProtractorArcGeometry(
          L.latLng(protractorVertex.lat, protractorVertex.lon),
          L.latLng(protractorArm.lat, protractorArm.lon),
          L.latLng(protractorPreviewPoint.lat, protractorPreviewPoint.lon)
        )
      : { arcPoints: [], labelLatLng: null };

  const handleCanvasClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (!interactive) return;
    if (suppressCanvasClickRef.current) {
      suppressCanvasClickRef.current = false;
      return;
    }
    const point = resolvePointFromClient(event.clientX, event.clientY);
    if (!point) return;
    if (goalMode && state.toolMode === "idle") return;
    if (state.toolMode === "inspect") {
      setInspectPoint(point);
      mapService.setInspectCoords(point.lat, point.lon);
      return;
    }
    if (state.toolMode === "ruler") {
      setMeasurePoints((current) => [...current, point].slice(-12));
      return;
    }
    if (state.toolMode === "area") {
      setMeasurePoints((current) => [...current, point].slice(-12));
      return;
    }
    if (state.toolMode === "protractor") {
      if (!protractorVertex) {
        setProtractorVertex(point);
        return;
      }
      const snappedPoint = resolveProtractorPoint(point, event.shiftKey);
      if (!protractorArm) {
        setProtractorArm(snappedPoint);
        return;
      }
      if (!protractorEnd) {
        setProtractorEnd(snappedPoint);
        return;
      }
      setProtractorVertex(snappedPoint);
      setProtractorArm(null);
      setProtractorEnd(null);
    }
  };

  const handleCanvasPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!interactive || !goalMode || state.toolMode !== "idle" || event.button !== 0) return;
    const point = resolvePointFromClient(event.clientX, event.clientY);
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setGoalDraft({
      pointerId: event.pointerId,
      origin: point
    });
  };

  const handleCanvasPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!interactive) return;
    const point = resolvePointFromClient(event.clientX, event.clientY);
    if (!point) return;
    if (goalDraft && goalDraft.pointerId === event.pointerId) {
      const yawDeg = yawDegFromLatLng(
        L.latLng(goalDraft.origin.lat, goalDraft.origin.lon),
        L.latLng(point.lat, point.lon)
      );
      setGoalDraft({ ...goalDraft, yawDeg });
      return;
    }
    if (state.toolMode === "ruler" || state.toolMode === "area") {
      setPreviewPoint(point);
      return;
    }
    if (state.toolMode === "protractor") {
      setPreviewPoint(resolveProtractorPoint(point, event.shiftKey));
      return;
    }
    setPreviewPoint(null);
  };

  const handleCanvasPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!goalDraft || goalDraft.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onQueueWaypoint(goalDraft.origin.lat, goalDraft.origin.lon, goalDraft.yawDeg);
    setGoalDraft(null);
    suppressCanvasClickRef.current = true;
  };

  const handleCanvasPointerLeave = (): void => {
    if (goalDraft) return;
    if (state.toolMode === "ruler" || state.toolMode === "area" || state.toolMode === "protractor") {
      setPreviewPoint(null);
    }
  };

  const handleCanvasWheel = (event: ReactWheelEvent<HTMLDivElement>): void => {
    if (!interactive) return;
    event.preventDefault();
    setZoom((current) =>
      clampNumber(current + (event.deltaY < 0 ? 1 : -1), 0, GPS_NATIVE_MAX_ZOOM)
    );
  };

  const renderProjectedPoints = (points: GeoPoint[]): string =>
    points
      .map((point) => {
        const projected = projectPoint(point);
        return `${projected.x},${projected.y}`;
      })
      .join(" ");

  return (
    <div
      ref={hostRef}
      className={`map-abstract-canvas${interactive ? " interactive" : ""}`}
      onClick={handleCanvasClick}
      onPointerDown={handleCanvasPointerDown}
      onPointerMove={handleCanvasPointerMove}
      onPointerUp={handleCanvasPointerUp}
      onPointerLeave={handleCanvasPointerLeave}
      onWheel={handleCanvasWheel}
    >
      <div className="map-grid" />
      <div className="map-grid map-grid-secondary" />
      <div className="map-radar-ring radar-ring-1" aria-hidden="true" />
      <div className="map-radar-ring radar-ring-2" aria-hidden="true" />
      <svg className="map-abstract-overlay map-abstract-overlay-zones" viewBox={`0 0 ${stageWidth} ${stageHeight}`} preserveAspectRatio="none">
        {zoneShapes.map((zone) => (
          <polygon
            key={zone.id}
            className={`map-zone-shape${zone.enabled ? "" : " disabled"}`}
            points={zone.points.map((point) => `${point.x},${point.y}`).join(" ")}
            onClick={(event) => {
              event.stopPropagation();
              if (state.toolMode !== "idle") return;
              mapService.toggleZoneEnabled(zone.id);
            }}
          />
        ))}
      </svg>
      <svg className="map-abstract-overlay map-abstract-overlay-passive" viewBox={`0 0 ${stageWidth} ${stageHeight}`} preserveAspectRatio="none" aria-hidden="true">
        {rulerDisplayPoints.length > 1 ? <polyline className="map-tool-line" points={renderProjectedPoints(rulerDisplayPoints)} /> : null}
        {areaDisplayPoints.length > 2 ? <polygon className="map-tool-area" points={renderProjectedPoints(areaDisplayPoints)} /> : null}
        {areaDisplayPoints.length > 1 ? <polyline className="map-tool-line" points={renderProjectedPoints(areaDisplayPoints)} /> : null}
        {protractorVertex && protractorArm ? (
          <line
            className="map-tool-line"
            x1={projectPoint(protractorVertex).x}
            y1={projectPoint(protractorVertex).y}
            x2={projectPoint(protractorArm).x}
            y2={projectPoint(protractorArm).y}
          />
        ) : null}
        {protractorVertex && protractorPreviewPoint ? (
          <line
            className="map-tool-line dashed"
            x1={projectPoint(protractorVertex).x}
            y1={projectPoint(protractorVertex).y}
            x2={projectPoint(protractorPreviewPoint).x}
            y2={projectPoint(protractorPreviewPoint).y}
          />
        ) : null}
        {protractorArc.arcPoints.length > 1 ? (
          <polyline className="map-tool-line faint" points={renderProjectedPoints(protractorArc.arcPoints.map((point) => ({ lat: point.lat, lon: point.lng })))} />
        ) : null}
      </svg>
      {datumPose ? (
        <div
          className="map-datum"
          style={{
            left: projectPoint(datumPose).x,
            top: projectPoint(datumPose).y
          }}
          title={`Datum ${datumPose.lat.toFixed(6)}, ${datumPose.lon.toFixed(6)}`}
        >
          <span className="map-datum-cross" />
        </div>
      ) : null}
      {displayRoutePolylinePoints.map((waypoint) => {
        const activeDrag = dragWaypoint?.index === waypoint.index ? dragWaypoint : null;
        const point = {
          lat: activeDrag ? activeDrag.lat : waypoint.lat,
          lon: activeDrag ? activeDrag.lon : waypoint.lon
        };
        if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return null;
        const projected = projectPoint(point);
        const isSelected = selectedWaypointIndexes.includes(waypoint.index);
        const isCurrent = activeWaypointIndex === waypoint.index;
        return (
          <button
            key={`waypoint-${waypoint.index}-${point.lat.toFixed(6)}-${point.lon.toFixed(6)}`}
            type="button"
            className={
              `wp${isSelected ? " selected" : ""}${isCurrent ? " current" : ""}${activeDrag ? " dragging" : ""}${waypoint.manual ? " manual" : " auto"}${waypoint.action ? " action" : ""}${waypoint.home ? " home" : ""}` +
              `${waypoint.patrolSegment === "return" ? " patrol-return" : waypoint.patrolSegment === "depart" ? " patrol-depart" : ""}`
            }
            data-index={waypoint.displayBadge}
            style={{
              left: projected.x,
              top: projected.y,
              transform: `translate(-50%, -50%) rotate(${normalizeYawDeg(90 - waypoint.displayYawDeg)}deg)`
            }}
            title={`${buildWaypointLabel(waypoint.home, waypoint.patrolSegment, waypoint.action)} ${waypoint.displayBadge}: ${point.lat.toFixed(6)}, ${point.lon.toFixed(6)} · ${
              waypoint.manual ? `${waypoint.displayYawDeg.toFixed(1)} deg manual` : `${waypoint.displayYawDeg.toFixed(1)} deg auto`
            }`}
            disabled={!interactive}
            onPointerDown={(event) => {
              if (!interactive || event.button !== 0) return;
              event.preventDefault();
              event.stopPropagation();
              event.currentTarget.setPointerCapture(event.pointerId);
              setDragWaypoint({
                pointerId: event.pointerId,
                index: waypoint.index,
                lat: point.lat,
                lon: point.lon,
                startClientX: event.clientX,
                startClientY: event.clientY,
                moved: false
              });
            }}
            onPointerMove={(event) => {
              if (!dragWaypoint || dragWaypoint.index !== waypoint.index || dragWaypoint.pointerId !== event.pointerId) return;
              const nextPoint = resolvePointFromClient(event.clientX, event.clientY);
              if (!nextPoint) return;
              const moved =
                dragWaypoint.moved ||
                Math.hypot(event.clientX - dragWaypoint.startClientX, event.clientY - dragWaypoint.startClientY) > 5;
              setDragWaypoint({
                ...dragWaypoint,
                lat: nextPoint.lat,
                lon: nextPoint.lon,
                moved
              });
            }}
            onPointerUp={(event) => {
              if (!dragWaypoint || dragWaypoint.index !== waypoint.index || dragWaypoint.pointerId !== event.pointerId) return;
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
              event.stopPropagation();
              if (dragWaypoint.moved) {
                onMoveWaypoint(waypoint.index, dragWaypoint.lat, dragWaypoint.lon);
              } else {
                onToggleWaypointSelection(waypoint.index);
              }
              setDragWaypoint(null);
              suppressCanvasClickRef.current = true;
            }}
            onPointerCancel={() => {
              setDragWaypoint(null);
            }}
          >
            {isSelected ? <span className="wp-selected-halo" aria-hidden="true" /> : null}
            {isSelected ? <span className="wp-selected-badge" aria-hidden="true">✓</span> : null}
          </button>
        );
      })}
      {routePolylinePoints.length === 0
        ? decorativeWaypoints.map((waypoint, index) => {
            const projected = projectPoint({ lat: waypoint.lat, lon: waypoint.lon });
            return (
              <div
                key={`decorative-waypoint-${index}`}
                className={`wp${waypoint.done ? " done" : ""}`}
                style={{ left: projected.x, top: projected.y, pointerEvents: "none" }}
                data-decorative="true"
                aria-hidden="true"
              />
            );
          })
        : null}
      {goalDraft ? (
        <>
          <div
            className={`wp draft${goalDraft.yawDeg === undefined ? " auto" : " manual"}`}
            data-index={waypoints.length + 1}
            style={{
              left: projectPoint(goalDraft.origin).x,
              top: projectPoint(goalDraft.origin).y,
              transform: `translate(-50%, -50%) rotate(${normalizeYawDeg(90 - (goalDraft.yawDeg ?? 0))}deg)`
            }}
          />
          <div
            className="map-goal-heading"
            style={{
              left: projectPoint(goalDraft.origin).x,
              top: projectPoint(goalDraft.origin).y,
              transform: `translate(-50%, -50%) rotate(${90 - (goalDraft.yawDeg ?? 0)}deg)`
            }}
            aria-hidden="true"
          />
        </>
      ) : null}
      {inspectPoint ? (
        <div className="map-inspect-tag" style={{ left: projectPoint(inspectPoint).x, top: projectPoint(inspectPoint).y }}>
          {inspectPoint.lat.toFixed(4)}, {inspectPoint.lon.toFixed(4)}
        </div>
      ) : null}
      <div className="robot" style={{ left: projectPoint(centerPoint).x, top: projectPoint(centerPoint).y }}>
        <div className="robot-ring">
          <div className="robot-inner" style={{ fontSize: 16, fontFamily: "var(--font-mono)" }}>
            ⊙
          </div>
        </div>
        <div className="robot-lbl">SALUS-01</div>
      </div>
      {protractorArc.labelLatLng ? (
        <div
          className="map-angle-label"
          style={{
            left: projectPoint({ lat: protractorArc.labelLatLng.lat, lon: protractorArc.labelLatLng.lng }).x,
            top: projectPoint({ lat: protractorArc.labelLatLng.lat, lon: protractorArc.labelLatLng.lng }).y
          }}
        >
          {formatAngleDegrees(
            calculateProtractorAngleDeg(
              L.latLng(protractorVertex!.lat, protractorVertex!.lon),
              L.latLng(protractorArm!.lat, protractorArm!.lon),
              L.latLng(protractorPreviewPoint!.lat, protractorPreviewPoint!.lon),
              PROTRACTOR_MIN_ARM_METERS
            ) ?? 0
          )}
        </div>
      ) : null}
    </div>
  );
}

function MapWorkspaceView({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const [nav2Config, setNav2Config] = useState<Nav2MapConfig>(() => readNav2MapConfig(runtime));
  const mapService = runtime.services.getService<MapService>(SERVICE_ID);
  let navigationService: NavigationService | null = null;
  try {
    navigationService = runtime.services.getService<NavigationService>(NAVIGATION_SERVICE_ID);
  } catch {
    navigationService = null;
  }
  let coverageService: CoverageService | null = null;
  try {
    coverageService = runtime.services.getService<CoverageService>(COVERAGE_SERVICE_ID);
  } catch {
    coverageService = null;
  }
  let connectionService: ConnectionService | null = null;
  try {
    connectionService = runtime.services.getService<ConnectionService>(CONNECTION_SERVICE_ID);
  } catch {
    connectionService = null;
  }
  let telemetryService: TelemetryServiceLike | null = null;
  try {
    telemetryService = runtime.services.getService<TelemetryServiceLike>(TELEMETRY_SERVICE_ID);
  } catch {
    telemetryService = null;
  }
  let sensorInfoService: SensorInfoService | null = null;
  try {
    sensorInfoService = runtime.services.getService<SensorInfoService>(SENSOR_INFO_SERVICE_ID);
  } catch {
    sensorInfoService = null;
  }
  const [state, setState] = useState<MapWorkspaceState>(mapService.getState());
  const [mainPane, setMainPane] = useState<"map" | "camera">("map");
  const [videoRequested, setVideoRequested] = useState(false);
  const [cameraDetections, setCameraDetections] = useState<CameraDetectionOverlayItem[]>([]);
  const [cameraStreamStatus, setCameraStreamStatus] = useState<CameraStreamStatus>({
    connected: false,
    connecting: false,
    error: "",
    lastFrameMs: 0,
    transport: "mjpeg"
  });
  const [leafletZoneToolActive, setLeafletZoneToolActive] = useState(false);
  const [centerRequestKey, setCenterRequestKey] = useState(0);
  const [showRobotTrail, setShowRobotTrail] = useState(true);
  const [mapZoom, setMapZoom] = useState(GPS_DEFAULT_ZOOM);
  const [navigationState, setNavigationState] = useState<NavigationState | null>(
    navigationService ? navigationService.getState() : null
  );
  const [coverageState, setCoverageState] = useState<CoverageState | null>(
    coverageService ? coverageService.getState() : null
  );
  const [connectionState, setConnectionState] = useState<ConnectionState | null>(
    connectionService ? connectionService.getState() : null
  );
  const [telemetrySnapshot, setTelemetrySnapshot] = useState<TelemetrySnapshot | null>(
    telemetryService ? telemetryService.getSnapshot() : null
  );
  const [displayMissionProgressPct, setDisplayMissionProgressPct] = useState(0);
  const [sensorInfoState, setSensorInfoState] = useState<SensorInfoState | null>(
    sensorInfoService ? sensorInfoService.getState() : null
  );
  const [datumProfiles, setDatumProfiles] = useState<DatumProfilesState | null>(mapService.getDatumProfilesState());
  const wasConnectedRef = useRef(false);
  const pendingCenterOnConnectRef = useRef(false);
  const cameraDetectionLastMsRef = useRef(0);
  const missionProgressHoldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousLoopWaypointRef = useRef<number | null>(null);
  const mapControlRef = useRef<MapViewportControlHandle | null>(null);

  useEffect(() => mapService.subscribe((next) => setState(next)), [mapService]);
  useEffect(() => {
    return () => {
      if (missionProgressHoldTimerRef.current) {
        clearTimeout(missionProgressHoldTimerRef.current);
        missionProgressHoldTimerRef.current = null;
      }
    };
  }, []);
  useEffect(() => {
    return runtime.eventBus.on<{ packageId?: unknown; config?: unknown }>(CORE_EVENTS.packageConfigUpdated, (payload) => {
      const packageId = typeof payload?.packageId === "string" ? payload.packageId : "";
      if (packageId !== "nav2") return;
      setNav2Config(readNav2MapConfig(runtime));
    });
  }, [runtime]);
  useEffect(() => {
    void mapService.loadMap("default-map").catch(() => undefined);
  }, [mapService]);
  useEffect(() => {
    if (!navigationService) return;
    return navigationService.subscribe((next) => setNavigationState(next));
  }, [navigationService]);
  useEffect(() => {
    if (!coverageService) return;
    return coverageService.subscribe((next) => setCoverageState(next));
  }, [coverageService]);
  useEffect(() => {
    if (!connectionService) return;
    return connectionService.subscribe((next) => setConnectionState(next));
  }, [connectionService]);

  useEffect(() => {
    mapService.setBackendSyncTransportState({
      connected: connectionState?.connected === true,
      host: connectionState?.host,
      port: connectionState?.port
    });
  }, [mapService, connectionState?.connected, connectionState?.host, connectionState?.port]);
  useEffect(() => mapService.subscribeDatumProfiles((next) => setDatumProfiles(next)), [mapService]);
  useEffect(() => {
    if (connectionState?.connected !== true) return;
    void mapService.getDatums().catch(() => undefined);
  }, [connectionState?.connected, mapService]);
  useEffect(() => {
    if (!telemetryService) return;
    return telemetryService.subscribeTelemetry((next) => setTelemetrySnapshot(next));
  }, [telemetryService]);
  useEffect(() => {
    if (!sensorInfoService) return;
    return sensorInfoService.subscribe((next) => setSensorInfoState(next));
  }, [sensorInfoService]);
  useEffect(() => {
    if (!sensorInfoService) return;
    void sensorInfoService.open();
    return () => {
      void sensorInfoService.close();
    };
  }, [sensorInfoService]);
  useEffect(() => {
    const connected = connectionState?.connected === true;
    const previous = wasConnectedRef.current;
    wasConnectedRef.current = connected;
    if (!connected || previous) return;

    pendingCenterOnConnectRef.current = true;
    void (async () => {
      try {
        const count = await mapService.loadZonesFromBackend();
        runtime.eventBus.emit("console.event", {
          level: "info",
          text: `No-go zones loaded (${count})`,
          timestamp: Date.now()
        });
        return;
      } catch (error) {
        // Legacy backend can timeout on load_zones_file right after connect.
        // Fallback to get_state avoids false negative on first connection.
      }

      try {
        const loaded = await mapService.loadMap("map");
        const count = mapService.getState().zones.length;
        runtime.eventBus.emit("console.event", {
          level: "info",
          text: `No-go zones loaded (${count}) from ${loaded.mapId}`,
          timestamp: Date.now()
        });
      } catch (fallbackError) {
        runtime.eventBus.emit("console.event", {
          level: "warn",
          text: `No-go zones load failed: ${String(fallbackError)}`,
          timestamp: Date.now()
        });
      }
    })();
  }, [connectionState?.connected, mapService, runtime.eventBus]);
  useEffect(() => {
    if (!pendingCenterOnConnectRef.current) return;
    const pose = telemetrySnapshot?.robotPose;
    if (!pose) return;
    pendingCenterOnConnectRef.current = false;
    setCenterRequestKey((value) => value + 1);
    runtime.eventBus.emit("console.event", {
      level: "info",
      text: "Map auto-centered on robot after connect",
      timestamp: Date.now()
    });
  }, [telemetrySnapshot?.robotPose, runtime.eventBus]);
  useEffect(() => {
    return runtime.eventBus.on(NAV_EVENTS.swapWorkspaceRequest, () => {
      if (connectionState?.preset === "sim") return;
      setMainPane((current) => (current === "map" ? "camera" : "map"));
    });
  }, [connectionState?.preset, runtime]);

  const isSimPreset = connectionState?.preset === "sim";
  const cameraPaneAvailable = !isSimPreset;
  const mainIsMap = !cameraPaneAvailable || mainPane === "map";
  const showMiniCameraPane = mainIsMap;
  const cameraConfig = readCameraStreamConfig(runtime);
  const cameraEnabled = connectionState?.preset !== "sim" && isCameraFeedConfigured(cameraConfig);
  const initialCenter = parseCenter(nav2Config);
  const initialCenterLat = initialCenter[0];
  const initialCenterLon = initialCenter[1];
  const initialZoom = parseZoom(nav2Config);
  const cameraStreamConnected = navigationState?.cameraStreamConnected === true || cameraStreamStatus.connected;
  const showVideo = cameraEnabled && videoRequested;
  const mapInteractive = mainIsMap;
  const mapToolsEnabled = mainIsMap;
  const routeMission = navigationState?.routeMission ?? null;
  const routeMissionActivity = routeMission
    ? getRouteMissionActivityState(routeMission, telemetrySnapshot?.goalActive === true)
    : null;
  const routePointCount = Math.max(0, routeMission?.expandedWaypointCount ?? 0);
  const routeStatusText = normalizeRouteMissionStatus(routeMission?.status ?? "");
  const routeComplete = routePointCount > 0 && (routeStatusText.includes("complete") || routeStatusText.includes("done") || routeStatusText.includes("succeeded"));
  const routeCompletedCount =
    routePointCount > 0
      ? routeComplete
        ? routePointCount
        : Math.min(routePointCount, Math.max(0, Math.round(routeMission?.currentStartIndex ?? 0)))
      : 0;
  const goalActive = telemetrySnapshot?.goalActive === true;
  const goalSucceeded = isNavigationGoalSucceeded(telemetrySnapshot) && !goalActive;
  const queuedWaypointCount = navigationState?.waypoints.length ?? 0;
  const fwCurrentWp = telemetrySnapshot?.currentWaypoint ?? 0;
  const fwTotalWp = telemetrySnapshot?.totalWaypoints ?? 0;
  const loopTotalWaypoints = telemetrySnapshot?.loopTotalWaypoints ?? 0;
  const displayTotal = loopTotalWaypoints > 0 ? loopTotalWaypoints : fwTotalWp;
  const simpleGoalTotal = routePointCount === 0 && (goalActive || goalSucceeded) ? Math.max(1, queuedWaypointCount) : queuedWaypointCount;
  const missionProgressTotal = routePointCount > 0 ? routePointCount : simpleGoalTotal;
  const missionCompletedCount = routePointCount > 0 ? routeCompletedCount : goalSucceeded ? simpleGoalTotal : 0;
  const goalProgressPct =
    goalActive && displayTotal > 0
      ? Math.min(100, Math.max(0, (fwCurrentWp / displayTotal) * 100))
      : goalSucceeded
        ? 100
        : 0;
  const missionProgressPct =
    routePointCount > 0
      ? (missionProgressTotal > 0 ? Math.min(100, Math.max(0, (missionCompletedCount / missionProgressTotal) * 100)) : 0)
      : goalActive || goalSucceeded
        ? goalProgressPct
        : 0;
  useEffect(() => {
    const nextProgress = Math.min(100, Math.max(0, missionProgressPct));
    const loopTelemetryActive = goalActive && loopTotalWaypoints > 0 && displayTotal > 0;
    const previousLoopWaypoint = previousLoopWaypointRef.current;
    const loopCycleComplete =
      loopTelemetryActive &&
      previousLoopWaypoint === displayTotal - 1 &&
      fwCurrentWp === 0;
    previousLoopWaypointRef.current = loopTelemetryActive ? fwCurrentWp : null;

    if (missionProgressHoldTimerRef.current) return undefined;

    const progressIsComplete = Math.round(nextProgress) === 100;
    if (loopCycleComplete || (progressIsComplete && (goalSucceeded || routeComplete))) {
      setDisplayMissionProgressPct(100);
      missionProgressHoldTimerRef.current = setTimeout(() => {
        setDisplayMissionProgressPct(0);
        missionProgressHoldTimerRef.current = null;
      }, 2000);
      return undefined;
    }
    setDisplayMissionProgressPct(nextProgress);
    return undefined;
  }, [displayTotal, fwCurrentWp, goalActive, goalSucceeded, loopTotalWaypoints, missionProgressPct, routeComplete]);
  const missionProgressLabel = `${Math.round(displayMissionProgressPct)}%`;
  const blockedState = routeMission?.blockedState ?? "";
  const blockedReason =
    routeMission?.blockedReasonText || routeMission?.blockedReasonCode || (blockedState ? "obstacle or path blockage" : "");
  const blockedRetryMax = Math.max(0, Math.round(routeMission?.blockedRetryMaxAttempts ?? 0));
  const blockedRetryAttempt = Math.max(0, Math.round(routeMission?.blockedRetryAttempt ?? 0));
  const blockedWait = Math.max(0, Number(routeMission?.blockedWaitRemainingS ?? 0));
  const blockedRetryText = blockedRetryMax > 0 ? `retry ${Math.min(blockedRetryAttempt + 1, blockedRetryMax)}/${blockedRetryMax}` : "";
  const blockedWaitText = blockedState === "BLOCKED_WAITING" && blockedWait > 0 ? `${Math.ceil(blockedWait)}s` : "";
  const blockedDetail = [blockedReason, blockedRetryText, blockedWaitText].filter((entry) => entry.length > 0).join(" · ");
  const returnHomePhase = routeMission?.returnHomePhase ?? "idle";
  const missionTitle =
    routeMission?.returnHomeActive ? "Returning HOME" :
    returnHomePhase === "completed" ? "HOME reached" :
    routeMission?.returnHomeRequested ? "Return HOME queued" :
    blockedState === "BLOCKED_NEEDS_OPERATOR" ? "Operator needed" :
    blockedState === "BLOCKED_RETRYING" ? "Retrying blocked route" :
    blockedState === "BLOCKED_WAITING" ? "Route blocked" :
    routeComplete ? "Route complete" :
    routeMission?.paused ? "Route paused" :
    routeMissionActivity?.running ? "Following route" :
    navigationState?.manualMode ? "Manual control" :
    goalActive ? "Goal active" :
    navigationState?.goalMode ? "Goal mode" :
    "Ready";
  const missionDetail =
    routeMission?.returnHomeActive
      ? routeMission?.lowBatteryActive ? "Low battery latched" : "Return-home mission"
      : returnHomePhase === "completed"
        ? routeMission?.lowBatteryActive ? "Waiting for final driver parking assist" : "Return-home mission complete"
        : routeMission?.returnHomeRequested
          ? routeMission?.homeAvailable
            ? returnHomePhase === "waiting_exit"
              ? `Waiting for exit waypoint${routeMission.returnHomeExitWaypointIndex >= 0 ? ` #${routeMission.returnHomeExitWaypointIndex + 1}` : ""}`
              : "Completing current segment before HOME"
            : "HOME unavailable"
        : blockedState ? blockedDetail :
    routePointCount > 0
      ? `${missionCompletedCount}/${missionProgressTotal} goals completed`
      : goalActive
        ? displayTotal > 0
          ? `Waypoint ${fwCurrentWp + 1} of ${displayTotal}`
          : `${queuedWaypointCount} queued waypoints`
        : goalSucceeded
          ? `${simpleGoalTotal}/${simpleGoalTotal} goals completed`
        : navigationState?.manualMode
          ? "Operator control"
          : `${queuedWaypointCount} queued waypoints`;
  const missionToneClass =
    blockedState === "BLOCKED_NEEDS_OPERATOR" || routeStatusText.includes("fail") || routeStatusText.includes("error")
      ? "error"
      : blockedState || routeMission?.paused || navigationState?.manualMode
        ? "warn"
        : routeMissionActivity?.activeVisual || routeComplete || goalActive || navigationState?.goalMode
          ? "active"
          : "";
  const routeBadgeText =
    routePointCount > 0 ? `${missionCompletedCount}/${routePointCount}` : `${navigationState?.selectedWaypointIndexes.length ?? 0} selected`;
  const patrolPresentation = getPatrolPresentation(
    navigationState?.patrolMissionProfile ?? {
      loopWaypoints: [],
      homeWaypoint: null,
      returnWaypoints: [],
      departWaypoints: [],
      departEntryLoopIndex: -1
    },
    navigationState?.patrolMission ?? null
  );
  const batteryPctRaw = Number(telemetrySnapshot?.robotStatus.batteryPct);
  const batteryPct = Number.isFinite(batteryPctRaw) ? Math.max(0, Math.min(100, batteryPctRaw)) : null;
  const batteryVoltageRaw = Number(telemetrySnapshot?.robotStatus.batteryVoltageV);
  const batteryVoltageV = Number.isFinite(batteryVoltageRaw) ? batteryVoltageRaw : null;
  const batteryState = String(telemetrySnapshot?.robotStatus.batteryState ?? "");
  const batteryMissionState = String(telemetrySnapshot?.robotStatus.batteryMissionState ?? "");
  const batteryReturnHomeRecommended = telemetrySnapshot?.robotStatus.batteryReturnHomeRecommended ?? null;
  const batteryRecoveredVoltageRaw = Number(telemetrySnapshot?.robotStatus.batteryRecoveredVoltageV);
  const batteryRecoveredVoltageV = Number.isFinite(batteryRecoveredVoltageRaw) ? batteryRecoveredVoltageRaw : null;
  const batteryLoadedVoltageRaw = Number(telemetrySnapshot?.robotStatus.batteryLoadedVoltageV);
  const batteryLoadedVoltageV = Number.isFinite(batteryLoadedVoltageRaw) ? batteryLoadedVoltageRaw : null;
  const batteryPresent = telemetrySnapshot?.robotStatus.batteryPresent ?? null;
  const batteryConnected = telemetrySnapshot?.robotStatus.connected === true;
  const batteryPresentation = getBatteryPresentation({
    batteryPct,
    connected: batteryConnected,
    lowBatteryActive: routeMission?.lowBatteryActive === true,
    batteryState,
    batteryMissionState,
    batteryReturnHomeRecommended,
    batteryPresent,
    batteryRecoveredVoltageV,
    batteryLoadedVoltageV
  });
  const batteryStatusTone = batteryPresentation.tone;
  const batteryStatusLabel = batteryPresentation.badgeLabel;
  const showAssistAlert = isReturnHomeAssistRequired(routeMission);

  useEffect(() => {
    if (cameraPaneAvailable) return;
    if (mainPane === "camera") {
      setMainPane("map");
    }
  }, [cameraPaneAvailable, mainPane]);

  useEffect(() => {
    setMapZoom(initialZoom);
  }, [initialZoom]);

  useEffect(() => {
    if (!cameraPaneAvailable) {
      setCameraDetections([]);
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function pollDetections(): Promise<void> {
      try {
        const response = await fetch(`${VISION_DATA_URL}?_=${Date.now()}`, { cache: "no-store" });
        if (!response.ok) throw new Error(`vision data ${response.status}`);
        const payload = await response.json() as unknown;
        if (!cancelled) {
          const next = parseCameraDetections(payload);
          const now = Date.now();
          if (next.length > 0) {
            cameraDetectionLastMsRef.current = now;
            setCameraDetections(next);
          } else if (now - cameraDetectionLastMsRef.current > 500) {
            setCameraDetections([]);
          }
        }
      } catch {
        if (!cancelled && Date.now() - cameraDetectionLastMsRef.current > 500) setCameraDetections([]);
      } finally {
        if (!cancelled) {
          timer = setTimeout(() => void pollDetections(), VISION_DATA_POLL_INTERVAL_MS);
        }
      }
    }

    void pollDetections();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [cameraPaneAvailable]);

  useEffect(() => {
    if (mainIsMap) return;
    if (state.toolMode === "idle") return;
    mapService.setToolMode("idle");
  }, [mainIsMap, mapService, state.toolMode]);
  const cameraOverlayText = !cameraEnabled
    ? connectionState?.preset === "sim"
      ? "camera disabled in sim"
      : "camera unavailable"
    : !videoRequested
      ? "video paused"
    : cameraStreamStatus.connecting
        ? "camera connecting"
        : cameraStreamStatus.error
          ? `camera ${cameraStreamStatus.error}`
          : cameraStreamStatus.connected
        ? ""
        : "camera connecting";
  const cameraRisk = cameraRiskFromDetections(cameraDetections);
  const generalPayload = sensorInfoState?.payloads.general as Record<string, unknown> | undefined;
  const generalSnapshot = (generalPayload?.snapshot ?? {}) as Record<string, unknown>;
  const datumFromSensor = generalSnapshot.datum as Record<string, unknown> | undefined;
  const selectedDatumProfile = datumProfiles?.datums.find((entry) => entry.id === datumProfiles.selectedId);
  // Las zonas no-go recortan el trazado de cobertura, asi que tocarlas deja el
  // preview viejo. Se invalida en vez de regenerarlo solo: regenerar dispara un
  // servicio al backend por cada vertice que se arrastra.
  // Editor de poligono de CAMPO. Los errores se muestran en la consola y no se
  // tragan: si un click no entra, el operador tiene que enterarse.
  const reportarErrorDeLote = useCallback(
    (error: unknown) => {
      runtime.eventBus.emit("console.event", {
        level: "warn",
        text: `Lote: ${error instanceof Error ? error.message : String(error)}`,
        timestamp: Date.now()
      });
    },
    [runtime.eventBus]
  );

  const appendCoverageDraftVertex = useCallback(
    (lat: number, lon: number) => {
      try {
        coverageService?.appendDraftVertex({ lat, lon });
      } catch (error) {
        reportarErrorDeLote(error);
      }
    },
    [coverageService, reportarErrorDeLote]
  );

  const moveCoverageDraftVertex = useCallback(
    (ringId: string | null, index: number, lat: number, lon: number) => {
      try {
        coverageService?.moveDraftVertex(ringId, index, { lat, lon });
      } catch (error) {
        reportarErrorDeLote(error);
      }
    },
    [coverageService, reportarErrorDeLote]
  );

  const translateCoverageDraft = useCallback(
    (deltaLat: number, deltaLon: number) => {
      try {
        coverageService?.moveDraftOutline(deltaLat, deltaLon);
      } catch (error) {
        reportarErrorDeLote(error);
      }
    },
    [coverageService, reportarErrorDeLote]
  );

  const rotateCoverageDraft = useCallback(
    (deltaDeg: number) => {
      try {
        coverageService?.rotateDraftOutline(deltaDeg);
      } catch (error) {
        reportarErrorDeLote(error);
      }
    },
    [coverageService, reportarErrorDeLote]
  );

  const scaleCoverageDraft = useCallback(
    (index: number, lat: number, lon: number) => {
      try {
        coverageService?.scaleDraftOutlineToVertex(index, { lat, lon });
      } catch (error) {
        reportarErrorDeLote(error);
      }
    },
    [coverageService, reportarErrorDeLote]
  );

  const removeCoverageDraftVertex = useCallback(
    (ringId: string | null, index: number) => {
      try {
        coverageService?.removeDraftVertex(ringId, index);
      } catch (error) {
        reportarErrorDeLote(error);
      }
    },
    [coverageService, reportarErrorDeLote]
  );

  const handleZonesChanged = useCallback(() => {
    coverageService?.invalidatePreview("Cambiaron las zonas no-go; regenera el preview");
  }, [coverageService]);

  const datumLat = Number(datumFromSensor?.datum_lat ?? datumProfiles?.runtime.lat ?? selectedDatumProfile?.lat ?? state.map?.originLat ?? Number.NaN);
  const datumLon = Number(datumFromSensor?.datum_lon ?? datumProfiles?.runtime.lon ?? selectedDatumProfile?.lon ?? state.map?.originLon ?? Number.NaN);
  const datumPose =
    Number.isFinite(datumLat) &&
    Number.isFinite(datumLon) &&
    !(Math.abs(datumLat) < 1e-9 && Math.abs(datumLon) < 1e-9)
      ? {
          lat: datumLat,
          lon: datumLon
        }
      : null;
  const coordsText =
    telemetrySnapshot?.robotPose
      ? `${telemetrySnapshot.robotPose.lat.toFixed(4)}°, ${telemetrySnapshot.robotPose.lon.toFixed(4)}°`
      : datumPose
        ? `${datumPose.lat.toFixed(4)}°, ${datumPose.lon.toFixed(4)}°`
        : "n/a";
  const selectTool = (tool: MapToolMode, infoLabel: string): void => {
    if (!mapToolsEnabled) {
      runtime.eventBus.emit("console.event", {
        level: "warn",
        text: "Map tools available only with map as main view",
        timestamp: Date.now()
      });
      return;
    }
    mapService.setToolMode(tool);
    runtime.eventBus.emit("console.event", {
      level: "info",
      text: `Map tool: ${infoLabel}`,
      timestamp: Date.now()
    });
  };

  const clickLeafletTool = (selector: string, label: string): void => {
    if (!mapToolsEnabled) {
      runtime.eventBus.emit("console.event", {
        level: "warn",
        text: "Map tools available only with map as main view",
        timestamp: Date.now()
      });
      return;
    }
    const control = document.querySelector<HTMLAnchorElement>(selector);
    if (!control || control.classList.contains("leaflet-disabled")) {
      runtime.eventBus.emit("console.event", {
        level: "warn",
        text: `${label} unavailable`,
        timestamp: Date.now()
      });
      return;
    }
    control.click();
    setLeafletZoneToolActive(true);
    runtime.eventBus.emit("console.event", {
      level: "info",
      text: `Map tool: ${label}`,
      timestamp: Date.now()
    });
  };

  const closeMapTools = (): void => {
    mapControlRef.current?.cancelZoneTool();
    setLeafletZoneToolActive(false);
    mapService.setToolMode("idle");
  };

  const confirmZoneTool = (): void => {
    const confirmed = mapControlRef.current?.confirmZoneTool() ?? false;
    if (!confirmed) {
      runtime.eventBus.emit("console.event", {
        level: "warn",
        text: "Zone edit has nothing to confirm yet",
        timestamp: Date.now()
      });
      return;
    }
    setLeafletZoneToolActive(false);
    mapService.setToolMode("idle");
  };

  const queueWaypointFromMap = (lat: number, lon: number, yawDeg?: number): void => {
    if (!navigationService || !navigationState?.goalMode) return;
    navigationService.queueWaypoint(
      yawDeg === undefined
        ? { x: lat, y: lon }
        : {
            x: lat,
            y: lon,
            yawDeg
          }
    );
    runtime.eventBus.emit("console.event", {
      level: "info",
      text: `Waypoint queued from map (${lat.toFixed(6)}, ${lon.toFixed(6)})${
        yawDeg === undefined ? " auto-yaw" : ` yaw=${yawDeg.toFixed(1)}°`
      }`,
      timestamp: Date.now()
    });
  };

  const toggleWaypointSelectionFromMap = (index: number): void => {
    if (!navigationService) return;
    navigationService.toggleWaypointSelection(index);
  };

  const setWaypointSelectionFromMap = (indexes: number[], mode: "replace" | "add"): void => {
    if (!navigationService) return;
    navigationService.setWaypointSelection(indexes, mode);
  };

  const moveWaypointFromMap = (index: number, lat: number, lon: number): void => {
    if (!navigationService) return;
    navigationService.moveWaypoint(index, lat, lon);
    runtime.eventBus.emit("console.event", {
      level: "info",
      text: `Waypoint ${index + 1} moved to (${lat.toFixed(6)}, ${lon.toFixed(6)})`,
      timestamp: Date.now()
    });
  };

  const moveCoverageFieldFromMap = (lat: number, lon: number): void => {
    if (!coverageService) return;
    try {
      coverageService.moveFieldTo({ lat, lon });
    } catch (error) {
      runtime.eventBus.emit("console.event", {
        level: "warn",
        text: `No se pudo mover el campo: ${String(error)}`,
        timestamp: Date.now()
      });
    }
  };

  const resizeCoverageFieldFromMap = (lat: number, lon: number, cornerIndex: number): void => {
    if (!coverageService) return;
    try {
      coverageService.resizeFieldFromCorner({ lat, lon }, cornerIndex);
    } catch (error) {
      runtime.eventBus.emit("console.event", {
        level: "warn",
        text: `No se pudo cambiar el lado del campo: ${String(error)}`,
        timestamp: Date.now()
      });
    }
  };

  /**
   * Poligono que tendria el lote con ese arrastre, sin guardarlo.
   *
   * El mapa lo usa para dibujar mientras dura el gesto. El calculo sale del mismo
   * servicio que despues guarda, asi que lo que se ve arrastrando es exactamente
   * lo que queda al soltar. Un arrastre invalido —lado por debajo del minimo,
   * tirador de giro pegado al centro— devuelve null y el cuadrado se queda donde
   * estaba, sin llenar la consola de avisos.
   */
  const previewCoverageFieldFromMap = (
    kind: "move" | "resize" | "rotate",
    lat: number,
    lon: number,
    cornerIndex?: number
  ): Array<{ lat: number; lon: number }> | null => {
    if (!coverageService) return null;
    try {
      if (kind === "move") {
        return coverageService.geometryForMove({ lat, lon }).polygon;
      }
      if (kind === "rotate") {
        return coverageService.geometryForRotate({ lat, lon })?.polygon ?? null;
      }
      return coverageService.geometryForResize({ lat, lon }, cornerIndex ?? 2).polygon;
    } catch {
      return null;
    }
  };

  const rotateCoverageFieldFromMap = (lat: number, lon: number): void => {
    if (!coverageService) return;
    try {
      coverageService.rotateFieldTo({ lat, lon });
    } catch (error) {
      runtime.eventBus.emit("console.event", {
        level: "warn",
        text: `No se pudo girar el campo: ${String(error)}`,
        timestamp: Date.now()
      });
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!mainIsMap || !mapToolsEnabled || isEditingTarget(event.target)) return;
      if (event.key === "Escape" && (state.toolMode !== "idle" || leafletZoneToolActive)) {
        closeMapTools();
        event.preventDefault();
        return;
      }
      if (event.key === "Escape" && navigationService && (navigationState?.waypointSelectionMode || navigationState?.selectedWaypointIndexes.length)) {
        navigationService.setWaypointSelectionMode(false);
        navigationService.clearWaypointSelection();
        event.preventDefault();
        return;
      }
      if (event.code === "Digit1") {
        selectTool("ruler", "ruler");
        event.preventDefault();
        return;
      }
      if (event.code === "Digit2") {
        selectTool("area", "area");
        event.preventDefault();
        return;
      }
      if (event.code === "Digit3") {
        selectTool("inspect", "inspect");
        event.preventDefault();
        return;
      }
      if (event.code === "Digit4") {
        selectTool("protractor", "protractor");
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [closeMapTools, coverageService, leafletZoneToolActive, mainIsMap, mapToolsEnabled, mapService, navigationService, navigationState?.selectedWaypointIndexes.length, navigationState?.waypointSelectionMode, selectTool, state.toolMode]);

  return (
    <div className="map-workspace-root map-html-root">
      <div className={`stage map-stage map-html-stage ${mainIsMap ? "mode-gps-main" : "mode-camera-main"}`}>
        {mainIsMap ? (
          <section className="stage-pane main map-stage-pane">
            <div className="map-canvas map-pane-canvas">
              <LeafletMapCanvas
                state={state}
                mapService={mapService}
                runtime={runtime}
                interactive={mapInteractive}
                goalMode={navigationState?.goalMode === true}
                waypointSelectionMode={navigationState?.waypointSelectionMode === true}
                coverageState={coverageState}
                routeMission={routeMission}
                waypoints={navigationState?.waypoints ?? []}
                patrolMissionProfile={
                  navigationState?.patrolMissionProfile ?? {
                    loopWaypoints: [],
                    homeWaypoint: null,
                    returnWaypoints: [],
                    departWaypoints: [],
                    departEntryLoopIndex: -1
                  }
                }
                selectedWaypointIndexes={navigationState?.selectedWaypointIndexes ?? []}
                robotPose={telemetrySnapshot?.robotPose ?? null}
                datumPose={datumPose}
                centerRequestKey={centerRequestKey}
                showRobotTrail={showRobotTrail}
                onQueueWaypoint={queueWaypointFromMap}
                onToggleWaypointSelection={toggleWaypointSelectionFromMap}
                onSetWaypointSelection={setWaypointSelectionFromMap}
                onMoveWaypoint={moveWaypointFromMap}
                onCoverageFieldMove={moveCoverageFieldFromMap}
                onCoverageFieldResize={resizeCoverageFieldFromMap}
                onCoverageFieldRotate={rotateCoverageFieldFromMap}
                onCoverageFieldPreview={previewCoverageFieldFromMap}
                onZoneToolSettled={() => setLeafletZoneToolActive(false)}
                onZonesChanged={handleZonesChanged}
                onCoverageDraftVertex={appendCoverageDraftVertex}
                onCoverageDraftMoveVertex={moveCoverageDraftVertex}
                onCoverageDraftRemoveVertex={removeCoverageDraftVertex}
                onCoverageDraftTranslate={translateCoverageDraft}
                onCoverageDraftRotate={rotateCoverageDraft}
                onCoverageDraftScale={scaleCoverageDraft}
                loopRoute={navigationState?.loopRoute === true}
                initialCenterLat={initialCenterLat}
                initialCenterLon={initialCenterLon}
                initialZoom={initialZoom}
                onZoomChange={setMapZoom}
                mapControlRef={mapControlRef}
              />
            </div>
          </section>
        ) : null}
        {cameraPaneAvailable && !mainIsMap ? (
          <section className="stage-pane main map-camera-stage-pane map-camera-stage-pane-full">
            <div className="map-camera-full-card">
              <div className={`camera-frame-wrap map-camera-frame-wrap map-camera-alert-${cameraRisk}`}>
                {cameraEnabled ? (
                  <CameraStreamSurface
                    isActive={showVideo}
                    config={cameraConfig}
                    className="camera-frame map-camera-frame"
                    alt="camera"
                    onStatusChange={setCameraStreamStatus}
                  />
                ) : null}
                {cameraEnabled ? (
                  <button type="button" className="map-camera-request-btn" onClick={() => setVideoRequested((current) => !current)}>
                    {videoRequested ? "Stop video" : "Start video"}
                  </button>
                ) : null}
                {cameraOverlayText ? <div className="camera-overlay visible">{cameraOverlayText}</div> : null}
              </div>
            </div>
          </section>
        ) : null}
        {cameraPaneAvailable && !mainIsMap ? (
          <section className="map-stage-pane map-map-stage-pane-mini">
            <div className="map-camera-mini-head map-map-mini-head">
              <span>Map</span>
              <div className="map-camera-mini-head-right">
                <button type="button" className="map-camera-expand-btn map-map-return-btn" onClick={() => setMainPane("map")} title="Volver al mapa" aria-label="Volver al mapa">
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M10 2h4v4"/>
                    <path d="M14 2 9 7"/>
                    <path d="M6 14H2v-4"/>
                    <path d="M2 14l5-5"/>
                  </svg>
                </button>
              </div>
            </div>
            <div className="map-mini-frame">
              <LeafletMapCanvas
                state={state}
                mapService={mapService}
                runtime={runtime}
                interactive={false}
                goalMode={false}
                waypointSelectionMode={false}
                coverageState={coverageState}
                routeMission={routeMission}
                waypoints={navigationState?.waypoints ?? []}
                patrolMissionProfile={
                  navigationState?.patrolMissionProfile ?? {
                    loopWaypoints: [],
                    homeWaypoint: null,
                    returnWaypoints: [],
                    departWaypoints: [],
                    departEntryLoopIndex: -1
                  }
                }
                selectedWaypointIndexes={navigationState?.selectedWaypointIndexes ?? []}
                robotPose={telemetrySnapshot?.robotPose ?? null}
                datumPose={datumPose}
                centerRequestKey={centerRequestKey}
                showRobotTrail={showRobotTrail}
                onQueueWaypoint={queueWaypointFromMap}
                onToggleWaypointSelection={toggleWaypointSelectionFromMap}
                onSetWaypointSelection={setWaypointSelectionFromMap}
                onMoveWaypoint={moveWaypointFromMap}
                onCoverageFieldMove={moveCoverageFieldFromMap}
                onCoverageFieldResize={resizeCoverageFieldFromMap}
                onCoverageFieldRotate={rotateCoverageFieldFromMap}
                onCoverageFieldPreview={previewCoverageFieldFromMap}
                onZoneToolSettled={() => setLeafletZoneToolActive(false)}
                onZonesChanged={handleZonesChanged}
                onCoverageDraftVertex={appendCoverageDraftVertex}
                onCoverageDraftMoveVertex={moveCoverageDraftVertex}
                onCoverageDraftRemoveVertex={removeCoverageDraftVertex}
                onCoverageDraftTranslate={translateCoverageDraft}
                onCoverageDraftRotate={rotateCoverageDraft}
                onCoverageDraftScale={scaleCoverageDraft}
                loopRoute={navigationState?.loopRoute === true}
                initialCenterLat={initialCenterLat}
                initialCenterLon={initialCenterLon}
                initialZoom={initialZoom}
              />
            </div>
          </section>
        ) : null}
        {mainIsMap ? (
          <>
            <div className="map-right-stack">
              {showMiniCameraPane ? (
                <section className="map-camera-stage-pane map-camera-stage-pane-mini">
                  <div className="map-camera-mini-head">
                    <span>Camera</span>
                    <div className="map-camera-mini-head-right">
                      {cameraPaneAvailable ? (
                        <button type="button" className="map-camera-expand-btn" onClick={() => setMainPane("camera")} title="Abrir cámara">
                          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M10 2h4v4"/>
                            <path d="M14 2 9 7"/>
                            <path d="M6 14H2v-4"/>
                            <path d="M2 14l5-5"/>
                          </svg>
                        </button>
                      ) : null}
                      <span className={cameraStreamConnected ? "online" : ""} aria-hidden="true" />
                    </div>
                  </div>
                  <div className={`camera-frame-wrap map-camera-frame-wrap map-camera-alert-${cameraRisk}`}>
                    {cameraEnabled ? (
                      <CameraStreamSurface
                        isActive={showVideo}
                        config={cameraConfig}
                        className="camera-frame map-camera-frame"
                        alt="camera"
                        onStatusChange={setCameraStreamStatus}
                      />
                    ) : null}
                    {cameraEnabled ? (
                      <button type="button" className="map-camera-request-btn" onClick={() => setVideoRequested((current) => !current)}>
                        {videoRequested ? "Stop video" : "Start video"}
                      </button>
                    ) : null}
                    {cameraOverlayText ? <div className="camera-overlay visible">{cameraOverlayText}</div> : null}
                    <div className="map-camera-crosshair" aria-hidden="true" />
                  </div>
                </section>
              ) : null}
              <div className="map-html-overlay-cards map-html-overlay-cards-inline">
                {showAssistAlert ? (
                  <div className="map-assist-alert" role="alert" aria-live="assertive">
                    <div className="map-assist-alert-head">
                      <span className="map-assist-alert-dot" aria-hidden="true" />
                      <div className="map-assist-alert-copy">
                        <div className="map-assist-alert-title">Low battery assistance required</div>
                        <div className="map-assist-alert-detail">
                          Robot reached HOME after low-battery return. Driver assistance is required for final parking alignment.
                        </div>
                      </div>
                    </div>
                  </div>
                ) : null}
                <div className={`mission-status ${missionToneClass}`.trim()}>
                  <div className="ms-main">
                    <span className="ms-dot" aria-hidden="true" />
                    <div className="ms-copy">
                      <div className="ms-title">{missionTitle}</div>
                      <div className="ms-detail">{missionDetail}</div>
                    </div>
                  </div>
                  <div className="ms-progress">
                    <div
                      className="ms-bar"
                      role="progressbar"
                      aria-label="Route progress"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(displayMissionProgressPct)}
                    >
                      <div className="ms-bar-fill" style={{ width: `${displayMissionProgressPct}%` }} />
                    </div>
                    <span className="ms-progress-label">{missionProgressLabel}</span>
                  </div>
                </div>
                <div className={`map-patrol-card tone-${patrolPresentation.tone}`.trim()}>
                  <div className="map-patrol-head">
                    <div className="map-patrol-title-wrap">
                      <span className="map-patrol-icon" aria-hidden="true">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="6" cy="17" r="1.8" />
                          <circle cx="12" cy="7" r="1.8" />
                          <circle cx="18" cy="13" r="1.8" />
                          <path d="M7.5 15.8 10.5 8.4" />
                          <path d="m13.5 8.2 3 3.6" />
                        </svg>
                      </span>
                      <span className="map-patrol-title">{patrolPresentation.title}</span>
                    </div>
                    <span className={`map-patrol-pill tone-${patrolPresentation.tone}`.trim()}>
                      {patrolPresentation.badgeLabel}
                    </span>
                  </div>
                  <div className="map-patrol-detail">
                    <span className="map-patrol-detail-primary">{patrolPresentation.detail}</span>
                    {patrolPresentation.secondaryDetail ? (
                      <span className="map-patrol-detail-secondary">{patrolPresentation.secondaryDetail}</span>
                    ) : null}
                  </div>
                </div>
                <div className={`map-battery-card tone-${batteryStatusTone}`.trim()}>
                  <div className="map-battery-head">
                    <div className="map-battery-title-wrap">
                      <span className="map-battery-icon" aria-hidden="true">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="3" y="7" width="16" height="10" rx="2" />
                          <path d="M21 10v4" />
                        </svg>
                      </span>
                      <span className="map-battery-title">Battery</span>
                    </div>
                    <span className={`map-battery-pill tone-${batteryStatusTone}`.trim()}>{batteryStatusLabel}</span>
                  </div>
                  <div className="map-battery-main">
                    <span className="map-battery-value">{formatBatteryPct(batteryPct)}</span>
                    <span className="map-battery-subvalue">{formatBatteryVoltage(batteryVoltageV)}</span>
                  </div>
                  <div className="map-battery-detail">
                    <span className="map-battery-detail-primary">{batteryPresentation.detail}</span>
                    {batteryPresentation.contextualVoltageText ? (
                      <span className="map-battery-detail-secondary">{batteryPresentation.contextualVoltageText}</span>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
            <div className="map-toolbar map-html-toolbar map-left-action-toolbar">
              <div className="map-tool-group map-tool-group-zoom">
                <div className="map-tool-group-title">Zoom</div>
                <div className="map-tool-buttons">
              <button
                type="button"
                className="map-btn"
                onClick={() => mapControlRef.current?.zoomIn()}
                title="Zoom in"
                aria-label="Zoom in"
                disabled={!mapToolsEnabled}
              >
                <svg className="map-btn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <line x1="8" y1="3" x2="8" y2="13"/>
                  <line x1="3" y1="8" x2="13" y2="8"/>
                </svg>
              </button>
              <button
                type="button"
                className="map-btn"
                onClick={() => mapControlRef.current?.zoomOut()}
                title="Zoom out"
                aria-label="Zoom out"
                disabled={!mapToolsEnabled}
              >
                <svg className="map-btn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <line x1="3" y1="8" x2="13" y2="8"/>
                </svg>
              </button>
                </div>
              </div>
              <div className="map-tool-group map-tool-group-zone">
                <div className="map-tool-group-title">Zone Editing</div>
                <div className="map-tool-buttons">
              <button
                type="button"
                className="map-btn"
                onClick={() => clickLeafletTool(".leaflet-draw-draw-polygon", "draw zone")}
                title="Dibujar zona"
                aria-label="Dibujar zona"
                disabled={!mapToolsEnabled}
              >
                <svg className="map-btn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 11.5 6 3l7 2.5-2.5 7.5L3 11.5Z"/>
                  <circle cx="6" cy="3" r="1" fill="currentColor" stroke="none"/>
                  <circle cx="13" cy="5.5" r="1" fill="currentColor" stroke="none"/>
                  <circle cx="10.5" cy="13" r="1" fill="currentColor" stroke="none"/>
                  <circle cx="3" cy="11.5" r="1" fill="currentColor" stroke="none"/>
                </svg>
              </button>
              <button
                type="button"
                className="map-btn"
                onClick={() => clickLeafletTool(".leaflet-draw-draw-rectangle", "draw zone rectangle")}
                title="Dibujar zona rectangular"
                aria-label="Dibujar zona rectangular"
                disabled={!mapToolsEnabled}
              >
                <svg className="map-btn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="4" width="10" height="8"/>
                  <circle cx="3" cy="4" r="1" fill="currentColor" stroke="none"/>
                  <circle cx="13" cy="12" r="1" fill="currentColor" stroke="none"/>
                </svg>
              </button>
              <button
                type="button"
                className="map-btn"
                onClick={() => clickLeafletTool(".leaflet-draw-edit-edit", "edit zones")}
                title="Editar zonas"
                aria-label="Editar zonas"
                disabled={!mapToolsEnabled || state.zones.length === 0}
              >
                <svg className="map-btn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 13 4 9.5 11.5 2 14 4.5 6.5 12 3 13Z"/>
                  <path d="M10 3.5 12.5 6"/>
                </svg>
              </button>
              <button
                type="button"
                className="map-btn"
                onClick={() => {
                  const count = state.zones.length;
                  mapService.clearZones();
                  // El preview que se genero con la zona vieja ya no describe
                  // la ruta que el backend va a ejecutar. Sin invalidarlo el
                  // boton de iniciar queda bloqueado por nogoClippedLocally
                  // despues de tocar el tacho, sin explicar por que.
                  handleZonesChanged();
                  runtime.eventBus.emit("console.event", {
                    level: "info",
                    text: `No-go zones deleted (${count})`,
                    timestamp: Date.now()
                  });
                }}
                title="Borrar zonas"
                aria-label="Borrar zonas"
                disabled={!mapToolsEnabled || state.zones.length === 0}
              >
                <svg className="map-btn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M2.5 4.5h11"/>
                  <path d="M6 4.5V3h4v1.5"/>
                  <path d="m4 4.5.7 8.5h6.6l.7-8.5"/>
                  <path d="M6.8 7v4"/>
                  <path d="M9.2 7v4"/>
                </svg>
              </button>
              <button
                type="button"
                className={`map-btn map-btn-confirm ${leafletZoneToolActive ? "active" : ""}`}
                onClick={confirmZoneTool}
                title="Confirmar edición de zonas"
                aria-label="Confirmar edición de zonas"
                disabled={!mapToolsEnabled || !leafletZoneToolActive}
              >
                <svg className="map-btn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 8.4 6.6 12 13 4"/>
                </svg>
              </button>
              <button
                type="button"
                className={`map-btn map-btn-close ${state.toolMode !== "idle" || leafletZoneToolActive ? "active" : ""}`}
                onClick={closeMapTools}
                title="Cerrar herramientas"
                aria-label="Cerrar herramientas"
                disabled={!mapToolsEnabled || (state.toolMode === "idle" && !leafletZoneToolActive)}
              >
                <svg className="map-btn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <line x1="4" y1="4" x2="12" y2="12"/>
                  <line x1="12" y1="4" x2="4" y2="12"/>
                </svg>
              </button>
                </div>
              </div>
              <div className="map-tool-group map-tool-group-measure">
                <div className="map-tool-group-title">Measure</div>
                <div className="map-tool-buttons">
              <button
                type="button"
                className={`map-btn ${toolButtonClass(state.toolMode, "ruler")}`}
                onClick={() => selectTool("ruler", "ruler")}
                title="Regla"
                aria-label="Regla"
                disabled={!mapToolsEnabled}
              >
                <svg className="map-btn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                  <rect x="1" y="5.5" width="14" height="5" rx="1"/>
                  <line x1="4" y1="5.5" x2="4" y2="8"/>
                  <line x1="7" y1="5.5" x2="7" y2="7.5"/>
                  <line x1="10" y1="5.5" x2="10" y2="8"/>
                  <line x1="13" y1="5.5" x2="13" y2="7.5"/>
                </svg>
              </button>
              <button
                type="button"
                className={`map-btn ${toolButtonClass(state.toolMode, "area")}`}
                onClick={() => selectTool("area", "area")}
                title="Área"
                aria-label="Área"
                disabled={!mapToolsEnabled}
              >
                <svg className="map-btn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polygon points="8,2 14,13 2,13"/>
                  <circle cx="8" cy="2" r="1" fill="currentColor" stroke="none"/>
                  <circle cx="14" cy="13" r="1" fill="currentColor" stroke="none"/>
                  <circle cx="2" cy="13" r="1" fill="currentColor" stroke="none"/>
                </svg>
              </button>
                </div>
              </div>
              <div className="map-tool-group map-tool-group-nav">
                <div className="map-tool-group-title">Nav</div>
                <div className="map-tool-buttons">
              <button
                type="button"
                className={`map-btn ${toolButtonClass(state.toolMode, "inspect")}`}
                onClick={() => selectTool("inspect", "inspect")}
                title="Inspección"
                aria-label="Inspección"
                disabled={!mapToolsEnabled}
              >
                <svg className="map-btn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                  <circle cx="8" cy="7" r="3"/>
                  <line x1="8" y1="1" x2="8" y2="4"/>
                  <line x1="8" y1="10" x2="8" y2="13"/>
                  <line x1="1" y1="7" x2="4" y2="7"/>
                  <line x1="12" y1="7" x2="15" y2="7"/>
                  <line x1="8" y1="13" x2="8" y2="15.5"/>
                </svg>
              </button>
              <button
                type="button"
                className="map-btn map-btn-sep"
                onClick={() => {
                  setCenterRequestKey((value) => value + 1);
                  mapService.centerRobot();
                  runtime.eventBus.emit("console.event", {
                    level: "info",
                    text: "Map centered on robot",
                    timestamp: Date.now()
                  });
                }}
                title="Centrar robot"
                aria-label="Centrar robot"
                disabled={!mapToolsEnabled}
              >
                <svg className="map-btn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                  <circle cx="8" cy="8" r="5"/>
                  <circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none"/>
                  <line x1="8" y1="1" x2="8" y2="3"/>
                  <line x1="8" y1="13" x2="8" y2="15"/>
                  <line x1="1" y1="8" x2="3" y2="8"/>
                  <line x1="13" y1="8" x2="15" y2="8"/>
                </svg>
              </button>
              <button
                type="button"
                className={`map-btn ${showRobotTrail ? "active" : ""}`}
                onClick={() => {
                  setShowRobotTrail((current) => {
                    const next = !current;
                    runtime.eventBus.emit("console.event", {
                      level: "info",
                      text: next ? "Robot trail enabled" : "Robot trail cleared",
                      timestamp: Date.now()
                    });
                    return next;
                  });
                }}
                title={showRobotTrail ? "Traza del recorrido: apagar y borrar" : "Traza del recorrido: encender"}
                aria-label="Traza del recorrido"
                aria-pressed={showRobotTrail}
              >
                <svg className="map-btn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M2 12.5c2.5 0 2.5-4 5-4s2.5 4 5 4"/>
                  <path d="M3.5 4.5h9"/>
                  <circle cx="12.5" cy="12.5" r="1.5" fill="currentColor" stroke="none"/>
                </svg>
              </button>
                </div>
              </div>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

export function createMapModule(): CockpitModule {
  return {
    id: "map",
    version: "1.1.0",
    enabledByDefault: true,
    register(ctx: ModuleContext): void {
      const dispatcher = new MapDispatcher(DISPATCHER_ID, TRANSPORT_ID);
      ctx.dispatchers.registerDispatcher({
        id: dispatcher.id,
        dispatcher
      });

      const service = new MapService(dispatcher);
      try {
        const connectionService = ctx.services.getService<ConnectionService>(CONNECTION_SERVICE_ID);
        const applyConnectionState = (state: ConnectionState): void => {
          service.setBackendSyncTransportState({
            connected: state.connected === true,
            host: state.host,
            port: state.port
          });
        };
        applyConnectionState(connectionService.getState());
        connectionService.subscribe((state) => applyConnectionState(state));
      } catch {
        service.setBackendSyncTransportState({ connected: false });
      }
      ctx.services.registerService({
        id: SERVICE_ID,
        service
      });

      ctx.contributions.register({
        id: "workspace.map",
        slot: "workspace",
        label: "Map",
        render: () => <MapWorkspaceView runtime={ctx} />
      });
    }
  };
}
