export interface PersonAlert {
  id: string; camera_id: string; label: string; timestamp_ms: number; count: number; confidence: number;
}
export interface PersonCamera {
  id: string; label: string; status: string; sample_ms: number; detections: unknown[]; inference_ms: number;
}
export interface WatchState {
  available: boolean; cameras: PersonCamera[]; alerts: PersonAlert[]; error: string;
}
const empty: WatchState = { available: false, cameras: [], alerts: [], error: "Conectando detector…" };
const cameraIds = new Set(["cam3", "cam4", "cam5"]);
export function parseWatchState(value: unknown, now = Date.now()): WatchState {
  const v = value as Record<string, unknown> | null;
  if (!v || v.schema !== 1 || !Array.isArray(v.cameras) || !Array.isArray(v.alerts)
    || typeof v.server_ms !== "number" || !Number.isFinite(v.server_ms)) throw new Error("Respuesta de detector inválida");
  // Evaluate camera age in server clock to tolerate a laptop/Jetson clock offset.
  const serverNow = v.server_ms;
  const cameras = v.cameras.map((c: PersonCamera) => {
    if (!c || !cameraIds.has(c.id) || typeof c.label !== "string" || typeof c.sample_ms !== "number"
      || !Number.isFinite(c.sample_ms) || !Array.isArray(c.detections)) throw new Error("Cámara inválida");
    return { ...c, status: serverNow-c.sample_ms > 5000 && c.status === "watching" ? "unavailable" : c.status };
  });
  if (cameras.length !== 3 || new Set(cameras.map(c => c.id)).size !== 3) throw new Error("Cámaras incompletas");
  const alerts = v.alerts.filter((a: PersonAlert) => a && typeof a.id === "string" && cameraIds.has(a.camera_id)
    && typeof a.label === "string" && typeof a.timestamp_ms === "number" && Number.isFinite(a.timestamp_ms)
    && Number.isInteger(a.count) && a.count > 0 && Number.isFinite(a.confidence) && a.confidence >= 0 && a.confidence <= 1)
    .slice(-50).map((a: PersonAlert) => ({ ...a, timestamp_ms: now - (serverNow-a.timestamp_ms) }));
  return { available: true, cameras, alerts, error: "" };
}

/** One in-flight request. Subscription lifetime owns polling, abort and timers. */
export class PersonWatchService {
  private state: WatchState = empty;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | undefined;
  private generation = 0;
  constructor(private endpoint: () => string, private fetchFn: typeof fetch = (input, init) => fetch(input, init)) {}
  getSnapshot = (): WatchState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) void this.poll(this.generation);
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) { this.generation++; clearTimeout(this.timer); this.controller?.abort(); }
    };
  };
  private emit(state: WatchState): void { this.state = state; this.listeners.forEach(fn => fn()); }
  private async poll(generation: number): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 3000);
    let endpoint = "";
    try {
      endpoint = this.endpoint();
      if (!endpoint) throw new Error("Detector no configurado para esta conexión");
      const response = await this.fetchFn(endpoint, { signal: controller.signal, cache: "no-store", credentials: "omit" });
      if (!response.ok) throw new Error("Detector no disponible");
      const next = parseWatchState(await response.json());
      if (generation === this.generation) this.emit(next);
    } catch {
      if (generation === this.generation) this.emit({ ...this.state, available: false,
        cameras: this.state.cameras.map(c => ({ ...c, status: "unavailable", detections: [] })),
        error: endpoint ? "Detector no disponible · sin vigilancia confirmada" : "Detector no configurado para esta conexión" });
    } finally {
      clearTimeout(timeout);
      if (generation === this.generation && this.listeners.size) this.timer = setTimeout(() => void this.poll(generation), 2000);
    }
  }
}
