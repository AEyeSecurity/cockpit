import type { MapToolMode, ZoneEntry } from "../service/impl/MapService";
import { calculateProtractorAngleDeg, snapToCartesianAxis } from "./protractor";
import {
  formatAngleDegrees,
  formatAreaSqMeters,
  formatDistanceMeters,
  haversineDistanceMeters,
  normalizeYawDeg,
  polygonAreaSqMeters,
  polylineDistanceMeters,
  projectMercator,
  unprojectMercator,
  yawDegFromLatLng,
  type GeoPoint
} from "./mapGeometry";

const MAP_TOOL_COLOR = "#55ff7f";
const PROTRACTOR_MIN_ARM_METERS = 0.05;
const PROTRACTOR_SNAP_THRESHOLD_DEG = 12;

export type ZoneEditMode = "idle" | "create" | "edit" | "delete";
export type GoogleMapType = "hybrid" | "roadmap";

export interface MapEngineWaypoint {
  x: number;
  y: number;
  yawDeg: number;
}

export interface MapEngineRobotPose {
  lat: number;
  lon: number;
  headingDeg?: number | null;
}

export interface MapEngineCallbacks {
  onToolInfo: (text: string) => void;
  onInspectCoords: (lat: number, lon: number) => void;
  onQueueWaypoint: (lat: number, lon: number, yawDeg: number) => void;
  onToggleWaypointSelection: (index: number) => void;
  onMoveWaypoint: (index: number, lat: number, lon: number) => void;
  onZoneToggle: (zoneId: string) => void;
  onZoneCreate: (polygon: Array<{ lat: number; lon: number }>) => void;
  onZonePolygonChange: (zoneId: string, polygon: Array<{ lat: number; lon: number }>) => void;
  onZoneDelete: (zoneId: string) => void;
  onInspectCopied?: (coordsText: string) => void;
}

export interface MapEngineOptions {
  maps: typeof google.maps;
  host: HTMLDivElement;
  initialCenterLat: number;
  initialCenterLon: number;
  initialZoom: number;
  interactive: boolean;
  mapType: GoogleMapType;
  callbacks: MapEngineCallbacks;
}

type MapOverlay = google.maps.Marker | google.maps.Polyline | google.maps.Polygon;

function toLatLngLiteral(point: GeoPoint): google.maps.LatLngLiteral {
  return { lat: Number(point.lat), lng: Number(point.lng) };
}

function toGeoPoint(point: google.maps.LatLng | google.maps.LatLngLiteral): GeoPoint {
  if (typeof (point as google.maps.LatLng).lat === "function") {
    const latLng = point as google.maps.LatLng;
    return { lat: Number(latLng.lat()), lng: Number(latLng.lng()) };
  }
  const raw = point as google.maps.LatLngLiteral;
  return { lat: Number(raw.lat), lng: Number(raw.lng) };
}

function samePoint(a: GeoPoint, b: GeoPoint): boolean {
  return Math.abs(a.lat - b.lat) < 1e-9 && Math.abs(a.lng - b.lng) < 1e-9;
}

function polygonFromMvcPath(path: google.maps.MVCArray<google.maps.LatLng>): Array<{ lat: number; lon: number }> {
  const next: Array<{ lat: number; lon: number }> = [];
  for (let index = 0; index < path.getLength(); index += 1) {
    const point = path.getAt(index);
    next.push({ lat: Number(point.lat()), lon: Number(point.lng()) });
  }
  return next;
}

export class MapEngine {
  private readonly maps: typeof google.maps;
  private readonly map: google.maps.Map;
  private readonly callbacks: MapEngineCallbacks;
  private readonly infoWindow: google.maps.InfoWindow;
  private readonly eventListeners: google.maps.MapsEventListener[] = [];
  private readonly zonePolygons = new Map<string, google.maps.Polygon>();
  private readonly zonePathListeners = new Map<string, google.maps.MapsEventListener[]>();
  private readonly toolDraftOverlays: MapOverlay[] = [];
  private readonly toolDrawingOverlays: MapOverlay[] = [];
  private zoneDraftMarkers: google.maps.Marker[] = [];

  private waypointMarkers: google.maps.Marker[] = [];
  private waypointLine: google.maps.Polyline | null = null;
  private draftWaypointMarker: google.maps.Marker | null = null;
  private robotMarker: google.maps.Marker | null = null;
  private datumMarker: google.maps.Marker | null = null;
  private zoneDraftLine: google.maps.Polyline | null = null;
  private zoneDraftFill: google.maps.Polygon | null = null;

  private toolMode: MapToolMode = "idle";
  private zoneEditMode: ZoneEditMode = "idle";
  private goalMode = false;
  private interactive = true;
  private activeZoneId: string | null = null;
  private zoneCreatePoints: GeoPoint[] = [];
  private zoneCreatePreview: GeoPoint | null = null;

  private measurePoints: GeoPoint[] = [];
  private measurePreviewPoint: GeoPoint | null = null;
  private protractorVertex: GeoPoint | null = null;
  private protractorArm1: GeoPoint | null = null;
  private hasCompletedDrawing = false;
  private completedDrawingTool: "ruler" | "area" | "protractor" | null = null;

  private goalDraft: { lat: number; lon: number; yawDeg: number; dragYaw: boolean } | null = null;
  private goalSession = { active: false, hasMoved: false };
  private waypointDragEndMs = 0;
  private pointerDownOnOverlay = false;
  private appliedMapOriginKey = "";

