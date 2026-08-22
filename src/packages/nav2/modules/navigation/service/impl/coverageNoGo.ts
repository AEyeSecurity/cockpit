/**
 * Recorte del trazado de cobertura contra las zonas no-go.
 *
 * Es el espejo de `coverage_nogo.py`: misma geometria, mismo orden de
 * operaciones y mismos resultados sobre el fixture compartido. Existe porque el
 * recorte del backend depende de que `zones_manager` este corriendo y de que el
 * push del GeoJSON haya llegado; si algo de eso falla, el backend planifica sin
 * zonas y el dibujo mentiria. Con las dos mitades, el operador ve el recorte
 * aunque el backend no lo haya hecho, y la guarda de divergencia le avisa que la
 * ruta que se va a ejecutar no es la que esta viendo.
 *
 * El recorte es idempotente, asi que correrlo sobre un trazado que el backend ya
 * recorto no lo cambia. Eso es lo que permite tenerlo por duplicado.
 *
 * Todo trabaja en metros locales planos: quien llama proyecta lat/lon a un
 * origen comun antes de entrar aca. La geometria no necesita saber de latitudes.
 */

/** Punto en metros locales. Con ENU, `x` es este e `y` es norte. */
export interface NoGoPoint {
  x: number;
  y: number;
}

export type NoGoPolygon = NoGoPoint[];

/** Rectangulo del lote en metros locales; permite reconocer zonas de borde. */
export interface NoGoBounds {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

/** Fase con la que se marcan los puntos que agrega un rodeo. */
export const NOGO_DETOUR_PHASE = "nogo_detour";

/**
 * Tope de pasadas de rodeo. Un rodeo puede meter la ruta dentro de otra zona,
 * asi que hay que reprocesar; el tope evita el ciclo cuando dos zonas se
 * encierran mutuamente.
 */
const MAX_DETOUR_PASSES = 8;

/**
 * Una esquina muy filosa manda el vertice inflado infinitamente lejos. Se corta
 * a este multiplo del margen: deforma la esquina pero no dispara una punta.
 */
const MAX_MITER_RATIO = 4.0;

const EPSILON_M = 1.0e-9;

/**
 * Holgura al chequear si un punto del rodeo cae dentro del lote. Las cabeceras
 * ya sobresalen por diseno, asi que un rodeo que roza el borde no es el problema
 * que se busca evitar: lo que no puede pasar es que salga metros afuera.
 */
const BOUNDS_TOLERANCE_M = 0.5;

/** Separacion que vuelve inequivocamente exterior un arco tangente al lote. */
const EDGE_EXIT_CLEARANCE_M = 0.75;

/**
 * Tolerancia para decidir si un punto cae sobre el contorno. Es mas floja que
 * `EPSILON_M` a proposito: los puntos del rodeo salen de una interseccion de
 * segmentos y caen sobre el borde con el error de esa cuenta, no exactamente
 * encima.
 */
const ON_EDGE_TOLERANCE_M = 1.0e-6;

/** Area con signo del poligono; positiva si los vertices van antihorarios. */
export function polygonSignedArea(polygon: NoGoPolygon): number {
  let total = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const following = polygon[(index + 1) % polygon.length];
    total += current.x * following.y - following.x * current.y;
  }
  return total / 2;
}

/** Decir si el punto cae sobre el segmento, dentro de la tolerancia de borde. */
function pointOnEdge(point: NoGoPoint, start: NoGoPoint, end: NoGoPoint): boolean {
  const edgeX = end.x - start.x;
  const edgeY = end.y - start.y;
  const length = Math.hypot(edgeX, edgeY);
  if (length <= EPSILON_M) {
    return Math.hypot(point.x - start.x, point.y - start.y) <= ON_EDGE_TOLERANCE_M;
  }
  const cross = edgeX * (point.y - start.y) - edgeY * (point.x - start.x);
  if (Math.abs(cross) > ON_EDGE_TOLERANCE_M * length) return false;
  const dot = (point.x - start.x) * edgeX + (point.y - start.y) * edgeY;
  const tolerance = ON_EDGE_TOLERANCE_M * length;
  return dot >= -tolerance && dot <= length * length + tolerance;
}

