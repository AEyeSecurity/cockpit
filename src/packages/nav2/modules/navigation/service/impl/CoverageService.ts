import type { Nav2IncomingMessage } from "../../../../protocol/messages";
import type { RobotDispatcher } from "../../dispatcher/impl/RobotDispatcher";
import type { NavigationService } from "./NavigationService";
import {
  NOGO_DETOUR_PHASE,
  clipPathToNoGo,
  type NoGoBounds,
  type NoGoPoint,
  type NoGoPolygon
} from "./coverageNoGo";

export const COVERAGE_SERVICE_ID = "service.coverage";
// Los arcos exteriores de Campo se mandan como guias cada ~1 m. El limite de
// 200 las recortaba globalmente y deformaba una cabecera de radio 4 m; 800
// permite conservarlas sin acercarse a los limites del mensaje ROS.
export const MAX_COVERAGE_ROUTE_WAYPOINTS = 800;

/**
 * Colchon fijo del recorte local. Es el valor por defecto del backend; este
 * cliente no lee los parametros ROS. Si el operador cambia aquel valor, la
 * segunda pasada puede diferir y `nogoClippedLocally` bloquea el arranque.
 */
const NOGO_EXTRA_MARGIN_M = 0.5;

/**
 * Parte local dependiente del radio de giro. Es el default del backend; una
 * diferencia de configuracion no se oculta: se detecta como recorte local y
 * el cockpit no deja iniciar una ruta distinta a la del preview.
 */
const NOGO_TURNING_MARGIN_RATIO = 0.0;

const METERS_PER_DEG_LAT = 111_320;
const MIN_FIELD_EDGE_M = 0.5;
/** Debajo de este radio el angulo de rotacion salta de forma erratica. */
const MIN_ROTATION_RADIUS_M = 1.0;
const DEFAULT_SQUARE_SIDE_M = 40;
// Tope del lote. No es una limitacion del planner: es que un factor de escala
// aplicado dos veces por error convierte un lote de 40 m en uno de kilometros, y
// eso se descubre recien cuando el preview tarda una eternidad.
const MAX_FIELD_EDGE_M = 2000;
// Vertices de la figura del lote sembrado. Ocho: se lee como un lote y no como
// un cuadrado, y con la figura rigida no hay ninguno de mas que acomodar.
const RIGID_FIELD_VERTICES = 8;
/**
 * Radio minimo que traza el planner de cada perfil.
 *
 * Es un piso, no una preferencia: el backend rechaza un plan de cobertura con un
 * radio menor que el del Smac que despues lo tiene que seguir. En simulacion se
 * usa 4.0 m para que la geometria de las cabeceras sea igual en simulacion y
 * en el vehiculo. Es un piso de seguridad, no una preferencia del usuario.
 */
const PLANNER_MIN_TURNING_RADIUS_M: Record<"sim" | "real", number> = {
  sim: 4.0,
  real: 4.0
};

export interface CoverageGeoPoint {
  lat: number;
  lon: number;
}

export interface CoverageParameters {
  cutterWidthM: number;
  overlapRatio: number;
  minTurningRadiusM: number;
  waypointSpacingM: number;
  chunkSpanM: number;
  chunkMaxWaypoints: number;
}

export interface CoverageFieldGeometry {
  startLat: number;
  startLon: number;
  startYawDeg: number;
  fieldLengthM: number;
  fieldWidthM: number;
  side: "left" | "right";
}

export interface CoverageWaypoint extends CoverageGeoPoint {
  yawDeg: number;
  phase: string;
  rowIndex: number;
  key: boolean;
}

export interface CoverageMetrics {
  topologyScope: "global" | "field_interior";
  rowCount: number;
  laneSpacingM: number;
  rowVisitOrder: number[];
  turnSeparationsM: number[];
  turnCount: number;
  cleanUturnCount: number;
  omegaTurnCount: number;
  minSeparationM: number;
  separationNeededForUturnM: number;
  estimatedPathLengthM: number;
  headlandBeforeM: number;
  headlandAfterM: number;
  lateralOverflowM: number;
  strictCrossingCount: number;
  nonadjacentTouchCount: number;
  collinearOverlapCount: number;
  topologyConflictCount: number;
  globalStrictCrossingCount: number;
  globalNonadjacentTouchCount: number;
  globalCollinearOverlapCount: number;
  globalTopologyConflictCount: number;
  topologyAuditSpacingM: number;
  plannerMinTurningRadiusM: number;
}

export interface CoveragePreview {
  /** Ruta que se enviaria a route_executor; es la unica que se dibuja. */
  executionWaypoints: CoverageWaypoint[];
  sampledWaypoints: CoverageWaypoint[];
  keyWaypoints: CoverageWaypoint[];
  metrics: CoverageMetrics;
  topologySafe: boolean;
  topologyError: string;
  legSpacingM: number;
  /** Cuantas zonas no-go aplico el backend. Cero significa que no recorto. */
  nogoPolygonCount: number;
  /** Motivo que dio el backend cuando no pudo leer las zonas. */
  nogoNote: string;
  /** El cockpit tuvo que recortar por su cuenta porque el backend no lo hizo. */
  nogoClippedLocally: boolean;
}

/**
 * Lo unico que este servicio necesita del mapa: las zonas dibujadas. Se declara
 * estructuralmente y no importando `MapService` para no atar el paquete de
 * navegacion al del mapa por un solo `getState`.
 */
export interface NoGoZoneSource {
  getState(): { zones: Array<{ enabled?: boolean; polygon?: CoverageGeoPoint[] }> };
}

/**
 * Anillo dibujado por el operador. ABIERTO: el primer vertice no se repite al
 * final, que es como lo espera GeoRing.msg. El cierre visual lo hace Leaflet.
 */
export interface CoverageRing {
  /**
   * Solo para la UI: sirve para decir "borra ESTA exclusion". No se serializa;
   * al backend le alcanza el orden del array.
   */
  id: string;
  vertices: CoverageGeoPoint[];
}

/** Con que definicion de lote se planifica. Espeja la bifurcacion del backend. */
export type CoverageFieldSource = "rectangle" | "polygon";

/** Lo que se esta dibujando en el mapa. Solo existe dentro de CAMPO. */
export interface CoverageDraft {
  mode: "idle" | "outline" | "exclusion";
  /** Contorno del lote. Con menos de 3 vertices todavia no es un lote. */
  outline: CoverageRing;
  /** Zonas donde no se debe cortar. Cero o mas. */
  exclusions: CoverageRing[];
  /** Que anillo recibe los clicks; null mientras se dibuja el contorno. */
  activeExclusionId: string | null;
  /**
   * Figura rigida: se mueve, gira y escala entera, y no se edita por vertices.
   *
   * Es la que siembra el atajo del vehiculo. Un poligono con ocho tiradores
   * sueltos se deforma con cada tiron y termina en una figura que se cruza a si
   * misma y que el backend rechaza. Con la figura rigida eso no puede pasar: la
   * forma es la que es y lo unico que cambia es donde esta, cuanto abarca y como
   * esta orientada.
   */
  rigid: boolean;
}

/** Minimo de vertices para que un anillo sea un poligono. */
export const MIN_RING_VERTICES = 3;

export interface CoverageState {
  runtimeProfile: "sim" | "real";
  /** Las cuatro esquinas del cuadrado, vacio mientras no haya campo. */
  fieldPolygon: CoverageGeoPoint[];
  field: CoverageFieldGeometry | null;
  parameters: CoverageParameters;
  preview: CoveragePreview | null;
  /**
   * Pose desde la que se armo el cuadrado, si se uso el atajo del vehiculo.
   *
   * Se guarda porque el corrimiento de la esquina depende del ancho de corte:
   * cambiarlo despues obliga a rehacer el campo desde la misma pose para que la
   * primera pasada siga cayendo bajo el vehiculo.
   */
  vehicleAnchor: CoverageVehiclePose | null;
  /**
   * Que definicion de lote se manda. Explicito y no deducido de si hay
   * poligono: el operador puede tener dibujado un poligono y volver al
   * rectangulo, y ahi adivinar cual quiso seria una fuente de sorpresas.
   */
  fieldSource: CoverageFieldSource;
  draft: CoverageDraft;
  loading: boolean;
  sending: boolean;
  error: string;
  lastStatus: string;
}

export interface CoverageMissionResult {
  inputCount: number;
  expandedCount: number;
  legSpacingM: number;
}

/** Pose del vehiculo usada como esquina del campo. */
export interface CoverageVehiclePose {
  lat: number;
  lon: number;
  yawDeg: number;
}

/**
 * Adelanto de como va a quedar el trazado, sin pedirle nada al backend.
 *
 * Reproduce el reparto de pasadas de `_resolve_coverage_row_layout` y la
 * geometria del giro de cabecera, para que cambiar lado, ancho de corte o
 * solape se vea al instante. El preview del backend sigue siendo la autoridad:
 * es el unico que audita cruces y el que habilita el inicio.
 */
export interface CoverageLayoutEstimate {
  rowCount: number;
  laneSpacingM: number;
  turnCount: number;
  cleanUturnCount: number;
  omegaTurnCount: number;
  /** Espacio libre necesario mas alla de cada extremo de pasada. */
  headlandClearanceM: number;
  /** Desborde a los costados de la primera y la ultima pasada. */
  lateralClearanceM: number;
  estimatedPathLengthM: number;
}

/**
 * Largo de un giro de cabecera de radio minimo entre dos pasadas antiparalelas.
 *
 * Con separacion menor al diametro de giro el enlace optimo es un omega RLR y
 * la vuelta sobresale del lote; con separacion mayor o igual alcanza una U
 * limpia. Devuelve tambien cuanto sobresale, que es el dato que decide si el
 * lote entra donde el operador lo quiere poner.
 */
function headlandTurnGeometry(
  laneSpacingM: number,
  minTurningRadiusM: number
): { lengthM: number; forwardClearanceM: number; lateralClearanceM: number; omega: boolean } {
  const radius = Math.max(1.0e-6, minTurningRadiusM);
  const separation = Math.abs(laneSpacingM);
  if (separation >= 2 * radius) {
    return {
      lengthM: Math.PI * radius + (separation - 2 * radius),
      forwardClearanceM: radius,
      lateralClearanceM: 0,
      omega: false
    };
  }
  // Centro del arco intermedio: equidista 2R de los centros de entrada y salida.
  const halfSpanM = separation / 2 + radius;
  const offsetM = Math.sqrt(Math.max(0, 4 * radius * radius - halfSpanM * halfSpanM));
  const entryAngleRad = Math.atan2(halfSpanM, offsetM);
  const sweepRad = 3 * Math.PI - 4 * entryAngleRad;
  return {
    lengthM: radius * sweepRad,
    forwardClearanceM: offsetM + radius,
    lateralClearanceM: Math.max(0, radius - separation / 2),
    omega: true
  };
}

