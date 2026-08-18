import { describe, expect, it, vi } from "vitest";
import type { Nav2IncomingMessage } from "../packages/nav2/protocol/messages";
import { RobotDispatcher } from "../packages/nav2/modules/navigation/dispatcher/impl/RobotDispatcher";
import type { NavigationService } from "../packages/nav2/modules/navigation/service/impl/NavigationService";
import {
  CoverageService,
  estimateCoverageLayout,
  type CoverageGeoPoint
} from "../packages/nav2/modules/navigation/service/impl/CoverageService";

const METERS_PER_DEG_LAT = 111_320;
const ORIGIN: CoverageGeoPoint = { lat: -31.4859, lon: -64.2425 };

function offsetPoint(origin: CoverageGeoPoint, eastM: number, northM: number): CoverageGeoPoint {
  return {
    lat: origin.lat + northM / METERS_PER_DEG_LAT,
    lon: origin.lon + eastM / (METERS_PER_DEG_LAT * Math.cos((origin.lat * Math.PI) / 180))
  };
}

function distanceBetween(first: CoverageGeoPoint, second: CoverageGeoPoint): number {
  const northM = (second.lat - first.lat) * METERS_PER_DEG_LAT;
  const eastM =
    (second.lon - first.lon) * METERS_PER_DEG_LAT * Math.cos((first.lat * Math.PI) / 180);
  return Math.hypot(eastM, northM);
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: (value: T) => resolvePromise(value) };
}

function makeDispatcher(response?: Nav2IncomingMessage): {
  dispatcher: RobotDispatcher;
  previewRequest: ReturnType<typeof vi.fn>;
  startRequest: ReturnType<typeof vi.fn>;
} {
  const previewRequest = vi.fn().mockResolvedValue(response ?? { op: "ack", ok: true });
  const startRequest = vi.fn().mockResolvedValue({
    op: "ack",
    ok: true,
    route_started: true,
    route_submission_state: "started",
    input_waypoint_count: 4,
    expanded_waypoint_count: 4
  });
  return {
    dispatcher: {
      requestCoveragePreview: previewRequest,
      requestStartCoverage: startRequest
    } as unknown as RobotDispatcher,
    previewRequest,
    startRequest
  };
}

function safeCoverageResponse(topologyKey: "topology_safe" | "is_topologically_safe" = "topology_safe"): Nav2IncomingMessage {
  const sampledWaypoints = [
    { lat: -31.4859, lon: -64.2425, yaw_deg: 0, phase: "row", row_index: 0, key: true },
    { lat: -31.4859, lon: -64.2424, yaw_deg: 0, phase: "row", row_index: 0, key: false },
    { lat: -31.4859, lon: -64.2423, yaw_deg: 0, phase: "row", row_index: 0, key: true },
    { lat: -31.4858, lon: -64.2423, yaw_deg: 180, phase: "row", row_index: 1, key: true },
    { lat: -31.4858, lon: -64.2425, yaw_deg: 180, phase: "row", row_index: 1, key: true }
  ];
  return {
    op: "ack",
    ok: true,
    coverage_plan: {
      sampled_waypoints: sampledWaypoints,
      key_waypoints: sampledWaypoints.filter((waypoint) => waypoint.key),
      metrics: {
        row_count: 2,
        lane_spacing_m: 8,
        row_visit_order: [0, 1],
        turn_separations_m: [8],
        clean_uturn_count: 1,
        omega_turn_count: 0,
        estimated_path_length_m: 49.3,
        headland_before_m: 4,
        headland_after_m: 4,
        lateral_overflow_m: 0,
        topology_audit_spacing_m: 0.5,
        planner_min_turning_radius_m: 4.0,
        topology_scope: "field_interior",
        topology_conflicts: {
          strict_crossings: 0,
          nonadjacent_touches: 0,
          collinear_overlaps: 0,
          total: 0
        },
        global_topology_conflicts: {
          strict_crossings: 0,
          nonadjacent_touches: 0,
          collinear_overlaps: 0,
          total: 0
        },
        [topologyKey]: true
      },
      route_request: {
        op: "set_route_ll",
        leg_spacing_m: 6,
        chunk_span_m: 60,
        chunk_max_waypoints: 25
      }
    }
  };
}

function squareCentre(polygon: CoverageGeoPoint[]): CoverageGeoPoint {
  const origin = polygon[0]!;
  const opposite = polygon[2]!;
  return { lat: (origin.lat + opposite.lat) / 2, lon: (origin.lon + opposite.lon) / 2 };
}

/** El lote es un cuadrado armado desde la pose del vehiculo; no se dibuja. */
function placeField(service: CoverageService, sideM = 20, yawDeg = 0): void {
  service.squareFromVehiclePose({ lat: ORIGIN.lat, lon: ORIGIN.lon, yawDeg }, { sideM });
}

