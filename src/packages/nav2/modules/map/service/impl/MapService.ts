import type { MapDispatcher } from "../../dispatcher/impl/MapDispatcher";

export interface MapData {
  mapId: string;
  title: string;
  originLat: number;
  originLon: number;
}

export type MapToolMode = "idle" | "ruler" | "area" | "protractor" | "inspect";

export interface ZoneEntry {
  id: string;
  name: string;
  vertices: number;
  updatedAt: number;
  enabled?: boolean;
  polygon?: Array<{ lat: number; lon: number }>;
}

export interface DatumProfile {
  id: string;
  name: string;
  lat: number;
  lon: number;
  yawDeg: number;
  source?: string;
  notes?: string;
  updatedAt?: string;
}

export interface DatumProfilesState {
  datums: DatumProfile[];
  selectedId: string;
  runtime: {
    lat: number | null;
    lon: number | null;
    yawDeg: number | null;
    source: string;
    available: boolean;
    alreadySet: boolean;
  };
  pendingRestart: boolean;
  applyMode: string;
  filePath: string;
  error: string;
}

export interface MapWorkspaceState {
  map: MapData | null;
  toolMode: MapToolMode;
  toolInfo: string;
  autoSync: boolean;
  zones: ZoneEntry[];
  inspectCoords: string;
}

const mapMemoryStorage = new Map<string, string>();

function getStorageAdapter(): {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
} {
  if (
    typeof window !== "undefined" &&
    window.localStorage &&
    typeof window.localStorage.getItem === "function" &&
    typeof window.localStorage.setItem === "function"
  ) {
    return window.localStorage;
  }
  return {
    getItem: (key: string) => (mapMemoryStorage.has(key) ? mapMemoryStorage.get(key)! : null),
    setItem: (key: string, value: string) => {
      mapMemoryStorage.set(key, value);
    }
  };
}

export class MapService {
  private readonly listeners = new Set<(state: MapWorkspaceState) => void>();
  private readonly datumListeners = new Set<(state: DatumProfilesState | null) => void>();
  private state: MapWorkspaceState = {
    map: null,
    toolMode: "idle",
    toolInfo: "Map tools idle.",
    autoSync: true,
    zones: [],
    inspectCoords: "n/a"
  };
  private datumProfilesState: DatumProfilesState | null = null;
  private savedZonesPayload = "[]";
  private readonly zoneStorageKey = "cockpit.map.zones.v1";

  constructor(private readonly mapDispatcher: MapDispatcher) {
    this.mapDispatcher.subscribe("state", (message) => {
      const payload = asRecord(message.datums);
      if (!payload) return;
      this.setDatumProfilesState(parseDatumProfilesState(payload));
    });
    this.mapDispatcher.subscribe("datums", (message) => {
      this.setDatumProfilesState(parseDatumProfilesState(message as Record<string, unknown>));
    });
    this.mapDispatcher.subscribe("ack", (message) => {
      if (!Array.isArray(message.datums)) return;
      this.setDatumProfilesState(parseDatumProfilesState(message as Record<string, unknown>));
    });
  }

  async loadMap(mapId: string): Promise<MapData> {
    if (!mapId.trim()) {
      throw new Error("mapId is required");
    }

    const response = await this.mapDispatcher.requestMap(mapId);
    if (response.ok === false) {
      throw new Error(response.error ?? "Map request failed");
    }

    const payload = ((response.payload as Record<string, unknown> | undefined) ?? response) as Record<string, unknown>;
    const loaded: MapData = {
      mapId: String(payload.frame_id ?? payload.mapId ?? mapId),
      title: String(payload.title ?? payload.frame_id ?? mapId),
      originLat: Number(payload.origin_lat ?? payload.originLat ?? 0),
      originLon: Number(payload.origin_lon ?? payload.originLon ?? 0)
    };

    if (Array.isArray(payload.zones)) {
      const incoming = payload.zones
        .map((zone, index): ZoneEntry | null => {
          if (!zone || typeof zone !== "object") return null;
          const value = zone as Record<string, unknown>;
          const polygon = Array.isArray(value.polygon)
            ? value.polygon
                .map((entry) => {
                  if (!entry || typeof entry !== "object") return null;
                  const point = entry as Record<string, unknown>;
                  const lat = Number(point.lat);
                  const lon = Number(point.lon);
                  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
                  return { lat, lon };
                })
                .filter((entry): entry is { lat: number; lon: number } => entry !== null)
            : [];
          return {
            id: String(value.id ?? `zone.${index + 1}`),
            name: String(value.id ?? `Zone ${index + 1}`),
            vertices: polygon.length,
            enabled: value.enabled !== false,
            polygon,
            updatedAt: Date.now()
          };
        })
        .filter((entry): entry is ZoneEntry => entry !== null);
      this.state = {
        ...this.state,
        zones: incoming
      };
    }

    this.state = {
      ...this.state,
      map: loaded
    };
    this.emit();
    return loaded;
  }