export function estimateCoverageLayout(input: {
  fieldLengthM: number;
  fieldWidthM: number;
  cutterWidthM: number;
  overlapRatio: number;
  minTurningRadiusM: number;
}): CoverageLayoutEstimate {
  const cutterWidthM = Math.max(1.0e-6, input.cutterWidthM);
  const maxLaneSpacingM = Math.max(1.0e-6, cutterWidthM * (1 - input.overlapRatio));
  const centerlineSpanM = Math.max(0, input.fieldWidthM - cutterWidthM);

  let rowCount = 1;
  let laneSpacingM = 0;
  if (centerlineSpanM > 1.0e-9) {
    // El ancho llega de un ida y vuelta lat/lon, asi que un lote de 20 m puede
    // valer 20 + 1e-14. Sin holgura ese resto agrega una pasada entera y la
    // estimacion parpadea entre 4 y 5 al redibujar el mismo cuadrado.
    const rowsNeeded = centerlineSpanM / maxLaneSpacingM;
    rowCount = Math.ceil(rowsNeeded - 1.0e-9) + 1;
    laneSpacingM = centerlineSpanM / (rowCount - 1);
  }

  const turnCount = Math.max(0, rowCount - 1);
  const turn = headlandTurnGeometry(laneSpacingM, input.minTurningRadiusM);
  const omegaTurnCount = turnCount > 0 && turn.omega ? turnCount : 0;
  const rowLengthM = Math.max(0, input.fieldLengthM - cutterWidthM);

  return {
    rowCount,
    laneSpacingM,
    turnCount,
    cleanUturnCount: turnCount - omegaTurnCount,
    omegaTurnCount,
    headlandClearanceM: turnCount > 0 ? turn.forwardClearanceM : 0,
    lateralClearanceM: turnCount > 0 ? turn.lateralClearanceM : 0,
    estimatedPathLengthM: rowCount * rowLengthM + turnCount * turn.lengthM
  };
}

type CoverageListener = (state: CoverageState) => void;
type NavigationSafetyService = Pick<NavigationService, "getState" | "setManualMode">;

const DEFAULT_PARAMETERS: CoverageParameters = {
  cutterWidthM: 2.0,
  overlapRatio: 0.15,
  minTurningRadiusM: PLANNER_MIN_TURNING_RADIUS_M.real,
  waypointSpacingM: 2.0,
  chunkSpanM: 60.0,
  chunkMaxWaypoints: 25
};

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function normalizeYawDeg(value: number): number {
  const normalized = value % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

function normalizeLongitudeDeg(value: number): number {
  return ((value + 180) % 360 + 360) % 360 - 180;
}

/** Diferencia corta de longitud: +179.999 y -179.999 estan a metros, no a 360°. */
function longitudeDeltaDeg(originLon: number, pointLon: number): number {
  return normalizeLongitudeDeg(pointLon - originLon);
}

function metersPerDegreeLon(lat: number): number {
  return METERS_PER_DEG_LAT * Math.max(1.0e-6, Math.abs(Math.cos(degreesToRadians(lat))));
}

function clonePoint(point: CoverageGeoPoint): CoverageGeoPoint {
  return { lat: point.lat, lon: point.lon };
}

function localMeters(origin: CoverageGeoPoint, point: CoverageGeoPoint): { east: number; north: number } {
  return {
    east: longitudeDeltaDeg(origin.lon, point.lon) * metersPerDegreeLon(origin.lat),
    north: (point.lat - origin.lat) * METERS_PER_DEG_LAT
  };
}

function offsetPoint(origin: CoverageGeoPoint, eastM: number, northM: number): CoverageGeoPoint {
  return {
    lat: origin.lat + northM / METERS_PER_DEG_LAT,
    lon: normalizeLongitudeDeg(origin.lon + eastM / metersPerDegreeLon(origin.lat))
  };
}

function fieldPolygonFromGeometry(field: CoverageFieldGeometry): CoverageGeoPoint[] {
  const yawRad = degreesToRadians(field.startYawDeg);
  const forward = {
    east: Math.cos(yawRad) * field.fieldLengthM,
    north: Math.sin(yawRad) * field.fieldLengthM
  };
  const sideSign = field.side === "left" ? 1 : -1;
  const lateral = {
    east: -Math.sin(yawRad) * field.fieldWidthM * sideSign,
    north: Math.cos(yawRad) * field.fieldWidthM * sideSign
  };
  const origin = { lat: field.startLat, lon: field.startLon };
  return [
    origin,
    offsetPoint(origin, forward.east, forward.north),
    offsetPoint(origin, forward.east + lateral.east, forward.north + lateral.north),
    offsetPoint(origin, lateral.east, lateral.north)
  ];
}

function radiansToDegrees(value: number): number {
  return (value * 180) / Math.PI;
}

/**
 * Medio diagonal del cuadrado, del centro hacia la esquina de arranque.
 *
 * Sirve para girar sobre el centro: se rota el vector y se recalcula la esquina,
 * en vez de rotar la esquina y que el lote se vaya caminando.
 */
function rotatedHalfDiagonal(
  sideM: number,
  yawDeg: number,
  side: "left" | "right"
): { east: number; north: number } {
  const yawRad = degreesToRadians(yawDeg);
  const lateralSign = side === "left" ? 1 : -1;
  const forward = { east: Math.cos(yawRad) * sideM, north: Math.sin(yawRad) * sideM };
  const lateral = {
    east: -Math.sin(yawRad) * sideM * lateralSign,
    north: Math.cos(yawRad) * sideM * lateralSign
  };
  return {
    east: (forward.east + lateral.east) / 2,
    north: (forward.north + lateral.north) / 2
  };
}

/** Centro del cuadrado: el punto que el operador arrastra para moverlo. */
function fieldCentre(field: CoverageFieldGeometry): CoverageGeoPoint {
  const polygon = fieldPolygonFromGeometry(field);
  const origin = polygon[0]!;
  const opposite = polygon[2]!;
  const diagonal = localMeters(origin, opposite);
  return offsetPoint(origin, diagonal.east / 2, diagonal.north / 2);
}

/**
 * Cuadrado con una esquina en `origin`, lado `sideM` y rumbo `yawDeg`.
 *
 * El lote es siempre cuadrado y siempre arranca en una esquina: no hay figura
 * libre que interpretar. El poligono sale del propio registro de campo, asi que
 * lo que se dibuja en el mapa y lo que viaja al backend no pueden separarse.
 */
/** Lote calculado: el registro que viaja al backend y el poligono que se dibuja. */
type SquareGeometry = { field: CoverageFieldGeometry; polygon: CoverageGeoPoint[] };

function buildSquareGeometry(input: {
  origin: CoverageGeoPoint;
  yawDeg: number;
  sideM: number;
  side: "left" | "right";
}): SquareGeometry {
  const sideM = Number(input.sideM);
  if (!Number.isFinite(sideM) || sideM < MIN_FIELD_EDGE_M) {
    throw new Error(`El lado del campo debe ser de al menos ${MIN_FIELD_EDGE_M.toFixed(1)} m`);
  }
  const field: CoverageFieldGeometry = {
    startLat: input.origin.lat,
    startLon: input.origin.lon,
    startYawDeg: normalizeYawDeg(Number(input.yawDeg)),
    fieldLengthM: sideM,
    fieldWidthM: sideM,
    side: input.side
  };
  return { field, polygon: fieldPolygonFromGeometry(field) };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nonNegativeInteger(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : fallback;
}

function numberList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map(Number).filter((entry) => Number.isFinite(entry));
}

function integerList(value: unknown): number[] {
  return numberList(value).map((entry) => Math.round(entry));
}

function parseCoverageWaypoint(value: unknown): CoverageWaypoint | null {
  const item = asRecord(value);
  if (!item) return null;
  const lat = Number(item.lat ?? item.latitude);
  const lon = Number(item.lon ?? item.longitude);
  const yawDeg = Number(item.yaw_deg ?? item.yawDeg ?? item.yaw ?? 0);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(yawDeg)) return null;
  return {
    lat,
    lon,
    yawDeg,
    phase: String(item.phase ?? ""),
    rowIndex: Math.round(finiteNumber(item.row_index ?? item.rowIndex, -1)),
    key: item.key === true || item.is_key === true || item.isKey === true
  };
}

function coverageBody(response: Nav2IncomingMessage): Record<string, unknown> {
  return (
    asRecord(response.coverage_plan) ??
    asRecord(response.preview) ??
    asRecord(response.coverage) ??
    asRecord(response.payload) ??
    (response as Record<string, unknown>)
  );
}

function clonePreview(preview: CoveragePreview): CoveragePreview {
  return {
    ...preview,
    executionWaypoints: preview.executionWaypoints.map((waypoint) => ({ ...waypoint })),
    sampledWaypoints: preview.sampledWaypoints.map((waypoint) => ({ ...waypoint })),
    keyWaypoints: preview.keyWaypoints.map((waypoint) => ({ ...waypoint })),
    metrics: {
      ...preview.metrics,
      rowVisitOrder: [...preview.metrics.rowVisitOrder],
      turnSeparationsM: [...preview.metrics.turnSeparationsM]
    }
  };
}

/**
 * Zonas habilitadas del mapa, proyectadas a metros locales contra el origen.
 *
 * Se usa el mismo origen para las zonas y para el trazado, asi que el recorte no
 * depende de donde esta el lote ni de como esta rotado.
 */
function noGoPolygonsFromZones(
  zoneSource: NoGoZoneSource | undefined,
  origin: CoverageGeoPoint
): NoGoPolygon[] {
  if (!zoneSource) return [];
  const polygons: NoGoPolygon[] = [];
  for (const zone of zoneSource.getState().zones) {
    if (zone.enabled === false) continue;
    const polygon = zone.polygon;
    if (!Array.isArray(polygon) || polygon.length < 3) continue;
    polygons.push(
      polygon.map((vertex) => {
        const local = localMeters(origin, vertex);
        return { x: local.east, y: local.north };
      })
    );
  }
  return polygons;
}

/**
 * Recortar el trazado contra las zonas del mapa.
 *
 * Es la misma cuenta que ya hizo el backend. Se repite porque el recorte del
 * backend depende de que `zones_manager` este vivo y de que el GeoJSON haya
 * llegado; si algo de eso fallo, sin esto el operador veria un trazado que
 * atraviesa la zona. Como el recorte es idempotente, cuando el backend si
 * recorto esta pasada no cambia nada.
 */