/**
 * Devolver true si el punto cae dentro del poligono (ray casting).
 *
 * Un punto justo sobre el borde cuenta como adentro: el poligono ya viene
 * inflado por el margen de seguridad, asi que dudar hacia adentro es lo
 * conservador.
 */
export function pointInPolygon(point: NoGoPoint, polygon: NoGoPolygon): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let index = 0; index < polygon.length; index += 1) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    if (pointOnEdge(point, a, b)) return true;
    if (a.y > point.y !== b.y > point.y) {
      const crossingX = a.x + ((point.y - a.y) / (b.y - a.y)) * (b.x - a.x);
      if (crossingX > point.x) inside = !inside;
    }
  }
  return inside;
}

/**
 * Adentro del poligono y sin tocar el contorno.
 *
 * Distingue un tramo que atraviesa la zona de uno que corre pegado a un lado. El
 * segundo no tiene nada que rodear: si se lo tratara como cruce, el rodeo se
 * volveria a insertar en cada pasada y la ruta creceria sola.
 */
export function strictlyInside(point: NoGoPoint, polygon: NoGoPolygon): boolean {
  if (!pointInPolygon(point, polygon)) return false;
  for (let index = 0; index < polygon.length; index += 1) {
    if (pointOnEdge(point, polygon[index], polygon[(index + 1) % polygon.length])) {
      return false;
    }
  }
  return true;
}

/** Normal unitaria que apunta hacia afuera del poligono para ese lado. */
function outwardNormal(start: NoGoPoint, end: NoGoPoint, orientation: number): NoGoPoint {
  const edgeX = end.x - start.x;
  const edgeY = end.y - start.y;
  const length = Math.hypot(edgeX, edgeY);
  if (length <= EPSILON_M) return { x: 0, y: 0 };
  return { x: (edgeY / length) * orientation, y: (-edgeX / length) * orientation };
}

/**
 * Correr cada vertice hacia afuera para dejar un margen de seguridad.
 *
 * El margen sale del ancho de corte: si la ruta pasara pegada al borde de la
 * zona, el implemento igual la pisaria.
 */
export function inflatePolygon(polygon: NoGoPolygon, marginM: number): NoGoPolygon {
  if (polygon.length < 3 || marginM <= 0) {
    return polygon.map((vertex) => ({ x: vertex.x, y: vertex.y }));
  }
  // Con vertices horarios las normales salen al reves; el signo del area lo
  // corrige sin tener que reordenar el poligono.
  const orientation = polygonSignedArea(polygon) >= 0 ? 1 : -1;
  const inflated: NoGoPolygon = [];
  for (let index = 0; index < polygon.length; index += 1) {
    const previous = polygon[(index - 1 + polygon.length) % polygon.length];
    const current = polygon[index];
    const following = polygon[(index + 1) % polygon.length];

    const incoming = outwardNormal(previous, current, orientation);
    const outgoing = outwardNormal(current, following, orientation);
    let bisectorX = incoming.x + outgoing.x;
    let bisectorY = incoming.y + outgoing.y;
    const bisectorLength = Math.hypot(bisectorX, bisectorY);
    if (bisectorLength <= EPSILON_M) {
      // Vertice que se dobla sobre si mismo: no hay hacia donde inflar.
      inflated.push({ x: current.x, y: current.y });
      continue;
    }
    bisectorX /= bisectorLength;
    bisectorY /= bisectorLength;

    const cosine = bisectorX * incoming.x + bisectorY * incoming.y;
    const rawScale = cosine > EPSILON_M ? marginM / cosine : marginM * MAX_MITER_RATIO;
    const scale = Math.min(rawScale, marginM * MAX_MITER_RATIO);
    inflated.push({ x: current.x + bisectorX * scale, y: current.y + bisectorY * scale });
  }
  return inflated;
}