  getState(): MapWorkspaceState {
    return {
      ...this.state,
      map: this.state.map ? { ...this.state.map } : null,
      zones: this.state.zones.map((entry) => ({ ...entry }))
    };
  }

  subscribe(callback: (state: MapWorkspaceState) => void): () => void {
    this.listeners.add(callback);
    callback(this.getState());
    return () => {
      this.listeners.delete(callback);
    };
  }

  getDatumProfilesState(): DatumProfilesState | null {
    return this.datumProfilesState ? cloneDatumProfilesState(this.datumProfilesState) : null;
  }

  subscribeDatumProfiles(callback: (state: DatumProfilesState | null) => void): () => void {
    this.datumListeners.add(callback);
    callback(this.getDatumProfilesState());
    return () => {
      this.datumListeners.delete(callback);
    };
  }

  setToolMode(mode: MapToolMode): void {
    const toolInfo =
      mode === "idle"
        ? "Map tools idle."
        : mode === "ruler"
          ? "Ruler mode active. Click points to measure distance."
          : mode === "area"
            ? "Area mode active. Draw a polygon to estimate area."
            : mode === "protractor"
              ? "Protractor mode active. Click vertex and rays to measure angle."
              : "Inspect mode active. Click map to inspect coordinates.";

    this.state = {
      ...this.state,
      toolMode: mode,
      toolInfo
    };
    this.emit();
  }

  setToolInfo(info: string): void {
    this.state = {
      ...this.state,
      toolInfo: info
    };
    this.emit();
  }

  setAutoSync(enabled: boolean): void {
    this.state = {
      ...this.state,
      autoSync: enabled
    };
    this.emit();
  }

  addZone(name?: string): ZoneEntry {
    const zone: ZoneEntry = {
      id: `zone.${Date.now()}.${Math.floor(Math.random() * 10_000)}`,
      name: name?.trim() ? name.trim() : `Zone ${this.state.zones.length + 1}`,
      vertices: 4,
      enabled: true,
      polygon: [],
      updatedAt: Date.now()
    };
    this.state = {
      ...this.state,
      zones: [zone, ...this.state.zones].slice(0, 40)
    };
    this.emit();
    return zone;
  }

  removeZone(zoneId: string, options?: { sync?: boolean }): void {
    this.state = {
      ...this.state,
      zones: this.state.zones.filter((zone) => zone.id !== zoneId)
    };
    this.emit();
    this.syncZonesIfEnabled(options);
  }

  toggleZoneEnabled(zoneId: string): void {
    this.state = {
      ...this.state,
      zones: this.state.zones.map((zone) =>
        zone.id === zoneId
          ? {
              ...zone,
              enabled: zone.enabled === false ? true : false,
              updatedAt: Date.now()
            }
          : zone
      )
    };
    this.emit();
    this.syncZonesIfEnabled();
  }

  setZonePolygon(zoneId: string, polygon: Array<{ lat: number; lon: number }>): void {
    this.state = {
      ...this.state,
      zones: this.state.zones.map((zone) =>
        zone.id === zoneId
          ? {
              ...zone,
              polygon: polygon.map((entry) => ({ ...entry })),
              vertices: polygon.length,
              updatedAt: Date.now()
            }
          : zone
      )
    };
    this.emit();
  }

  addZoneFromPolygon(polygon: Array<{ lat: number; lon: number }>, name?: string): ZoneEntry {
    const zone = this.addZone(name);
    this.setZonePolygon(zone.id, polygon);
    return this.getState().zones.find((entry) => entry.id === zone.id) ?? zone;
  }

  clearZones(): void {
    this.state = {
      ...this.state,
      zones: []
    };
    this.emit();
    this.syncZonesIfEnabled();
  }

