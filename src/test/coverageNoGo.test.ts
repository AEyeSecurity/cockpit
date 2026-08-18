import { describe, expect, it, vi } from "vitest";
import type { Nav2IncomingMessage } from "../packages/nav2/protocol/messages";
import type { RobotDispatcher } from "../packages/nav2/modules/navigation/dispatcher/impl/RobotDispatcher";
import {
  CoverageService,
  type CoverageGeoPoint
} from "../packages/nav2/modules/navigation/service/impl/CoverageService";
import {
  NOGO_DETOUR_PHASE,
  clipPathToNoGo,
  detourAlongContour,
  inflatePolygon,
  pointInPolygon,
  segmentPolygonIntersections,
  type NoGoPoint,
  type NoGoPolygon
} from "../packages/nav2/modules/navigation/service/impl/coverageNoGo";

// Fixture compartido con el test de Python
// (`src/navegacion_gps/test/test_coverage_nogo.py`). Si cambia aca tiene que
// cambiar alla: es lo unico que mantiene honestas a las dos implementaciones
// del recorte, que corren la misma cuenta en los dos lados a proposito.
const ZONA_CUADRADA: NoGoPolygon = [
  { x: 10, y: 10 },
  { x: 20, y: 10 },
  { x: 20, y: 20 },
  { x: 10, y: 20 }
];
const FILA_QUE_ATRAVIESA: NoGoPoint[] = [
  { x: 0, y: 15 },
  { x: 10, y: 15 },
  { x: 15, y: 15 },
  { x: 20, y: 15 },
  { x: 30, y: 15 }
];
const MARGEN_M = 0.5;

interface Punto extends NoGoPoint {
  phase: string;
  yawDeg: number;
}

function fila(puntos: NoGoPoint[]): Punto[] {
  return puntos.map((punto) => ({ ...punto, phase: "row", yawDeg: 0 }));
}

function clip(puntos: Punto[], polygons: NoGoPolygon[], marginM = MARGEN_M) {
  return clipPathToNoGo<Punto>(puntos, polygons, {
    marginM,
    positionOf: (item) => ({ x: item.x, y: item.y }),
    headingOf: (item) => item.yawDeg,
    makeDetour: (point, headingDeg) => ({
      x: point.x,
      y: point.y,
      phase: NOGO_DETOUR_PHASE,
      yawDeg: headingDeg
    })
  });
}

function posiciones(items: Punto[]): Array<[number, number, string]> {
  return items.map((item) => [
    Number(item.x.toFixed(6)),
    Number(item.y.toFixed(6)),
    item.phase
  ]);
}