/**
 * Cruce de dos segmentos; devuelve el parametro sobre el primero y el punto.
 *
 * Los casos paralelos y colineales devuelven null a proposito: si el segmento
 * corre pegado a un lado de la zona no hay nada que rodear, y la contencion de
 * los extremos ya la resolvio `pointInPolygon`.
 */
function segmentIntersection(
  firstStart: NoGoPoint,
  firstEnd: NoGoPoint,
  secondStart: NoGoPoint,
  secondEnd: NoGoPoint
): { t: number; point: NoGoPoint } | null {
  const firstDx = firstEnd.x - firstStart.x;
  const firstDy = firstEnd.y - firstStart.y;
  const secondDx = secondEnd.x - secondStart.x;
  const secondDy = secondEnd.y - secondStart.y;

  const denominator = firstDx * secondDy - firstDy * secondDx;
  if (Math.abs(denominator) <= EPSILON_M) return null;

  const offsetX = secondStart.x - firstStart.x;
  const offsetY = secondStart.y - firstStart.y;
  const firstT = (offsetX * secondDy - offsetY * secondDx) / denominator;
  const secondT = (offsetX * firstDy - offsetY * firstDx) / denominator;
  if (firstT < 0 || firstT > 1 || secondT < 0 || secondT > 1) return null;
  return {
    t: firstT,
    point: { x: firstStart.x + firstDx * firstT, y: firstStart.y + firstDy * firstT }
  };
}

/** Cortes del segmento con el contorno, ordenados desde `start`. */
export function segmentPolygonIntersections(
  start: NoGoPoint,
  end: NoGoPoint,
  polygon: NoGoPolygon
): Array<{ t: number; point: NoGoPoint; edge: number }> {
  const crossings: Array<{ t: number; point: NoGoPoint; edge: number }> = [];
  for (let index = 0; index < polygon.length; index += 1) {
    const hit = segmentIntersection(
      start,
      end,
      polygon[index],
      polygon[(index + 1) % polygon.length]
    );
    if (hit) crossings.push({ t: hit.t, point: hit.point, edge: index });
  }
  crossings.sort((left, right) => left.t - right.t);
  return crossings;
}

function effectiveFieldPolygon(
  bounds?: NoGoBounds,
  fieldBoundary?: NoGoPolygon
): NoGoPolygon | undefined {
  if (fieldBoundary && fieldBoundary.length >= 3) {
    return fieldBoundary.map((point) => ({ ...point }));
  }
  if (!bounds) return undefined;
  return [
    { x: bounds.xMin, y: bounds.yMin },
    { x: bounds.xMax, y: bounds.yMin },
    { x: bounds.xMax, y: bounds.yMax },
    { x: bounds.xMin, y: bounds.yMax }
  ];
}

/**
 * Una exclusion es interna solo si vertices y lados quedan estrictamente
 * dentro del lote. Tocar el contorno la convierte en zona de borde y habilita
 * el rodeo exterior.
 */
export function polygonIsStrictlyInsideField(
  polygon: NoGoPolygon,
  bounds?: NoGoBounds,
  fieldBoundary?: NoGoPolygon
): boolean {
  const field = effectiveFieldPolygon(bounds, fieldBoundary);
  if (!field || polygon.length < 3) return false;
  if (!polygon.every((point) => strictlyInside(point, field))) return false;

  for (let index = 0; index < polygon.length; index += 1) {
    const start = polygon[index];
    const end = polygon[(index + 1) % polygon.length];
    const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
    if (!strictlyInside(midpoint, field)) return false;
    for (let fieldIndex = 0; fieldIndex < field.length; fieldIndex += 1) {
      const fieldStart = field[fieldIndex];
      const fieldEnd = field[(fieldIndex + 1) % field.length];
      if (segmentIntersection(start, end, fieldStart, fieldEnd)) return false;
      if (
        pointOnEdge(start, fieldStart, fieldEnd) ||
        pointOnEdge(end, fieldStart, fieldEnd) ||
        pointOnEdge(fieldStart, start, end) ||
        pointOnEdge(fieldEnd, start, end)
      ) return false;
    }
  }
  return true;
}