  constructor(options: MapEngineOptions) {
    this.maps = options.maps;
    this.callbacks = options.callbacks;
    this.interactive = options.interactive;
    this.map = new this.maps.Map(options.host, {
      center: { lat: options.initialCenterLat, lng: options.initialCenterLon },
      zoom: options.initialZoom,
      mapTypeId: options.mapType,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: false,
      clickableIcons: false,
      disableDefaultUI: false,
      disableDoubleClickZoom: true,
      keyboardShortcuts: true,
      gestureHandling: options.interactive ? "auto" : "none"
    });
    this.infoWindow = new this.maps.InfoWindow();

    this.bindMapEvents();
    this.setInteractive(options.interactive);
    this.setToolMode("idle");
  }

  destroy(): void {
    this.clearGoalDraft();
    this.clearToolDraft();
    this.clearToolDrawings();
    this.clearZoneDraft();
    this.clearWaypoints();
    this.setRobotPose(null);
    this.setDatumPose(null);
    this.zonePathListeners.forEach((listeners) => listeners.forEach((listener) => listener.remove()));
    this.zonePathListeners.clear();
    this.zonePolygons.forEach((polygon) => polygon.setMap(null));
    this.zonePolygons.clear();
    this.eventListeners.forEach((listener) => listener.remove());
    this.eventListeners.length = 0;
    this.infoWindow.close();
  }

  invalidateSize(): void {
    this.maps.event.trigger(this.map, "resize");
  }

  setInteractive(interactive: boolean): void {
    this.interactive = interactive;
    this.map.setOptions({
      draggable: interactive,
      scrollwheel: interactive,
      keyboardShortcuts: interactive,
      gestureHandling: interactive ? "auto" : "none"
    });
    this.waypointMarkers.forEach((marker) => marker.setDraggable(interactive));
  }

  setMapType(mapType: GoogleMapType): void {
    this.map.setMapTypeId(mapType);
  }

  setGoalMode(goalMode: boolean): void {
    this.goalMode = goalMode;
    if (!goalMode) {
      this.clearGoalDraft();
      this.measurePreviewPoint = null;
    }
  }

  setToolMode(mode: MapToolMode): void {
    if (this.toolMode === mode) {
      this.emitToolLegend(mode);
      return;
    }
    this.toolMode = mode;

    if (mode !== "idle") {
      this.clearGoalDraft();
    }

    if (mode === "idle") {
      this.clearToolDrawings();
      this.emitToolLegend("idle");
    } else {
      this.clearToolDraft();
      this.emitToolLegend(mode);
    }
  }

  setZoneEditMode(mode: ZoneEditMode): void {
    if (this.zoneEditMode === mode) return;
    this.zoneEditMode = mode;
    if (mode !== "edit") {
      this.activeZoneId = null;
    }
    if (mode !== "create") {
      this.clearZoneDraft();
    }
    if (mode !== "idle") {
      this.clearToolDraft();
      this.clearToolDrawings();
      this.setToolMode("idle");
    }
    this.applyZoneEditState();
  }

  setMapOrigin(mapId: string, originLat: number, originLon: number): void {
    if (!Number.isFinite(originLat) || !Number.isFinite(originLon)) return;
    if (Math.abs(originLat) < 1e-9 && Math.abs(originLon) < 1e-9) return;
    const nextKey = `${mapId}:${originLat}:${originLon}`;
    if (this.appliedMapOriginKey === nextKey) return;
    this.appliedMapOriginKey = nextKey;
    this.map.setCenter({ lat: originLat, lng: originLon });
  }

  setInitialView(initialCenterLat: number, initialCenterLon: number, initialZoom: number): void {
    this.map.setCenter({ lat: initialCenterLat, lng: initialCenterLon });
    this.map.setZoom(initialZoom);
  }

  centerOnRobot(minZoom = 17): void {
    if (!this.robotMarker) return;
    const position = this.robotMarker.getPosition();
    if (!position) return;
    this.map.setCenter(position);
    const currentZoom = Number(this.map.getZoom() ?? minZoom);
    this.map.setZoom(Math.max(currentZoom, minZoom));
  }

  setZones(zones: ZoneEntry[]): void {
    const present = new Set(zones.map((zone) => zone.id));

    this.zonePolygons.forEach((polygon, zoneId) => {
      if (present.has(zoneId)) return;
      this.zonePathListeners.get(zoneId)?.forEach((listener) => listener.remove());
      this.zonePathListeners.delete(zoneId);
      polygon.setMap(null);
      this.zonePolygons.delete(zoneId);
      if (this.activeZoneId === zoneId) {
        this.activeZoneId = null;
      }
    });

    zones.forEach((zone) => {
      const polygon = Array.isArray(zone.polygon) ? zone.polygon : [];
      if (polygon.length < 3) {
        const existing = this.zonePolygons.get(zone.id);
        if (existing) {
          this.zonePathListeners.get(zone.id)?.forEach((listener) => listener.remove());
          this.zonePathListeners.delete(zone.id);
          existing.setMap(null);
          this.zonePolygons.delete(zone.id);
        }
        return;
      }

      const path = polygon.map((entry) => ({ lat: Number(entry.lat), lng: Number(entry.lon) }));
      const existing = this.zonePolygons.get(zone.id);
      if (!existing) {
        const created = new this.maps.Polygon({
          map: this.map,
          paths: path,
          clickable: true,
          draggable: false,
          editable: false,
          strokeWeight: 3
        });
        this.zonePolygons.set(zone.id, created);
        this.bindZoneEvents(zone.id, created);
      } else {
        existing.setPaths(path);
      }

      const render = this.zonePolygons.get(zone.id);
      if (!render) return;
      render.setOptions({
        strokeColor: zone.enabled === false ? "#64748b" : "#f97316",
        fillColor: zone.enabled === false ? "#64748b" : "#f97316",
        fillOpacity: zone.enabled === false ? 0.1 : 0.25
      });
    });

    this.applyZoneEditState();
  }