describe("coverageNoGo", () => {
  it("distingue adentro, afuera y borde", () => {
    expect(pointInPolygon({ x: 15, y: 15 }, ZONA_CUADRADA)).toBe(true);
    expect(pointInPolygon({ x: 5, y: 15 }, ZONA_CUADRADA)).toBe(false);
    expect(pointInPolygon({ x: 25, y: 25 }, ZONA_CUADRADA)).toBe(false);
    // El borde cuenta como adentro: el poligono ya viene inflado por el margen.
    expect(pointInPolygon({ x: 10, y: 15 }, ZONA_CUADRADA)).toBe(true);
  });

  it("infla el mismo cuadrado sin importar el sentido de los vertices", () => {
    // El cockpit dibuja el rectangulo en el sentido en que se arrastra el mouse,
    // asi que el sentido no puede cambiar hacia donde se infla.
    const antihorario = inflatePolygon(ZONA_CUADRADA, 1);
    const horario = inflatePolygon([...ZONA_CUADRADA].reverse(), 1);
    expect(antihorario).toEqual([
      { x: 9, y: 9 },
      { x: 21, y: 9 },
      { x: 21, y: 21 },
      { x: 9, y: 21 }
    ]);
    const clave = (punto: NoGoPoint): string => `${punto.x},${punto.y}`;
    expect(horario.map(clave).sort()).toEqual(antihorario.map(clave).sort());
  });

  it("sin margen no toca el poligono", () => {
    expect(inflatePolygon(ZONA_CUADRADA, 0)).toEqual(ZONA_CUADRADA);
  });

  it("ordena los cortes desde el inicio del segmento", () => {
    const cortes = segmentPolygonIntersections({ x: 0, y: 15 }, { x: 30, y: 15 }, ZONA_CUADRADA);
    expect(cortes.map((corte) => Number(corte.point.x.toFixed(3)))).toEqual([10, 20]);
  });

  it("deja el trazado intacto cuando la zona no toca el lote", () => {
    const lejos: NoGoPolygon = [
      { x: 100, y: 100 },
      { x: 110, y: 100 },
      { x: 110, y: 110 },
      { x: 100, y: 110 }
    ];
    const puntos = fila(FILA_QUE_ATRAVIESA);
    const resultado = clip(puntos, [lejos]);
    expect(posiciones(resultado.items)).toEqual(posiciones(puntos));
    expect([resultado.dropped, resultado.detours]).toEqual([0, 0]);
  });

  it("deja el trazado intacto cuando no hay zonas", () => {
    const puntos = fila(FILA_QUE_ATRAVIESA);
    const resultado = clip(puntos, []);
    expect(posiciones(resultado.items)).toEqual(posiciones(puntos));
    expect([resultado.dropped, resultado.detours]).toEqual([0, 0]);
  });

  it("descarta lo que cae adentro y bordea el contorno", () => {
    // Mismo resultado exacto que el test de Python sobre el mismo fixture.
    const resultado = clip(fila(FILA_QUE_ATRAVIESA), [ZONA_CUADRADA]);
    expect(resultado.dropped).toBe(3);
    expect(resultado.detours).toBe(1);
    expect(posiciones(resultado.items)).toEqual([
      [0, 15, "row"],
      [9.5, 15, NOGO_DETOUR_PHASE],
      [9.5, 9.5, NOGO_DETOUR_PHASE],
      [20.5, 9.5, NOGO_DETOUR_PHASE],
      [20.5, 15, NOGO_DETOUR_PHASE],
      [30, 15, "row"]
    ]);
  });

  it("no deja ningun punto dentro de la zona", () => {
    const resultado = clip(fila(FILA_QUE_ATRAVIESA), [ZONA_CUADRADA]);
    for (const item of resultado.items) {
      expect(pointInPolygon({ x: item.x, y: item.y }, ZONA_CUADRADA)).toBe(false);
    }
  });

  it.each([
    [18, 20.5, 9.5],
    [12, 9.5, 20.5]
  ])("rodea por el lado corto cuando cruza a y=%s", (y, esperado, largo) => {
    const resultado = clip(
      fila([
        { x: 0, y },
        { x: 30, y }
      ]),
      [ZONA_CUADRADA]
    );
    const laterales = resultado.items
      .filter((item) => item.phase === NOGO_DETOUR_PHASE)
      .map((item) => Number(item.y.toFixed(3)));
    expect(laterales).toContain(esperado);
    // Si apareciera el lado largo, el rodeo dio la vuelta entera.
    expect(laterales).not.toContain(largo);
  });

  it("orienta cada punto del rodeo hacia el tramo siguiente", () => {
    const resultado = clip(fila(FILA_QUE_ATRAVIESA), [ZONA_CUADRADA]);
    const rodeo = resultado.items.filter((item) => item.phase === NOGO_DETOUR_PHASE);
    expect(rodeo.map((item) => Number(item.yawDeg.toFixed(3)))).toEqual([-90, 0, 90, 0]);
  });

  it("no genera rodeo para un tramo que corre pegado al borde", () => {
    // Hay dos cortes con los lados perpendiculares, pero nada que rodear. Si se
    // tratara como cruce, el rodeo se reinsertaria en cada pasada.
    const inflado = inflatePolygon(ZONA_CUADRADA, MARGEN_M);
    expect(detourAlongContour({ x: 0, y: 9.5 }, { x: 30, y: 9.5 }, inflado)).toEqual([]);
  });

  it("es idempotente", () => {
    // Es lo que permite que el cockpit recorte lo que ya recorto el backend sin
    // pisarlo: la segunda pasada tiene que ser un no-op exacto.
    const primera = clip(fila(FILA_QUE_ATRAVIESA), [ZONA_CUADRADA]);
    const segunda = clip(primera.items, [ZONA_CUADRADA]);
    expect(posiciones(segunda.items)).toEqual(posiciones(primera.items));
    expect([segunda.dropped, segunda.detours]).toEqual([0, 0]);
  });

  it("lanza cuando la zona cubre todo el lote en vez de devolver una ruta vacia", () => {
    const todo: NoGoPolygon = [
      { x: -50, y: -50 },
      { x: 50, y: -50 },
      { x: 50, y: 50 },
      { x: -50, y: 50 }
    ];
    expect(() => clip(fila(FILA_QUE_ATRAVIESA), [todo])).toThrow(/no dejan superficie/i);
  });

  it("rodea las dos zonas cuando hay una atras de la otra", () => {
    const segunda: NoGoPolygon = [
      { x: 40, y: 10 },
      { x: 50, y: 10 },
      { x: 50, y: 20 },
      { x: 40, y: 20 }
    ];
    const resultado = clip(
      fila([
        { x: 0, y: 15 },
        { x: 60, y: 15 }
      ]),
      [ZONA_CUADRADA, segunda]
    );
    expect(resultado.dropped).toBe(0);
    expect(resultado.detours).toBe(2);
    for (const zona of [ZONA_CUADRADA, segunda]) {
      for (const item of resultado.items) {
        expect(pointInPolygon({ x: item.x, y: item.y }, zona)).toBe(false);
      }
    }
  });
});

