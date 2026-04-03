import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet-draw";
import "leaflet-draw/dist/leaflet.draw.css";
import { NAV_EVENTS } from "../../core/events/topics";
import type { CockpitModule, ModuleContext } from "../../core/types/module";
import { MapDispatcher } from "../../dispatcher/impl/MapDispatcher";
import { ConnectionService, type ConnectionState } from "../../services/impl/ConnectionService";
import { MapService, type MapToolMode, type MapWorkspaceState } from "../../services/impl/MapService";
import { NavigationService, type NavigationState } from "../../services/impl/NavigationService";

const TRANSPORT_ID = "transport.ws.core";
const DISPATCHER_ID = "dispatcher.map";
const SERVICE_ID = "service.map";
const NAVIGATION_SERVICE_ID = "service.navigation";
const CONNECTION_SERVICE_ID = "service.connection";

function ZonesSidebarPanel({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const service = runtime.registries.serviceRegistry.getService<MapService>(SERVICE_ID);
  const [state, setState] = useState<MapWorkspaceState>(service.getState());
  const [zoneName, setZoneName] = useState("");

  useEffect(() => service.subscribe((next) => setState(next)), [service]);

  return (
    <div className="stack">
      <div className="panel-card">
        <h3>Zones</h3>
        <p className="muted">Gestion de zonas editable separada del transport.</p>
        <div className="action-grid">
          <button
            type="button"
            onClick={async () => {
              try {
                await service.loadMap("map");
                runtime.eventBus.emit("console.event", {
                  level: "info",
                  text: "Zones refreshed",
                  timestamp: Date.now()
                });
              } catch (error) {
                runtime.eventBus.emit("console.event", {
                  level: "error",
                  text: `Refresh failed: ${String(error)}`,
                  timestamp: Date.now()
                });
              }
            }}
          >
            Refresh
          </button>
          <button
            type="button"
            className="danger-btn"
            onClick={() => {
              if (typeof window !== "undefined") {
                const ok = window.confirm(`Clear all ${state.zones.length} no-go zones?`);
                if (!ok) return;
              }
              service.clearZones();
              runtime.eventBus.emit("console.event", {
                level: "warn",
                text: "Zones cleared",
                timestamp: Date.now()
              });
            }}
          >
            Clear
          </button>
        </div>
        <div className="action-grid">
          <button
            type="button"
            onClick={async () => {
              try {
                await service.pushZonesToBackend();
                const count = service.persistZonesToStorage();
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
            Save
          </button>
          <button
            type="button"
            onClick={async () => {
              try {
                const count = service.loadZonesFromStorage();
                await service.loadZonesFromBackend();
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
            Load
          </button>
        </div>
        <label className="check-row">
          <input type="checkbox" checked={state.autoSync} onChange={(event) => service.setAutoSync(event.target.checked)} />
          Auto-sync edits
        </label>
        <div className="row">
          <input
            className="grow"
            value={zoneName}
            onChange={(event) => setZoneName(event.target.value)}
            placeholder="Zone name"
          />
          <button
            type="button"
            onClick={() => {
              const zone = service.addZone(zoneName);
              setZoneName("");
              runtime.eventBus.emit("console.event", {
                level: "info",
                text: `Zone added: ${zone.name}`,
                timestamp: Date.now()
              });
            }}
          >
            Add
          </button>
        </div>
      </div>
      <div className="panel-card">
        <h4>Zone List</h4>
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
                <button type="button" className="danger-btn" onClick={() => service.removeZone(zone.id)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function toolButtonClass(current: MapToolMode, target: MapToolMode): string {
  return current === target ? "active" : "";
}

function extractPolygonLatLon(layer: L.Polygon): Array<{ lat: number; lon: number }> {
  const latLngs = layer.getLatLngs();
  const ring = Array.isArray(latLngs[0]) ? (latLngs[0] as L.LatLng[]) : [];
  return ring.map((entry) => ({ lat: entry.lat, lon: entry.lng }));
}

function LeafletMapCanvas({
  state,
  mapService,
  runtime,
  interactive
}: {
  state: MapWorkspaceState;
  mapService: MapService;
  runtime: ModuleContext;
  interactive: boolean;
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const drawnItemsRef = useRef<L.FeatureGroup | null>(null);
  const syncFromServiceRef = useRef(false);

  useEffect(() => {
    if (!hostRef.current || mapRef.current) return;
    const map = L.map(hostRef.current, { zoomControl: true }).setView([-31.421785, -64.102448], 16);
    L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      {
        maxZoom: 26,
        maxNativeZoom: 19,
        detectRetina: true,
        attribution: "Tiles © Esri"
      }
    ).addTo(map);

    const drawnItems = new L.FeatureGroup();
    map.addLayer(drawnItems);
    mapRef.current = map;
    drawnItemsRef.current = drawnItems;

    const drawControl = new L.Control.Draw({
      edit: {
        featureGroup: drawnItems
      },
      draw: {
        polyline: false,
        rectangle: false,
        circle: false,
        marker: false,
        circlemarker: false,
        polygon: {}
      }
    });
    map.addControl(drawControl);

    map.on(L.Draw.Event.CREATED, (event) => {
      if (state.toolMode !== "idle") return;
      const layer = event.layer;
      if (!(layer instanceof L.Polygon)) return;
      const polygon = extractPolygonLatLon(layer);
      const zone = mapService.addZoneFromPolygon(polygon);
      (layer as L.Polygon & { zoneId?: string }).zoneId = zone.id;
      drawnItems.addLayer(layer);
      if (mapService.getState().autoSync) {
        void mapService.pushZonesToBackend().catch((error) => {
          runtime.eventBus.emit("console.event", {
            level: "error",
            text: `set_zones_geojson failed: ${String(error)}`,
            timestamp: Date.now()
          });
        });
      }
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
      if (mapService.getState().autoSync) {
        void mapService.pushZonesToBackend().catch(() => undefined);
      }
    });

    map.on(L.Draw.Event.DELETED, (event: L.LeafletEvent) => {
      const layers = (event as unknown as { layers?: L.LayerGroup }).layers;
      if (!layers) return;
      layers.eachLayer((layer) => {
        if (!(layer instanceof L.Polygon)) return;
        const zoneId = (layer as L.Polygon & { zoneId?: string }).zoneId;
        if (!zoneId) return;
        mapService.removeZone(zoneId);
      });
      if (mapService.getState().autoSync) {
        void mapService.pushZonesToBackend().catch(() => undefined);
      }
    });

    map.on("click", (evt: L.LeafletMouseEvent) => {
      if (mapService.getState().toolMode !== "inspect") return;
      mapService.setInspectCoords(evt.latlng.lat, evt.latlng.lng);
      const popup = L.popup()
        .setLatLng(evt.latlng)
        .setContent(
          `<div class="map-inspect-popup"><div>${evt.latlng.lat.toFixed(6)}, ${evt.latlng.lng.toFixed(6)}</div></div>`
        );
      popup.openOn(map);
    });

    return () => {
      map.remove();
      mapRef.current = null;
      drawnItemsRef.current = null;
    };
  }, [mapService, runtime.eventBus, state.toolMode]);

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
    if (state.map && Number.isFinite(state.map.originLat) && Number.isFinite(state.map.originLon)) {
      map.setView([state.map.originLat, state.map.originLon], map.getZoom());
    }
  }, [state.map]);

  useEffect(() => {
    const drawnItems = drawnItemsRef.current;
    if (!drawnItems) return;
    syncFromServiceRef.current = true;
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
        mapService.toggleZoneEnabled(zone.id);
      });
      drawnItems.addLayer(layer);
    });
    syncFromServiceRef.current = false;
  }, [mapService, state.zones]);

  return <div ref={hostRef} className="leaflet-host map-host-canvas" />;
}

function MapWorkspaceView({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const mapService = runtime.registries.serviceRegistry.getService<MapService>(SERVICE_ID);
  let navigationService: NavigationService | null = null;
  try {
    navigationService = runtime.registries.serviceRegistry.getService<NavigationService>(NAVIGATION_SERVICE_ID);
  } catch {
    navigationService = null;
  }
  let connectionService: ConnectionService | null = null;
  try {
    connectionService = runtime.registries.serviceRegistry.getService<ConnectionService>(CONNECTION_SERVICE_ID);
  } catch {
    connectionService = null;
  }
  const [state, setState] = useState<MapWorkspaceState>(mapService.getState());
  const [mainPane, setMainPane] = useState<"map" | "camera">("map");
  const [controlsLocked, setControlsLocked] = useState(true);
  const [frameSrc, setFrameSrc] = useState("");
  const [frameReady, setFrameReady] = useState(false);
  const [navigationState, setNavigationState] = useState<NavigationState | null>(
    navigationService ? navigationService.getState() : null
  );
  const [connectionState, setConnectionState] = useState<ConnectionState | null>(
    connectionService ? connectionService.getState() : null
  );

  useEffect(() => mapService.subscribe((next) => setState(next)), [mapService]);
  useEffect(() => {
    void mapService.loadMap("default-map").catch(() => undefined);
  }, [mapService]);
  useEffect(() => {
    if (!navigationService) return;
    return navigationService.subscribe((next) => setNavigationState(next));
  }, [navigationService]);
  useEffect(() => {
    if (!connectionService) return;
    return connectionService.subscribe((next) => setConnectionState(next));
  }, [connectionService]);
  useEffect(() => {
    return runtime.eventBus.on(NAV_EVENTS.swapWorkspaceRequest, () => {
      setMainPane((current) => (current === "map" ? "camera" : "map"));
    });
  }, [runtime]);

  const mainIsMap = mainPane === "map";
  const cameraEnabled = connectionService?.isCameraEnabled() ?? false;
  const cameraUrl = connectionService?.getCameraIframeUrl() ?? "";
  const cameraStreamConnected = navigationState?.cameraStreamConnected === true;
  const mapControlsEnabled = mainIsMap && !controlsLocked;

  useEffect(() => {
    if (!cameraStreamConnected || !cameraEnabled || !cameraUrl) {
      setFrameSrc("");
      setFrameReady(false);
      return;
    }
    const separator = cameraUrl.includes("?") ? "&" : "?";
    setFrameSrc(`${cameraUrl}${separator}_ts=${Date.now()}`);
    setFrameReady(false);
  }, [cameraEnabled, cameraStreamConnected, cameraUrl]);

  useEffect(() => {
    if (mainIsMap) return;
    if (state.toolMode === "idle") return;
    mapService.setToolMode("idle");
  }, [mainIsMap, mapService, state.toolMode]);

  const cameraOverlayText = !cameraEnabled
    ? connectionState?.preset === "sim"
      ? "camera disabled in sim"
      : "camera unavailable"
    : !cameraStreamConnected
      ? "camara desconectada"
      : frameReady
        ? ""
        : "camera connecting";

  const selectTool = (tool: MapToolMode, infoLabel: string): void => {
    if (!mapControlsEnabled) {
      runtime.eventBus.emit("console.event", {
        level: "warn",
        text: "Map tools available only with map as main view and controls unlocked",
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

  return (
    <div className="map-workspace-root">
      <div className={`stage map-stage ${mainIsMap ? "mode-gps-main" : "mode-camera-main"}`}>
        <section className={`stage-pane ${mainIsMap ? "main" : "mini"} map-stage-pane`}>
          <h4>Map</h4>
          <div className="map-canvas map-pane-canvas">
            <LeafletMapCanvas state={state} mapService={mapService} runtime={runtime} interactive={mapControlsEnabled} />
            <div className={`map-overlay-tools ${mainIsMap ? "" : "hidden"}`}>
              <div className="map-tool-status">{state.toolInfo}</div>
              <div className="map-toolbar map-toolbar-icons">
                <button
                  type="button"
                  className={toolButtonClass(state.toolMode, "ruler")}
                  onClick={() => selectTool("ruler", "ruler")}
                  title="Ruler"
                  aria-label="Ruler"
                  disabled={!mapControlsEnabled}
                >
                  📏
                </button>
                <button
                  type="button"
                  className={toolButtonClass(state.toolMode, "area")}
                  onClick={() => selectTool("area", "area")}
                  title="Area"
                  aria-label="Area"
                  disabled={!mapControlsEnabled}
                >
                  📐
                </button>
                <button
                  type="button"
                  className={toolButtonClass(state.toolMode, "inspect")}
                  onClick={() => selectTool("inspect", "inspect")}
                  title="Inspect"
                  aria-label="Inspect"
                  disabled={!mapControlsEnabled}
                >
                  📍
                </button>
                <button
                  type="button"
                  onClick={() => {
                    mapService.centerRobot();
                    runtime.eventBus.emit("console.event", {
                      level: "info",
                      text: "Map centered on robot",
                      timestamp: Date.now()
                    });
                  }}
                  title="Center robot"
                  aria-label="Center robot"
                  disabled={!mapControlsEnabled}
                >
                  🎯
                </button>
                <button
                  type="button"
                  onClick={() => {
                    mapService.setDatumFromRobot();
                    runtime.eventBus.emit("console.event", {
                      level: "info",
                      text: "Datum updated from robot pose",
                      timestamp: Date.now()
                    });
                  }}
                  title="Set datum"
                  aria-label="Set datum"
                  disabled={!mapControlsEnabled}
                >
                  🧲
                </button>
                <button
                  type="button"
                  onClick={() => selectTool("idle", "idle")}
                  title="Close tools"
                  aria-label="Close tools"
                  disabled={!mapControlsEnabled}
                >
                  ❌
                </button>
              </div>
            </div>
          </div>
        </section>
        <section className={`stage-pane ${mainIsMap ? "mini" : "main"} map-camera-stage-pane`}>
          <h4>Camera</h4>
          <div className="camera-frame-wrap">
            <iframe
              className="camera-frame"
              src={frameSrc}
              title="Camera feed"
              loading="lazy"
              onLoad={() => setFrameReady(true)}
            />
            {cameraOverlayText ? <div className="camera-overlay visible">{cameraOverlayText}</div> : null}
          </div>
        </section>
        <button type="button" className="swap-btn" onClick={() => setMainPane(mainIsMap ? "camera" : "map")}>
          🔄
        </button>
        {controlsLocked ? (
          <div className="view-stage-unlock-overlay">
            <button type="button" className="view-stage-unlock-btn" onClick={() => setControlsLocked(false)}>
              <span className="view-stage-unlock-icon" aria-hidden="true">
                🔒
              </span>
              <span>Desbloquear</span>
            </button>
          </div>
        ) : (
          <div className="stage-actions">
            <button
              type="button"
              disabled={!navigationService || !cameraEnabled}
              onClick={() => {
                if (!navigationService) return;
                const connected = navigationService.toggleCameraStream();
                runtime.eventBus.emit("console.event", {
                  level: "info",
                  text: connected ? "Camera stream connected" : "Camera stream disconnected",
                  timestamp: Date.now()
                });
              }}
            >
              {cameraStreamConnected ? "Disconnect camera" : "Connect camera"}
            </button>
            <button type="button" onClick={() => setControlsLocked(true)}>
              Lock controls
            </button>
          </div>
        )}
        {mainIsMap ? null : <div className="stage-gps-mini-badge">Map minimapa</div>}
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
      ctx.registries.dispatcherRegistry.registerDispatcher({
        id: dispatcher.id,
        order: 30,
        dispatcher
      });

      const service = new MapService(dispatcher);
      ctx.registries.serviceRegistry.registerService({
        id: SERVICE_ID,
        order: 30,
        service
      });

      ctx.registries.sidebarPanelRegistry.registerSidebarPanel({
        id: "sidebar.zones",
        label: "Zones",
        order: 20,
        render: (runtime) => <ZonesSidebarPanel runtime={runtime} />
      });

      ctx.registries.workspaceViewRegistry.registerWorkspaceView({
        id: "workspace.map",
        label: "Map",
        order: 10,
        render: (runtime) => <MapWorkspaceView runtime={runtime} />
      });
    }
  };
}