describe("CoverageService", () => {
  it("builds the field as a square with four equal sides", () => {
    // No hay figura libre: el lote es un cuadrado y el operador solo elige el
    // lado. Los cuatro lados del poligono tienen que medir lo mismo.
    const { dispatcher } = makeDispatcher();
    const service = new CoverageService(dispatcher);

    placeField(service, 20);

    const square = service.getState();
    expect(square.fieldPolygon).toHaveLength(4);
    expect(square.field?.fieldLengthM).toBeCloseTo(20, 3);
    expect(square.field?.fieldWidthM).toBeCloseTo(20, 3);
    expect(square.field?.startYawDeg).toBeCloseTo(0, 6);
    expect(square.field?.side).toBe("left");

    const corners = square.fieldPolygon;
    for (let index = 0; index < 4; index += 1) {
      expect(distanceBetween(corners[index]!, corners[(index + 1) % 4]!)).toBeCloseTo(20, 1);
    }
  });

  it("keeps the square square when the side changes", () => {
    const service = new CoverageService(makeDispatcher().dispatcher);
    placeField(service, 12);
    expect(service.getState().field?.fieldWidthM).toBeCloseTo(12, 3);

    placeField(service, 31);
    const corners = service.getState().fieldPolygon;
    expect(service.getState().field?.fieldLengthM).toBeCloseTo(31, 3);
    expect(service.getState().field?.fieldWidthM).toBeCloseTo(31, 3);
    expect(distanceBetween(corners[0]!, corners[1]!)).toBeCloseTo(31, 1);
    expect(distanceBetween(corners[1]!, corners[2]!)).toBeCloseTo(31, 1);
  });

  it("mueve el cuadrado sin cambiarle el lado ni el rumbo", () => {
    const service = new CoverageService(makeDispatcher().dispatcher);
    placeField(service, 20, 30);
    const before = service.getState().field!;
    const centreBefore = squareCentre(service.getState().fieldPolygon);

    // El tirador del centro se suelta 40 m al este y 10 m al norte.
    const target = offsetPoint(centreBefore, 40, 10);
    service.moveFieldTo(target);

    const after = service.getState().field!;
    expect(after.fieldLengthM).toBeCloseTo(before.fieldLengthM, 6);
    expect(after.fieldWidthM).toBeCloseTo(before.fieldWidthM, 6);
    expect(after.startYawDeg).toBeCloseTo(before.startYawDeg, 6);
    expect(after.side).toBe(before.side);
    expect(distanceBetween(squareCentre(service.getState().fieldPolygon), target))
      .toBeLessThan(0.05);
    // El campo ya no cuelga de la pose del vehiculo, y el preview se invalida.
    expect(service.getState().vehicleAnchor).toBeNull();
    expect(service.getState().preview).toBeNull();
  });

  it("cambia el lado arrastrando la esquina opuesta, sin mover el arranque", () => {
    const service = new CoverageService(makeDispatcher().dispatcher);
    placeField(service, 20, 0);
    const before = service.getState().field!;
    const origin = { lat: before.startLat, lon: before.startLon };

    // Rumbo 0 (este) y lado izquierdo: la esquina opuesta esta al noreste.
    service.resizeFieldFromCorner(offsetPoint(origin, 32, 12));

    const after = service.getState().field!;
    // Se toma la proyeccion mayor: 32 m de avance contra 12 m de costado.
    expect(after.fieldLengthM).toBeCloseTo(32, 1);
    expect(after.fieldWidthM).toBeCloseTo(32, 1);
    // Redondeado a 0.1 m: el numero va al campo "lado exacto".
    expect(after.fieldLengthM * 10).toBeCloseTo(Math.round(after.fieldLengthM * 10), 9);
    expect(after.startLat).toBeCloseTo(before.startLat, 9);
    expect(after.startLon).toBeCloseTo(before.startLon, 9);
    expect(after.startYawDeg).toBeCloseTo(before.startYawDeg, 6);

    // Nunca por debajo del ancho de corte.
    expect(() => service.resizeFieldFromCorner(offsetPoint(origin, 1, 0.5)))
      .toThrow(/lado debe ser mayor/i);
  });

  it("redimensiona desde cualquier esquina dejando fija la opuesta", () => {
    // Arrastrar la esquina 1 tiene que dejar quieta la 3, y viceversa. Es lo que
    // espera cualquiera que haya redimensionado un rectangulo en un editor.
    for (const arrastrada of [0, 1, 2, 3]) {
      const service = new CoverageService(makeDispatcher().dispatcher);
      placeField(service, 20, 0);
      const antes = service.getState().fieldPolygon;
      const anclaEsperada = antes[(arrastrada + 2) % 4]!;

      // Se lleva la esquina a 30 m de la opuesta, sobre la diagonal.
      const hacia = offsetPoint(
        anclaEsperada,
        (antes[arrastrada]!.lon - anclaEsperada.lon) > 0 ? 30 : -30,
        (antes[arrastrada]!.lat - anclaEsperada.lat) > 0 ? 30 : -30
      );
      service.resizeFieldFromCorner(hacia, arrastrada);

      const despues = service.getState();
      expect(despues.field?.fieldLengthM).toBeCloseTo(30, 1);
      expect(despues.field?.fieldWidthM).toBeCloseTo(30, 1);
      // La opuesta no se movio.
      expect(distanceBetween(despues.fieldPolygon[(arrastrada + 2) % 4]!, anclaEsperada))
        .toBeLessThan(0.05);
      // Y el rumbo no cambio.
      expect(despues.field?.startYawDeg).toBeCloseTo(0, 6);
    }
  });

  it("gira el cuadrado sobre su centro sin cambiarle el lado", () => {
    const service = new CoverageService(makeDispatcher().dispatcher);
    placeField(service, 20, 0);
    const centroAntes = squareCentre(service.getState().fieldPolygon);

    // El tirador cuelga de la esquina opuesta, que esta sobre la diagonal: a 45
    // grados del eje de las pasadas. Soltarlo al norte del centro deja rumbo 45,
    // no 90. Sin ese descuento el cuadrado saltaria apenas se lo toca.
    service.rotateFieldTo(offsetPoint(centroAntes, 0, 18));

    const despues = service.getState();
    expect(despues.field?.startYawDeg).toBeCloseTo(45, 0);
    expect(despues.field?.fieldLengthM).toBeCloseTo(20, 6);
    // El centro se queda donde estaba: gira sobre si mismo, no camina.
    expect(distanceBetween(squareCentre(despues.fieldPolygon), centroAntes)).toBeLessThan(0.05);
    expect(despues.preview).toBeNull();

    // Muy cerca del centro el angulo salta: se ignora en vez de dar un rumbo al azar.
    const rumboAntes = despues.field!.startYawDeg;
    service.rotateFieldTo(offsetPoint(squareCentre(despues.fieldPolygon), 0.3, 0));
    expect(service.getState().field?.startYawDeg).toBeCloseTo(rumboAntes, 6);
  });

  it("previsualiza el arrastre sin tocar el estado y termina en la misma figura", () => {
    // El mapa dibuja el cuadrado durante el gesto con `geometryFor*` y recien
    // guarda al soltar. Si las dos cuentas no dieran igual, el cuadrado saltaria
    // al soltarlo; y si la previsualizacion escribiera estado, volveria el
    // problema que la motivo: rearmar la capa entera en cada movimiento del mouse.
    const service = new CoverageService(makeDispatcher().dispatcher);
    placeField(service, 20, 0);
    const antes = service.getState();
    const centro = squareCentre(antes.fieldPolygon);
    const origen = { lat: antes.field!.startLat, lon: antes.field!.startLon };

    const casos: Array<[string, () => CoverageGeoPoint[] | null, () => void]> = [
      [
        "mover",
        () => service.geometryForMove(offsetPoint(centro, 25, -8)).polygon,
        () => service.moveFieldTo(offsetPoint(centro, 25, -8))
      ],
      [
        "girar",
        () => service.geometryForRotate(offsetPoint(centro, 0, 18))?.polygon ?? null,
        () => service.rotateFieldTo(offsetPoint(centro, 0, 18))
      ],
      [
        "redimensionar",
        () => service.geometryForResize(offsetPoint(origen, 28, 28), 2).polygon,
        () => service.resizeFieldFromCorner(offsetPoint(origen, 28, 28), 2)
      ]
    ];

    for (const [nombre, previsualizar, guardar] of casos) {
      const estadoPrevio = service.getState();
      const previsto = previsualizar();
      expect(previsto, nombre).not.toBeNull();
      // Previsualizar no movio nada.
      expect(service.getState().field, nombre).toEqual(estadoPrevio.field);
      expect(service.getState().fieldPolygon, nombre).toEqual(estadoPrevio.fieldPolygon);

      guardar();
      const guardado = service.getState().fieldPolygon;
      previsto!.forEach((esquina, indice) => {
        expect(distanceBetween(esquina, guardado[indice]!), nombre).toBeLessThan(0.01);
      });
      // Y el estado vuelve al de partida para el caso siguiente.
      service.moveFieldTo(centro);
      service.rotateFieldTo(offsetPoint(centro, 18, 18));
      service.resizeFieldFromCorner(offsetPoint(origen, 20, 20), 2);
    }
  });

  it("uses the ROS yaw convention: east is 0 degrees and north is 90 degrees", () => {
    const eastService = new CoverageService(makeDispatcher().dispatcher);
    placeField(eastService, 500, 0);
    expect(eastService.getState().field?.fieldLengthM).toBeCloseTo(500, 6);
    expect(eastService.getState().field?.startYawDeg).toBeCloseTo(0, 6);

    const northService = new CoverageService(makeDispatcher().dispatcher);
    placeField(northService, 500, 90);
    expect(northService.getState().field?.fieldLengthM).toBeCloseTo(500, 6);
    expect(northService.getState().field?.startYawDeg).toBeCloseTo(90, 6);
  });

  it("allows an exact side and reversing the starting edge", () => {
    const service = new CoverageService(makeDispatcher().dispatcher);
    placeField(service, 20);

    service.setFieldDimensions({ fieldLengthM: 24 });
    expect(service.getState().field?.fieldLengthM).toBeCloseTo(24, 6);
    expect(service.getState().field?.fieldWidthM).toBeCloseTo(24, 6);

    // Escribir cualquiera de los dos lados mueve los dos: el lote es cuadrado.
    service.setFieldDimensions({ fieldWidthM: 11 });
    expect(service.getState().field?.fieldLengthM).toBeCloseTo(11, 6);
    expect(service.getState().field?.fieldWidthM).toBeCloseTo(11, 6);

    service.setFieldDimensions({ fieldLengthM: 24 });
    const beforeReverse = service.getState().field!;
    service.reverseFieldDirection();
    const reversed = service.getState();

    expect(reversed.field?.fieldLengthM).toBeCloseTo(24, 6);
    expect(reversed.field?.fieldWidthM).toBeCloseTo(24, 6);
    expect(reversed.field?.startYawDeg).toBeCloseTo(180, 6);
    expect(reversed.field?.side).toBe("right");
    expect(reversed.field?.startLon).not.toBeCloseTo(beforeReverse.startLon, 6);
    expect(reversed.fieldPolygon).toHaveLength(4);
    expect(reversed.preview).toBeNull();
  });

  it("rejects preview spacing below the backend audit contract", () => {
    const service = new CoverageService(makeDispatcher().dispatcher);

    expect(() => service.setParameters({ waypointSpacingM: 0.49 })).toThrow(/0\.5 m/);
    expect(service.getState().parameters.waypointSpacingM).toBe(2);
  });

  it("normalizes coverage_plan and starts coverage from a fresh server-side geometry validation", async () => {
    const { dispatcher, previewRequest, startRequest } = makeDispatcher(safeCoverageResponse());
    const setManualMode = vi.fn().mockResolvedValue(undefined);
    const navigationService = {
      getState: () => ({ controlLocked: false, controlLockReason: "", manualMode: true }),
      setManualMode
    } as unknown as NavigationService;
    const service = new CoverageService(dispatcher, navigationService);
    service.setRuntimeProfile("sim");
    placeField(service);

    const preview = await service.previewCoverage();
    expect(previewRequest).toHaveBeenCalledWith(expect.objectContaining({
      field_length_m: expect.closeTo(20, 3),
      field_width_m: expect.closeTo(20, 3),
      start_yaw_deg: expect.closeTo(0, 6),
      side: "left"
    }));
    expect(preview.sampledWaypoints).toHaveLength(5);
    expect(preview.keyWaypoints).toHaveLength(4);
    expect(preview.topologySafe).toBe(true);
    expect(preview.metrics.cleanUturnCount).toBe(1);
    expect(preview.metrics.topologyConflictCount).toBe(0);
    expect(preview.metrics.topologyAuditSpacingM).toBe(0.5);
    expect(preview.legSpacingM).toBeCloseTo(21, 3);
    expect(service.canStartMission()).toBe(true);

    await service.sendCoverageMission();

    expect(setManualMode).toHaveBeenCalledWith(false);
    expect(startRequest).toHaveBeenCalledTimes(1);
    expect(startRequest).toHaveBeenCalledWith({
      start_lat: expect.any(Number),
      start_lon: expect.any(Number),
      start_yaw_deg: expect.closeTo(0, 6),
      field_length_m: expect.closeTo(20, 3),
      field_width_m: expect.closeTo(20, 3),
      cutter_width_m: 2,
      overlap_ratio: 0.15,
      // Perfil sim: el radio que viaja es el piso del Smac de simulacion.
      min_turning_radius_m: 2.9,
      waypoint_spacing_m: 2,
      side: "left"
    });
    const startPayload = startRequest.mock.calls[0]?.[0] as Record<string, unknown>;
    // La esquina que viaja no es la pose del vehiculo: queda corrida media
    // pasada para que el inset del backend deje la primera pasada bajo el
    // vehiculo. Con corte 2 m eso es 1 m en diagonal, 1.41 m de distancia.
    expect(
      distanceBetween(ORIGIN, {
        lat: Number(startPayload.start_lat),
        lon: Number(startPayload.start_lon)
      })
    ).toBeCloseTo(Math.SQRT2, 1);
    expect(startPayload).not.toHaveProperty("waypoints");
    expect(startPayload).not.toHaveProperty("leg_spacing_m");
  });

  it("takes the turning radius floor from the active profile", () => {
    // El piso es el radio del Smac de cada perfil: pedir menos lo rechaza el
    // backend. Simulacion traza a 2.9 m; el real sigue en 4.0 m sin validar.
    const service = new CoverageService(makeDispatcher().dispatcher);

    expect(service.getState().parameters.minTurningRadiusM).toBe(4.0);
    service.setRuntimeProfile("sim");
    expect(service.getState().parameters.minTurningRadiusM).toBe(2.9);
    expect(() => service.setParameters({ minTurningRadiusM: 2.8 })).toThrow(/2\.9 m/);
    service.setParameters({ minTurningRadiusM: 3.5 });
    expect(service.getState().parameters.minTurningRadiusM).toBe(3.5);

    service.setRuntimeProfile("real");
    expect(service.getState().parameters.minTurningRadiusM).toBe(4.0);
    expect(() => service.setParameters({ minTurningRadiusM: 2.9 })).toThrow(/4\.0 m/);
  });

  it("accepts is_topologically_safe as a normalized backend alias", async () => {
    const service = new CoverageService(makeDispatcher(safeCoverageResponse("is_topologically_safe")).dispatcher);
    placeField(service);
    const preview = await service.previewCoverage();
    expect(preview.topologySafe).toBe(true);
    expect(service.canStartMission()).toBe(true);
  });

  it("blocks mission dispatch on topology conflicts even with zero omega turns", async () => {
    const response = safeCoverageResponse();
    const plan = response.coverage_plan as Record<string, unknown>;
    const metrics = plan.metrics as Record<string, unknown>;
    metrics.topology_safe = false;
    metrics.topology_conflicts = {
      strict_crossings: 1,
      nonadjacent_touches: 0,
      collinear_overlaps: 0,
      total: 1
    };
    const { dispatcher, startRequest } = makeDispatcher(response);
    const service = new CoverageService(dispatcher);
    placeField(service);

    const preview = await service.previewCoverage();
    expect(preview.metrics.omegaTurnCount).toBe(0);
    expect(preview.metrics.strictCrossingCount).toBe(1);
    expect(preview.topologySafe).toBe(false);
    expect(preview.topologyError).toContain("conflicto");
    expect(service.canStartMission()).toBe(false);
    await expect(service.sendCoverageMission()).rejects.toThrow(/conflicto|topolog/i);
    expect(startRequest).not.toHaveBeenCalled();
  });

  it("fails closed when reported topology safety contradicts individual conflict counts", async () => {
    const response = safeCoverageResponse();
    const plan = response.coverage_plan as Record<string, unknown>;
    const metrics = plan.metrics as Record<string, unknown>;
    metrics.topology_safe = true;
    metrics.topology_conflicts = {
      strict_crossings: 1,
      nonadjacent_touches: 0,
      collinear_overlaps: 0,
      total: 0
    };
    const service = new CoverageService(makeDispatcher(response).dispatcher);
    placeField(service);

    const preview = await service.previewCoverage();
    expect(preview.metrics.strictCrossingCount).toBe(1);
    expect(preview.metrics.topologyConflictCount).toBe(1);
    expect(preview.topologySafe).toBe(false);
    expect(service.canStartMission()).toBe(false);
  });

  it("keeps omega turns blocking when the backend audits the complete path", async () => {
    const response = safeCoverageResponse();
    const plan = response.coverage_plan as Record<string, unknown>;
    const metrics = plan.metrics as Record<string, unknown>;
    metrics.topology_safe = false;
    metrics.topology_scope = "global";
    metrics.omega_turn_count = 1;
    metrics.clean_uturn_count = 0;
    const { dispatcher, startRequest } = makeDispatcher(response);
    const service = new CoverageService(dispatcher);
    placeField(service);
    await service.previewCoverage();

    expect(service.canStartMission()).toBe(false);
    await expect(service.sendCoverageMission()).rejects.toThrow("giro(s) omega");
    expect(startRequest).not.toHaveBeenCalled();
  });

  it("allows omega turns when conflicts are outside the simulated field", async () => {
    const response = safeCoverageResponse();
    const plan = response.coverage_plan as Record<string, unknown>;
    const metrics = plan.metrics as Record<string, unknown>;
    metrics.omega_turn_count = 3;
    metrics.clean_uturn_count = 0;
    metrics.global_topology_conflicts = {
      strict_crossings: 4,
      nonadjacent_touches: 0,
      collinear_overlaps: 0,
      total: 4
    };
    const service = new CoverageService(makeDispatcher(response).dispatcher);
    placeField(service);

    const preview = await service.previewCoverage();

    expect(preview.metrics.topologyScope).toBe("field_interior");
    expect(preview.metrics.topologyConflictCount).toBe(0);
    expect(preview.metrics.globalTopologyConflictCount).toBe(4);
    expect(preview.metrics.omegaTurnCount).toBe(3);
    expect(preview.topologySafe).toBe(true);
    expect(service.canStartMission()).toBe(true);
  });

  it("discards a stale preview response after the field is cleared", async () => {
    const previewResponse = deferred<Nav2IncomingMessage>();
    const previewRequest = vi.fn().mockReturnValue(previewResponse.promise);
    const dispatcher = {
      requestCoveragePreview: previewRequest,
      requestStartCoverage: vi.fn()
    } as unknown as RobotDispatcher;
    const service = new CoverageService(dispatcher);
    placeField(service);

    const pendingPreview = service.previewCoverage();
    expect(service.getState().loading).toBe(true);
    service.clear();
    expect(service.getState().field).toBeNull();
    expect(service.getState().loading).toBe(false);

    previewResponse.resolve(safeCoverageResponse());
    await expect(pendingPreview).rejects.toThrow("descartado");
    expect(service.getState().preview).toBeNull();
    expect(service.getState().fieldPolygon).toEqual([]);
    expect(service.canStartMission()).toBe(false);
  });

  it("invalidates a cached preview when the connection identity changes", async () => {
    const service = new CoverageService(makeDispatcher(safeCoverageResponse()).dispatcher);
    placeField(service);
    await service.previewCoverage();
    expect(service.canStartMission()).toBe(true);

    service.invalidatePreview("Cambió el endpoint de conexión");

    expect(service.getState().field).not.toBeNull();
    expect(service.getState().preview).toBeNull();
    expect(service.getState().lastStatus).toContain("endpoint");
    expect(service.canStartMission()).toBe(false);
  });

  it("does not allow clearing state while start_coverage is pending", async () => {
    const startResponse = deferred<Nav2IncomingMessage>();
    const dispatcher = {
      requestCoveragePreview: vi.fn().mockResolvedValue(safeCoverageResponse()),
      requestStartCoverage: vi.fn().mockReturnValue(startResponse.promise)
    } as unknown as RobotDispatcher;
    const navigationService = {
      getState: () => ({ controlLocked: false, controlLockReason: "", manualMode: false }),
      setManualMode: vi.fn()
    } as unknown as NavigationService;
    const service = new CoverageService(dispatcher, navigationService);
    placeField(service);
    await service.previewCoverage();

    const pendingMission = service.sendCoverageMission();
    expect(service.getState().sending).toBe(true);
    expect(() => service.clear()).toThrow("mientras se está enviando");
    expect(service.getState().preview).not.toBeNull();

    startResponse.resolve({
      op: "ack",
      ok: true,
      route_started: true,
      route_submission_state: "started",
      input_waypoint_count: 4,
      expanded_waypoint_count: 4
    });
    const result = await pendingMission;
    expect(result.inputCount).toBe(4);
    expect(result.expandedCount).toBe(4);
    expect(result.legSpacingM).toBeCloseTo(21, 6);
  });

  it("preserves backend approach rejection details and never reports a start", async () => {
    const backendError = "coverage approach rejected (distance=7.25 m, limit=5.00 m; heading_error=4.0 deg, limit=30.0 deg)";
    const { dispatcher, startRequest } = makeDispatcher(safeCoverageResponse());
    startRequest.mockResolvedValue({
      op: "ack",
      ok: false,
      error: backendError,
      route_started: false,
      route_submission_state: "not_started"
    });
    const service = new CoverageService(dispatcher);
    placeField(service);
    await service.previewCoverage();

    await expect(service.sendCoverageMission()).rejects.toThrow(backendError);
    expect(service.getState().error).toBe(backendError);
    expect(service.getState().lastStatus).toBe("No se pudo iniciar la cobertura");
  });

  it("treats unknown_timeout as uncertain and warns against blind retries", async () => {
    const { dispatcher, startRequest } = makeDispatcher(safeCoverageResponse());
    startRequest.mockResolvedValue({
      op: "ack",
      ok: false,
      error: "set_route_ll timeout",
      route_started: null,
      route_submission_state: "unknown_timeout"
    });
    const service = new CoverageService(dispatcher);
    placeField(service);
    await service.previewCoverage();

    await expect(service.sendCoverageMission()).rejects.toThrow(/incierto.*no reintentar.*consultá o cancelá/i);
    expect(service.getState().error).toContain("set_route_ll timeout");
    expect(service.getState().lastStatus).toContain("Estado de envío incierto");
    expect(startRequest).toHaveBeenCalledTimes(1);
  });

  it("uses bounded dispatcher timeouts with 25 seconds for atomic coverage start", async () => {
    const dispatcher = new RobotDispatcher("dispatcher.test", "transport.test");
    const request = vi
      .spyOn(dispatcher as unknown as { request: (...args: unknown[]) => Promise<Nav2IncomingMessage> }, "request")
      .mockResolvedValue({ op: "ack", ok: true });

    await dispatcher.requestCoveragePreview({ field_length_m: 20 });
    await dispatcher.requestStartCoverage({ field_length_m: 20 });
    await dispatcher.requestRouteMission({ waypoints: [] });

    expect(request).toHaveBeenNthCalledWith(
      1,
      "preview_coverage",
      { field_length_m: 20 },
      { timeoutMs: 15000 }
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "start_coverage",
      { field_length_m: 20 },
      { timeoutMs: 25000 }
    );
    expect(request).toHaveBeenNthCalledWith(
      3,
      "set_route_ll",
      { waypoints: [] },
      { timeoutMs: 15000 }
    );
  });
});

