import { describe, expect, it, vi } from "vitest";
import type { Nav2IncomingMessage } from "../packages/nav2/protocol/messages";
import type { RobotDispatcher } from "../packages/nav2/modules/navigation/dispatcher/impl/RobotDispatcher";
import {
  CoverageService,
  isCoverageDraftPlannable,
  type CoverageDraft,
  type CoverageGeoPoint
} from "../packages/nav2/modules/navigation/service/impl/CoverageService";

const ORIGEN: CoverageGeoPoint = { lat: -31.4859, lon: -64.2409 };
const DLAT = 40 / 111_320;
const DLON = 40 / (111_320 * 0.853);

/** Lote en L: lo que un rectangulo no puede representar. */
const EN_L: CoverageGeoPoint[] = [
  { lat: ORIGEN.lat, lon: ORIGEN.lon },
  { lat: ORIGEN.lat, lon: ORIGEN.lon + DLON },
  { lat: ORIGEN.lat + DLAT / 2, lon: ORIGEN.lon + DLON },
  { lat: ORIGEN.lat + DLAT / 2, lon: ORIGEN.lon + DLON / 2 },
  { lat: ORIGEN.lat + DLAT, lon: ORIGEN.lon + DLON / 2 },
  { lat: ORIGEN.lat + DLAT, lon: ORIGEN.lon }
];

const EXCLUSION: CoverageGeoPoint[] = [
  { lat: ORIGEN.lat + DLAT * 0.2, lon: ORIGEN.lon + DLON * 0.2 },
  { lat: ORIGEN.lat + DLAT * 0.2, lon: ORIGEN.lon + DLON * 0.3 },
  { lat: ORIGEN.lat + DLAT * 0.3, lon: ORIGEN.lon + DLON * 0.3 },
  { lat: ORIGEN.lat + DLAT * 0.3, lon: ORIGEN.lon + DLON * 0.2 }
];

function servicio(respuesta?: Nav2IncomingMessage) {
  const previewRequest = vi.fn().mockResolvedValue(respuesta ?? { op: "ack", ok: true });
  const startRequest = vi.fn().mockResolvedValue({ op: "ack", ok: true, route_started: true });
  const dispatcher = {
    requestCoveragePreview: previewRequest,
    requestStartCoverage: startRequest
  } as unknown as RobotDispatcher;
  return { service: new CoverageService(dispatcher), previewRequest, startRequest };
}

function dibujar(service: CoverageService, vertices: CoverageGeoPoint[]): void {
  service.startOutlineDraft();
  for (const vertex of vertices) service.appendDraftVertex(vertex);
  service.finishDraftRing();
}