  refreshZones(): void {
    const now = Date.now();
    const nextZones =
      this.state.zones.length > 0
        ? this.state.zones.map((zone) => ({ ...zone, updatedAt: now }))
        : [
            {
              id: `zone.seed.${now}`,
              name: "No-go default",
              vertices: 5,
              updatedAt: now
            }
          ];
    this.state = {
      ...this.state,
      zones: nextZones
    };
    this.emit();
  }

  saveZones(): string {
    this.savedZonesPayload = JSON.stringify(this.state.zones);
    return this.savedZonesPayload;
  }

  loadZones(payload?: string): void {
    const source = payload ?? this.savedZonesPayload;
    const parsed = JSON.parse(source) as ZoneEntry[];
    this.state = {
      ...this.state,
      zones: Array.isArray(parsed) ? parsed.map((zone) => ({ ...zone })) : []
    };
    this.emit();
  }

  async pushZonesToBackend(): Promise<void> {
    const geojson = this.buildGeoJsonFromState();
    const response = await this.mapDispatcher.setZonesGeoJson(geojson);
    if (response.ok === false) {
      throw new Error(String(response.error ?? "set_zones_geojson failed"));
    }
  }

  async loadZonesFromBackend(): Promise<number> {
    const response = await this.mapDispatcher.loadZonesFile();
    if (response.ok === false) {
      throw new Error(String(response.error ?? "load_zones_file failed"));
    }
    await this.loadMap(String((response as Record<string, unknown>).frame_id ?? "map"));
    return this.state.zones.length;
  }

  persistZonesToStorage(): number {
    const payload = this.saveZones();
    getStorageAdapter().setItem(this.zoneStorageKey, payload);
    return this.state.zones.length;
  }

  loadZonesFromStorage(): number {
    const raw = getStorageAdapter().getItem(this.zoneStorageKey);
    if (!raw) {
      return 0;
    }
    this.loadZones(raw);
    return this.state.zones.length;
  }

  setInspectCoords(lat: number, lon: number): void {
    this.state = {
      ...this.state,
      inspectCoords: `${lat.toFixed(6)}, ${lon.toFixed(6)}`
    };
    this.emit();
  }

  centerRobot(): void {
    this.state = {
      ...this.state,
      toolInfo: "Centered map on robot pose."
    };
    this.emit();
  }

  setDatumFromRobot(): void {
    this.state = {
      ...this.state,
      toolInfo: "Datum updated from current robot pose."
    };
    this.emit();
  }

  async getDatums(): Promise<DatumProfilesState> {
    const response = await this.mapDispatcher.getDatums();
    if (response.ok === false) {
      throw new Error(String(response.error ?? "get_datums failed"));
    }
    const next = parseDatumProfilesState(response as Record<string, unknown>);
    this.setDatumProfilesState(next);
    return next;
  }

  async saveDatumOnBackend(input: {
    id?: string;
    name: string;
    lat: number;
    lon: number;
    yawDeg: number;
    notes?: string;
    select?: boolean;
  }): Promise<DatumProfilesState> {
    const response = await this.mapDispatcher.saveDatum({
      id: input.id,
      name: input.name,
      lat: input.lat,
      lon: input.lon,
      yaw_deg: input.yawDeg,
      notes: input.notes ?? "",
      select: input.select === true
    });
    if (response.ok === false) {
      throw new Error(String(response.error ?? "save_datum failed"));
    }
    this.state = {
      ...this.state,
      toolInfo: "Datum profile saved for next navigation restart."
    };
    this.emit();
    const next = parseDatumProfilesState(response as Record<string, unknown>);
    this.setDatumProfilesState(next);
    return next;
  }

  async selectDatumOnBackend(id: string): Promise<DatumProfilesState> {
    const response = await this.mapDispatcher.selectDatum(id);
    if (response.ok === false) {
      throw new Error(String(response.error ?? "select_datum failed"));
    }
    const next = parseDatumProfilesState(response as Record<string, unknown>);
    this.setDatumProfilesState(next);
    return next;
  }

  async deleteDatumOnBackend(id: string): Promise<DatumProfilesState> {
    const response = await this.mapDispatcher.deleteDatum(id);
    if (response.ok === false) {
      throw new Error(String(response.error ?? "delete_datum failed"));
    }
    const next = parseDatumProfilesState(response as Record<string, unknown>);
    this.setDatumProfilesState(next);
    return next;
  }