/** Vertices que se recorren yendo de un lado al otro por el contorno. */
function contourWalk(
  entryEdge: number,
  exitEdge: number,
  polygon: NoGoPolygon,
  forward: boolean
): NoGoPoint[] {
  const count = polygon.length;
  const vertices: NoGoPoint[] = [];
  const wrap = (value: number): number => ((value % count) + count) % count;
  let index = forward ? wrap(entryEdge + 1) : wrap(entryEdge);
  const target = forward ? wrap(exitEdge) : wrap(exitEdge + 1);
  for (;;) {
    vertices.push({ x: polygon[index].x, y: polygon[index].y });
    if (index === target) break;
    index = forward ? wrap(index + 1) : wrap(index - 1);
    if (vertices.length > count) break;
  }
  return vertices;
}

/** Largo de la poligonal que une los puntos en orden. */
function pathLength(points: NoGoPoint[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += Math.hypot(
      points[index].x - points[index - 1].x,
      points[index].y - points[index - 1].y
    );
  }
  return total;
}

/**
 * Camino que bordea la zona en vez de atravesarla.
 *
 * Devuelve los puntos intermedios que hay que meter entre `start` y `end`. Se
 * prueban los dos sentidos del perimetro. Para una zona interna gana el mas
 * corto que queda dentro del lote; si la exclusion toca el borde, gana el arco
 * exterior, que sale temporalmente del contorno y vuelve a entrar.
 */
export function detourAlongContour(
  start: NoGoPoint,
  end: NoGoPoint,
  polygon: NoGoPolygon,
  bounds?: NoGoBounds,
  fieldBoundary?: NoGoPolygon
): NoGoPoint[] {
  const crossings = segmentPolygonIntersections(start, end, polygon);
  if (crossings.length < 2) {
    // Un solo corte significa que una punta esta adentro; eso lo resuelve el
    // descarte previo de waypoints, no el rodeo.
    return [];
  }
  const entry = crossings[0];
  const exit = crossings[crossings.length - 1];
  if (exit.t <= entry.t) return [];

  // El tramo puede estar corriendo pegado a un lado en vez de atravesar la zona;
  // ahi no hay nada que rodear.
  const midpoint = {
    x: (entry.point.x + exit.point.x) / 2,
    y: (entry.point.y + exit.point.y) / 2
  };
  if (!strictlyInside(midpoint, polygon)) return [];

  const candidates = [
    [entry.point, ...contourWalk(entry.edge, exit.edge, polygon, true), exit.point],
    [entry.point, ...contourWalk(entry.edge, exit.edge, polygon, false), exit.point]
  ];
  const inside = candidates.filter((path) => withinBounds(path, bounds, fieldBoundary));
  const boundaryZone = !polygonIsStrictlyInsideField(polygon, bounds, fieldBoundary);
  if (boundaryZone && (bounds || fieldBoundary)) {
    const outside = candidates.filter(
      (path) => !pathStrictlyInsideField(path, bounds, fieldBoundary)
    );
    const selected = (outside.length > 0 ? outside : candidates)
      .reduce((a, b) => (pathLength(a) <= pathLength(b) ? a : b));
    return shiftDetourOutsideField(selected, bounds, fieldBoundary);
  }
  const elegibles = inside.length > 0 ? inside : candidates;
  return elegibles.reduce((a, b) => (pathLength(a) <= pathLength(b) ? a : b));
}

/** Decir si todos los puntos caen dentro del rectangulo del lote. */
function withinBounds(
  points: NoGoPoint[],
  bounds?: NoGoBounds,
  fieldBoundary?: NoGoPolygon
): boolean {
  if (bounds && !points.every(
    (p) =>
      p.x >= bounds.xMin - BOUNDS_TOLERANCE_M &&
      p.x <= bounds.xMax + BOUNDS_TOLERANCE_M &&
      p.y >= bounds.yMin - BOUNDS_TOLERANCE_M &&
      p.y <= bounds.yMax + BOUNDS_TOLERANCE_M
  )) return false;
  return !fieldBoundary || points.every((point) => pointInPolygon(point, fieldBoundary));
}