describe("editor de poligono de CAMPO", () => {
  it("arranca en modo rectangulo y con el borrador vacio", () => {
    const { service } = servicio();
    const state = service.getState();
    expect(state.fieldSource).toBe("rectangle");
    expect(state.draft.outline.vertices).toEqual([]);
    expect(state.draft.exclusions).toEqual([]);
  });

  it("acumula vertices y conserva la geometria dibujada", () => {
    // Seis vertices, no cuatro: el punto del cambio es dejar de rectangulizar.
    const { service } = servicio();
    dibujar(service, EN_L);
    const draft = service.getState().draft;
    expect(draft.outline.vertices).toHaveLength(6);
    expect(draft.outline.vertices).toEqual(EN_L);
    expect(service.getState().fieldSource).toBe("polygon");
  });

  it("no deja previsualizar con menos de 3 vertices", () => {
    const { service } = servicio();
    service.startOutlineDraft();
    service.appendDraftVertex(EN_L[0]);
    service.appendDraftVertex(EN_L[1]);
    expect(service.canPreview()).toBe(false);
    service.appendDraftVertex(EN_L[2]);
    expect(service.canPreview()).toBe(true);
  });

  it("mueve y elimina vertices del contorno", () => {
    const { service } = servicio();
    dibujar(service, EN_L);
    const movido = { lat: ORIGEN.lat + DLAT * 0.9, lon: ORIGEN.lon + DLON * 0.9 };
    service.moveDraftVertex(null, 2, movido);
    expect(service.getState().draft.outline.vertices[2]).toEqual(movido);
    service.removeDraftVertex(null, 0);
    expect(service.getState().draft.outline.vertices).toHaveLength(5);
  });

  it("agrega, dibuja y borra exclusiones", () => {
    const { service } = servicio();
    dibujar(service, EN_L);
    service.startExclusionDraft();
    for (const vertex of EXCLUSION) service.appendDraftVertex(vertex);
    service.finishDraftRing();
    let draft = service.getState().draft;
    expect(draft.exclusions).toHaveLength(1);
    expect(draft.exclusions[0].vertices).toEqual(EXCLUSION);

    service.removeExclusion(draft.exclusions[0].id);
    draft = service.getState().draft;
    expect(draft.exclusions).toHaveLength(0);
  });

  it("no deja abrir una exclusion sin contorno", () => {
    const { service } = servicio();
    expect(() => service.startExclusionDraft()).toThrow(/contorno/i);
  });

  it("una exclusion a medio dibujar bloquea el preview", () => {
    // Mandarla asi la rechazaria el backend y el operador perderia el preview
    // por algo que se ve a simple vista.
    const { service } = servicio();
    dibujar(service, EN_L);
    service.startExclusionDraft();
    service.appendDraftVertex(EXCLUSION[0]);
    expect(service.canPreview()).toBe(false);
    service.appendDraftVertex(EXCLUSION[1]);
    service.appendDraftVertex(EXCLUSION[2]);
    expect(service.canPreview()).toBe(true);
  });

  it("limpiar vuelve al lote rectangular", () => {
    const { service } = servicio();
    dibujar(service, EN_L);
    service.clearDraft();
    const state = service.getState();
    expect(state.fieldSource).toBe("rectangle");
    expect(state.draft.outline.vertices).toEqual([]);
  });

  it("serializa el anillo ABIERTO y sin los id", async () => {
    const { service, previewRequest } = servicio();
    dibujar(service, EN_L);
    service.startExclusionDraft();
    for (const vertex of EXCLUSION) service.appendDraftVertex(vertex);
    service.finishDraftRing();
    await service.previewCoverage().catch(() => undefined);

    const payload = previewRequest.mock.calls[0][0] as Record<string, unknown>;
    const poly = payload.coverage_polygon as { vertices: CoverageGeoPoint[] };
    // Abierto: 6 vertices, no 7. Repetir el primero seria contar uno de mas.
    expect(poly.vertices).toHaveLength(6);
    expect(poly.vertices[0]).not.toEqual(poly.vertices[poly.vertices.length - 1]);
    expect(JSON.stringify(payload)).not.toContain("\"id\"");
    expect(JSON.stringify(payload)).not.toContain("ring.");

    const excls = payload.coverage_exclusions as Array<{ vertices: CoverageGeoPoint[] }>;
    expect(excls).toHaveLength(1);
    expect(excls[0].vertices).toHaveLength(4);
  });

  it("en modo rectangulo NO manda poligono", async () => {
    // La compatibilidad legacy: un lote cuadrado tiene que seguir viajando sin
    // los campos nuevos.
    const { service, previewRequest } = servicio();
    service.squareFromVehiclePose({ lat: ORIGEN.lat, lon: ORIGEN.lon, yawDeg: 0 }, { sideM: 20 });
    await service.previewCoverage().catch(() => undefined);
    const payload = previewRequest.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.coverage_polygon).toBeUndefined();
    expect(payload.coverage_exclusions).toBeUndefined();
  });

  it("mover un vertice invalida el preview", () => {
    const { service } = servicio();
    dibujar(service, EN_L);
    service.moveDraftVertex(null, 0, { lat: ORIGEN.lat - DLAT, lon: ORIGEN.lon });
    expect(service.getState().preview).toBeNull();
  });

  it("el estado derivado no se guarda duplicado", () => {
    // isCoverageDraftPlannable es una funcion sobre el borrador: no puede haber
    // un booleano en el estado que se desincronice de los vertices.
    const { service } = servicio();
    dibujar(service, EN_L);
    const state = service.getState() as unknown as Record<string, unknown>;
    for (const clave of ["polygonValid", "isValid", "canPreview", "canStart"]) {
      expect(state[clave]).toBeUndefined();
    }
    expect(isCoverageDraftPlannable(service.getState().draft)).toBe(true);
  });

  it("getState devuelve una copia del borrador", () => {
    const { service } = servicio();
    dibujar(service, EN_L);
    const draft: CoverageDraft = service.getState().draft;
    draft.outline.vertices.push({ lat: 0, lon: 0 });
    expect(service.getState().draft.outline.vertices).toHaveLength(6);
  });
});


describe("armar lote desde el vehiculo", () => {
  const POSE = { lat: ORIGEN.lat, lon: ORIGEN.lon, yawDeg: 0 };

  it("siembra un poligono de 4 vertices, no el cuadrado legacy", () => {
    // Tener las dos representaciones vivas al mismo tiempo confunde: el
    // operador arma un cuadrado, dibuja un poligono encima, y despues no sabe
    // cual se va a trabajar.
    const { service } = servicio();
    service.seedPolygonFromVehiclePose(POSE, { sideM: 40 });
    const state = service.getState();
    expect(state.fieldSource).toBe("polygon");
    expect(state.draft.outline.vertices).toHaveLength(4);
    expect(state.field).toBeNull();
    expect(state.fieldPolygon).toEqual([]);
  });

  it("el lote sembrado se puede editar como cualquier poligono", () => {
    const { service } = servicio();
    service.seedPolygonFromVehiclePose(POSE, { sideM: 40 });
    const movido = { lat: ORIGEN.lat + DLAT, lon: ORIGEN.lon + DLON };
    service.moveDraftVertex(null, 0, movido);
    expect(service.getState().draft.outline.vertices[0]).toEqual(movido);
    service.appendDraftVertex(movido);
    expect(service.getState().draft.outline.vertices).toHaveLength(4);
    service.startOutlineDraft();
    expect(service.getState().draft.outline.vertices).toEqual([]);
  });

  it("el lote sembrado viaja como poligono, no como rectangulo", async () => {
    const { service, previewRequest } = servicio();
    service.seedPolygonFromVehiclePose(POSE, { sideM: 40 });
    expect(service.canPreview()).toBe(true);
    await service.previewCoverage().catch(() => undefined);
    const payload = previewRequest.mock.calls[0][0] as Record<string, unknown>;
    const poly = payload.coverage_polygon as { vertices: CoverageGeoPoint[] };
    expect(poly.vertices).toHaveLength(4);
  });

  it("squareFromVehiclePose sigue existiendo para el modo legacy", () => {
    // No se rompe: el backend mantiene el rectangulo para llamadas viejas.
    const { service } = servicio();
    service.squareFromVehiclePose(POSE, { sideM: 40 });
    const state = service.getState();
    expect(state.fieldSource).toBe("rectangle");
    expect(state.fieldPolygon).toHaveLength(4);
  });
});
