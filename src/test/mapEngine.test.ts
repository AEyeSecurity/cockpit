import { describe, expect, it, vi } from "vitest";
import { MapEngine } from "../packages/nav2/modules/map/frontend/mapEngine";
import type { ZoneEntry } from "../packages/nav2/modules/map/service/impl/MapService";

type ListenerMap = Map<string, Set<(...args: unknown[]) => void>>;

class FakeMapsEventListener {
  constructor(private readonly listeners: ListenerMap, private readonly event: string, private readonly handler: (...args: unknown[]) => void) {}

  remove(): void {
    const set = this.listeners.get(this.event);
    if (!set) return;
    set.delete(this.handler);
    if (set.size === 0) {
      this.listeners.delete(this.event);
    }
  }
}

class FakeLatLng {
  constructor(private readonly latitude: number, private readonly longitude: number) {}

  lat(): number {
    return this.latitude;
  }

  lng(): number {
    return this.longitude;
  }
}

class FakeMVCArray {
  private readonly listeners: ListenerMap = new Map();

  constructor(private values: FakeLatLng[]) {}

  getLength(): number {
    return this.values.length;
  }

  getAt(index: number): FakeLatLng {
    return this.values[index];
  }

  setAt(index: number, value: FakeLatLng): void {
    this.values[index] = value;
    this.emit("set_at", index, value);
  }

  insertAt(index: number, value: FakeLatLng): void {
    this.values.splice(index, 0, value);
    this.emit("insert_at", index, value);
  }

  removeAt(index: number): FakeLatLng {
    const [removed] = this.values.splice(index, 1);
    this.emit("remove_at", index, removed);
    return removed;
  }

  addListener(event: string, handler: (...args: unknown[]) => void): FakeMapsEventListener {
    const current = this.listeners.get(event) ?? new Set();
    current.add(handler);
    this.listeners.set(event, current);
    return new FakeMapsEventListener(this.listeners, event, handler);
  }

  emit(event: string, ...args: unknown[]): void {
    const current = this.listeners.get(event);
    if (!current) return;
    [...current].forEach((handler) => handler(...args));
  }
}

class FakeBase {
  protected readonly listeners: ListenerMap = new Map();

  addListener(event: string, handler: (...args: unknown[]) => void): FakeMapsEventListener {
    const current = this.listeners.get(event) ?? new Set();
    current.add(handler);
    this.listeners.set(event, current);
    return new FakeMapsEventListener(this.listeners, event, handler);
  }

  emit(event: string, ...args: unknown[]): void {
    const current = this.listeners.get(event);
    if (!current) return;
    [...current].forEach((handler) => handler(...args));
  }
}

class FakeMap extends FakeBase {
  private options: Record<string, unknown>;

  constructor(_host: HTMLDivElement, options: Record<string, unknown>) {
    super();
    this.options = { ...options, draggable: true };
  }

  setOptions(options: Record<string, unknown>): void {
    this.options = {
      ...this.options,
      ...options
    };
  }

  setCenter(center: unknown): void {
    this.options.center = center;
  }

  setZoom(zoom: number): void {
    this.options.zoom = zoom;
  }

  getZoom(): number {
    return Number(this.options.zoom ?? 0);
  }

  get(key: string): unknown {
    return this.options[key];
  }

  setMapTypeId(value: string): void {
    this.options.mapTypeId = value;
  }
}

class FakePolyline extends FakeBase {
  map: FakeMap | null = null;

  constructor(private options: Record<string, unknown>) {
    super();
    this.map = (options.map as FakeMap | undefined) ?? null;
  }

  setMap(map: FakeMap | null): void {
    this.map = map;
  }
}

class FakePolygon extends FakeBase {
  map: FakeMap | null = null;
  private path: FakeMVCArray;
  private options: Record<string, unknown>;

  constructor(options: Record<string, unknown>) {
    super();
    this.options = { ...options };
    this.map = (options.map as FakeMap | undefined) ?? null;
    const paths = Array.isArray(options.paths) ? (options.paths as Array<{ lat: number; lng: number }>) : [];
    this.path = new FakeMVCArray(paths.map((entry) => new FakeLatLng(entry.lat, entry.lng)));
  }

  setMap(map: FakeMap | null): void {
    this.map = map;
  }

  getPath(): FakeMVCArray {
    return this.path;
  }

  setPaths(paths: Array<{ lat: number; lng: number }>): void {
    this.path = new FakeMVCArray(paths.map((entry) => new FakeLatLng(entry.lat, entry.lng)));
  }