  setWaypoints(waypoints: MapEngineWaypoint[], selectedWaypointIndexes: number[]): void {
    this.clearWaypoints();

    const points = waypoints
      .map((waypoint, index) => ({
        index,
        lat: Number(waypoint.x),
        lon: Number(waypoint.y),
        yawDeg: Number(waypoint.yawDeg ?? 0),
        selected: selectedWaypointIndexes.includes(index)
      }))
      .filter((entry) => Number.isFinite(entry.lat) && Number.isFinite(entry.lon));

    if (points.length > 1) {
      this.waypointLine = new this.maps.Polyline({
        map: this.map,
        path: points.map((entry) => ({ lat: entry.lat, lng: entry.lon })),
        strokeColor: "#ff8095",
        strokeWeight: 2,
        strokeOpacity: 0.9,
        clickable: false
      });
    }

    points.forEach((entry) => {
      const marker = new this.maps.Marker({
        map: this.map,
        position: { lat: entry.lat, lng: entry.lon },
        draggable: this.interactive,
        clickable: true,
        label: {
          text: String(entry.index + 1),
          color: entry.selected ? "#1d4ed8" : "#111827",
          fontSize: "10px",
          fontWeight: "700"
        },
        icon: this.buildWaypointSymbol(entry.yawDeg, false, entry.selected),
        title: `#${entry.index + 1}`
      });

      this.eventListeners.push(
        marker.addListener("mousedown", () => {
          this.pointerDownOnOverlay = true;
        }),
        marker.addListener("dragstart", () => {
          this.pointerDownOnOverlay = true;
          if (this.map.get("draggable")) {
            this.map.setOptions({ draggable: false });
          }
        }),
        marker.addListener("dragend", () => {
          const latLng = marker.getPosition();
          if (latLng) {
            this.callbacks.onMoveWaypoint(entry.index, Number(latLng.lat()), Number(latLng.lng()));
          }
          this.waypointDragEndMs = Date.now();
          if (this.interactive) {
            this.map.setOptions({ draggable: true });
          }
          this.pointerDownOnOverlay = false;
        }),
        marker.addListener("click", () => {
          if (Date.now() - this.waypointDragEndMs < 250) return;
          this.callbacks.onToggleWaypointSelection(entry.index);
        })
      );
      this.waypointMarkers.push(marker);
    });
  }

  setRobotPose(robotPose: MapEngineRobotPose | null): void {
    if (!robotPose) {
      if (this.robotMarker) {
        this.robotMarker.setMap(null);
        this.robotMarker = null;
      }
      return;
    }

    const position = { lat: Number(robotPose.lat), lng: Number(robotPose.lon) };
    const hasHeading = robotPose.headingDeg !== null && robotPose.headingDeg !== undefined && Number.isFinite(Number(robotPose.headingDeg));
    const yaw = hasHeading ? normalizeYawDeg(Number(robotPose.headingDeg)) : 0;
    const icon: google.maps.Symbol = {
      path: this.maps.SymbolPath.FORWARD_CLOSED_ARROW,
      scale: 6,
      rotation: yaw,
      fillColor: "#ffff00",
      fillOpacity: hasHeading ? 0.95 : 0.55,
      strokeColor: "#111827",
      strokeWeight: 1.2
    };

    if (!this.robotMarker) {
      this.robotMarker = new this.maps.Marker({
        map: this.map,
        position,
        clickable: false,
        icon,
        zIndex: 1200,
        title: "Robot"
      });
      return;
    }

    this.robotMarker.setPosition(position);
    this.robotMarker.setIcon(icon);
  }

  setDatumPose(datumPose: { lat: number; lon: number } | null): void {
    if (!datumPose) {
      if (this.datumMarker) {
        this.datumMarker.setMap(null);
        this.datumMarker = null;
      }
      return;
    }

    const position = { lat: Number(datumPose.lat), lng: Number(datumPose.lon) };
    const icon: google.maps.Symbol = {
      path: this.maps.SymbolPath.CIRCLE,
      scale: 6,
      fillColor: "#ff00ff",
      fillOpacity: 0.95,
      strokeColor: "#111827",
      strokeWeight: 1.2
    };

    if (!this.datumMarker) {
      this.datumMarker = new this.maps.Marker({
        map: this.map,
        position,
        clickable: false,
        icon,
        zIndex: 1100,
        title: "Datum"
      });
      return;
    }

    this.datumMarker.setPosition(position);
    this.datumMarker.setIcon(icon);
  }

  private bindMapEvents(): void {
    this.eventListeners.push(
      this.map.addListener("click", (event: google.maps.MapMouseEvent) => this.handleMapClick(event)),
      this.map.addListener("dblclick", (event: google.maps.MapMouseEvent) => this.handleMapDoubleClick(event)),
      this.map.addListener("mousedown", (event: google.maps.MapMouseEvent) => this.handleMapMouseDown(event)),
      this.map.addListener("mousemove", (event: google.maps.MapMouseEvent) => this.handleMapMouseMove(event)),
      this.map.addListener("mouseup", () => this.handleMapMouseUp()),
      this.map.addListener("mouseout", () => {
        if (this.toolMode === "ruler" || this.toolMode === "area" || this.toolMode === "protractor") {
          this.measurePreviewPoint = null;
        }
      })
    );
  }