const METERS_PER_DEG_LAT = 111_320;
const ORIGEN: CoverageGeoPoint = { lat: -31.4859, lon: -64.2425 };

function desplazar(origin: CoverageGeoPoint, eastM: number, northM: number): CoverageGeoPoint {
  return {
    lat: origin.lat + northM / METERS_PER_DEG_LAT,
    lon: origin.lon + eastM / (METERS_PER_DEG_LAT * Math.cos((origin.lat * Math.PI) / 180))
  };
}

/**
 * Trazado recto de 30 m hacia el este desde el origen, con puntos cada 5 m.
 * Los del medio caen dentro de la zona de prueba.
 */
function respuestaDePreview(nogoPolygonCount = 0, nogoNote = ""): Nav2IncomingMessage {
  const sampled = [0, 5, 10, 15, 20, 25, 30].map((eastM, index) => {
    const punto = desplazar(ORIGEN, eastM, 0);
    return {
      lat: punto.lat,
      lon: punto.lon,
      yaw_deg: 0,
      phase: "row",
      row_index: 0,
      key: index === 0 || index === 6
    };
  });
  return {
    op: "ack",
    ok: true,
    coverage_plan: {
      sampled_waypoints: sampled,
      key_waypoints: sampled.filter((item) => item.key),
      nogo_polygon_count: nogoPolygonCount,
      nogo_note: nogoNote,
      metrics: {
        row_count: 1,
        lane_spacing_m: 8,
        row_visit_order: [0],
        turn_separations_m: [],
        clean_uturn_count: 0,
        omega_turn_count: 0,
        estimated_path_length_m: 30,
        headland_before_m: 4,
        headland_after_m: 4,
        lateral_overflow_m: 0,
        topology_audit_spacing_m: 0.5,
        planner_min_turning_radius_m: 4.0,
        topology_scope: "field_interior",
        topology_safe: true,
        topology_conflicts: { strict_crossings: 0, nonadjacent_touches: 0, collinear_overlaps: 0, total: 0 },
        global_topology_conflicts: { strict_crossings: 0, nonadjacent_touches: 0, collinear_overlaps: 0, total: 0 }
      },
      route_request: { op: "set_route_ll", leg_spacing_m: 40, chunk_span_m: 60, chunk_max_waypoints: 25 }
    }
  };
}