  setOptions(options: Record<string, unknown>): void {
    this.options = {
      ...this.options,
      ...options
    };
  }
}

class FakeMarker extends FakeBase {
  map: FakeMap | null = null;
  position: FakeLatLng | null = null;
  title = "";

  constructor(options: Record<string, unknown>) {
    super();
    this.map = (options.map as FakeMap | undefined) ?? null;
    this.position = fromLatLngLiteral(options.position as { lat: number; lng: number } | undefined);
    this.title = String(options.title ?? "");
  }

  setMap(map: FakeMap | null): void {
    this.map = map;
  }

  setPosition(value: { lat: number; lng: number } | FakeLatLng): void {
    this.position = value instanceof FakeLatLng ? value : new FakeLatLng(value.lat, value.lng);
  }

  getPosition(): FakeLatLng | null {
    return this.position;
  }

  setIcon(_value: unknown): void {}

  setDraggable(_value: boolean): void {}
}

class FakeInfoWindow extends FakeBase {
  setContent(_content: string): void {}

  setPosition(_position: unknown): void {}

  open(_map: FakeMap): void {
    this.emit("domready");
  }

  close(): void {}
}

function fromLatLngLiteral(value?: { lat: number; lng: number }): FakeLatLng | null {
  if (!value) return null;
  return new FakeLatLng(value.lat, value.lng);
}

interface FakeMapsContext {
  maps: typeof google.maps;
  readonly map: FakeMap;
  polygons: FakePolygon[];
  markers: FakeMarker[];
}

function createFakeMaps(): FakeMapsContext {
  const polygons: FakePolygon[] = [];
  const markers: FakeMarker[] = [];
  let mapRef: FakeMap | null = null;

  const maps = {
    Map: class extends FakeMap {
      constructor(host: HTMLDivElement, options: Record<string, unknown>) {
        super(host, options);
        mapRef = this;
      }
    },
    Marker: class extends FakeMarker {
      constructor(options: Record<string, unknown>) {
        super(options);
        markers.push(this);
      }
    },
    Polyline: FakePolyline,
    Polygon: class extends FakePolygon {
      constructor(options: Record<string, unknown>) {
        super(options);
        polygons.push(this);
      }
    },
    InfoWindow: FakeInfoWindow,
    SymbolPath: {
      FORWARD_CLOSED_ARROW: 1,
      CIRCLE: 2
    },
    event: {
      addListener: (target: { addListener: (event: string, handler: (...args: unknown[]) => void) => FakeMapsEventListener }, event: string, handler: (...args: unknown[]) => void) =>
        target.addListener(event, handler),
      addListenerOnce: (
        target: { addListener: (event: string, handler: (...args: unknown[]) => void) => FakeMapsEventListener },
        event: string,
        handler: (...args: unknown[]) => void
      ) => {
        let ref: FakeMapsEventListener | null = null;
        ref = target.addListener(event, (...args: unknown[]) => {
          handler(...args);
          ref?.remove();
        });
        return ref;
      },
      trigger: (target: { emit: (event: string, ...args: unknown[]) => void }, event: string, ...args: unknown[]) => {
        target.emit(event, ...args);
      }
    }
  } as unknown as typeof google.maps;

  return {
    maps,
    get map() {
      if (!mapRef) {
        throw new Error("Map not created yet");
      }
      return mapRef;
    },
    polygons,
    markers
  };
}

function buildCallbacks() {
  return {
    onToolInfo: vi.fn(),
    onInspectCoords: vi.fn(),
    onQueueWaypoint: vi.fn(),
    onToggleWaypointSelection: vi.fn(),
    onMoveWaypoint: vi.fn(),
    onZoneToggle: vi.fn(),
    onZoneCreate: vi.fn(),
    onZonePolygonChange: vi.fn(),
    onZoneDelete: vi.fn(),
    onInspectCopied: vi.fn()
  };
}

function emitMapEvent(context: FakeMapsContext, event: string, lat: number, lng: number): void {
  context.map.emit(event, {
    latLng: new FakeLatLng(lat, lng),
    domEvent: new MouseEvent(event)
  });
}