  async captureCurrentGpsDatumOnBackend(input: {
    name: string;
    yawDeg?: number;
    notes?: string;
    select?: boolean;
  }): Promise<DatumProfilesState> {
    const response = await this.mapDispatcher.captureCurrentGpsDatum({
      name: input.name,
      yaw_deg: input.yawDeg,
      notes: input.notes ?? "",
      select: input.select === true
    });
    if (response.ok === false) {
      throw new Error(String(response.error ?? "capture_current_gps_datum failed"));
    }
    this.setDatumFromRobot();
    const next = parseDatumProfilesState(response as Record<string, unknown>);
    this.setDatumProfilesState(next);
    return next;
  }

  private emit(): void {
    const state = this.getState();
    this.listeners.forEach((listener) => listener(state));
  }

  private setDatumProfilesState(next: DatumProfilesState): void {
    this.datumProfilesState = cloneDatumProfilesState(next);
    const state = this.getDatumProfilesState();
    this.datumListeners.forEach((listener) => listener(state));
  }

  private syncZonesIfEnabled(options?: { sync?: boolean }): void {
    const shouldSync = options?.sync ?? true;
    if (!shouldSync || !this.state.autoSync) return;
    void this.pushZonesToBackend().catch(() => undefined);
  }

  private buildGeoJsonFromState(): Record<string, unknown> {
    const features = this.state.zones
      .map((zone) => {
        const polygon = Array.isArray(zone.polygon) ? zone.polygon : [];
        if (polygon.length < 3) return null;
        const ring = polygon.map((entry) => [entry.lon, entry.lat]);
        const first = ring[0];
        const last = ring[ring.length - 1];
        if (!first || !last) return null;
        if (first[0] !== last[0] || first[1] !== last[1]) {
          ring.push([first[0], first[1]]);
        }
        return {
          type: "Feature",
          properties: {
            id: zone.id,
            type: "no_go",
            enabled: zone.enabled !== false
          },
          geometry: {
            type: "Polygon",
            coordinates: [ring]
          }
        };
      })
      .filter((entry) => entry !== null);
    return {
      type: "FeatureCollection",
      features
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function cloneDatumProfilesState(state: DatumProfilesState): DatumProfilesState {
  return {
    ...state,
    datums: state.datums.map((entry) => ({ ...entry })),
    runtime: { ...state.runtime }
  };
}

function parseDatumProfile(value: unknown): DatumProfile | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const lat = Number(item.lat ?? item.latitude);
  const lon = Number(item.lon ?? item.longitude);
  const yawDeg = Number(item.yaw_deg ?? item.yawDeg ?? item.yaw ?? 0);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(yawDeg)) return null;
  return {
    id: String(item.id ?? ""),
    name: String(item.name ?? item.id ?? "Datum"),
    lat,
    lon,
    yawDeg,
    source: item.source === undefined ? undefined : String(item.source),
    notes: item.notes === undefined ? undefined : String(item.notes),
    updatedAt: item.updated_at === undefined ? undefined : String(item.updated_at)
  };
}

export function parseDatumProfilesState(payload: Record<string, unknown>): DatumProfilesState {
  const datums = Array.isArray(payload.datums)
    ? payload.datums.map(parseDatumProfile).filter((entry): entry is DatumProfile => entry !== null && entry.id.length > 0)
    : [];
  const runtimeRaw = (payload.runtime ?? {}) as Record<string, unknown>;
  const runtimeLat = Number(runtimeRaw.lat);
  const runtimeLon = Number(runtimeRaw.lon);
  const runtimeYaw = Number(runtimeRaw.yaw_deg ?? runtimeRaw.yawDeg);
  return {
    datums,
    selectedId: String(payload.selected_id ?? payload.selectedId ?? ""),
    runtime: {
      lat: Number.isFinite(runtimeLat) ? runtimeLat : null,
      lon: Number.isFinite(runtimeLon) ? runtimeLon : null,
      yawDeg: Number.isFinite(runtimeYaw) ? runtimeYaw : null,
      source: String(runtimeRaw.source ?? ""),
      available: runtimeRaw.available === true,
      alreadySet: runtimeRaw.already_set === true || runtimeRaw.alreadySet === true
    },
    pendingRestart: payload.pending_restart === true || payload.pendingRestart === true,
    applyMode: String(payload.apply_mode ?? payload.applyMode ?? "next_restart"),
    filePath: String(payload.file_path ?? payload.filePath ?? ""),
    error: String(payload.error ?? "")
  };
}