  private bindZoneEvents(zoneId: string, polygon: google.maps.Polygon): void {
    const listeners: google.maps.MapsEventListener[] = [];
    listeners.push(
      polygon.addListener("mousedown", () => {
        this.pointerDownOnOverlay = true;
      }),
      polygon.addListener("click", () => {
        if (this.zoneEditMode === "delete") {
          this.callbacks.onZoneDelete(zoneId);
          return;
        }
        if (this.zoneEditMode === "edit") {
          this.activeZoneId = zoneId;
          this.applyZoneEditState();
          this.emitToolInfo("Edicion de zona activa. Arrastra vertices para ajustar.");
          return;
        }
        if (this.zoneEditMode !== "idle") return;
        if (this.toolMode !== "idle") return;
        this.callbacks.onZoneToggle(zoneId);
      }),
      polygon.addListener("dragend", () => this.handleZonePathEdited(zoneId, polygon)),
      polygon.addListener("mouseup", () => this.handleZonePathEdited(zoneId, polygon))
    );

    const path = polygon.getPath();
    listeners.push(
      this.maps.event.addListener(path, "set_at", () => this.handleZonePathEdited(zoneId, polygon)),
      this.maps.event.addListener(path, "insert_at", () => this.handleZonePathEdited(zoneId, polygon)),
      this.maps.event.addListener(path, "remove_at", () => this.handleZonePathEdited(zoneId, polygon))
    );

    this.zonePathListeners.set(zoneId, listeners);
    this.eventListeners.push(...listeners);
  }

  private applyZoneEditState(): void {
    if (this.zoneEditMode === "edit" && !this.activeZoneId) {
      const first = this.zonePolygons.keys().next().value;
      this.activeZoneId = typeof first === "string" ? first : null;
    }

    this.zonePolygons.forEach((polygon, zoneId) => {
      const editable = this.zoneEditMode === "edit" && this.activeZoneId === zoneId;
      polygon.setOptions({
        editable,
        draggable: false,
        clickable: true
      });
    });
  }

  private handleZonePathEdited(zoneId: string, polygon: google.maps.Polygon): void {
    if (this.zoneEditMode !== "edit") return;
    const path = polygon.getPath();
    this.callbacks.onZonePolygonChange(zoneId, polygonFromMvcPath(path));
  }

  private handleMapClick(event: google.maps.MapMouseEvent): void {
    if (!this.interactive) return;
    if (!event.latLng) return;

    const point = toGeoPoint(event.latLng);

    if (this.zoneEditMode === "create" && this.toolMode === "idle") {
      this.zoneCreatePoints.push(point);
      this.zoneCreatePreview = null;
      this.renderZoneDraft(null);
      return;
    }

    if (this.zoneEditMode !== "idle") return;

    if (this.toolMode === "inspect") {
      this.handleInspectClick(point);
      return;
    }

    if (this.toolMode === "ruler") {
      this.measurePoints = this.collectMeasurePoints(point);
      this.measurePreviewPoint = null;
      this.renderRuler(point);
      return;
    }

    if (this.toolMode === "area") {
      this.measurePoints = this.collectMeasurePoints(point);
      this.measurePreviewPoint = null;
      this.renderArea(point);
      return;
    }

    if (this.toolMode === "protractor") {
      const shiftPressed = Boolean((event.domEvent as MouseEvent | undefined)?.shiftKey);
      if (!this.protractorVertex) {
        this.protractorVertex = point;
        this.protractorArm1 = null;
        this.measurePreviewPoint = null;
        this.renderProtractor(null);
        return;
      }
      const snapped = this.resolveProtractorPoint(point, shiftPressed);
      if (!this.protractorArm1) {
        this.protractorArm1 = snapped;
        this.measurePreviewPoint = null;
        this.renderProtractor(null);
        return;
      }
      this.finalizeProtractor(snapped);
    }
  }

  private handleMapDoubleClick(event: google.maps.MapMouseEvent): void {
    if (!this.interactive || !event.latLng) return;

    if (this.zoneEditMode === "create") {
      this.finalizeZoneCreate();
      return;
    }

    if (this.toolMode !== "ruler" && this.toolMode !== "area" && this.toolMode !== "protractor") {
      return;
    }

    const point = toGeoPoint(event.latLng);
    if (this.toolMode === "ruler") {
      this.finalizeRuler(point);
      return;
    }

    if (this.toolMode === "protractor") {
      const shiftPressed = Boolean((event.domEvent as MouseEvent | undefined)?.shiftKey);
      this.finalizeProtractor(this.resolveProtractorPoint(point, shiftPressed));
      return;
    }

    this.finalizeArea(point);
  }

  private handleMapMouseDown(event: google.maps.MapMouseEvent): void {
    if (!this.interactive || !event.latLng) return;
    if (!this.goalMode || this.toolMode !== "idle" || this.zoneEditMode !== "idle") return;

    const domEvent = event.domEvent as MouseEvent | undefined;
    if (domEvent && typeof domEvent.button === "number" && domEvent.button !== 0) return;
    if (this.pointerDownOnOverlay) {
      this.pointerDownOnOverlay = false;
      return;
    }

    this.goalSession = { active: true, hasMoved: false };
    this.goalDraft = {
      lat: Number(event.latLng.lat()),
      lon: Number(event.latLng.lng()),
      yawDeg: 0,
      dragYaw: false
    };

    if (this.map.get("draggable")) {
      this.map.setOptions({ draggable: false });
    }
    this.renderGoalDraft();
  }

  private handleMapMouseMove(event: google.maps.MapMouseEvent): void {
    if (!event.latLng) return;
    const point = toGeoPoint(event.latLng);

    if (this.goalSession.active) {
      const draft = this.goalDraft;
      if (!draft) return;
      const origin = { lat: draft.lat, lng: draft.lon };
      const distance = haversineDistanceMeters(origin, point);
      const dragYaw = distance > 0.35;
      draft.dragYaw = dragYaw;
      if (dragYaw) {
        draft.yawDeg = yawDegFromLatLng(origin, point);
        this.goalSession.hasMoved = true;
      }
      this.renderGoalDraft();
      return;
    }

    if (!this.interactive) return;

    if (this.zoneEditMode === "create" && this.toolMode === "idle") {
      this.zoneCreatePreview = point;
      this.renderZoneDraft(point);
      return;
    }

    if (this.zoneEditMode !== "idle") return;

    if (this.toolMode === "ruler") {
      this.measurePreviewPoint = point;
      this.renderRuler(point);
      return;
    }

    if (this.toolMode === "area") {
      this.measurePreviewPoint = point;
      this.renderArea(point);
      return;
    }

    if (this.toolMode === "protractor") {
      const shiftPressed = Boolean((event.domEvent as MouseEvent | undefined)?.shiftKey);
      const preview = this.resolveProtractorPoint(point, shiftPressed);
      this.measurePreviewPoint = preview;
      this.renderProtractor(preview);
    }
  }