describe("MapEngine", () => {
  it("creates no-go zone using create mode", () => {
    const context = createFakeMaps();
    const callbacks = buildCallbacks();

    const engine = new MapEngine({
      maps: context.maps,
      host: document.createElement("div"),
      initialCenterLat: 0,
      initialCenterLon: 0,
      initialZoom: 15,
      interactive: true,
      mapType: "hybrid",
      callbacks
    });

    engine.setZoneEditMode("create");
    emitMapEvent(context, "click", 1, 1);
    emitMapEvent(context, "click", 1, 2);
    emitMapEvent(context, "click", 2, 2);
    emitMapEvent(context, "dblclick", 2, 2);

    expect(callbacks.onZoneCreate).toHaveBeenCalledTimes(1);
    const polygon = callbacks.onZoneCreate.mock.calls[0]?.[0] as Array<{ lat: number; lon: number }>;
    expect(polygon).toHaveLength(3);

    engine.destroy();
  });

  it("updates zone polygon while editing", () => {
    const context = createFakeMaps();
    const callbacks = buildCallbacks();

    const engine = new MapEngine({
      maps: context.maps,
      host: document.createElement("div"),
      initialCenterLat: 0,
      initialCenterLon: 0,
      initialZoom: 15,
      interactive: true,
      mapType: "hybrid",
      callbacks
    });

    const zones: ZoneEntry[] = [
      {
        id: "z1",
        name: "Zone 1",
        vertices: 3,
        updatedAt: Date.now(),
        enabled: true,
        polygon: [
          { lat: 0, lon: 0 },
          { lat: 0, lon: 1 },
          { lat: 1, lon: 1 }
        ]
      }
    ];

    engine.setZones(zones);
    engine.setZoneEditMode("edit");

    const polygon = context.polygons[0];
    polygon.emit("click");
    polygon.getPath().setAt(0, new FakeLatLng(0.25, 0.25));

    expect(callbacks.onZonePolygonChange).toHaveBeenCalled();
    expect(callbacks.onZonePolygonChange.mock.calls.at(-1)?.[0]).toBe("z1");

    engine.destroy();
  });

  it("deletes zone in delete mode", () => {
    const context = createFakeMaps();
    const callbacks = buildCallbacks();

    const engine = new MapEngine({
      maps: context.maps,
      host: document.createElement("div"),
      initialCenterLat: 0,
      initialCenterLon: 0,
      initialZoom: 15,
      interactive: true,
      mapType: "hybrid",
      callbacks
    });

    engine.setZones([
      {
        id: "z-delete",
        name: "Delete me",
        vertices: 3,
        updatedAt: Date.now(),
        polygon: [
          { lat: 0, lon: 0 },
          { lat: 0, lon: 1 },
          { lat: 1, lon: 1 }
        ]
      }
    ]);

    engine.setZoneEditMode("delete");
    context.polygons[0]?.emit("click");

    expect(callbacks.onZoneDelete).toHaveBeenCalledWith("z-delete");

    engine.destroy();
  });

  it("handles waypoint click and drag callbacks", () => {
    const context = createFakeMaps();
    const callbacks = buildCallbacks();

    const engine = new MapEngine({
      maps: context.maps,
      host: document.createElement("div"),
      initialCenterLat: 0,
      initialCenterLon: 0,
      initialZoom: 15,
      interactive: true,
      mapType: "hybrid",
      callbacks
    });

    engine.setWaypoints(
      [
        {
          x: 1,
          y: 2,
          yawDeg: 0
        }
      ],
      []
    );

    const waypointMarker = context.markers.find((marker) => marker.title === "#1");
    if (!waypointMarker) {
      throw new Error("Waypoint marker not found");
    }

    waypointMarker.emit("click");
    expect(callbacks.onToggleWaypointSelection).toHaveBeenCalledWith(0);

    waypointMarker.setPosition({ lat: 4, lng: 5 });
    waypointMarker.emit("dragend");
    expect(callbacks.onMoveWaypoint).toHaveBeenCalledWith(0, 4, 5);

    engine.destroy();
  });

  it("resets tool info when tool mode returns to idle", () => {
    const context = createFakeMaps();
    const callbacks = buildCallbacks();

    const engine = new MapEngine({
      maps: context.maps,
      host: document.createElement("div"),
      initialCenterLat: 0,
      initialCenterLon: 0,
      initialZoom: 15,
      interactive: true,
      mapType: "hybrid",
      callbacks
    });

    engine.setToolMode("ruler");
    engine.setToolMode("idle");

    expect(callbacks.onToolInfo).toHaveBeenLastCalledWith("Map tools idle.");

    engine.destroy();
  });
});