function clipWaypointsToZones(
  waypoints: CoverageWaypoint[],
  polygons: NoGoPolygon[],
  origin: CoverageGeoPoint,
  marginM: number,
  bounds: NoGoBounds,
  fieldBoundary: NoGoPolygon
): { waypoints: CoverageWaypoint[]; dropped: number; detours: number } {
  const result = clipPathToNoGo<CoverageWaypoint>(waypoints, polygons, {
    marginM,
    bounds,
    fieldBoundary,
    positionOf: (item) => {
      const local = localMeters(origin, item);
      return { x: local.east, y: local.north };
    },
    headingOf: (item) => item.yawDeg,
    makeDetour: (point: NoGoPoint, headingDeg: number, target: CoverageWaypoint) => {
      const geo = offsetPoint(origin, point.x, point.y);
      return {
        ...target,
        lat: geo.lat,
        lon: geo.lon,
        yawDeg: normalizeYawDeg(headingDeg),
        phase: NOGO_DETOUR_PHASE,
        key: true
      };
    }
  });
  return { waypoints: result.items, dropped: result.dropped, detours: result.detours };
}

function parseCoveragePreview(
  response: Nav2IncomingMessage,
  field: CoverageFieldGeometry,
  parameters: CoverageParameters
): CoveragePreview {
  const body = coverageBody(response);
  const plan = asRecord(body.metrics) ?? asRecord(body.plan) ?? body;
  const turns = asRecord(body.headland_turns) ?? asRecord(plan.headland_turns) ?? {};
  const headland = asRecord(body.required_headland_m) ?? asRecord(plan.required_headland_m) ?? {};
  const routeRequest = asRecord(body.route_request) ?? {};
  const topologyConflicts = asRecord(plan.topology_conflicts) ?? asRecord(body.topology_conflicts) ?? {};
  const globalTopologyConflicts =
    asRecord(plan.global_topology_conflicts) ?? asRecord(body.global_topology_conflicts) ?? topologyConflicts;
  const sampledRaw =
    (Array.isArray(body.sampled_waypoints) ? body.sampled_waypoints : null) ??
    (Array.isArray(body.waypoints) ? body.waypoints : null) ??
    (Array.isArray(plan.waypoints) ? plan.waypoints : []);
  const sampledWaypoints = sampledRaw
    .map(parseCoverageWaypoint)
    .filter((waypoint): waypoint is CoverageWaypoint => waypoint !== null);
  // `route_request` es la lista que el backend va a mandar a route_executor.
  // No se debe dibujar el muestreo denso si se tuvo que reducir para respetar
  // el limite de la ruta: eso fue justamente lo que hacia que el plano azul y
  // el recorrido real no coincidieran.
  const executionRaw =
    (Array.isArray(routeRequest.waypoints) ? routeRequest.waypoints : null) ??
    (Array.isArray(body.route_waypoints) ? body.route_waypoints : null) ??
    sampledRaw;
  const executionWaypoints = executionRaw
    .map(parseCoverageWaypoint)
    .filter((waypoint): waypoint is CoverageWaypoint => waypoint !== null);
  const explicitKeyRaw =
    (Array.isArray(body.key_waypoints) ? body.key_waypoints : null) ??
    (Array.isArray(plan.key_waypoints) ? plan.key_waypoints : null);
  const keyWaypoints = explicitKeyRaw
    ? explicitKeyRaw
        .map(parseCoverageWaypoint)
        .filter((waypoint): waypoint is CoverageWaypoint => waypoint !== null)
        .map((waypoint) => ({ ...waypoint, key: true }))
    : sampledWaypoints.filter((waypoint) => waypoint.key);
  if (sampledWaypoints.length < 2) {
    throw new Error("preview_coverage no devolvió una trayectoria válida");
  }
  if (executionWaypoints.length < 2) {
    throw new Error("preview_coverage no devolvió una ruta ejecutable válida");
  }
  if (keyWaypoints.length < 2) {
    throw new Error("preview_coverage no devolvió waypoints key suficientes");
  }

  const turnSeparationsM = numberList(
    body.turn_separations_m ?? plan.turn_separations_m ?? turns.separations_m
  );
  const turnCount = nonNegativeInteger(
    turns.count ?? body.turn_count ?? plan.turn_count,
    turnSeparationsM.length
  );
  const cleanUturnCount = nonNegativeInteger(
    turns.clean_uturns ?? body.clean_uturn_count ?? plan.clean_uturn_count
  );
  const omegaTurnCount = nonNegativeInteger(
    turns.omega_turns ?? body.omega_turn_count ?? plan.omega_turn_count,
    Math.max(0, turnCount - cleanUturnCount)
  );
  const safeLegSpacingM =
    Math.max(5.0, field.fieldLengthM, ...turnSeparationsM, 0.0) + 1.0;
  const requestedLegSpacingM = finiteNumber(
    routeRequest.leg_spacing_m ?? body.recommended_leg_spacing_m ?? body.leg_spacing_m ?? plan.leg_spacing_m,
    safeLegSpacingM
  );
  const legSpacingM = Math.max(safeLegSpacingM, requestedLegSpacingM);
  const topologyFlags = [
    body.topology_safe,
    body.is_topologically_safe,
    plan.topology_safe,
    plan.is_topologically_safe
  ].filter((value): value is boolean => typeof value === "boolean");
  const reportedTopologySafe = topologyFlags.length > 0 && topologyFlags.every((value) => value);
  const topologyScopeRaw = String(plan.topology_scope ?? body.topology_scope ?? "global").trim().toLowerCase();
  const topologyScope: "global" | "field_interior" = topologyScopeRaw === "field_interior"
    ? "field_interior"
    : "global";
  const strictCrossingCount = nonNegativeInteger(
    topologyConflicts.strict_crossings ?? plan.strict_crossing_count ?? body.strict_crossing_count
  );
  const nonadjacentTouchCount = nonNegativeInteger(
    topologyConflicts.nonadjacent_touches ?? plan.nonadjacent_touch_count ?? body.nonadjacent_touch_count
  );
  const collinearOverlapCount = nonNegativeInteger(
    topologyConflicts.collinear_overlaps ?? plan.collinear_overlap_count ?? body.collinear_overlap_count
  );
  const reportedTopologyConflictCount = nonNegativeInteger(
    topologyConflicts.total ?? plan.topology_conflict_count ?? body.topology_conflict_count
  );
  const topologyConflictCount = Math.max(
    reportedTopologyConflictCount,
    strictCrossingCount + nonadjacentTouchCount + collinearOverlapCount
  );
  const globalStrictCrossingCount = nonNegativeInteger(
    globalTopologyConflicts.strict_crossings ?? plan.strict_crossing_count ?? body.strict_crossing_count,
    strictCrossingCount
  );
  const globalNonadjacentTouchCount = nonNegativeInteger(
    globalTopologyConflicts.nonadjacent_touches ?? plan.nonadjacent_touch_count ?? body.nonadjacent_touch_count,
    nonadjacentTouchCount
  );
  const globalCollinearOverlapCount = nonNegativeInteger(
    globalTopologyConflicts.collinear_overlaps ?? plan.collinear_overlap_count ?? body.collinear_overlap_count,
    collinearOverlapCount
  );
  const globalReportedConflictCount = nonNegativeInteger(
    globalTopologyConflicts.total ?? plan.global_topology_conflict_count ?? body.global_topology_conflict_count,
    topologyConflictCount
  );
  const globalTopologyConflictCount = Math.max(
    globalReportedConflictCount,
    globalStrictCrossingCount + globalNonadjacentTouchCount + globalCollinearOverlapCount
  );
  const topologySafe = reportedTopologySafe && topologyConflictCount === 0;
  const topologyErrorRaw = String(
    body.topology_error ?? body.topology_error_text ?? plan.topology_error ?? plan.topology_error_text ?? ""
  ).trim();
  const topologyError = topologyErrorRaw || (topologySafe
    ? ""
    : topologyConflictCount > 0
      ? `El trazado nominal tiene ${topologyConflictCount} conflicto(s) dentro del campo: ` +
        `${strictCrossingCount} cruce(s), ${nonadjacentTouchCount} contacto(s) no adyacente(s) y ` +
        `${collinearOverlapCount} solape(s) colineal(es).`
      : omegaTurnCount > 0 && topologyScope === "global"
        ? `El perfil actual no permite ${omegaTurnCount} giro(s) omega en el trazado global.`
        : `El backend marcó conflictos topológicos en el alcance ${topologyScope}.`);

  return {
    executionWaypoints,
    sampledWaypoints,
    keyWaypoints,
    topologySafe,
    topologyError,
    legSpacingM,
    nogoPolygonCount: nonNegativeInteger(body.nogo_polygon_count ?? plan.nogo_polygon_count),
    nogoNote: String(body.nogo_note ?? plan.nogo_note ?? "").trim(),
    nogoClippedLocally: false,
    metrics: {
      topologyScope,
      rowCount: nonNegativeInteger(body.row_count ?? plan.row_count),
      laneSpacingM: finiteNumber(body.lane_spacing_m ?? plan.lane_spacing_m),
      rowVisitOrder: integerList(body.row_visit_order ?? plan.row_visit_order),
      turnSeparationsM,
      turnCount,
      cleanUturnCount,
      omegaTurnCount,
      minSeparationM: finiteNumber(
        turns.min_separation_m,
        turnSeparationsM.length > 0 ? Math.min(...turnSeparationsM) : 0
      ),
      separationNeededForUturnM: finiteNumber(
        turns.separation_needed_for_uturn_m,
        2.0 * parameters.minTurningRadiusM
      ),
      estimatedPathLengthM: finiteNumber(body.estimated_path_length_m ?? plan.estimated_path_length_m),
      headlandBeforeM: finiteNumber(headland.before ?? plan.headland_before_m ?? body.headland_before_m),
      headlandAfterM: finiteNumber(headland.after ?? plan.headland_after_m ?? body.headland_after_m),
      lateralOverflowM: finiteNumber(
        headland.lateral_centerline_overflow ?? plan.lateral_overflow_m ?? body.lateral_overflow_m
      ),
      strictCrossingCount,
      nonadjacentTouchCount,
      collinearOverlapCount,
      topologyConflictCount,
      globalStrictCrossingCount,
      globalNonadjacentTouchCount,
      globalCollinearOverlapCount,
      globalTopologyConflictCount,
      topologyAuditSpacingM: finiteNumber(plan.topology_audit_spacing_m ?? body.topology_audit_spacing_m),
      plannerMinTurningRadiusM: finiteNumber(
        plan.planner_min_turning_radius_m ?? body.planner_min_turning_radius_m,
        parameters.minTurningRadiusM
      )
    }
  };
}