function pointSegmentDistance(
  point: NoGoPoint,
  start: NoGoPoint,
  end: NoGoPoint
): number {
  const edgeX = end.x - start.x;
  const edgeY = end.y - start.y;
  const lengthSq = edgeX * edgeX + edgeY * edgeY;
  if (lengthSq <= EPSILON_M) return Math.hypot(point.x - start.x, point.y - start.y);
  const rawT = ((point.x - start.x) * edgeX + (point.y - start.y) * edgeY) / lengthSq;
  const t = Math.max(0, Math.min(1, rawT));
  return Math.hypot(point.x - (start.x + t * edgeX), point.y - (start.y + t * edgeY));
}

function pathStrictlyInsideField(
  points: NoGoPoint[],
  bounds?: NoGoBounds,
  fieldBoundary?: NoGoPolygon
): boolean {
  const field = effectiveFieldPolygon(bounds, fieldBoundary);
  return Boolean(field) && points.every((point) => strictlyInside(point, field!));
}

/** Correr el tramo intermedio hacia el exterior mas cercano del lote. */
function shiftDetourOutsideField(
  path: NoGoPoint[],
  bounds?: NoGoBounds,
  fieldBoundary?: NoGoPolygon
): NoGoPoint[] {
  const field = effectiveFieldPolygon(bounds, fieldBoundary);
  if (!field || path.length <= 2) return path.map((point) => ({ ...point }));
  const middle = path.slice(1, -1);
  const orientation = polygonSignedArea(field) >= 0 ? 1 : -1;
  let nearest: { distance: number; normal: NoGoPoint } | null = null;
  for (let index = 0; index < field.length; index += 1) {
    const start = field[index];
    const end = field[(index + 1) % field.length];
    const distance = Math.min(...middle.map((point) => pointSegmentDistance(point, start, end)));
    const normal = outwardNormal(start, end, orientation);
    if (!nearest || distance < nearest.distance) nearest = { distance, normal };
  }
  if (!nearest) return path.map((point) => ({ ...point }));
  return [
    { ...path[0] },
    ...middle.map((point) => ({
      x: point.x + EDGE_EXIT_CLEARANCE_M * nearest!.normal.x,
      y: point.y + EDGE_EXIT_CLEARANCE_M * nearest!.normal.y
    })),
    { ...path[path.length - 1] }
  ];
}

/** Rumbo del tramo en grados; 0 hacia +x, 90 hacia +y. */
function headingDeg(start: NoGoPoint, end: NoGoPoint, fallbackDeg: number): number {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  if (Math.hypot(deltaX, deltaY) <= EPSILON_M) return fallbackDeg;
  return (Math.atan2(deltaY, deltaX) * 180) / Math.PI;
}

/** Rodeo de la primera zona que corta el tramo, yendo desde `start`. */
function shortestDetour(
  start: NoGoPoint,
  end: NoGoPoint,
  polygons: NoGoPolygon[],
  bounds?: NoGoBounds,
  fieldBoundary?: NoGoPolygon
): NoGoPoint[] {
  let best: { entryT: number; detour: NoGoPoint[] } | null = null;
  for (const polygon of polygons) {
    const crossings = segmentPolygonIntersections(start, end, polygon);
    if (crossings.length < 2) continue;
    const detour = detourAlongContour(start, end, polygon, bounds, fieldBoundary);
    if (detour.length === 0) continue;
    if (!best || crossings[0].t < best.entryT) best = { entryT: crossings[0].t, detour };
  }
  return best ? best.detour : [];
}