describe("CoverageService.squareFromVehiclePose", () => {
  it("arma el cuadrado desde la pose del vehiculo", () => {
    const { dispatcher } = makeDispatcher();
    const service = new CoverageService(dispatcher);

    const state = service.squareFromVehiclePose(
      { lat: ORIGIN.lat, lon: ORIGIN.lon, yawDeg: 90 },
      { sideM: 30 }
    );

    expect(state.field?.fieldLengthM).toBeCloseTo(30, 3);
    expect(state.field?.fieldWidthM).toBeCloseTo(30, 3);
    expect(state.field?.startYawDeg).toBeCloseTo(90, 3);
    // La esquina NO es la pose del vehiculo: queda corrida media pasada hacia
    // atras y hacia el otro lado, para que el inset del proveedor deje la
    // primera pasada justo bajo el vehiculo (ver el test del inset).
    expect(state.field?.startLat).not.toBeCloseTo(ORIGIN.lat, 9);
    expect(state.field?.side).toBe("left");
    expect(state.fieldPolygon).toHaveLength(4);
    expect(state.preview).toBeNull();
  });

  it("corre la esquina para que el inset del backend caiga sobre el vehiculo", () => {
    const { dispatcher } = makeDispatcher();
    const service = new CoverageService(dispatcher);
    service.setParameters({ cutterWidthM: 5 });

    const state = service.squareFromVehiclePose(
      { lat: ORIGIN.lat, lon: ORIGIN.lon, yawDeg: 0 },
      { sideM: 40 }
    );

    // El proveedor mete la primera pasada media pasada adelante y media al
    // costado de start_lat/lon. Reproducimos ese inset y tiene que dar la pose
    // del vehiculo: si no, arranca en diagonal y con radio minimo hace un rulo.
    const field = state.field!;
    const inset = 2.5;
    const yaw = (field.startYawDeg * Math.PI) / 180;
    const lateralSign = field.side === "left" ? 1 : -1;
    const firstRowStart = offsetPoint(
      { lat: field.startLat, lon: field.startLon },
      Math.cos(yaw) * inset - Math.sin(yaw) * inset * lateralSign,
      Math.sin(yaw) * inset + Math.cos(yaw) * inset * lateralSign
    );

    expect(firstRowStart.lat).toBeCloseTo(ORIGIN.lat, 9);
    expect(firstRowStart.lon).toBeCloseTo(ORIGIN.lon, 9);
    expect(state.vehicleAnchor).toEqual({ lat: ORIGIN.lat, lon: ORIGIN.lon, yawDeg: 0 });
  });

  it("rehace el cuadrado cuando cambia el ancho de corte, para no desalinear el arranque", () => {
    const { dispatcher } = makeDispatcher();
    const service = new CoverageService(dispatcher);
    service.setParameters({ cutterWidthM: 5 });
    service.squareFromVehiclePose({ lat: ORIGIN.lat, lon: ORIGIN.lon, yawDeg: 0 }, { sideM: 40 });
    const cornerWithFive = { ...service.getState().field! };

    service.setParameters({ cutterWidthM: 2 });
    const cornerWithTwo = service.getState().field!;

    // Media pasada menos de inset => la esquina se corre 1.5 m hacia el vehiculo.
    expect(cornerWithTwo.startLat).not.toBeCloseTo(cornerWithFive.startLat, 9);
    expect(cornerWithTwo.fieldLengthM).toBeCloseTo(cornerWithFive.fieldLengthM, 6);
    expect(cornerWithTwo.side).toBe(cornerWithFive.side);
    expect(service.getState().vehicleAnchor).not.toBeNull();
  });

  it("olvida el ancla al limpiar", () => {
    const { dispatcher } = makeDispatcher();
    const service = new CoverageService(dispatcher);
    service.squareFromVehiclePose({ lat: ORIGIN.lat, lon: ORIGIN.lon, yawDeg: 0 }, { sideM: 30 });
    expect(service.getState().vehicleAnchor).not.toBeNull();

    service.clear();
    expect(service.getState().vehicleAnchor).toBeNull();
    expect(service.getState().field).toBeNull();
  });

  it("respeta el lado pedido", () => {
    const { dispatcher } = makeDispatcher();
    const service = new CoverageService(dispatcher);

    const state = service.squareFromVehiclePose(
      { lat: ORIGIN.lat, lon: ORIGIN.lon, yawDeg: 0 },
      { sideM: 25, side: "right" }
    );

    expect(state.field?.side).toBe("right");
    expect(state.field?.fieldWidthM).toBeCloseTo(25, 3);
  });

  it("reusa el lado del campo anterior cuando no se le pasa uno", () => {
    const { dispatcher } = makeDispatcher();
    const service = new CoverageService(dispatcher);
    placeField(service, 18);

    const state = service.squareFromVehiclePose({ lat: ORIGIN.lat, lon: ORIGIN.lon, yawDeg: 45 });

    expect(state.field?.fieldLengthM).toBeCloseTo(18, 3);
  });

  it("rechaza una pose incompleta y un lado que no supera el ancho de corte", () => {
    const { dispatcher } = makeDispatcher();
    const service = new CoverageService(dispatcher);

    expect(() =>
      service.squareFromVehiclePose({ lat: Number.NaN, lon: ORIGIN.lon, yawDeg: 0 })
    ).toThrow(/pose del vehículo/i);
    expect(() =>
      service.squareFromVehiclePose({ lat: ORIGIN.lat, lon: ORIGIN.lon, yawDeg: 0 }, { sideM: 1 })
    ).toThrow(/ancho de corte/i);
  });

  it("invalida el preview anterior para no arrancar sobre un campo viejo", async () => {
    const { dispatcher } = makeDispatcher(safeCoverageResponse());
    const service = new CoverageService(dispatcher);
    placeField(service);
    await service.previewCoverage();
    expect(service.getState().preview).not.toBeNull();

    service.squareFromVehiclePose({ lat: ORIGIN.lat, lon: ORIGIN.lon, yawDeg: 0 }, { sideM: 30 });

    expect(service.getState().preview).toBeNull();
    expect(service.canStartMission()).toBe(false);
  });

  it("expone la estimacion del trazado recien cuando hay campo", () => {
    const { dispatcher } = makeDispatcher();
    const service = new CoverageService(dispatcher);
    expect(service.getLayoutEstimate()).toBeNull();

    service.squareFromVehiclePose({ lat: ORIGIN.lat, lon: ORIGIN.lon, yawDeg: 0 }, { sideM: 20 });
    service.setParameters({ cutterWidthM: 5, overlapRatio: 0, minTurningRadiusM: 4 });

    const estimate = service.getLayoutEstimate();
    expect(estimate?.rowCount).toBe(4);
    expect(estimate?.omegaTurnCount).toBe(3);
  });
});

