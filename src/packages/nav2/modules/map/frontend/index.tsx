import { useEffect, useMemo, useRef, useState } from "react";
import "./styles.css";
import { CORE_EVENTS, NAV_EVENTS } from "../../../../../core/events/topics";
import type { CockpitModule, ModuleContext } from "../../../../../core/types/module";
import { MapDispatcher } from "../dispatcher/impl/MapDispatcher";
import { ConnectionService, type ConnectionState } from "../../navigation/service/impl/ConnectionService";
import { MapService, type MapToolMode, type MapWorkspaceState } from "../service/impl/MapService";
import { NavigationService, type NavigationState } from "../../navigation/service/impl/NavigationService";
import type { SensorInfoService, SensorInfoState } from "../../navigation/service/impl/SensorInfoService";
import type { TelemetrySnapshot } from "../../telemetry/service/impl/TelemetryService";
import { GoogleMapsLoadError, loadGoogleMapsApi } from "./googleMapsLoader";
import { MapEngine, type GoogleMapType, type MapEngineCallbacks, type ZoneEditMode } from "./mapEngine";

const TRANSPORT_ID = "transport.ws.core";
const DISPATCHER_ID = "dispatcher.map";
const SERVICE_ID = "service.map";
const NAVIGATION_SERVICE_ID = "service.navigation";
const CONNECTION_SERVICE_ID = "service.connection";
const TELEMETRY_SERVICE_ID = "service.telemetry";
const SENSOR_INFO_SERVICE_ID = "service.sensor-info";
const GPS_DEFAULT_ZOOM = 16;
const GPS_DEFAULT_CENTER: [number, number] = [-31.4201, -64.1888];

interface Nav2MapConfig {
  map_default_center_lat?: unknown;
  map_default_center_lon?: unknown;
  map_default_zoom?: unknown;
  map_default_type?: unknown;
  camera_probe_timeout_ms?: unknown;
  camera_load_timeout_ms?: unknown;
}

interface TelemetryServiceLike {
  getSnapshot: () => TelemetrySnapshot;
  subscribeTelemetry: (callback: (snapshot: TelemetrySnapshot) => void) => () => void;
}

function readNav2MapConfig(runtime: ModuleContext): Nav2MapConfig {
  return runtime.getPackageConfig<Record<string, unknown>>("nav2") as Nav2MapConfig;
}