/** Zona de 10 x 10 m que tapa el tramo entre los 10 y los 20 m del trazado. */
function fuenteDeZonas(enabled = true) {
  const esquinas: CoverageGeoPoint[] = [
    desplazar(ORIGEN, 10, -5),
    desplazar(ORIGEN, 20, -5),
    desplazar(ORIGEN, 20, 5),
    desplazar(ORIGEN, 10, 5)
  ];
  return {
    getState: () => ({
      zones: [{ enabled, polygon: esquinas }]
    })
  };
}

function servicioConZonas(respuesta: Nav2IncomingMessage, zonas = fuenteDeZonas()) {
  const previewRequest = vi.fn().mockResolvedValue(respuesta);
  const startRequest = vi.fn().mockResolvedValue({ op: "ack", ok: true, route_started: true });
  const dispatcher = {
    requestCoveragePreview: previewRequest,
    requestStartCoverage: startRequest
  } as unknown as RobotDispatcher;
  const service = new CoverageService(dispatcher, undefined, zonas);
  service.squareFromVehiclePose({ lat: ORIGEN.lat, lon: ORIGEN.lon, yawDeg: 0 }, { sideM: 40 });
  return { service, startRequest };
}

describe("CoverageService con zonas no-go", () => {
  it("recorta el trazado cuando el backend no aplico las zonas", async () => {
    const { service } = servicioConZonas(respuestaDePreview(0));
    const preview = await service.previewCoverage();
    expect(preview.nogoClippedLocally).toBe(true);
    expect(preview.sampledWaypoints.some((item) => item.phase === NOGO_DETOUR_PHASE)).toBe(true);
  });

  it("bloquea el inicio cuando el recorte lo hizo solo el cockpit", async () => {
    // El backend replanifica al iniciar: si el no recorto, la ruta ejecutada
    // atraviesa la zona aunque el dibujo la esquive.
    const { service, startRequest } = servicioConZonas(
      respuestaDePreview(0, "zones service unavailable")
    );
    await service.previewCoverage();
    expect(service.canStartMission()).toBe(false);
    await expect(service.sendCoverageMission()).rejects.toThrow(/zones_manager/i);
    expect(startRequest).not.toHaveBeenCalled();
  });

  it("no marca divergencia cuando el backend ya recorto", async () => {
    // El backend devuelve el trazado ya rodeado; volver a recortarlo tiene que
    // ser un no-op, que es lo que permite tener las dos mitades.
    const yaRecortado = respuestaDePreview(1);
    const plan = yaRecortado.coverage_plan as Record<string, unknown>;
    const previo = servicioConZonas(respuestaDePreview(0));
    const preview = await previo.service.previewCoverage();
    plan.sampled_waypoints = preview.sampledWaypoints.map((item) => ({
      lat: item.lat,
      lon: item.lon,
      yaw_deg: item.yawDeg,
      phase: item.phase,
      row_index: item.rowIndex,
      key: item.key
    }));
    plan.key_waypoints = (plan.sampled_waypoints as Array<{ key: boolean }>).filter(
      (item) => item.key
    );

    const { service } = servicioConZonas(yaRecortado);
    const segundo = await service.previewCoverage();
    expect(segundo.nogoClippedLocally).toBe(false);
    expect(segundo.sampledWaypoints.length).toBe(preview.sampledWaypoints.length);
  });

  it("ignora las zonas apagadas", async () => {
    const { service } = servicioConZonas(respuestaDePreview(0), fuenteDeZonas(false));
    const preview = await service.previewCoverage();
    expect(preview.nogoClippedLocally).toBe(false);
    expect(preview.sampledWaypoints.some((item) => item.phase === NOGO_DETOUR_PHASE)).toBe(false);
  });

  it("sin fuente de zonas se comporta como antes", async () => {
    const { service } = servicioConZonas(respuestaDePreview(0), { getState: () => ({ zones: [] }) });
    const preview = await service.previewCoverage();
    expect(preview.nogoClippedLocally).toBe(false);
    expect(preview.sampledWaypoints).toHaveLength(7);
  });
});
