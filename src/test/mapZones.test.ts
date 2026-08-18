import { describe, expect, it, vi } from "vitest";
import { MapService } from "../packages/nav2/modules/map/service/impl/MapService";
import type { MapDispatcher } from "../packages/nav2/modules/map/dispatcher/impl/MapDispatcher";

/** Los cuatro vertices que emite leaflet-draw al cerrar un rectangulo. */
const RECTANGULO = [
  { lat: -31.4859, lon: -64.2425 },
  { lat: -31.4859, lon: -64.2415 },
  { lat: -31.4849, lon: -64.2415 },
  { lat: -31.4849, lon: -64.2425 }
];

function servicio(): { service: MapService; setZones: ReturnType<typeof vi.fn> } {
  const setZones = vi.fn().mockResolvedValue({ ok: true });
  const dispatcher = {
    subscribe: () => () => undefined,
    setZonesGeoJson: setZones
  } as unknown as MapDispatcher;
  const service = new MapService(dispatcher);
  service.setBackendSyncTransportState({ connected: true, host: "127.0.0.1", port: "8080" });
  return { service, setZones };
}

describe("zonas dibujadas a mano", () => {
  it("guarda el rectangulo con sus cuatro vertices y habilitado", () => {
    // El rectangulo de leaflet-draw entra por el mismo camino que el poligono:
    // si esto se rompe, la herramienta nueva deja de crear zonas usables.
    const { service } = servicio();
    const zona = service.addZoneFromPolygon(RECTANGULO);
    expect(zona.vertices).toBe(4);
    expect(zona.enabled).not.toBe(false);
    expect(zona.polygon).toEqual(RECTANGULO);
  });

  it("emite un anillo GeoJSON cerrado y en orden lon/lat", async () => {
    // El backend parsea con `for lon, lat in outer_ll` y exige el anillo
    // cerrado; un rectangulo abierto se descarta en silencio.
    const { service, setZones } = servicio();
    service.addZoneFromPolygon(RECTANGULO);
    await service.pushZonesToBackend();

    const documento = setZones.mock.calls[0][0] as {
      type: string;
      features: Array<{
        properties: { type: string; enabled: boolean };
        geometry: { type: string; coordinates: number[][][] };
      }>;
    };
    expect(documento.type).toBe("FeatureCollection");
    expect(documento.features).toHaveLength(1);

    const feature = documento.features[0];
    expect(feature.properties.type).toBe("no_go");
    expect(feature.properties.enabled).toBe(true);
    const anillo = feature.geometry.coordinates[0];
    expect(anillo).toHaveLength(5);
    expect(anillo[0]).toEqual([RECTANGULO[0].lon, RECTANGULO[0].lat]);
    expect(anillo[4]).toEqual(anillo[0]);
  });

  it("no manda al backend una zona con menos de tres vertices", async () => {
    const { service, setZones } = servicio();
    service.addZoneFromPolygon([RECTANGULO[0], RECTANGULO[1]]);
    await service.pushZonesToBackend();
    const documento = setZones.mock.calls[0][0] as { features: unknown[] };
    expect(documento.features).toHaveLength(0);
  });

  it("marca la zona apagada como enabled:false para el backend", async () => {
    const { service, setZones } = servicio();
    const zona = service.addZoneFromPolygon(RECTANGULO);
    service.toggleZoneEnabled(zona.id);
    await service.pushZonesToBackend();

    const ultima = setZones.mock.calls[setZones.mock.calls.length - 1][0] as {
      features: Array<{ properties: { enabled: boolean } }>;
    };
    expect(ultima.features[0].properties.enabled).toBe(false);
  });
});