function parseFinite(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseCenter(config: Nav2MapConfig): [number, number] {
  const lat = parseFinite(config.map_default_center_lat, GPS_DEFAULT_CENTER[0]);
  const lon = parseFinite(config.map_default_center_lon, GPS_DEFAULT_CENTER[1]);
  return [Math.max(-90, Math.min(90, lat)), Math.max(-180, Math.min(180, lon))];
}

function parseZoom(config: Nav2MapConfig): number {
  const parsed = Math.round(parseFinite(config.map_default_zoom, GPS_DEFAULT_ZOOM));
  return Math.max(0, Math.min(22, parsed));
}

function parseMapType(config: Nav2MapConfig): GoogleMapType {
  const value = String(config.map_default_type ?? "hybrid").trim().toLowerCase();
  return value === "roadmap" ? "roadmap" : "hybrid";
}

function parseCameraProbeTimeout(config: Nav2MapConfig, runtime: ModuleContext): number {
  const fallback = Math.max(500, Number(runtime.env.cameraProbeTimeoutMs ?? 3000));
  const parsed = Number(config.camera_probe_timeout_ms);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(500, Math.round(parsed));
}

function parseCameraLoadTimeout(config: Nav2MapConfig, runtime: ModuleContext): number {
  const fallback = Math.max(1000, Number(runtime.env.cameraLoadTimeoutMs ?? 7000));
  const parsed = Number(config.camera_load_timeout_ms);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1000, Math.round(parsed));
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

function mapTypeButtonClass(current: GoogleMapType, target: GoogleMapType): string {
  return current === target ? "active" : "";
}

function zoneButtonClass(current: ZoneEditMode, target: ZoneEditMode): string {
  return current === target ? "active" : "";
}

function toMapErrorText(error: unknown): string {
  if (error instanceof GoogleMapsLoadError) return error.message;
  return String(error);
}

export function GoogleMapCanvas({
  active,
  state,
  mapService,
  runtime,
  interactive,
  goalMode,
  zoneEditMode,
  mapType,
  waypoints,
  selectedWaypointIndexes,
  robotPose,
  datumPose,
  centerRequestKey,
  onQueueWaypoint,
  onToggleWaypointSelection,
  onMoveWaypoint,
  onZoneCreate,
  onZonePolygonChange,
  onZoneDelete,
  onZoneToggle,
  initialCenterLat,
  initialCenterLon,
  initialZoom
}: {
  active: boolean;
  state: MapWorkspaceState;
  mapService: MapService;
  runtime: ModuleContext;
  interactive: boolean;
  goalMode: boolean;
  zoneEditMode: ZoneEditMode;
  mapType: GoogleMapType;
  waypoints: NavigationState["waypoints"];
  selectedWaypointIndexes: number[];
  robotPose: TelemetrySnapshot["robotPose"];
  datumPose: { lat: number; lon: number } | null;
  centerRequestKey: number;
  onQueueWaypoint: (lat: number, lon: number, yawDeg: number) => void;
  onToggleWaypointSelection: (index: number) => void;
  onMoveWaypoint: (index: number, lat: number, lon: number) => void;
  onZoneCreate: (polygon: Array<{ lat: number; lon: number }>) => void;
  onZonePolygonChange: (zoneId: string, polygon: Array<{ lat: number; lon: number }>) => void;
  onZoneDelete: (zoneId: string) => void;
  onZoneToggle: (zoneId: string) => void;
  initialCenterLat: number;
  initialCenterLon: number;
  initialZoom: number;
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<MapEngine | null>(null);
  const loadInFlightRef = useRef(false);
  const unmountedRef = useRef(false);
  const centerRequestHandledRef = useRef(0);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "ready" | "error">(active ? "loading" : "idle");
  const [loadError, setLoadError] = useState("");

  const callbacksRef = useRef<{
    onQueueWaypoint: (lat: number, lon: number, yawDeg: number) => void;
    onToggleWaypointSelection: (index: number) => void;
    onMoveWaypoint: (index: number, lat: number, lon: number) => void;
    onZoneCreate: (polygon: Array<{ lat: number; lon: number }>) => void;
    onZonePolygonChange: (zoneId: string, polygon: Array<{ lat: number; lon: number }>) => void;
    onZoneDelete: (zoneId: string) => void;
    onZoneToggle: (zoneId: string) => void;
  }>({
    onQueueWaypoint,
    onToggleWaypointSelection,
    onMoveWaypoint,
    onZoneCreate,
    onZonePolygonChange,
    onZoneDelete,
    onZoneToggle
  });

  callbacksRef.current = {
    onQueueWaypoint,
    onToggleWaypointSelection,
    onMoveWaypoint,
    onZoneCreate,
    onZonePolygonChange,
    onZoneDelete,
    onZoneToggle
  };

  useEffect(
    () => () => {
      unmountedRef.current = true;
      if (engineRef.current) {
        engineRef.current.destroy();
        engineRef.current = null;
      }
    },
    []
  );

  useEffect(() => {
    if (!active) {
      if (!engineRef.current && loadState !== "error") {
        setLoadState("idle");
      }
      return;
    }
    if (engineRef.current || loadInFlightRef.current) {
      if (engineRef.current) {
        setLoadState("ready");
      }
      return;
    }

    const apiKey = String(runtime.env.googleMapsApiKey ?? "").trim();
    if (!apiKey) {
      setLoadState("error");
      setLoadError("Missing VITE_GOOGLE_MAPS_API_KEY. Map disabled.");
      return;
    }
    if (!hostRef.current) return;

    let cancelled = false;
    loadInFlightRef.current = true;
    setLoadState("loading");
    setLoadError("");

    void loadGoogleMapsApi(apiKey)
      .then((maps) => {
        if (cancelled || unmountedRef.current) return;
        if (!hostRef.current) {
          setLoadState("error");
          setLoadError("Map host unavailable");
          return;
        }

        const callbacks: MapEngineCallbacks = {
          onToolInfo: (text) => {
            mapService.setToolInfo(text);
          },
          onInspectCoords: (lat, lon) => {
            mapService.setInspectCoords(lat, lon);
          },
          onInspectCopied: (coordsText) => {
            runtime.eventBus.emit("console.event", {
              level: "info",
              text: `Inspect copied: ${coordsText}`,
              timestamp: Date.now()
            });
          },
          onQueueWaypoint: (lat, lon, yawDeg) => callbacksRef.current.onQueueWaypoint(lat, lon, yawDeg),
          onToggleWaypointSelection: (index) => callbacksRef.current.onToggleWaypointSelection(index),
          onMoveWaypoint: (index, lat, lon) => callbacksRef.current.onMoveWaypoint(index, lat, lon),
          onZoneCreate: (polygon) => callbacksRef.current.onZoneCreate(polygon),
          onZonePolygonChange: (zoneId, polygon) => callbacksRef.current.onZonePolygonChange(zoneId, polygon),
          onZoneDelete: (zoneId) => callbacksRef.current.onZoneDelete(zoneId),
          onZoneToggle: (zoneId) => callbacksRef.current.onZoneToggle(zoneId)
        };

        const engine = new MapEngine({
          maps,
          host: hostRef.current,
          initialCenterLat,
          initialCenterLon,
          initialZoom,
          interactive: active ? interactive : false,
          mapType,
          callbacks
        });

        engineRef.current = engine;
        setLoadState("ready");
      })
      .catch((error) => {
        if (cancelled || unmountedRef.current) return;
        setLoadState("error");
        setLoadError(toMapErrorText(error));
      })
      .finally(() => {
        loadInFlightRef.current = false;
      });

    return () => {
      cancelled = true;
    };
  }, [active, mapService, runtime.env.googleMapsApiKey, runtime.eventBus]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.setInteractive(active ? interactive : false);
  }, [active, interactive]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    if (!active) return;
    engine.setMapType(mapType);
  }, [active, mapType]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    if (!active) return;
    engine.setToolMode(state.toolMode);
  }, [active, state.toolMode]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    if (!active) return;
    engine.setGoalMode(goalMode);
  }, [active, goalMode]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    if (!active) return;
    engine.setZoneEditMode(zoneEditMode);
  }, [active, zoneEditMode]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    if (!active) return;
    engine.setZones(state.zones);
  }, [active, state.zones]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    if (!active) return;
    engine.setWaypoints(waypoints, selectedWaypointIndexes);
  }, [active, waypoints, selectedWaypointIndexes]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    if (!active) return;
    engine.setRobotPose(robotPose ? { lat: robotPose.lat, lon: robotPose.lon, headingDeg: robotPose.headingDeg } : null);
  }, [active, robotPose]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    if (!active) return;
    engine.setDatumPose(datumPose);
  }, [active, datumPose]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    if (!active) return;
    if (!state.map) return;
    engine.setMapOrigin(state.map.mapId, state.map.originLat, state.map.originLon);
  }, [active, state.map?.mapId, state.map?.originLat, state.map?.originLon]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    if (!active) return;
    if (!robotPose || centerRequestKey <= 0) return;
    if (centerRequestHandledRef.current === centerRequestKey) return;
    centerRequestHandledRef.current = centerRequestKey;
    engine.centerOnRobot(17);
  }, [active, centerRequestKey, robotPose]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    if (!active) return;
    engine.setInitialView(initialCenterLat, initialCenterLon, initialZoom);
  }, [active, initialCenterLat, initialCenterLon, initialZoom]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      engineRef.current?.invalidateSize();
    });
    observer.observe(host);
    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (active && (state.toolMode !== "idle" || goalMode || zoneEditMode === "create")) {
      host.classList.add("map-tool-pointer");
    } else {
      host.classList.remove("map-tool-pointer");
    }
    return () => {
      host.classList.remove("map-tool-pointer");
    };
  }, [active, goalMode, state.toolMode, zoneEditMode]);

  return (
    <div className={`google-host-wrap ${active ? "" : "is-hidden"}`}>
      <div ref={hostRef} className="google-host map-host-canvas" />
      {active && loadState === "loading" ? <div className="map-overlay-message">Loading Google Maps...</div> : null}
      {active && loadState === "error" ? <div className="map-overlay-message error">{loadError || "Google Maps unavailable"}</div> : null}
    </div>
  );
}