  private handleMapMouseUp(): void {
    if (!this.goalSession.active) {
      this.pointerDownOnOverlay = false;
      return;
    }
    const draft = this.goalDraft;
    this.clearGoalDraft();
    if (!draft) return;
    this.callbacks.onQueueWaypoint(draft.lat, draft.lon, draft.yawDeg);
    this.pointerDownOnOverlay = false;
  }

  private handleInspectClick(point: GeoPoint): void {
    this.callbacks.onInspectCoords(point.lat, point.lng);
    const coordsText = `${point.lat.toFixed(6)}, ${point.lng.toFixed(6)}`;
    const buttonId = `inspect-copy-${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
    this.infoWindow.close();
    this.infoWindow.setContent(
      `<div class=\"map-inspect-popup\"><div class=\"coords\">${coordsText}</div><button type=\"button\" id=\"${buttonId}\" class=\"map-inspect-copy\">Copy</button></div>`
    );
    this.infoWindow.setPosition(toLatLngLiteral(point));
    this.infoWindow.open(this.map);

    this.maps.event.addListenerOnce(this.infoWindow, "domready", () => {
      const button = document.getElementById(buttonId);
      if (!button) return;
      const onClick = (): void => {
        if (typeof navigator !== "undefined" && navigator.clipboard) {
          void navigator.clipboard.writeText(coordsText);
        }
        this.callbacks.onInspectCopied?.(coordsText);
      };
      button.addEventListener("click", onClick, { once: true });
    });
  }

  private clearWaypoints(): void {
    this.waypointMarkers.forEach((marker) => marker.setMap(null));
    this.waypointMarkers = [];
    if (this.waypointLine) {
      this.waypointLine.setMap(null);
      this.waypointLine = null;
    }
  }

  private renderGoalDraft(): void {
    const draft = this.goalDraft;
    if (!draft) {
      if (this.draftWaypointMarker) {
        this.draftWaypointMarker.setMap(null);
        this.draftWaypointMarker = null;
      }
      return;
    }

    const position = { lat: Number(draft.lat), lng: Number(draft.lon) };
    const icon = this.buildWaypointSymbol(draft.yawDeg, true, false);

    if (!this.draftWaypointMarker) {
      this.draftWaypointMarker = new this.maps.Marker({
        map: this.map,
        position,
        clickable: false,
        draggable: false,
        icon,
        label: {
          text: "+",
          color: "#92400e",
          fontSize: "11px",
          fontWeight: "700"
        },
        zIndex: 1300
      });
      return;
    }

    this.draftWaypointMarker.setPosition(position);
    this.draftWaypointMarker.setIcon(icon);
  }

  private clearGoalDraft(): void {
    this.goalDraft = null;
    this.goalSession = { active: false, hasMoved: false };
    if (this.draftWaypointMarker) {
      this.draftWaypointMarker.setMap(null);
      this.draftWaypointMarker = null;
    }
    if (this.interactive) {
      this.map.setOptions({ draggable: true });
    }
  }

  private buildWaypointSymbol(yawDeg: number, draft: boolean, selected: boolean): google.maps.Symbol {
    return {
      path: this.maps.SymbolPath.FORWARD_CLOSED_ARROW,
      scale: 5,
      rotation: normalizeYawDeg(Number(yawDeg)),
      fillColor: draft ? "#f59e0b" : selected ? "#2563eb" : "#ef4444",
      fillOpacity: 0.95,
      strokeColor: "#111827",
      strokeWeight: 1.2
    };
  }

  private emitToolInfo(text: string): void {
    this.callbacks.onToolInfo(text);
  }

  private emitToolLegend(mode: MapToolMode): void {
    if (mode === "ruler") {
      this.emitToolInfo("Regla activa. Click agrega, doble click cierra.");
      return;
    }
    if (mode === "area") {
      this.emitToolInfo("Area activa. Click agrega, doble click cierra.");
      return;
    }
    if (mode === "inspect") {
      this.emitToolInfo("Inspeccion activa. Click inspecciona coordenadas.");
      return;
    }
    if (mode === "protractor") {
      this.emitToolInfo("Transportador activo. Click define vertice. Shift alinea ejes.");
      return;
    }
    this.emitToolInfo("Map tools idle.");
  }

  private collectMeasurePoints(closingPoint: GeoPoint | null): GeoPoint[] {
    const next = [...this.measurePoints];
    if (!closingPoint) return next;
    const last = next[next.length - 1];
    if (!last || haversineDistanceMeters(last, closingPoint) >= 0.05) {
      next.push(closingPoint);
    }
    return next;
  }

  private resolveProtractorPoint(point: GeoPoint, shiftPressed: boolean): GeoPoint {
    if (!shiftPressed) return point;
    if (!this.protractorVertex) return point;
    return snapToCartesianAxis(this.protractorVertex, point, PROTRACTOR_SNAP_THRESHOLD_DEG, PROTRACTOR_MIN_ARM_METERS);
  }

  private clearOverlayList(overlays: MapOverlay[]): void {
    overlays.forEach((overlay) => overlay.setMap(null));
    overlays.length = 0;
  }

  private clearToolDraft(): void {
    this.measurePreviewPoint = null;
    this.clearOverlayList(this.toolDraftOverlays);
  }

  private clearToolDrawings(): void {
    this.measurePoints = [];
    this.protractorVertex = null;
    this.protractorArm1 = null;
    this.hasCompletedDrawing = false;
    this.completedDrawingTool = null;
    this.clearOverlayList(this.toolDrawingOverlays);
    this.clearToolDraft();
  }

  private addDraftPointMarker(point: GeoPoint): void {
    this.toolDraftOverlays.push(
      new this.maps.Marker({
        map: this.map,
        position: toLatLngLiteral(point),
        icon: {
          path: this.maps.SymbolPath.CIRCLE,
          scale: 3,
          fillColor: MAP_TOOL_COLOR,
          fillOpacity: 0.9,
          strokeColor: MAP_TOOL_COLOR,
          strokeWeight: 1.2
        },
        clickable: false,
        zIndex: 900
      })
    );
  }

  private addDrawingPointMarker(point: GeoPoint): void {
    this.toolDrawingOverlays.push(
      new this.maps.Marker({
        map: this.map,
        position: toLatLngLiteral(point),
        icon: {
          path: this.maps.SymbolPath.CIRCLE,
          scale: 3,
          fillColor: MAP_TOOL_COLOR,
          fillOpacity: 0.9,
          strokeColor: MAP_TOOL_COLOR,
          strokeWeight: 1.2
        },
        clickable: false,
        zIndex: 900
      })
    );
  }

  private markSingleDrawing(tool: "ruler" | "area" | "protractor"): void {
    this.hasCompletedDrawing = true;
    this.completedDrawingTool = tool;
  }

  private renderRuler(preview: GeoPoint | null): void {
    if (this.completedDrawingTool && this.completedDrawingTool !== "ruler") {
      this.clearOverlayList(this.toolDrawingOverlays);
      this.completedDrawingTool = null;
      this.hasCompletedDrawing = false;
    }

    this.clearOverlayList(this.toolDraftOverlays);
    const points = [...this.measurePoints];
    points.forEach((point) => this.addDraftPointMarker(point));

    const displayPoints = preview && points.length > 0 ? [...points, preview] : points;
    if (points.length > 1) {
      this.toolDraftOverlays.push(
        new this.maps.Polyline({
          map: this.map,
          path: points.map((entry) => toLatLngLiteral(entry)),
          strokeColor: MAP_TOOL_COLOR,
          strokeWeight: 2,
          clickable: false
        })
      );
    }
    if (preview && points.length > 0) {
      this.toolDraftOverlays.push(
        new this.maps.Polyline({
          map: this.map,
          path: [toLatLngLiteral(points[points.length - 1]), toLatLngLiteral(preview)],
          strokeColor: MAP_TOOL_COLOR,
          strokeWeight: 2,
          strokeOpacity: 0.8,
          clickable: false,
          icons: [
            {
              icon: {
                path: "M 0,-1 0,1",
                strokeOpacity: 1,
                scale: 3
              },
              offset: "0",
              repeat: "10px"
            }
          ]
        })
      );
    }

    const meters = polylineDistanceMeters(displayPoints);
    this.emitToolInfo(`Ruler: ${formatDistanceMeters(meters)} (${displayPoints.length} puntos)`);
  }

  private finalizeRuler(closingPoint: GeoPoint | null): void {
    const points = this.collectMeasurePoints(closingPoint);
    if (points.length < 2) return;

    this.clearOverlayList(this.toolDrawingOverlays);
    points.forEach((point) => this.addDrawingPointMarker(point));
    this.toolDrawingOverlays.push(
      new this.maps.Polyline({
        map: this.map,
        path: points.map((entry) => toLatLngLiteral(entry)),
        strokeColor: MAP_TOOL_COLOR,
        strokeWeight: 2.5,
        clickable: false
      })
    );

    this.markSingleDrawing("ruler");
    this.clearToolDraft();
    this.measurePoints = [];
    this.emitToolLegend("ruler");
  }

  private renderArea(preview: GeoPoint | null): void {
    if (this.completedDrawingTool && this.completedDrawingTool !== "area") {
      this.clearOverlayList(this.toolDrawingOverlays);
      this.completedDrawingTool = null;
      this.hasCompletedDrawing = false;
    }

    this.clearOverlayList(this.toolDraftOverlays);
    const points = [...this.measurePoints];
    points.forEach((point) => this.addDraftPointMarker(point));

    const drawPoints = preview && points.length > 0 ? [...points, preview] : points;
    if (drawPoints.length > 2) {
      this.toolDraftOverlays.push(
        new this.maps.Polygon({
          map: this.map,
          paths: drawPoints.map((entry) => toLatLngLiteral(entry)),
          strokeColor: MAP_TOOL_COLOR,
          strokeWeight: 2,
          fillColor: MAP_TOOL_COLOR,
          fillOpacity: 0.2,
          clickable: false
        })
      );
    } else if (drawPoints.length > 1) {
      this.toolDraftOverlays.push(
        new this.maps.Polyline({
          map: this.map,
          path: drawPoints.map((entry) => toLatLngLiteral(entry)),
          strokeColor: MAP_TOOL_COLOR,
          strokeWeight: 2,
          clickable: false
        })
      );
    }

    let perimeter = polylineDistanceMeters(drawPoints);
    if (drawPoints.length > 2) {
      perimeter += haversineDistanceMeters(drawPoints[drawPoints.length - 1], drawPoints[0]);
    }
    const area = drawPoints.length > 2 ? polygonAreaSqMeters(drawPoints) : 0;
    this.emitToolInfo(`Area ${formatAreaSqMeters(area)} · Perim ${formatDistanceMeters(perimeter)}`);
  }

  private finalizeArea(closingPoint: GeoPoint | null): void {
    const points = this.collectMeasurePoints(closingPoint);
    if (points.length < 3) return;

    this.clearOverlayList(this.toolDrawingOverlays);
    points.forEach((point) => this.addDrawingPointMarker(point));
    this.toolDrawingOverlays.push(
      new this.maps.Polygon({
        map: this.map,
        paths: points.map((entry) => toLatLngLiteral(entry)),
        strokeColor: MAP_TOOL_COLOR,
        strokeWeight: 2.5,
        fillColor: MAP_TOOL_COLOR,
        fillOpacity: 0.18,
        clickable: false
      })
    );

    this.markSingleDrawing("area");
    this.clearToolDraft();
    this.measurePoints = [];
    this.emitToolLegend("area");
  }

  private buildProtractorArcGeometry(
    vertex: GeoPoint,
    armA: GeoPoint,
    armB: GeoPoint
  ): { arcPoints: GeoPoint[]; labelPoint: GeoPoint | null } {
    const origin = projectMercator(vertex);
    const first = projectMercator(armA);
    const second = projectMercator(armB);

    const firstVec = { x: first.x - origin.x, y: first.y - origin.y };
    const secondVec = { x: second.x - origin.x, y: second.y - origin.y };
    const firstLen = Math.hypot(firstVec.x, firstVec.y);
    const secondLen = Math.hypot(secondVec.x, secondVec.y);
    if (firstLen < PROTRACTOR_MIN_ARM_METERS || secondLen < PROTRACTOR_MIN_ARM_METERS) {
      return { arcPoints: [], labelPoint: null };
    }

    const startAngle = Math.atan2(firstVec.y, firstVec.x);
    const endAngle = Math.atan2(secondVec.y, secondVec.x);
    let delta = endAngle - startAngle;
    while (delta <= -Math.PI) delta += Math.PI * 2;
    while (delta > Math.PI) delta -= Math.PI * 2;

    const radius = Math.max(1, Math.min(firstLen, secondLen) * 0.45);
    const stepCount = Math.max(8, Math.ceil(Math.abs(delta) / (Math.PI / 24)));
    const arcPoints: GeoPoint[] = [];
    for (let index = 0; index <= stepCount; index += 1) {
      const angle = startAngle + (delta * index) / stepCount;
      arcPoints.push(
        unprojectMercator({
          x: origin.x + Math.cos(angle) * radius,
          y: origin.y + Math.sin(angle) * radius
        })
      );
    }

    const labelAngle = startAngle + delta / 2;
    const labelRadius = Math.max(1, radius * 0.65);
    return {
      arcPoints,
      labelPoint: unprojectMercator({
        x: origin.x + Math.cos(labelAngle) * labelRadius,
        y: origin.y + Math.sin(labelAngle) * labelRadius
      })
    };
  }

  private renderProtractor(preview: GeoPoint | null): void {
    if (this.completedDrawingTool && this.completedDrawingTool !== "protractor") {
      this.clearOverlayList(this.toolDrawingOverlays);
      this.completedDrawingTool = null;
      this.hasCompletedDrawing = false;
    }

    this.clearOverlayList(this.toolDraftOverlays);
    const vertex = this.protractorVertex;
    const arm1 = this.protractorArm1;

    if (!vertex) {
      this.emitToolInfo("Transportador activo. Click define vertice. Shift alinea ejes.");
      return;
    }

    this.addDraftPointMarker(vertex);

    if (!arm1) {
      if (preview) {
        this.toolDraftOverlays.push(
          new this.maps.Polyline({
            map: this.map,
            path: [toLatLngLiteral(vertex), toLatLngLiteral(preview)],
            strokeColor: MAP_TOOL_COLOR,
            strokeWeight: 2,
            clickable: false
          })
        );
      }
      this.emitToolInfo("Transportador activo. Click define brazo referencia.");
      return;
    }

    this.toolDraftOverlays.push(
      new this.maps.Polyline({
        map: this.map,
        path: [toLatLngLiteral(vertex), toLatLngLiteral(arm1)],
        strokeColor: MAP_TOOL_COLOR,
        strokeWeight: 2,
        clickable: false
      })
    );

    const arm2 = preview ?? this.measurePreviewPoint;
    if (!arm2) {
      this.emitToolInfo("Transportador activo. Click final define angulo.");
      return;
    }

    this.toolDraftOverlays.push(
      new this.maps.Polyline({
        map: this.map,
        path: [toLatLngLiteral(vertex), toLatLngLiteral(arm2)],
        strokeColor: MAP_TOOL_COLOR,
        strokeWeight: 2,
        clickable: false
      })
    );

    const angle = calculateProtractorAngleDeg(vertex, arm1, arm2, PROTRACTOR_MIN_ARM_METERS);
    if (angle === null) {
      this.emitToolInfo("Transportador activo. Brazo final invalido.");
      return;
    }

    const angleText = formatAngleDegrees(angle);
    const { arcPoints, labelPoint } = this.buildProtractorArcGeometry(vertex, arm1, arm2);
    if (arcPoints.length > 1) {
      this.toolDraftOverlays.push(
        new this.maps.Polyline({
          map: this.map,
          path: arcPoints.map((entry) => toLatLngLiteral(entry)),
          strokeColor: MAP_TOOL_COLOR,
          strokeWeight: 2,
          clickable: false
        })
      );
    }
    if (labelPoint) {
      this.toolDraftOverlays.push(
        new this.maps.Marker({
          map: this.map,
          position: toLatLngLiteral(labelPoint),
          clickable: false,
          icon: {
            path: this.maps.SymbolPath.CIRCLE,
            scale: 0,
            fillOpacity: 0,
            strokeOpacity: 0
          },
          label: {
            text: angleText,
            color: "#111827",
            fontSize: "11px",
            fontWeight: "700"
          },
          zIndex: 910
        })
      );
    }

    this.emitToolInfo(`Transportador ${angleText}. Click cierra. Shift alinea ejes.`);
  }

  private finalizeProtractor(closingPoint: GeoPoint | null): void {
    const vertex = this.protractorVertex;
    const arm1 = this.protractorArm1;
    if (!closingPoint || !vertex || !arm1) return;

    const angle = calculateProtractorAngleDeg(vertex, arm1, closingPoint, PROTRACTOR_MIN_ARM_METERS);
    if (angle === null) {
      this.emitToolInfo("Transportador invalido. Brazo demasiado corto.");
      return;
    }

    const angleText = formatAngleDegrees(angle);
    const { arcPoints, labelPoint } = this.buildProtractorArcGeometry(vertex, arm1, closingPoint);
    this.clearOverlayList(this.toolDrawingOverlays);

    this.addDrawingPointMarker(vertex);
    this.toolDrawingOverlays.push(
      new this.maps.Polyline({
        map: this.map,
        path: [toLatLngLiteral(vertex), toLatLngLiteral(arm1)],
        strokeColor: MAP_TOOL_COLOR,
        strokeWeight: 2.5,
        clickable: false
      }),
      new this.maps.Polyline({
        map: this.map,
        path: [toLatLngLiteral(vertex), toLatLngLiteral(closingPoint)],
        strokeColor: MAP_TOOL_COLOR,
        strokeWeight: 2.5,
        clickable: false
      })
    );

    if (arcPoints.length > 1) {
      this.toolDrawingOverlays.push(
        new this.maps.Polyline({
          map: this.map,
          path: arcPoints.map((entry) => toLatLngLiteral(entry)),
          strokeColor: MAP_TOOL_COLOR,
          strokeWeight: 2,
          clickable: false
        })
      );
    }
    if (labelPoint) {
      this.toolDrawingOverlays.push(
        new this.maps.Marker({
          map: this.map,
          position: toLatLngLiteral(labelPoint),
          clickable: false,
          icon: {
            path: this.maps.SymbolPath.CIRCLE,
            scale: 0,
            fillOpacity: 0,
            strokeOpacity: 0
          },
          label: {
            text: angleText,
            color: "#111827",
            fontSize: "11px",
            fontWeight: "700"
          },
          zIndex: 910
        })
      );
    }

    this.markSingleDrawing("protractor");
    this.protractorVertex = null;
    this.protractorArm1 = null;
    this.measurePreviewPoint = null;
    this.clearToolDraft();
    this.emitToolLegend("protractor");
  }

  private clearZoneDraft(): void {
    this.zoneCreatePoints = [];
    this.zoneCreatePreview = null;
    this.zoneDraftMarkers.forEach((marker) => marker.setMap(null));
    this.zoneDraftMarkers = [];
    if (this.zoneDraftLine) {
      this.zoneDraftLine.setMap(null);
      this.zoneDraftLine = null;
    }
    if (this.zoneDraftFill) {
      this.zoneDraftFill.setMap(null);
      this.zoneDraftFill = null;
    }
  }

  private renderZoneDraft(preview: GeoPoint | null): void {
    this.zoneDraftMarkers.forEach((marker) => marker.setMap(null));
    this.zoneDraftMarkers = [];

    this.zoneCreatePoints.forEach((point) => {
      this.zoneDraftMarkers.push(
        new this.maps.Marker({
          map: this.map,
          position: toLatLngLiteral(point),
          clickable: false,
          icon: {
            path: this.maps.SymbolPath.CIRCLE,
            scale: 3,
            fillColor: "#f97316",
            fillOpacity: 0.95,
            strokeColor: "#7c2d12",
            strokeWeight: 1
          },
          zIndex: 905
        })
      );
    });

    const draftPoints = preview && this.zoneCreatePoints.length > 0 ? [...this.zoneCreatePoints, preview] : [...this.zoneCreatePoints];

    if (this.zoneDraftLine) {
      this.zoneDraftLine.setMap(null);
      this.zoneDraftLine = null;
    }
    if (this.zoneDraftFill) {
      this.zoneDraftFill.setMap(null);
      this.zoneDraftFill = null;
    }

    if (draftPoints.length > 1) {
      this.zoneDraftLine = new this.maps.Polyline({
        map: this.map,
        path: draftPoints.map((entry) => toLatLngLiteral(entry)),
        strokeColor: "#f97316",
        strokeWeight: 2,
        clickable: false,
        icons: preview
          ? [
              {
                icon: {
                  path: "M 0,-1 0,1",
                  strokeOpacity: 1,
                  scale: 3
                },
                offset: "0",
                repeat: "10px"
              }
            ]
          : undefined
      });
    }

    if (this.zoneCreatePoints.length >= 3) {
      this.zoneDraftFill = new this.maps.Polygon({
        map: this.map,
        paths: this.zoneCreatePoints.map((entry) => toLatLngLiteral(entry)),
        strokeColor: "#f97316",
        strokeWeight: 2,
        fillColor: "#f97316",
        fillOpacity: 0.18,
        clickable: false
      });
    }

    this.emitToolInfo("Modo zona crear. Click agrega vertices, doble click cierra.");
  }

  private finalizeZoneCreate(): void {
    if (this.zoneEditMode !== "create") return;
    if (this.zoneCreatePoints.length < 3) {
      this.emitToolInfo("Modo zona crear. Requiere al menos 3 vertices.");
      return;
    }

    const polygon = this.zoneCreatePoints.map((entry) => ({ lat: entry.lat, lon: entry.lng }));
    this.callbacks.onZoneCreate(polygon);
    this.clearZoneDraft();
    this.emitToolInfo("Zona creada. Continua dibujando o cambia modo.");
  }
}
