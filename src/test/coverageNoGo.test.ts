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
  polygonIsStrictlyInsideField,
  segmentPolygonIntersections,
  type NoGoBounds,
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

  it("es idempotente cuando dos zonas se solapan", () => {
    const primera: NoGoPolygon = [
      { x: 21.9132805385, y: -19.4012230618 },
      { x: 24.9744600865, y: -19.4012230618 },
      { x: 24.9744600865, y: -3.5730292693 },
      { x: 21.9132805385, y: -3.5730292693 }
    ];
    const segunda: NoGoPolygon = [
      { x: 15.8286704333, y: -16.4143527562 },
      { x: 24.8657650897, y: -16.4143527562 },
      { x: 24.8657650897, y: 1.271242778 },
      { x: 15.8286704333, y: 1.271242778 }
    ];
    const options = {
      marginM: 1.5,
      bounds: { xMin: 0, xMax: 100, yMin: -30, yMax: 30 },
      positionOf: (item: Punto) => ({ x: item.x, y: item.y }),
      headingOf: (item: Punto) => item.yawDeg,
      makeDetour: (point: NoGoPoint, headingDeg: number) => ({
        x: point.x, y: point.y, phase: NOGO_DETOUR_PHASE, yawDeg: headingDeg
      })
    };
    const original = fila([
      { x: 0, y: -8.388373976 },
      { x: 100, y: -1.016251981 }
    ]);
    const first = clipPathToNoGo(original, [primera, segunda], options);
    const second = clipPathToNoGo(first.items, [primera, segunda], options);
    expect(posiciones(second.items)).toEqual(posiciones(first.items));
    expect([second.dropped, second.detours]).toEqual([0, 0]);
  });

  it("usa el exterior cuando la zona toca el borde concavo", () => {
    const loteEnL: NoGoPolygon = [
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 4 },
      { x: 4, y: 4 }, { x: 4, y: 10 }, { x: 0, y: 10 }
    ];
    const zona: NoGoPolygon = [
      { x: 2, y: 3 }, { x: 4, y: 3 }, { x: 4, y: 5 }, { x: 2, y: 5 }
    ];
    const result = clipPathToNoGo(fila([{ x: 3, y: 0 }, { x: 3, y: 10 }]), [zona], {
      marginM: 0.25,
      bounds: { xMin: 0, xMax: 10, yMin: 0, yMax: 10 },
      fieldBoundary: loteEnL,
      positionOf: (item) => ({ x: item.x, y: item.y }),
      headingOf: (item) => item.yawDeg,
      makeDetour: (point, headingDeg) => ({
        x: point.x, y: point.y, phase: NOGO_DETOUR_PHASE, yawDeg: headingDeg
      })
    });
    expect(result.detours).toBe(1);
    expect(
      result.items.some(
        (item) => item.phase === NOGO_DETOUR_PHASE && !pointInPolygon(item, loteEnL)
      )
    ).toBe(true);
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

  it("no une las key por adentro cuando el rodeo viaja como guias no-key", async () => {
    const local = servicioConZonas(respuestaDePreview(0));
    const recortado = await local.service.previewCoverage();
    const waypoints = recortado.sampledWaypoints.map((item) => ({
      lat: item.lat,
      lon: item.lon,
      yaw_deg: item.yawDeg,
      phase: item.phase,
      row_index: item.rowIndex,
      key: item.phase !== NOGO_DETOUR_PHASE && item.key
    }));
    const respuesta = respuestaDePreview(1);
    const plan = respuesta.coverage_plan as Record<string, unknown>;
    plan.sampled_waypoints = waypoints;
    plan.key_waypoints = waypoints.filter((item) => item.key);
    plan.route_request = {
      op: "set_route_ll",
      waypoints,
      leg_spacing_m: 40,
      chunk_span_m: 60,
      chunk_max_waypoints: 25
    };

    const { service } = servicioConZonas(respuesta);
    const preview = await service.previewCoverage();
    expect(preview.nogoClippedLocally).toBe(false);
    expect(preview.keyWaypoints).toHaveLength(2);
    expect(
      preview.executionWaypoints.some(
        (item) => item.phase === NOGO_DETOUR_PHASE && !item.key
      )
    ).toBe(true);
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


// Lote de prueba, compartido con `src/navegacion_gps/test/test_coverage_nogo.py`.
const LOTE: NoGoBounds = { xMin: 0, xMax: 38, yMin: 0, yMax: 40 };

function zonaCentrada(xc: number, yc: number): NoGoPolygon {
  return [
    { x: xc - 2.6, y: yc - 1.6 },
    { x: xc + 2.6, y: yc - 1.6 },
    { x: xc + 2.6, y: yc + 1.6 },
    { x: xc - 2.6, y: yc + 1.6 }
  ];
}

function clipConLote(puntos: Punto[], zona: NoGoPolygon, bounds?: NoGoBounds) {
  return clipPathToNoGo<Punto>(puntos, [zona], {
    marginM: 4.4,
    bounds,
    positionOf: (item) => ({ x: item.x, y: item.y }),
    headingOf: (item) => item.yawDeg,
    makeDetour: (point, headingDeg) => ({
      x: point.x, y: point.y, phase: NOGO_DETOUR_PHASE, yawDeg: headingDeg
    })
  });
}

describe("coverageNoGo dentro del lote", () => {
  it.each([1, 2.5, 4, 6])(
    "saca el rodeo del lote con la zona a %s m del borde",
    (yc) => {
      // La envolvente inflada toca el borde: se elige el arco exterior.
      const r = clipConLote(
        fila([0, 10, 21.4, 30, 38].map((x) => ({ x, y: yc }))),
        zonaCentrada(21.4, yc),
        LOTE
      );
      expect(r.detours).toBeGreaterThanOrEqual(1);
      expect(Math.min(...r.items.map((item) => item.y))).toBeLessThan(-0.5);
    }
  );

  it("sin lote el rodeo puede salirse", () => {
    // El comportamiento de antes, documentado para dejar claro que el
    // rectangulo es lo unico que lo impide.
    const r = clipConLote(
      fila([{ x: 0, y: 2.5 }, { x: 38, y: 2.5 }]),
      zonaCentrada(21.4, 2.5)
    );
    expect(Math.min(...r.items.map((i) => i.y))).toBeLessThan(-0.5);
  });

  it("el lote no cambia el rodeo cuando la zona esta en el medio", () => {
    const puntos = fila([{ x: 0, y: 20 }, { x: 38, y: 20 }]);
    const con = clipConLote(puntos, zonaCentrada(21.4, 20), LOTE);
    const sin = clipConLote(puntos, zonaCentrada(21.4, 20));
    expect(posiciones(con.items)).toEqual(posiciones(sin.items));
  });

  it("clasifica usando la envolvente inflada", () => {
    const interna = inflatePolygon(zonaCentrada(21.4, 20), 4.4);
    const borde = inflatePolygon(zonaCentrada(21.4, 6), 4.4);
    expect(polygonIsStrictlyInsideField(interna, LOTE)).toBe(true);
    expect(polygonIsStrictlyInsideField(borde, LOTE)).toBe(false);
  });
});