export function MapWorkspaceView({ runtime, active = true }: { runtime: ModuleContext; active?: boolean }): JSX.Element {
  const [nav2Config, setNav2Config] = useState<Nav2MapConfig>(() => readNav2MapConfig(runtime));
  const mapService = runtime.services.getService<MapService>(SERVICE_ID);

  let navigationService: NavigationService | null = null;
  try {
    navigationService = runtime.services.getService<NavigationService>(NAVIGATION_SERVICE_ID);
  } catch {
    navigationService = null;
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
  const [mainPane, setMainPane] = useState<"map" | "camera">(() =>
    connectionService?.isCameraEnabled() ? "camera" : "map"
  );
  const [frameSrc, setFrameSrc] = useState("");
  const [frameReady, setFrameReady] = useState(false);
  const [cameraStreamPending, setCameraStreamPending] = useState<"idle" | "connecting">("idle");
  const [cameraConnectError, setCameraConnectError] = useState("");
  const [centerRequestKey, setCenterRequestKey] = useState(0);
  const [navigationState, setNavigationState] = useState<NavigationState | null>(
    navigationService ? navigationService.getState() : null
  );
  const [connectionState, setConnectionState] = useState<ConnectionState | null>(
    connectionService ? connectionService.getState() : null
  );
  const [telemetrySnapshot, setTelemetrySnapshot] = useState<TelemetrySnapshot | null>(
    telemetryService ? telemetryService.getSnapshot() : null
  );
  const [sensorInfoState, setSensorInfoState] = useState<SensorInfoState | null>(
    sensorInfoService ? sensorInfoService.getState() : null
  );
  const [zoneEditMode, setZoneEditMode] = useState<ZoneEditMode>("idle");
  const [mapType, setMapType] = useState<GoogleMapType>(() => parseMapType(nav2Config));

  const wasConnectedRef = useRef(false);
  const pendingCenterOnConnectRef = useRef(false);
  const cameraStreamSeqRef = useRef(0);
  const cameraLoadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const zoneSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => mapService.subscribe((next) => setState(next)), [mapService]);

  useEffect(() => {
    return runtime.eventBus.on<{ packageId?: unknown; config?: unknown }>(CORE_EVENTS.packageConfigUpdated, (payload) => {
      const packageId = typeof payload?.packageId === "string" ? payload.packageId : "";
      if (packageId !== "nav2") return;
      setNav2Config(readNav2MapConfig(runtime));
    });
  }, [runtime]);

  useEffect(() => {
    setMapType(parseMapType(nav2Config));
  }, [nav2Config]);

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
      } catch {
        // Backend can timeout after reconnect.
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
      if (!active) return;
      if (connectionState?.preset === "sim") return;
      setMainPane((current) => (current === "map" ? "camera" : "map"));
    });
  }, [active, connectionState?.preset, runtime]);

  useEffect(() => {
    return () => {
      if (zoneSyncTimerRef.current) {
        clearTimeout(zoneSyncTimerRef.current);
        zoneSyncTimerRef.current = null;
      }
    };
  }, []);

  const isSimPreset = connectionState?.preset === "sim";
  const cameraPaneAvailable = !isSimPreset;
  const workspaceActive = active;
  const mainIsMap = !cameraPaneAvailable || mainPane === "map";
  const cameraEnabled = connectionService?.isCameraEnabled() ?? false;
  const cameraUrl = connectionService?.getCameraIframeUrl() ?? "";
  const cameraProbeTimeoutMs = parseCameraProbeTimeout(nav2Config, runtime);
  const cameraLoadTimeoutMs = parseCameraLoadTimeout(nav2Config, runtime);
  const initialCenter = parseCenter(nav2Config);
  const initialCenterLat = initialCenter[0];
  const initialCenterLon = initialCenter[1];
  const initialZoom = parseZoom(nav2Config);
  const cameraStreamConnected = navigationState?.cameraStreamConnected === true;
  const mapInteractive = workspaceActive && mainIsMap;
  const mapToolsEnabled = workspaceActive && mainIsMap;

  const clearCameraLoadTimer = (): void => {
    if (!cameraLoadTimerRef.current) return;
    clearTimeout(cameraLoadTimerRef.current);
    cameraLoadTimerRef.current = null;
  };

  const scheduleZonePolygonSync = (): void => {
    if (zoneSyncTimerRef.current) {
      clearTimeout(zoneSyncTimerRef.current);
    }
    zoneSyncTimerRef.current = setTimeout(() => {
      zoneSyncTimerRef.current = null;
      if (!mapService.getState().autoSync) return;
      void mapService.pushZonesToBackend().catch((error) => {
        runtime.eventBus.emit("console.event", {
          level: "error",
          text: `set_zones_geojson failed: ${String(error)}`,
          timestamp: Date.now()
        });
      });
    }, 300);
  };

  useEffect(() => {
    if (cameraPaneAvailable) return;
    if (mainPane === "camera") {
      setMainPane("map");
    }
  }, [cameraPaneAvailable, mainPane]);

  useEffect(() => {
    cameraStreamSeqRef.current += 1;
    clearCameraLoadTimer();
    setCameraConnectError("");

    if (!workspaceActive || mainIsMap || !cameraStreamConnected || !cameraEnabled || !cameraUrl || !cameraPaneAvailable) {
      setFrameSrc("");
      setFrameReady(false);
      setCameraStreamPending("idle");
      if ((!workspaceActive || mainIsMap || !cameraEnabled) && cameraStreamConnected) {
        navigationService?.setCameraStreamConnected(false);
      }
      return;
    }

    const sequence = cameraStreamSeqRef.current;
    let cancelled = false;
    setCameraStreamPending("connecting");
    setFrameReady(false);

    const connectStream = async (): Promise<void> => {
      let probeOk = true;
      let probeError = "";
      let controller: AbortController | null = null;
      let probeTimeoutId: ReturnType<typeof setTimeout> | null = null;
      try {
        if (typeof AbortController !== "undefined") {
          controller = new AbortController();
          probeTimeoutId = setTimeout(() => {
            controller?.abort();
          }, cameraProbeTimeoutMs);
        }
        await fetch(cameraUrl, {
          method: "GET",
          mode: "no-cors",
          cache: "no-store",
          signal: controller?.signal
        });
      } catch (error) {
        probeOk = false;
        probeError = error instanceof Error && error.name === "AbortError" ? "probe timeout" : "probe failed";
      } finally {
        if (probeTimeoutId) {
          clearTimeout(probeTimeoutId);
        }
      }

      if (cancelled || sequence !== cameraStreamSeqRef.current) return;
      if (!probeOk) {
        setCameraConnectError(probeError);
        setCameraStreamPending("idle");
        setFrameSrc("");
        setFrameReady(false);
        navigationService?.setCameraStreamConnected(false);
        runtime.eventBus.emit("console.event", {
          level: "warn",
          text: `Camera connection failed (${probeError})`,
          timestamp: Date.now()
        });
        return;
      }

      const separator = cameraUrl.includes("?") ? "&" : "?";
      setFrameSrc(`${cameraUrl}${separator}_ts=${Date.now()}`);
      cameraLoadTimerRef.current = setTimeout(() => {
        if (sequence !== cameraStreamSeqRef.current) return;
        setCameraConnectError("stream timeout");
        setCameraStreamPending("idle");
        setFrameSrc("");
        setFrameReady(false);
        navigationService?.setCameraStreamConnected(false);
        runtime.eventBus.emit("console.event", {
          level: "warn",
          text: "Camera stream timeout",
          timestamp: Date.now()
        });
      }, cameraLoadTimeoutMs);
    };

    void connectStream();
    return () => {
      cancelled = true;
      clearCameraLoadTimer();
    };
  }, [
    workspaceActive,
    mainIsMap,
    cameraEnabled,
    cameraPaneAvailable,
    cameraStreamConnected,
    cameraUrl,
    cameraLoadTimeoutMs,
    cameraProbeTimeoutMs,
    navigationService,
    runtime.eventBus
  ]);

  useEffect(() => {
    if (mainIsMap) return;
    if (state.toolMode !== "idle") {
      mapService.setToolMode("idle");
    }
    if (zoneEditMode !== "idle") {
      setZoneEditMode("idle");
    }
  }, [mainIsMap, mapService, state.toolMode, zoneEditMode]);

  const cameraOverlayText = !cameraEnabled
    ? connectionState?.preset === "sim"
      ? "camera disabled in sim"
      : "camera unavailable"
    : !cameraStreamConnected
      ? "camara desconectada"
      : cameraStreamPending === "connecting"
        ? "camera connecting"
        : cameraConnectError
          ? `camera ${cameraConnectError}`
          : frameReady
            ? ""
            : "camera connecting";

  const generalPayload = sensorInfoState?.payloads.general as Record<string, unknown> | undefined;
  const generalSnapshot = (generalPayload?.snapshot ?? {}) as Record<string, unknown>;
  const datumFromSensor = generalSnapshot.datum as Record<string, unknown> | undefined;
  const datumLat = Number(datumFromSensor?.datum_lat ?? state.map?.originLat ?? Number.NaN);
  const datumLon = Number(datumFromSensor?.datum_lon ?? state.map?.originLon ?? Number.NaN);
  const datumPose =
    Number.isFinite(datumLat) &&
    Number.isFinite(datumLon) &&
    !(Math.abs(datumLat) < 1e-9 && Math.abs(datumLon) < 1e-9)
      ? {
          lat: datumLat,
          lon: datumLon
        }
      : null;

  const zoneStatusText =
    zoneEditMode === "create"
      ? "Modo zonas: crear (click agrega, doble click cierra)"
      : zoneEditMode === "edit"
        ? "Modo zonas: editar (click zona y arrastra vertices)"
        : zoneEditMode === "delete"
          ? "Modo zonas: eliminar (click zona)"
          : "";

  const toolStatusText = mainIsMap
    ? zoneEditMode !== "idle"
      ? zoneStatusText
      : state.toolInfo
    : "Herramientas disponibles con mapa principal";

  const selectTool = (tool: MapToolMode, infoLabel: string): void => {
    if (!mapToolsEnabled) {
      runtime.eventBus.emit("console.event", {
        level: "warn",
        text: "Map tools available only with map as main view",
        timestamp: Date.now()
      });
      return;
    }
    if (zoneEditMode !== "idle") {
      setZoneEditMode("idle");
    }
    mapService.setToolMode(tool);
    runtime.eventBus.emit("console.event", {
      level: "info",
      text: `Map tool: ${infoLabel}`,
      timestamp: Date.now()
    });
  };

  const selectZoneMode = (mode: ZoneEditMode, infoLabel: string): void => {
    if (!mapToolsEnabled) {
      runtime.eventBus.emit("console.event", {
        level: "warn",
        text: "Map tools available only with map as main view",
        timestamp: Date.now()
      });
      return;
    }
    if (state.toolMode !== "idle") {
      mapService.setToolMode("idle");
    }
    setZoneEditMode((current) => (current === mode ? "idle" : mode));
    runtime.eventBus.emit("console.event", {
      level: "info",
      text: `Zone mode: ${infoLabel}`,
      timestamp: Date.now()
    });
  };

  const queueWaypointFromMap = (lat: number, lon: number, yawDeg: number): void => {
    if (!navigationService || !navigationState?.goalMode) return;
    navigationService.queueWaypoint({
      x: lat,
      y: lon,
      yawDeg
    });
    runtime.eventBus.emit("console.event", {
      level: "info",
      text: `Waypoint queued from map (${lat.toFixed(6)}, ${lon.toFixed(6)}) yaw=${yawDeg.toFixed(1)}°`,
      timestamp: Date.now()
    });
  };

  const toggleWaypointSelectionFromMap = (index: number): void => {
    if (!navigationService) return;
    navigationService.toggleWaypointSelection(index);
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

  const createZoneFromMap = (polygon: Array<{ lat: number; lon: number }>): void => {
    mapService.addZoneFromPolygon(polygon);
    if (!mapService.getState().autoSync) return;
    void mapService.pushZonesToBackend().catch((error) => {
      runtime.eventBus.emit("console.event", {
        level: "error",
        text: `set_zones_geojson failed: ${String(error)}`,
        timestamp: Date.now()
      });
    });
  };

  const updateZonePolygonFromMap = (zoneId: string, polygon: Array<{ lat: number; lon: number }>): void => {
    mapService.setZonePolygon(zoneId, polygon);
    scheduleZonePolygonSync();
  };

  const deleteZoneFromMap = (zoneId: string): void => {
    mapService.removeZone(zoneId);
  };

  const toggleZoneFromMap = (zoneId: string): void => {
    mapService.toggleZoneEnabled(zoneId);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!mainIsMap || !mapToolsEnabled || isEditingTarget(event.target)) return;
      if (event.key === "Escape") {
        if (state.toolMode !== "idle") {
          mapService.setToolMode("idle");
          event.preventDefault();
          return;
        }
        if (zoneEditMode !== "idle") {
          setZoneEditMode("idle");
          event.preventDefault();
        }
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
  }, [mainIsMap, mapToolsEnabled, mapService, selectTool, state.toolMode, zoneEditMode]);

  return (
    <div className="map-workspace-root">
      <div className="map-workspace-toolbar">
        <div className="map-workspace-toolbar-left">
          <div className="map-toolbar map-toolbar-icons">
            <button
              type="button"
              className={toolButtonClass(state.toolMode, "ruler")}
              onClick={() => selectTool("ruler", "ruler")}
              title="Regla"
              aria-label="Regla"
              disabled={!mapToolsEnabled}
            >
              📏
            </button>
            <button
              type="button"
              className={toolButtonClass(state.toolMode, "area")}
              onClick={() => selectTool("area", "area")}
              title="Área"
              aria-label="Área"
              disabled={!mapToolsEnabled}
            >
              📐
            </button>
            <button
              type="button"
              className={toolButtonClass(state.toolMode, "inspect")}
              onClick={() => selectTool("inspect", "inspect")}
              title="Inspeccionar"
              aria-label="Inspeccionar"
              disabled={!mapToolsEnabled}
            >
              📍
            </button>
            <button
              type="button"
              className={toolButtonClass(state.toolMode, "protractor")}
              onClick={() => selectTool("protractor", "protractor")}
              title="Transportador"
              aria-label="Transportador"
              disabled={!mapToolsEnabled}
            >
              ∠
            </button>
            <button
              type="button"
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
              🎯
            </button>
            <button
              type="button"
              onClick={() => {
                void mapService
                  .setDatumOnBackend()
                  .then(() => {
                    runtime.eventBus.emit("console.event", {
                      level: "info",
                      text: "Datum updated from robot pose",
                      timestamp: Date.now()
                    });
                  })
                  .catch((error) => {
                    runtime.eventBus.emit("console.event", {
                      level: "error",
                      text: `Set datum failed: ${String(error)}`,
                      timestamp: Date.now()
                    });
                  });
              }}
              title="Definir datum"
              aria-label="Definir datum"
              disabled={!mapToolsEnabled}
            >
              🧲
            </button>
            <button
              type="button"
              onClick={() => selectTool("idle", "idle")}
              title="Cerrar herramientas"
              aria-label="Cerrar herramientas"
              disabled={!mapToolsEnabled}
            >
              ❌
            </button>

            <span className="map-toolbar-separator" aria-hidden="true" />

            <button
              type="button"
              className={zoneButtonClass(zoneEditMode, "create")}
              onClick={() => selectZoneMode("create", "create")}
              title="Crear zona"
              aria-label="Crear zona"
              disabled={!mapToolsEnabled}
            >
              ➕
            </button>
            <button
              type="button"
              className={zoneButtonClass(zoneEditMode, "edit")}
              onClick={() => selectZoneMode("edit", "edit")}
              title="Editar zona"
              aria-label="Editar zona"
              disabled={!mapToolsEnabled}
            >
              ✏️
            </button>
            <button
              type="button"
              className={zoneButtonClass(zoneEditMode, "delete")}
              onClick={() => selectZoneMode("delete", "delete")}
              title="Eliminar zona"
              aria-label="Eliminar zona"
              disabled={!mapToolsEnabled}
            >
              🗑
            </button>
            <button
              type="button"
              className={zoneButtonClass(zoneEditMode, "idle")}
              onClick={() => setZoneEditMode("idle")}
              title="Cerrar modo zonas"
              aria-label="Cerrar modo zonas"
              disabled={!mapToolsEnabled}
            >
              ⛔
            </button>
          </div>
        </div>

        <div className="map-workspace-toolbar-right">
          <div className="map-toolbar map-type-toggle">
            <button
              type="button"
              className={mapTypeButtonClass(mapType, "hybrid")}
              onClick={() => setMapType("hybrid")}
              title="Satélite"
              disabled={!mapToolsEnabled}
            >
              SAT
            </button>
            <button
              type="button"
              className={mapTypeButtonClass(mapType, "roadmap")}
              onClick={() => setMapType("roadmap")}
              title="Roadmap"
              disabled={!mapToolsEnabled}
            >
              MAP
            </button>
          </div>
          <div className="map-tool-status">{toolStatusText}</div>
        </div>
      </div>

      <div className={`stage map-stage ${mainIsMap ? "mode-gps-main" : "mode-camera-main"}`}>
        <section className={`stage-pane main map-stage-pane ${mainIsMap ? "" : "is-hidden"}`}>
          <div className="map-canvas map-pane-canvas">
            <GoogleMapCanvas
              active={workspaceActive && mainIsMap}
              state={state}
              mapService={mapService}
              runtime={runtime}
              interactive={mapInteractive}
              goalMode={navigationState?.goalMode === true}
              zoneEditMode={zoneEditMode}
              mapType={mapType}
              waypoints={navigationState?.waypoints ?? []}
              selectedWaypointIndexes={navigationState?.selectedWaypointIndexes ?? []}
              robotPose={telemetrySnapshot?.robotPose ?? null}
              datumPose={datumPose}
              centerRequestKey={centerRequestKey}
              onQueueWaypoint={queueWaypointFromMap}
              onToggleWaypointSelection={toggleWaypointSelectionFromMap}
              onMoveWaypoint={moveWaypointFromMap}
              onZoneCreate={createZoneFromMap}
              onZonePolygonChange={updateZonePolygonFromMap}
              onZoneDelete={deleteZoneFromMap}
              onZoneToggle={toggleZoneFromMap}
              initialCenterLat={initialCenterLat}
              initialCenterLon={initialCenterLon}
              initialZoom={initialZoom}
            />
          </div>
        </section>

        {cameraPaneAvailable ? (
          <section className={`stage-pane main map-camera-stage-pane ${mainIsMap ? "is-hidden" : ""}`}>
            <h4>Camera</h4>
            <div className="camera-frame-wrap">
              <iframe
                className="camera-frame"
                src={frameSrc}
                title="Vista de cámara"
                loading="lazy"
                onLoad={() => {
                  if (!(navigationService?.getState().cameraStreamConnected === true)) return;
                  clearCameraLoadTimer();
                  setFrameReady(true);
                  setCameraConnectError("");
                  setCameraStreamPending("idle");
                }}
                onError={() => {
                  clearCameraLoadTimer();
                  setFrameReady(false);
                  setCameraConnectError("load error");
                  setCameraStreamPending("idle");
                  navigationService?.setCameraStreamConnected(false);
                  runtime.eventBus.emit("console.event", {
                    level: "warn",
                    text: "Camera frame load error",
                    timestamp: Date.now()
                  });
                }}
              />
              {cameraOverlayText ? <div className="camera-overlay visible">{cameraOverlayText}</div> : null}
            </div>
          </section>
        ) : null}

        <div className="stage-bottom-left-actions">
          {cameraPaneAvailable ? (
            <button type="button" className="swap-btn" onClick={() => setMainPane(mainIsMap ? "camera" : "map")}>
              🔄
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function createMapModule(): CockpitModule {
  return {
    id: "map",
    version: "1.2.0",
    enabledByDefault: true,
    register(ctx: ModuleContext): void {
      const dispatcher = new MapDispatcher(DISPATCHER_ID, TRANSPORT_ID);
      ctx.dispatchers.registerDispatcher({
        id: dispatcher.id,
        dispatcher
      });

      const service = new MapService(dispatcher);
      ctx.services.registerService({
        id: SERVICE_ID,
        service
      });

      ctx.contributions.register({
        id: "workspace.map",
        slot: "workspace",
        label: "Map",
        render: (workspaceCtx) => <MapWorkspaceView runtime={ctx} active={workspaceCtx?.active ?? true} />
      });
    }
  };
}