function validateParameters(
  parameters: CoverageParameters,
  minimumTurningRadiusM = PLANNER_MIN_TURNING_RADIUS_M.real
): void {
  if (!Number.isFinite(parameters.cutterWidthM) || parameters.cutterWidthM <= 0) {
    throw new Error("El ancho de corte debe ser mayor que cero");
  }
  if (!Number.isFinite(parameters.overlapRatio) || parameters.overlapRatio < 0 || parameters.overlapRatio >= 1) {
    throw new Error("El solape debe estar entre 0% y menos de 100%");
  }
  if (!Number.isFinite(parameters.minTurningRadiusM) || parameters.minTurningRadiusM < minimumTurningRadiusM) {
    throw new Error(`El radio mínimo de giro no puede ser menor que los ${minimumTurningRadiusM.toFixed(1)} m del perfil actual`);
  }
  if (!Number.isFinite(parameters.waypointSpacingM) || parameters.waypointSpacingM < 0.5) {
    throw new Error("El espaciado de preview debe ser de al menos 0.5 m");
  }
  if (!Number.isFinite(parameters.chunkSpanM) || parameters.chunkSpanM < 20) {
    throw new Error("El largo de chunk debe ser de al menos 20 m");
  }
  if (!Number.isInteger(parameters.chunkMaxWaypoints) || parameters.chunkMaxWaypoints < 2) {
    throw new Error("El máximo de waypoints por chunk debe ser un entero mayor o igual a 2");
  }
}

function newRingId(): string {
  return `ring.${Date.now()}.${Math.floor(Math.random() * 100_000)}`;
}

function emptyDraft(): CoverageDraft {
  return {
    mode: "idle",
    outline: { id: newRingId(), vertices: [] },
    exclusions: [],
    activeExclusionId: null,
    rigid: false
  };
}

function cloneRing(ring: CoverageRing): CoverageRing {
  return { id: ring.id, vertices: ring.vertices.map(clonePoint) };
}

function cloneDraft(draft: CoverageDraft): CoverageDraft {
  return {
    mode: draft.mode,
    outline: cloneRing(draft.outline),
    exclusions: draft.exclusions.map(cloneRing),
    activeExclusionId: draft.activeExclusionId,
    rigid: draft.rigid === true
  };
}

/** Centro del anillo; la longitud se promedia sobre el circulo, no en grados. */
function ringCentre(ring: CoverageRing): CoverageGeoPoint | null {
  if (ring.vertices.length === 0) return null;
  const lat = ring.vertices.reduce((acc, v) => acc + v.lat, 0) / ring.vertices.length;
  const sinLon = ring.vertices.reduce(
    (acc, vertex) => acc + Math.sin(degreesToRadians(vertex.lon)), 0
  );
  const cosLon = ring.vertices.reduce(
    (acc, vertex) => acc + Math.cos(degreesToRadians(vertex.lon)), 0
  );
  const lon = normalizeLongitudeDeg(Math.atan2(sinLon, cosLon) * 180 / Math.PI);
  return { lat, lon };
}

/**
 * Tamano del anillo: el lado mayor de su caja, en metros.
 *
 * Es la medida que el operador ve en el mapa y la que tiene sentido escribir a
 * mano. Se calcula, no se guarda: el anillo es la unica fuente de verdad.
 */
export function ringSizeM(ring: CoverageRing): number {
  const centre = ringCentre(ring);
  if (!centre || ring.vertices.length < 2) return 0;
  const locales = ring.vertices.map((vertex) => localMeters(centre, vertex));
  const ancho = Math.max(...locales.map((p) => p.east)) - Math.min(...locales.map((p) => p.east));
  const alto = Math.max(...locales.map((p) => p.north)) - Math.min(...locales.map((p) => p.north));
  return Math.max(ancho, alto);
}

/** Correr el anillo entero. Traslacion pura: la forma no cambia. */
function translateRing(ring: CoverageRing, deltaLat: number, deltaLon: number): CoverageRing {
  return {
    id: ring.id,
    vertices: ring.vertices.map((vertex) => ({
      lat: vertex.lat + deltaLat,
      lon: normalizeLongitudeDeg(vertex.lon + deltaLon)
    }))
  };
}

/** Girar el anillo alrededor de `centre`, en grados antihorarios. */
function rotateRing(ring: CoverageRing, centre: CoverageGeoPoint, deltaDeg: number): CoverageRing {
  const rad = degreesToRadians(deltaDeg);
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    id: ring.id,
    vertices: ring.vertices.map((vertex) => {
      // En metros locales, si no el giro sale ovalado: un grado de longitud mide
      // menos que uno de latitud en cualquier latitud que no sea el ecuador.
      const local = localMeters(centre, vertex);
      return offsetPoint(
        centre,
        local.east * cos - local.north * sin,
        local.east * sin + local.north * cos
      );
    })
  };
}

/** Escalar el anillo respecto de su centro, conservando la forma. */
function scaleRing(ring: CoverageRing, factor: number): CoverageRing {
  const centre = ringCentre(ring);
  if (!centre) return cloneRing(ring);
  return {
    id: ring.id,
    vertices: ring.vertices.map((vertex) => {
      const local = localMeters(centre, vertex);
      return offsetPoint(centre, local.east * factor, local.north * factor);
    })
  };
}

/**
 * Si el borrador alcanza para planificar.
 *
 * Se calcula, no se guarda. Un booleano en el estado seria una copia mas que
 * mantener sincronizada con los vertices, y la autoridad sobre la validez fina
 * —autointersecciones, exclusiones fuera del lote— es el backend igual.
 */
export function isCoverageDraftPlannable(draft: CoverageDraft): boolean {
  if (draft.outline.vertices.length < MIN_RING_VERTICES) return false;
  // Una exclusion a medio dibujar no puede viajar: el backend la rechazaria y
  // el operador perderia el preview por algo que se ve a simple vista.
  return draft.exclusions.every(
    (ring) => ring.vertices.length >= MIN_RING_VERTICES
  );
}

/** Anillo abierto al objeto que espera GeoRing. Los id no se serializan. */
function ringPayload(ring: CoverageRing): Record<string, unknown> {
  return {
    vertices: ring.vertices.map((vertex) => ({ lat: vertex.lat, lon: vertex.lon }))
  };
}

/**
 * Rectangulo envolvente del poligono, para los campos legacy del pedido.
 *
 * En modo poligono el backend planifica con el poligono, pero igual usa
 * `start_*` como origen para georreferenciar y valida que las dimensiones sean
 * razonables. Se le manda la caja del poligono: un origen real y unas medidas
 * que se corresponden con el lote, en vez de numeros inventados.
 */
function fieldGeometryFromRing(
  ring: CoverageRing,
  side: "left" | "right"
): CoverageFieldGeometry | null {
  if (ring.vertices.length < MIN_RING_VERTICES) return null;
  // Se mide contra un vertice y con delta de longitud corta. Min/max lon crudo
  // convierte un lote que cruza el antimeridiano en uno de casi 40.000 km.
  const reference = ring.vertices[0]!;
  const local = ring.vertices.map((vertex) => localMeters(reference, vertex));
  const xMin = Math.min(...local.map((point) => point.east));
  const xMax = Math.max(...local.map((point) => point.east));
  const yMin = Math.min(...local.map((point) => point.north));
  const yMax = Math.max(...local.map((point) => point.north));
  const origin = offsetPoint(reference, xMin, yMin);
  return {
    startLat: origin.lat,
    startLon: origin.lon,
    // Yaw 0: en modo poligono las pasadas las orienta Fields2Cover, no este
    // rumbo. Solo define el marco en el que van y vuelven las coordenadas.
    startYawDeg: 0,
    fieldLengthM: Math.max(1, xMax - xMin),
    fieldWidthM: Math.max(1, yMax - yMin),
    side
  };
}

function coverageRequestPayload(
  field: CoverageFieldGeometry,
  parameters: CoverageParameters,
  draft?: CoverageDraft
): Record<string, unknown> {
  // Los campos del rectangulo viajan siempre: el backend los usa como origen
  // para georreferenciar, tambien en modo poligono.
  const polygon = draft
    ? {
        coverage_polygon: ringPayload(draft.outline),
        coverage_exclusions: draft.exclusions.map(ringPayload)
      }
    : {};
  return {
    ...polygon,
    start_lat: field.startLat,
    start_lon: field.startLon,
    start_yaw_deg: field.startYawDeg,
    field_length_m: field.fieldLengthM,
    field_width_m: field.fieldWidthM,
    cutter_width_m: parameters.cutterWidthM,
    overlap_ratio: parameters.overlapRatio,
    min_turning_radius_m: parameters.minTurningRadiusM,
    waypoint_spacing_m: parameters.waypointSpacingM,
    side: field.side
  };
}

export class CoverageService {
  private readonly listeners = new Set<CoverageListener>();
  private planGeneration = 0;
  private runtimeProfile: "sim" | "real" | null = null;
  private state: CoverageState = {
    runtimeProfile: "real",
    fieldPolygon: [],
    field: null,
    parameters: { ...DEFAULT_PARAMETERS },
    preview: null,
    vehicleAnchor: null,
    fieldSource: "rectangle",
    draft: emptyDraft(),
    loading: false,
    sending: false,
    error: "",
    lastStatus: "Definí un campo para generar la cobertura"
  };

  constructor(
    private readonly robotDispatcher: RobotDispatcher,
    private readonly navigationService?: NavigationSafetyService,
    private readonly zoneSource?: NoGoZoneSource
  ) {}

  getState(): CoverageState {
    return {
      ...this.state,
      fieldPolygon: this.state.fieldPolygon.map(clonePoint),
      field: this.state.field ? { ...this.state.field } : null,
      parameters: { ...this.state.parameters },
      preview: this.state.preview ? clonePreview(this.state.preview) : null,
      draft: cloneDraft(this.state.draft)
    };
  }