export interface NoGoClipOptions<T> {
  /** Margen de seguridad, normalmente medio ancho de corte mas un colchon. */
  marginM: number;
  /** Posicion del elemento en metros locales. */
  positionOf: (item: T) => NoGoPoint;
  /** Rumbo actual del elemento, para cuando el tramo del rodeo es degenerado. */
  headingOf: (item: T) => number;
  /** Construir un punto de rodeo clonando el destino del tramo. */
  makeDetour: (point: NoGoPoint, headingDeg: number, target: T) => T;
  /** Rectangulo del lote; el rodeo no puede salirse de ahi. */
  bounds?: NoGoBounds;
  /** Contorno real para lotes concavos; la caja envolvente no alcanza. */
  fieldBoundary?: NoGoPolygon;
}

export interface NoGoClipResult<T> {
  items: T[];
  dropped: number;
  detours: number;
}

/**
 * Sacar del trazado lo que cae en una zona y bordear lo que la cruza.
 *
 * Lanza si no quedan al menos dos puntos: una zona que tapa el lote entero es un
 * error que el operador tiene que ver, no una ruta vacia.
 */
export function clipPathToNoGo<T>(
  items: T[],
  polygons: NoGoPolygon[],
  options: NoGoClipOptions<T>
): NoGoClipResult<T> {
  if (polygons.length === 0) return { items: [...items], dropped: 0, detours: 0 };

  const inflated = polygons
    .map((polygon) => inflatePolygon(polygon, options.marginM))
    .filter((polygon) => polygon.length >= 3);
  if (inflated.length === 0) return { items: [...items], dropped: 0, detours: 0 };

  const kept: T[] = [];
  let dropped = 0;
  for (const item of items) {
    const position = options.positionOf(item);
    // `strictlyInside` y no `pointInPolygon`: el contorno inflado es justamente
    // la linea segura por donde se puede circular, asi que los puntos que un
    // rodeo dejo apoyados ahi tienen que sobrevivir. Si no, esta pasada borraria
    // el rodeo que ya armo el backend.
    if (inflated.some((polygon) => strictlyInside(position, polygon))) {
      dropped += 1;
      continue;
    }
    kept.push(item);
  }
  if (kept.length < 2) {
    throw new Error("Las zonas no-go no dejan superficie para cubrir");
  }

  let current = kept;
  let droppedDuringDetour = 0;
  let totalDetours = 0;
  for (let pass = 0; pass < MAX_DETOUR_PASSES; pass += 1) {
    // Un rodeo de zonas solapadas puede insertar un vertice dentro de otra
    // zona. Esos puntos no existian durante el filtrado inicial; si se los
    // dejara, una segunda aplicacion del recorte cambiaria la ruta. Filtrar
    // antes de cada pasada hace que el resultado estable sea idempotente.
    const filtered: T[] = [];
    for (const item of current) {
      const position = options.positionOf(item);
      if (inflated.some((polygon) => strictlyInside(position, polygon))) {
        droppedDuringDetour += 1;
        continue;
      }
      filtered.push(item);
    }
    if (filtered.length < 2) {
      throw new Error("Las zonas no-go no dejan superficie para cubrir");
    }
    current = filtered;

    const rebuilt: T[] = [];
    let passDetours = 0;
    for (let index = 0; index < current.length - 1; index += 1) {
      const origin = current[index];
      const target = current[index + 1];
      rebuilt.push(origin);

      const start = options.positionOf(origin);
      const end = options.positionOf(target);
      const detour = shortestDetour(
        start, end, inflated, options.bounds, options.fieldBoundary
      );
      if (detour.length === 0) continue;

      passDetours += 1;
      for (let step = 0; step < detour.length; step += 1) {
        const point = detour[step];
        const following = step + 1 < detour.length ? detour[step + 1] : end;
        rebuilt.push(
          options.makeDetour(point, headingDeg(point, following, options.headingOf(origin)), target)
        );
      }
    }
    rebuilt.push(current[current.length - 1]);
    current = rebuilt;
    totalDetours += passDetours;
    if (passDetours === 0) {
      return {
        items: current,
        dropped: dropped + droppedDuringDetour,
        detours: totalDetours
      };
    }
  }
  throw new Error("Las zonas no-go solapadas no estabilizaron el rodeo");
}