describe("estimateCoverageLayout", () => {
  // Contrastado contra el backend: generate_coverage_plan_ll devuelve
  // 4 pasadas a 5.00 m y 207.0 m para el primer caso, y 12 pasadas a 1.636 m y
  // 753.9 m para los valores por defecto del panel. El reparto de pasadas y la
  // separacion coinciden exacto; el largo total queda dentro del 0.5 % porque el
  // backend lo suma sobre la poligonal muestreada y aca se usa el arco exacto.
  it("reparte las pasadas igual que el backend", () => {
    const wide = estimateCoverageLayout({
      fieldLengthM: 40,
      fieldWidthM: 20,
      cutterWidthM: 5,
      overlapRatio: 0,
      minTurningRadiusM: 4
    });
    expect(wide.rowCount).toBe(4);
    expect(wide.laneSpacingM).toBeCloseTo(5.0, 6);
    expect(wide.estimatedPathLengthM).toBeGreaterThan(205.5);
    expect(wide.estimatedPathLengthM).toBeLessThan(208.5);

    const tight = estimateCoverageLayout({
      fieldLengthM: 40,
      fieldWidthM: 20,
      cutterWidthM: 2,
      overlapRatio: 0.15,
      minTurningRadiusM: 4
    });
    expect(tight.rowCount).toBe(12);
    expect(tight.laneSpacingM).toBeCloseTo(18 / 11, 6);
    expect(tight.estimatedPathLengthM).toBeGreaterThan(750);
    expect(tight.estimatedPathLengthM).toBeLessThan(758);
  });

  it("marca omega y su desborde cuando la separacion no llega al diametro de giro", () => {
    const estimate = estimateCoverageLayout({
      fieldLengthM: 40,
      fieldWidthM: 20,
      cutterWidthM: 5,
      overlapRatio: 0,
      minTurningRadiusM: 4
    });
    expect(estimate.omegaTurnCount).toBe(3);
    expect(estimate.cleanUturnCount).toBe(0);
    // Geometria del omega medida sobre el plan real: apice a 8.66 m del extremo
    // de pasada y 1.5 m de desborde lateral.
    expect(estimate.headlandClearanceM).toBeCloseTo(8.664, 2);
    expect(estimate.lateralClearanceM).toBeCloseTo(1.5, 6);
  });

  it("usa U limpia sin desborde lateral cuando las pasadas se separan lo suficiente", () => {
    const estimate = estimateCoverageLayout({
      fieldLengthM: 40,
      fieldWidthM: 40,
      cutterWidthM: 10,
      overlapRatio: 0,
      minTurningRadiusM: 4
    });
    expect(estimate.laneSpacingM).toBeGreaterThanOrEqual(8);
    expect(estimate.omegaTurnCount).toBe(0);
    expect(estimate.cleanUturnCount).toBe(estimate.turnCount);
    expect(estimate.lateralClearanceM).toBe(0);
    expect(estimate.headlandClearanceM).toBeCloseTo(4, 6);
  });

  it("no divide por cero cuando el campo no da para mas de una pasada", () => {
    const estimate = estimateCoverageLayout({
      fieldLengthM: 20,
      fieldWidthM: 2,
      cutterWidthM: 2,
      overlapRatio: 0,
      minTurningRadiusM: 4
    });
    expect(estimate.rowCount).toBe(1);
    expect(estimate.turnCount).toBe(0);
    expect(estimate.laneSpacingM).toBe(0);
    expect(estimate.headlandClearanceM).toBe(0);
    expect(Number.isFinite(estimate.estimatedPathLengthM)).toBe(true);
  });
});