  subscribe(listener: CoverageListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Piso de radio del perfil activo; sin perfil resuelto se usa el conservador. */
  private plannerMinTurningRadiusM(): number {
    return PLANNER_MIN_TURNING_RADIUS_M[this.runtimeProfile ?? "real"];
  }

  setRuntimeProfile(profile: "sim" | "real"): void {
    if (this.runtimeProfile === profile) return;
    this.runtimeProfile = profile;
    const minTurningRadiusM = PLANNER_MIN_TURNING_RADIUS_M[profile];
    this.planGeneration += 1;
    this.state = {
      ...this.state,
      runtimeProfile: profile,
      parameters: {
        ...this.state.parameters,
        minTurningRadiusM
      },
      preview: null,
      loading: false,
      error: "",
      lastStatus: this.state.field
        ? `Perfil ${profile === "sim" ? "simulación" : "real"} ` +
          `(R=${minTurningRadiusM.toFixed(1)} m); regenerá el preview`
        : this.state.lastStatus
    };
    this.emit();
  }

  /**
   * Armar un cuadrado con la esquina en la pose actual del vehiculo.
   *
   * Es el mismo encuadre que hace `start_coverage` cuando no se le pasa
   * referencia: la esquina es donde esta parado y el rumbo del campo es su
   * rumbo. Es la unica forma de definir el lote: no hay figura libre que
   * dibujar, asi que el operador ubica el vehiculo en la esquina y elige el lado.
   */
  squareFromVehiclePose(
    pose: CoverageVehiclePose,
    options: { sideM?: number; side?: "left" | "right" } = {}
  ): CoverageState {
    if (this.state.sending) {
      throw new Error("No se puede modificar el campo mientras se envía la cobertura");
    }
    if (!Number.isFinite(pose.lat) || !Number.isFinite(pose.lon) || !Number.isFinite(pose.yawDeg)) {
      throw new Error("La pose del vehículo todavía no está disponible");
    }

    const sideM = Number(
      options.sideM ?? this.state.field?.fieldLengthM ?? DEFAULT_SQUARE_SIDE_M
    );
    if (!Number.isFinite(sideM) || sideM < MIN_FIELD_EDGE_M) {
      throw new Error(`El lado del campo debe ser de al menos ${MIN_FIELD_EDGE_M.toFixed(1)} m`);
    }
    if (sideM <= this.state.parameters.cutterWidthM) {
      throw new Error("El lado del campo debe superar el ancho de corte");
    }

    const side = options.side ?? this.state.field?.side ?? "left";
    const yawRad = degreesToRadians(pose.yawDeg);
    const forwardEast = Math.cos(yawRad);
    const forwardNorth = Math.sin(yawRad);
    // Positivo a la izquierda del rumbo: elige de que lado del vehiculo crece el
    // cuadrado.
    const lateralSign = side === "left" ? 1 : -1;

    // El proveedor trata start_lat/lon como la esquina fisica y mete la primera
    // pasada media pasada adelante y media al costado. Si la esquina fuese la
    // pose del vehiculo, esa primera meta quedaria en diagonal a media pasada:
    // un corrimiento lateral que con radio minimo no se toma de frente y obliga
    // a un rulo entero antes de empezar a trabajar. Corriendo la esquina esa
    // misma media pasada hacia atras y hacia el otro lado, el inset la deja
    // exactamente sobre el vehiculo y arranca alineado. La esquina asi ubicada
    // ademas es la correcta: trabajando la primera pasada el implemento cubre
    // hasta el borde del lote, no hasta el eje del vehiculo.
    const insetM = 0.5 * this.state.parameters.cutterWidthM;
    const origin = offsetPoint(
      { lat: pose.lat, lon: pose.lon },
      -(forwardEast * insetM) + forwardNorth * insetM * lateralSign,
      -(forwardNorth * insetM) - forwardEast * insetM * lateralSign
    );

    const geometry = buildSquareGeometry({
      origin,
      yawDeg: pose.yawDeg,
      sideM,
      side
    });

    this.planGeneration += 1;
    this.state = {
      ...this.state,
      fieldPolygon: geometry.polygon,
      field: geometry.field,
      preview: null,
      vehicleAnchor: { lat: pose.lat, lon: pose.lon, yawDeg: pose.yawDeg },
      error: "",
      lastStatus:
        `Cuadrado de ${geometry.field.fieldLengthM.toFixed(1)} m desde el vehículo ` +
        `(rumbo ${geometry.field.startYawDeg.toFixed(0)}°, hacia la ${side === "left" ? "izquierda" : "derecha"})`
    };
    this.emit();
    return this.getState();
  }

  /**
   * Adelanto del trazado con el campo y los parametros actuales.
   *
   * Devuelve null mientras no haya campo. No reemplaza al preview del backend:
   * no audita cruces ni habilita el inicio.
   */
  getLayoutEstimate(): CoverageLayoutEstimate | null {
    const field = this.state.field;
    if (!field) return null;
    return estimateCoverageLayout({
      fieldLengthM: field.fieldLengthM,
      fieldWidthM: field.fieldWidthM,
      cutterWidthM: this.state.parameters.cutterWidthM,
      overlapRatio: this.state.parameters.overlapRatio,
      minTurningRadiusM: this.state.parameters.minTurningRadiusM
    });
  }

  clear(): void {
    if (this.state.sending) {
      throw new Error("No se puede limpiar la cobertura mientras se está enviando");
    }
    this.planGeneration += 1;
    this.state = {
      ...this.state,
      fieldPolygon: [],
      field: null,
      preview: null,
      vehicleAnchor: null,
      loading: false,
      sending: false,
      error: "",
      lastStatus: "Campo y preview eliminados"
    };
    this.emit();
  }

  invalidatePreview(reason: string): void {
    if (!this.state.preview && !this.state.loading && !this.state.sending) return;
    this.planGeneration += 1;
    this.state = {
      ...this.state,
      preview: null,
      loading: false,
      sending: false,
      error: "",
      lastStatus: reason.trim() || "Preview invalidado; regeneralo antes de iniciar"
    };
    this.emit();
  }

  setParameters(update: Partial<CoverageParameters>): void {
    if (this.state.sending) {
      throw new Error("No se pueden cambiar parámetros mientras se envía la cobertura");
    }
    const parameters: CoverageParameters = {
      ...this.state.parameters,
      ...update,
      chunkMaxWaypoints:
        update.chunkMaxWaypoints === undefined
          ? this.state.parameters.chunkMaxWaypoints
          : Math.round(Number(update.chunkMaxWaypoints))
    };
    validateParameters(parameters, this.plannerMinTurningRadiusM());
    this.planGeneration += 1;
    this.state = {
      ...this.state,
      parameters,
      preview: null,
      loading: false,
      error: "",
      lastStatus: this.state.field ? "Parámetros actualizados; regenerá el preview" : this.state.lastStatus
    };

    // El corrimiento de la esquina de un cuadrado hecho desde el vehiculo vale
    // media pasada, asi que cambiar el ancho de corte lo desalinea. Se rehace
    // desde la misma pose para que la primera pasada siga cayendo bajo el
    // vehiculo; si el lado nuevo ya no es valido se conserva el campo anterior y
    // el operador ve el error del parametro, no un campo movido a medias.
    const anchor = this.state.vehicleAnchor;
    if (anchor && update.cutterWidthM !== undefined && this.state.field) {
      const sideM = this.state.field.fieldLengthM;
      const side = this.state.field.side;
      try {
        this.squareFromVehiclePose(anchor, { sideM, side });
        return;
      } catch {
        // Se conserva el campo previo: emitir igual el cambio de parametros.
      }
    }

    this.emit();
  }

  /** Corregir a mano el lado del cuadrado; los dos lados van siempre juntos. */
  setFieldDimensions(update: { fieldLengthM?: number; fieldWidthM?: number }): void {
    if (this.state.sending) {
      throw new Error("No se puede modificar el campo mientras se envía la cobertura");
    }
    const current = this.state.field;
    if (!current) {
      throw new Error("Primero armá el cuadrado");
    }
    const requested = update.fieldLengthM === undefined ? update.fieldWidthM : update.fieldLengthM;
    const sideM = requested === undefined ? current.fieldLengthM : Number(requested);
    const fieldLengthM = sideM;
    const fieldWidthM = sideM;
    const minimumPhysicalEdgeM = Math.max(MIN_FIELD_EDGE_M, this.state.parameters.cutterWidthM);
    if (!Number.isFinite(sideM) || sideM <= minimumPhysicalEdgeM) {
      throw new Error(`El lado debe ser mayor que ${minimumPhysicalEdgeM.toFixed(1)} m`);
    }
    const field: CoverageFieldGeometry = {
      ...current,
      fieldLengthM,
      fieldWidthM
    };
    this.planGeneration += 1;
    this.state = {
      ...this.state,
      fieldPolygon: fieldPolygonFromGeometry(field),
      field,
      preview: null,
      loading: false,
      error: "",
      lastStatus: `Campo ajustado: ${fieldLengthM.toFixed(1)} × ${fieldWidthM.toFixed(1)} m; regenerá el preview`
    };
    this.emit();
  }

  /**
   * Mover el cuadrado sin cambiarle el lado ni el rumbo.
   *
   * `centre` es donde quedo el tirador que el operador arrastro en el mapa; la
   * esquina de arranque se recalcula a partir de el. Deja de estar anclado a la
   * pose del vehiculo: a partir de aca el campo es donde el operador lo puso.
   */
  moveFieldTo(centre: CoverageGeoPoint): void {
    this.commitFieldGeometry(this.geometryForMove(centre), (field) =>
      `Cuadrado movido: lado ${field.fieldLengthM.toFixed(1)} m; regenerá el preview`
    );
  }

  /** Geometria que tendria el lote si se soltara el arrastre acá. No guarda nada. */
  geometryForMove(centre: CoverageGeoPoint): SquareGeometry {
    if (this.state.sending) {
      throw new Error("No se puede mover el campo mientras se envía la cobertura");
    }
    const current = this.state.field;
    if (!current) {
      throw new Error("Primero armá el cuadrado");
    }
    if (!Number.isFinite(centre.lat) || !Number.isFinite(centre.lon)) {
      throw new Error("Posición inválida para el campo");
    }
    const delta = localMeters(fieldCentre(current), centre);
    const origin = offsetPoint(
      { lat: current.startLat, lon: current.startLon },
      delta.east,
      delta.north
    );
    const geometry = buildSquareGeometry({
      origin,
      yawDeg: current.startYawDeg,
      sideM: current.fieldLengthM,
      side: current.side
    });
    return geometry;
  }

  /**
   * Girar el cuadrado alrededor de su centro.
   *
   * `pointer` es donde esta el tirador de rotacion, que cuelga de la esquina
   * opuesta a la de arranque. Esa esquina esta sobre la **diagonal**, o sea a 45
   * grados del eje de las pasadas, asi que hay que descontarlos: sin eso el
   * cuadrado pega un salto de 45 grados apenas se empieza a arrastrar. El signo
   * depende de hacia que lado crece el lote.
   *
   * El rumbo se redondea a un grado: sin el redondeo queda con diez decimales y
   * el campo "rumbo inicial" del panel se vuelve ilegible.
   *
   * Rotar cambia la direccion de las pasadas sin mover el lote, que es lo que
   * hace falta para alinearlas con un alambrado o con un surco existente.
   */
  rotateFieldTo(pointer: CoverageGeoPoint): void {
    this.commitFieldGeometry(this.geometryForRotate(pointer), (field) =>
      `Rumbo ${field.startYawDeg.toFixed(0)}°; regenerá el preview`
    );
  }

  /** Geometria que tendria el lote con ese rumbo. No guarda nada. */
  geometryForRotate(pointer: CoverageGeoPoint): SquareGeometry | null {
    if (this.state.sending) {
      throw new Error("No se puede girar el campo mientras se envía la cobertura");
    }
    const current = this.state.field;
    if (!current) {
      throw new Error("Primero armá el cuadrado");
    }
    if (!Number.isFinite(pointer.lat) || !Number.isFinite(pointer.lon)) {
      throw new Error("Posición inválida para el campo");
    }

    const centre = fieldCentre(current);
    const delta = localMeters(centre, pointer);
    if (Math.hypot(delta.east, delta.north) < MIN_ROTATION_RADIUS_M) {
      // Demasiado cerca del centro: el angulo salta de forma erratica.
      return null;
    }
    const lateralSign = current.side === "left" ? 1 : -1;
    const diagonalDeg = radiansToDegrees(Math.atan2(delta.north, delta.east));
    const yawDeg = normalizeYawDeg(Math.round(diagonalDeg - 45 * lateralSign));

    // El centro se mantiene: se recalcula la esquina de arranque desde el centro
    // nuevo, no al reves, para que el cuadrado gire sobre si mismo.
    const halfDiagonal = rotatedHalfDiagonal(current.fieldLengthM, yawDeg, current.side);
    const origin = offsetPoint(centre, -halfDiagonal.east, -halfDiagonal.north);
    const geometry = buildSquareGeometry({
      origin,
      yawDeg,
      sideM: current.fieldLengthM,
      side: current.side
    });
    return geometry;
  }

  /**
   * Cambiar el lado arrastrando cualquiera de las cuatro esquinas.
   *
   * La esquina diagonalmente opuesta queda fija, que es lo que espera cualquiera
   * que haya redimensionado un rectangulo en un editor. El lado nuevo es la mayor
   * de las dos proyecciones del arrastre sobre los ejes del campo, igual criterio
   * que el numero que se escribe a mano.
   */
  resizeFieldFromCorner(corner: CoverageGeoPoint, cornerIndex = 2): void {
    this.commitFieldGeometry(this.geometryForResize(corner, cornerIndex), (field) =>
      `Lado ${field.fieldLengthM.toFixed(1)} m; regenerá el preview`
    );
  }

  /** Geometria que tendria el lote con esa esquina ahí. No guarda nada. */
  geometryForResize(corner: CoverageGeoPoint, cornerIndex = 2): SquareGeometry {
    if (this.state.sending) {
      throw new Error("No se puede redimensionar el campo mientras se envía la cobertura");
    }
    const current = this.state.field;
    if (!current) {
      throw new Error("Primero armá el cuadrado");
    }
    if (!Number.isFinite(corner.lat) || !Number.isFinite(corner.lon)) {
      throw new Error("Posición inválida para el campo");
    }
    // El ancla es la esquina diagonalmente opuesta a la que se arrastra: es lo
    // que espera cualquiera que haya redimensionado un rectangulo en un editor.
    const polygon = fieldPolygonFromGeometry(current);
    const dragged = ((Math.round(cornerIndex) % 4) + 4) % 4;
    const anchor = polygon[(dragged + 2) % 4]!;

    const yawRad = degreesToRadians(current.startYawDeg);
    const lateralSign = current.side === "left" ? 1 : -1;
    const drag = localMeters(anchor, corner);
    const forwardM = drag.east * Math.cos(yawRad) + drag.north * Math.sin(yawRad);
    const lateralM =
      (-drag.east * Math.sin(yawRad) + drag.north * Math.cos(yawRad)) * lateralSign;
    // Redondeado a 0.1 m: el arrastre da un flotante de diez decimales y ese
    // numero termina en el campo "lado exacto", donde no hay nada que corregir.
    const sideM = Math.round(Math.max(Math.abs(forwardM), Math.abs(lateralM)) * 10) / 10;
    const minimumPhysicalEdgeM = Math.max(MIN_FIELD_EDGE_M, this.state.parameters.cutterWidthM);
    if (!Number.isFinite(sideM) || sideM <= minimumPhysicalEdgeM) {
      throw new Error(`El lado debe ser mayor que ${minimumPhysicalEdgeM.toFixed(1)} m`);
    }

    // El ancla se queda quieta, asi que la esquina de arranque se recalcula desde
    // ella. Cada esquina del poligono esta a una combinacion conocida de avance y
    // costado respecto del arranque, en unidades de lado:
    //   0 = (0,0)   1 = (1,0)   2 = (1,1)   3 = (0,1)
    // asi que el arranque es el ancla menos su propia combinacion.
    const COMBINACION: ReadonlyArray<readonly [number, number]> = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1]
    ];
    const [avance, costado] = COMBINACION[(dragged + 2) % 4]!;
    const forwardUnit = { east: Math.cos(yawRad), north: Math.sin(yawRad) };
    const lateralUnit = {
      east: -Math.sin(yawRad) * lateralSign,
      north: Math.cos(yawRad) * lateralSign
    };
    const origin = offsetPoint(
      anchor,
      -(forwardUnit.east * avance + lateralUnit.east * costado) * sideM,
      -(forwardUnit.north * avance + lateralUnit.north * costado) * sideM
    );

    const geometry = buildSquareGeometry({
      origin,
      yawDeg: current.startYawDeg,
      sideM,
      side: current.side
    });
    return geometry;
  }

  /**
   * Guardar una geometria calculada por los `geometryFor*`.
   *
   * Los tres tiradores terminan igual: invalidan el preview viejo (el trazado ya
   * no corresponde al lote nuevo) y sueltan el ancla del vehiculo. Lo unico que
   * cambia es el cartel de estado, asi que va como funcion.
   */
  private commitFieldGeometry(
    geometry: SquareGeometry | null,
    status: (field: CoverageFieldGeometry) => string
  ): void {
    if (!geometry) {
      return;
    }
    this.planGeneration += 1;
    this.state = {
      ...this.state,
      fieldPolygon: geometry.polygon,
      field: geometry.field,
      preview: null,
      vehicleAnchor: null,
      loading: false,
      error: "",
      lastStatus: status(geometry.field)
    };
    this.emit();
  }

  reverseFieldDirection(): void {
    if (this.state.sending) {
      throw new Error("No se puede invertir el campo mientras se envía la cobertura");
    }
    const current = this.state.field;
    if (!current) {
      throw new Error("Primero armá el cuadrado");
    }
    const currentPolygon = fieldPolygonFromGeometry(current);
    const nextStart = currentPolygon[1]!;
    const field: CoverageFieldGeometry = {
      ...current,
      startLat: nextStart.lat,
      startLon: nextStart.lon,
      startYawDeg: normalizeYawDeg(current.startYawDeg + 180),
      side: current.side === "left" ? "right" : "left"
    };
    this.planGeneration += 1;
    this.state = {
      ...this.state,
      fieldPolygon: fieldPolygonFromGeometry(field),
      field,
      preview: null,
      loading: false,
      error: "",
      lastStatus: "Inicio invertido a la esquina opuesta; regenerá el preview"
    };
    this.emit();
  }

  async previewCoverage(): Promise<CoveragePreview> {
    const field = this.state.field;
    if (this.state.fieldSource === "polygon") {
      if (!isCoverageDraftPlannable(this.state.draft)) {
        throw new Error(
          "El polígono del lote necesita al menos 3 vértices, y cada exclusión también"
        );
      }
    } else if (!field || this.state.fieldPolygon.length !== 4) {
      throw new Error("Primero armá el cuadrado");
    }
    validateParameters(this.state.parameters, this.plannerMinTurningRadiusM());
    if (this.state.loading) {
      throw new Error("Ya hay un preview en curso");
    }
    const requestGeneration = this.planGeneration;
    const requestParameters = { ...this.state.parameters };
    this.state = {
      ...this.state,
      loading: true,
      preview: null,
      error: "",
      lastStatus: "Generando preview de cobertura..."
    };
    this.emit();
    try {
      const response = await this.robotDispatcher.requestCoveragePreview(
        coverageRequestPayload(
          this.fieldForRequest(field), requestParameters, this.draftForRequest()
        )
      );
      if (requestGeneration !== this.planGeneration) {
        throw new Error("Preview descartado porque cambió el campo o sus parámetros");
      }
      if (response.ok === false) {
        throw new Error(String(response.error ?? "preview_coverage fue rechazado"));
      }
      // El mismo rectangulo que viajo en el pedido: en modo poligono es su caja
      // envolvente, y es el marco en el que el backend devolvio las coordenadas.
      const requestField = this.fieldForRequest(field);
      const preview = this.applyLocalNoGoClip(
        parseCoveragePreview(response, requestField, requestParameters),
        requestField,
        requestParameters
      );
      this.state = {
        ...this.state,
        loading: false,
        preview,
        error: "",
        lastStatus: preview.topologySafe && preview.metrics.omegaTurnCount === 0
          ? `Preview listo: ${preview.metrics.rowCount} pasadas, ${preview.keyWaypoints.length} metas key`
          : "Preview inseguro: corregí el campo antes de iniciar"
      };
      this.emit();
      return clonePreview(preview);
    } catch (error) {
      if (requestGeneration !== this.planGeneration) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.state = {
        ...this.state,
        loading: false,
        preview: null,
        error: message,
        lastStatus: "No se pudo generar el preview"
      };
      this.emit();
      throw error;
    }
  }

  /**
   * Repetir el recorte de zonas sobre lo que devolvio el backend.
   *
   * Si el backend ya recorto, esto es un no-op: el recorte es idempotente. Si no
   * lo hizo —`zones_manager` caido, push del GeoJSON fallado— el dibujo queda
   * bien igual y `nogoClippedLocally` marca la divergencia para que
   * `sendCoverageMission` bloquee el arranque.
   */
  private applyLocalNoGoClip(
    preview: CoveragePreview,
    field: CoverageFieldGeometry,
    parameters: CoverageParameters
  ): CoveragePreview {
    const origin = { lat: field.startLat, lon: field.startLon };
    const polygons = noGoPolygonsFromZones(this.zoneSource, origin);
    if (polygons.length === 0) return preview;

    // Margen local por defecto. Si el backend fue configurado distinto, el
    // recorte deja de ser idempotente y el resultado se marca para bloqueo.
    const marginM =
      0.5 * parameters.cutterWidthM +
      NOGO_EXTRA_MARGIN_M +
      NOGO_TURNING_MARGIN_RATIO * parameters.minTurningRadiusM;
    // Rectangulo del lote en los mismos metros locales que las zonas: sin esto,
    // una zona pegada al borde hace que el rodeo se dibuje fuera del lote.
    const corners = fieldPolygonFromGeometry(field).map((corner) => {
      const local = localMeters(origin, corner);
      return { x: local.east, y: local.north };
    });
    const bounds: NoGoBounds = {
      xMin: Math.min(...corners.map((c) => c.x)),
      xMax: Math.max(...corners.map((c) => c.x)),
      yMin: Math.min(...corners.map((c) => c.y)),
      yMax: Math.max(...corners.map((c) => c.y))
    };
    const fieldBoundary =
      this.state.fieldSource === "polygon"
        ? this.state.draft.outline.vertices.map((vertex) => {
            const local = localMeters(origin, vertex);
            return { x: local.east, y: local.north };
          })
        : corners;
    const sampled = clipWaypointsToZones(
      preview.sampledWaypoints, polygons, origin, marginM, bounds, fieldBoundary
    );
    const execution = clipWaypointsToZones(
      preview.executionWaypoints, polygons, origin, marginM, bounds, fieldBoundary
    );
    const keys = clipWaypointsToZones(
      preview.keyWaypoints, polygons, origin, marginM, bounds, fieldBoundary
    );
    // El contador del backend dice que vio *alguna* zona, no que vio las mismas
    // zonas ni que aplico el mismo margen. Si este segundo recorte cambia una
    // ruta que el backend marco como recortada, iniciar ejecutaria algo distinto
    // de lo dibujado. En ese caso se bloquea igual; con un recorte idempotente
    // bien aplicado los cuatro contadores son cero.
    const clippedLocally =
      sampled.dropped > 0 || sampled.detours > 0 ||
      execution.dropped > 0 || execution.detours > 0 ||
      keys.dropped > 0 || keys.detours > 0;
    return {
      ...preview,
      executionWaypoints: execution.waypoints,
      sampledWaypoints: sampled.waypoints,
      keyWaypoints: keys.waypoints,
      nogoClippedLocally: clippedLocally
    };
  }

  // ---------------------------------------------------------------------
  // Editor de poligono. Solo lo usa CAMPO; ruta, patrulla y goals no lo tocan.
  // ---------------------------------------------------------------------

  /**
   * Sembrar el poligono del lote apoyado en la pose del vehiculo.
   *
   * Es el atajo de siempre —un lote de un click, alineado con el vehiculo—
   * pero deja un poligono de 4 vertices editables en vez de la figura
   * rectangular legacy. Tener las dos representaciones vivas al mismo tiempo
   * confunde: el operador arma un cuadrado, dibuja encima un poligono, y
   * despues no sabe cual de los dos se va a trabajar. Con esto hay una sola.
   *
   * El cuadrado legacy sigue existiendo en el backend para las llamadas viejas;
   * lo que ya no hace es salir de este cockpit.
   */
  seedPolygonFromVehiclePose(
    pose: CoverageVehiclePose,
    options: { sideM?: number; side?: "left" | "right" } = {}
  ): CoverageState {
    // Se reusa la geometria del cuadrado en vez de repetir la trigonometria:
    // es la misma figura, cambia como se guarda.
    const previo = {
      draft: cloneDraft(this.state.draft),
      fieldSource: this.state.fieldSource
    };
    const conCuadrado = this.squareFromVehiclePose(pose, options);
    const esquinas = conCuadrado.fieldPolygon.map(clonePoint);
    // Octogono regular inscripto en el cuadrado, con el centro y el rumbo del
    // cuadrado. Es una figura fija: ocho vertices calculados de una vez, no
    // ocho puntos que el operador tenga que acomodar. Lo unico que se hace con
    // ella es moverla, girarla y agrandarla, siempre entera.
    const centro = ringCentre({ id: "square-centre", vertices: esquinas });
    if (!centro) {
      this.state = { ...this.state, ...previo };
      throw new Error("No se pudo calcular el centro del lote");
    }
    const radio = 0.5 * Number(
      options.sideM ?? this.state.field?.fieldLengthM ?? DEFAULT_SQUARE_SIDE_M
    ) / Math.cos(Math.PI / RIGID_FIELD_VERTICES);
    // El rumbo del vehiculo, para que la figura salga alineada con el como
    // salia el cuadrado.
    const rumbo = degreesToRadians(90 - pose.yawDeg);
    const vertices: CoverageGeoPoint[] = [];
    for (let index = 0; index < RIGID_FIELD_VERTICES; index += 1) {
      const angulo =
        rumbo + (Math.PI / RIGID_FIELD_VERTICES) + (2 * Math.PI * index) / RIGID_FIELD_VERTICES;
      vertices.push(
        offsetPoint(centro, radio * Math.cos(angulo), radio * Math.sin(angulo))
      );
    }
    if (vertices.length < MIN_RING_VERTICES) {
      this.state = { ...this.state, ...previo };
      throw new Error("No se pudo armar el lote desde la pose del vehículo");
    }
    this.planGeneration += 1;
    this.state = {
      ...this.state,
      // El cuadrado legacy se descarta: lo unico que queda es el poligono.
      field: null,
      fieldPolygon: [],
      vehicleAnchor: null,
      fieldSource: "polygon",
      draft: {
        mode: "idle",
        outline: { id: newRingId(), vertices },
        exclusions: [],
        activeExclusionId: null,
        rigid: true
      },
      preview: null,
      error: "",
      lastStatus:
        "Lote armado desde el vehículo: arrastralo para moverlo, un vértice para agrandarlo"
    };
    this.emit();
    return this.getState();
  }

  /**
   * Tamano actual del lote dibujado, en metros. Derivado del anillo.
   */
  draftOutlineSizeM(): number {
    return ringSizeM(this.state.draft.outline);
  }

  /**
   * Agrandar o achicar el lote entero, sin tocar los vertices de a uno.
   *
   * El poligono sembrado casi nunca sale del tamano justo, y corregirlo
   * arrastrando ocho tiradores deforma la figura: cada tiron cambia la forma
   * ademas del tamano. Esto escala respecto del centro, asi que la figura es la
   * misma y solo cambia cuanto abarca.
   *
   * Las exclusiones no se escalan: marcan cosas que estan en el terreno y no se
   * mueven porque el lote crezca.
   */
  scaleDraftOutline(factor: number): void {
    const escala = Number(factor);
    if (!Number.isFinite(escala) || escala <= 0) {
      throw new Error("La escala del lote tiene que ser un número mayor que cero");
    }
    const outline = this.state.draft.outline;
    if (outline.vertices.length < MIN_RING_VERTICES) {
      throw new Error("Todavía no hay un polígono para agrandar");
    }
    const destino = ringSizeM(outline) * escala;
    if (destino < MIN_FIELD_EDGE_M) {
      throw new Error(`El lote no puede achicarse a menos de ${MIN_FIELD_EDGE_M.toFixed(1)} m`);
    }
    if (destino > MAX_FIELD_EDGE_M) {
      throw new Error(`El lote no puede pasar de ${MAX_FIELD_EDGE_M.toFixed(0)} m de lado`);
    }
    const draft = cloneDraft(this.state.draft);
    draft.outline = scaleRing(outline, escala);
    this.setDraft(draft, "polygon");
  }

  /**
   * Escalar el lote llevando uno de sus vertices hasta `point`.
   *
   * Es el gesto que el operador ya hace: agarra un tirador y tira. Sobre la
   * figura rigida eso agranda o achica todo, en vez de mover ese vertice solo y
   * deformarla.
   */
  scaleDraftOutlineToVertex(index: number, point: CoverageGeoPoint): void {
    const outline = this.state.draft.outline;
    const centre = ringCentre(outline);
    const vertex = outline.vertices[index];
    if (!centre || !vertex) {
      throw new Error("Ese vértice ya no existe");
    }
    const actual = localMeters(centre, vertex);
    const pedido = localMeters(centre, point);
    const radioActual = Math.hypot(actual.east, actual.north);
    if (radioActual <= 0) {
      throw new Error("No se puede escalar desde el centro del lote");
    }
    this.scaleDraftOutline(Math.hypot(pedido.east, pedido.north) / radioActual);
  }

  /** Llevar el lado mayor del lote a `targetM`, conservando la forma. */
  resizeDraftOutline(targetM: number): void {
    const destino = Number(targetM);
    if (!Number.isFinite(destino) || destino <= 0) {
      throw new Error("El tamaño del lote tiene que ser un número mayor que cero");
    }
    const actual = ringSizeM(this.state.draft.outline);
    if (actual <= 0) {
      throw new Error("Todavía no hay un polígono para redimensionar");
    }
    this.scaleDraftOutline(destino / actual);
  }

  /**
   * Correr el lote entero, con sus exclusiones.
   *
   * Las exclusiones acompanan: se dibujaron relativas al lote, y si el lote se
   * reubica es porque estaba en el lugar equivocado, no porque el operador
   * quiera separarlo de sus exclusiones.
   */
  moveDraftOutline(deltaLat: number, deltaLon: number): void {
    if (!Number.isFinite(deltaLat) || !Number.isFinite(deltaLon)) {
      throw new Error("El desplazamiento del lote no es un número");
    }
    if (this.state.draft.outline.vertices.length === 0) {
      throw new Error("Todavía no hay un polígono para mover");
    }
    const draft = cloneDraft(this.state.draft);
    draft.outline = translateRing(draft.outline, deltaLat, deltaLon);
    draft.exclusions = draft.exclusions.map((ring) =>
      translateRing(ring, deltaLat, deltaLon)
    );
    this.setDraft(draft, "polygon");
  }

  /** Girar el lote entero alrededor de su centro, en grados antihorarios. */
  rotateDraftOutline(deltaDeg: number): void {
    const giro = Number(deltaDeg);
    if (!Number.isFinite(giro)) {
      throw new Error("El giro del lote no es un número");
    }
    const centre = ringCentre(this.state.draft.outline);
    if (!centre) {
      throw new Error("Todavía no hay un polígono para girar");
    }
    const draft = cloneDraft(this.state.draft);
    draft.outline = rotateRing(draft.outline, centre, giro);
    draft.exclusions = draft.exclusions.map((ring) => rotateRing(ring, centre, giro));
    this.setDraft(draft, "polygon");
  }

  /** Empezar a dibujar el contorno del lote, descartando el borrador previo. */
  startOutlineDraft(): void {
    this.setDraft({ ...emptyDraft(), mode: "outline" }, "polygon");
    this.invalidatePreview("Dibujá el contorno del lote");
  }

  /** Abrir una exclusion nueva y mandarle los clicks siguientes. */
  startExclusionDraft(): void {
    const draft = cloneDraft(this.state.draft);
    if (draft.outline.vertices.length < MIN_RING_VERTICES) {
      throw new Error("Primero cerrá el contorno del lote");
    }
    const ring: CoverageRing = { id: newRingId(), vertices: [] };
    draft.exclusions = [...draft.exclusions, ring];
    draft.activeExclusionId = ring.id;
    draft.mode = "exclusion";
    this.setDraft(draft, "polygon");
  }

  /**
   * Frenar cualquier edicion por vertices sobre una figura rigida.
   *
   * Solo el contorno: las exclusiones se dibujan a mano igual, esten sobre la
   * figura rigida o sobre un lote dibujado.
   */
  private assertContornoEditable(ringId: string | null): void {
    if (ringId === null && this.state.draft.rigid) {
      throw new Error(
        "El lote del vehículo se mueve, gira y se agranda entero. " +
          "Para editar vértices sueltos, dibujalo a mano con DIBUJAR LOTE"
      );
    }
  }

  /** Agregar un vertice al anillo que este activo. */
  appendDraftVertex(point: CoverageGeoPoint): void {
    const draft = cloneDraft(this.state.draft);
    if (draft.mode === "idle") return;
    if (draft.mode === "outline") this.assertContornoEditable(null);
    const vertex = clonePoint(point);
    if (draft.mode === "outline") {
      draft.outline.vertices = [...draft.outline.vertices, vertex];
    } else {
      draft.exclusions = draft.exclusions.map((ring) =>
        ring.id === draft.activeExclusionId
          ? { ...ring, vertices: [...ring.vertices, vertex] }
          : ring
      );
    }
    this.setDraft(draft, "polygon");
  }

  /** Mover un vertice ya puesto. `ringId` null es el contorno. */
  moveDraftVertex(ringId: string | null, index: number, point: CoverageGeoPoint): void {
    this.assertContornoEditable(ringId);
    const draft = cloneDraft(this.state.draft);
    const mover = (ring: CoverageRing): CoverageRing => ({
      ...ring,
      vertices: ring.vertices.map((vertex, position) =>
        position === index ? clonePoint(point) : vertex
      )
    });
    if (ringId === null) {
      draft.outline = mover(draft.outline);
    } else {
      draft.exclusions = draft.exclusions.map((ring) =>
        ring.id === ringId ? mover(ring) : ring
      );
    }
    this.setDraft(draft, "polygon");
  }

  /** Sacar un vertice. `ringId` null es el contorno. */
  removeDraftVertex(ringId: string | null, index: number): void {
    this.assertContornoEditable(ringId);
    const draft = cloneDraft(this.state.draft);
    const sacar = (ring: CoverageRing): CoverageRing => ({
      ...ring,
      vertices: ring.vertices.filter((_, position) => position !== index)
    });
    if (ringId === null) {
      draft.outline = sacar(draft.outline);
    } else {
      draft.exclusions = draft.exclusions.map((ring) =>
        ring.id === ringId ? sacar(ring) : ring
      );
    }
    this.setDraft(draft, "polygon");
  }

  /** Borrar una exclusion entera. */
  removeExclusion(ringId: string): void {
    const draft = cloneDraft(this.state.draft);
    draft.exclusions = draft.exclusions.filter((ring) => ring.id !== ringId);
    if (draft.activeExclusionId === ringId) {
      draft.activeExclusionId = null;
      draft.mode = "idle";
    }
    this.setDraft(draft, "polygon");
  }

  /** Cerrar el anillo activo y dejar de recibir clicks. */
  finishDraftRing(): void {
    const draft = cloneDraft(this.state.draft);
    draft.mode = "idle";
    draft.activeExclusionId = null;
    this.setDraft(draft, "polygon");
  }

  /** Tirar el poligono y volver al lote rectangular. */
  clearDraft(): void {
    this.setDraft(emptyDraft(), "rectangle");
    this.invalidatePreview("Se borró el polígono del lote");
  }

  private setDraft(draft: CoverageDraft, source: CoverageFieldSource): void {
    this.planGeneration += 1;
    this.state = {
      ...this.state,
      draft,
      fieldSource: source,
      // El preview deja de corresponder al lote apenas se mueve un vertice.
      preview: null
    };
    this.emit();
  }

  /**
   * El borrador que hay que mandar, o undefined en modo rectangulo.
   *
   * Derivado de `fieldSource`, no un campo aparte: si el operador vuelve al
   * rectangulo, el poligono queda en el estado pero no viaja.
   */
  /**
   * El rectangulo que viaja en el pedido.
   *
   * Con poligono sale de su caja envolvente; el `field` del cuadrado legacy
   * puede no existir. Derivado, no guardado: si se mueve un vertice, la caja
   * se recalcula sola.
   */
  private fieldForRequest(field: CoverageFieldGeometry | null): CoverageFieldGeometry {
    if (this.state.fieldSource === "polygon") {
      const derivado = fieldGeometryFromRing(
        this.state.draft.outline,
        field?.side ?? "left"
      );
      if (derivado) return derivado;
    }
    if (!field) {
      throw new Error("No hay lote definido para planificar");
    }
    return field;
  }

  private draftForRequest(): CoverageDraft | undefined {
    return this.state.fieldSource === "polygon"
      ? cloneDraft(this.state.draft)
      : undefined;
  }

  /** Si el lote definido alcanza para pedir un preview. Derivado. */
  canPreview(): boolean {
    if (this.state.loading || this.state.sending) return false;
    if (this.state.fieldSource === "polygon") {
      return isCoverageDraftPlannable(this.state.draft);
    }
    return this.state.field !== null && this.state.fieldPolygon.length === 4;
  }

  canStartMission(): boolean {
    const preview = this.state.preview;
    // Con poligono el cuadrado legacy no existe, asi que la condicion del lote
    // depende de con que se planifico.
    const loteListo =
      this.state.fieldSource === "polygon"
        ? isCoverageDraftPlannable(this.state.draft)
        : this.state.field !== null && this.state.fieldPolygon.length === 4;
    return Boolean(
      preview &&
      loteListo &&
      !this.state.loading &&
      !this.state.sending &&
      preview.topologySafe &&
      !preview.nogoClippedLocally &&
      preview.executionWaypoints.length >= 2 &&
      preview.executionWaypoints.length <= MAX_COVERAGE_ROUTE_WAYPOINTS &&
      preview.keyWaypoints.length >= 2 &&
      preview.keyWaypoints.length <= MAX_COVERAGE_ROUTE_WAYPOINTS
    );
  }

  async sendCoverageMission(): Promise<CoverageMissionResult> {
    const preview = this.state.preview;
    const field = this.state.field;
    if (!preview) {
      throw new Error("Generá un preview antes de iniciar");
    }
    if (this.state.fieldSource === "polygon") {
      if (!isCoverageDraftPlannable(this.state.draft)) {
        throw new Error(
          "El polígono del lote necesita al menos 3 vértices, y cada exclusión también"
        );
      }
    } else if (!field || this.state.fieldPolygon.length !== 4) {
      throw new Error("El campo del preview ya no está disponible; regeneralo");
    }
    if (!preview.topologySafe) {
      throw new Error(preview.topologyError || "La topología de cobertura no es segura");
    }
    // El backend replanifica al iniciar: si el no recorto, la ruta que se va a
    // ejecutar atraviesa la zona aunque el dibujo la esquive. Antes que correr
    // algo distinto a lo que se ve, no se arranca.
    if (preview.nogoClippedLocally) {
      throw new Error(
        preview.nogoNote
          ? `El recorte no-go del backend difiere del preview (${preview.nogoNote}); revisá zones_manager y sus márgenes`
          : "El recorte no-go del backend difiere del preview; revisá zones_manager y sus márgenes"
      );
    }
    if (preview.executionWaypoints.length > MAX_COVERAGE_ROUTE_WAYPOINTS) {
      throw new Error(
        `La ruta ejecutable tiene ${preview.executionWaypoints.length} puntos; el máximo seguro es ${MAX_COVERAGE_ROUTE_WAYPOINTS}`
      );
    }
    if (preview.executionWaypoints.length < 2) {
      throw new Error("La cobertura necesita al menos dos puntos ejecutables");
    }
    if (preview.keyWaypoints.length > MAX_COVERAGE_ROUTE_WAYPOINTS) {
      throw new Error(
        `La cobertura tiene ${preview.keyWaypoints.length} metas; el máximo seguro es ${MAX_COVERAGE_ROUTE_WAYPOINTS}`
      );
    }
    if (preview.keyWaypoints.length < 2) {
      throw new Error("La cobertura necesita al menos dos waypoints key");
    }
    if (this.state.sending) {
      throw new Error("La cobertura ya se está enviando");
    }
    const requestParameters = { ...this.state.parameters };
    validateParameters(requestParameters, this.plannerMinTurningRadiusM());
    const navigationState = this.navigationService?.getState();
    if (navigationState?.controlLocked) {
      throw new Error(`Controls are locked (${navigationState.controlLockReason || "locked"})`);
    }
    this.state = {
      ...this.state,
      sending: true,
      error: "",
      lastStatus: "Revalidando e iniciando cobertura en el backend..."
    };
    const requestGeneration = this.planGeneration;
    this.emit();
    try {
      if (navigationState?.manualMode) {
        await this.navigationService?.setManualMode(false);
      }
      if (requestGeneration !== this.planGeneration) {
        throw new Error("El campo cambió antes de enviar la cobertura");
      }
      let response: Nav2IncomingMessage;
      try {
        response = await this.robotDispatcher.requestStartCoverage(
          coverageRequestPayload(
            this.fieldForRequest(field), requestParameters, this.draftForRequest()
          )
        );
      } catch (requestError) {
        const requestMessage = requestError instanceof Error ? requestError.message : String(requestError);
        throw new Error(
          "Estado de envío incierto: no reintentar a ciegas; consultá o cancelá la ruta" +
          (requestMessage ? ` (${requestMessage})` : "")
        );
      }
      if (requestGeneration !== this.planGeneration) {
        throw new Error("La respuesta de misión pertenece a un campo reemplazado");
      }
      const submissionState = String(response.route_submission_state ?? "").trim();
      const backendError = String(response.error ?? "").trim();
      if (
        response.ok !== true ||
        response.route_started !== true ||
        submissionState !== "started"
      ) {
        if (submissionState === "unknown_timeout" || response.route_started === null) {
          throw new Error(
            "Estado de envío incierto: no reintentar a ciegas; consultá o cancelá la ruta" +
            (backendError ? ` (${backendError})` : "")
          );
        }
        throw new Error(backendError || "start_coverage rechazó la cobertura antes de iniciar");
      }
      const inputCount = nonNegativeInteger(
        response.input_key_waypoint_count,
        preview.keyWaypoints.length
      );
      const expandedCount = nonNegativeInteger(response.expanded_waypoint_count, inputCount);
      this.state = {
        ...this.state,
        sending: false,
        error: "",
        lastStatus: `Cobertura iniciada: ${inputCount} metas key`
      };
      this.emit();
      return {
        inputCount,
        expandedCount,
        legSpacingM: preview.legSpacingM
      };
    } catch (error) {
      if (requestGeneration !== this.planGeneration) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      const submissionUncertain = message.startsWith("Estado de envío incierto:");
      this.state = {
        ...this.state,
        sending: false,
        error: message,
        lastStatus: submissionUncertain
          ? "Estado de envío incierto; consultá o cancelá la ruta antes de cualquier reintento"
          : "No se pudo iniciar la cobertura"
      };
      this.emit();
      throw error;
    }
  }

  private emit(): void {
    const state = this.getState();
    this.listeners.forEach((listener) => listener(state));
  }
}
