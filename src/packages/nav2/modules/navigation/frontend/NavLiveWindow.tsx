import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppRuntime } from "../../../../../core/types/module";
import type { ConnectionService, ConnectionState } from "../service/impl/ConnectionService";
import type { NavigationService, SnapshotData } from "../service/impl/NavigationService";
import "./styles.css";

const CONNECTION_SERVICE_ID = "service.connection";
const NAVIGATION_SERVICE_ID = "service.navigation";
export const NAV_LIVE_REFRESH_MS = 1000;

const LAYER_ORDER = [
  "local_costmap",
  "global_costmap",
  "keepout_mask",
  "footprint",
  "stop_zone",
  "scan",
  "plan",
  "collision_polygons",
  "global_inset"
];

interface NavLiveWindowProps {
  runtime: AppRuntime;
}

interface SnapshotFrame {
  snapshot: SnapshotData;
  receivedAtMs: number;
}

interface NavLiveTarget {
  preset: "real" | "sim";
  host: string;
  port: string;
}

function normalizePreset(raw: string | null): "real" | "sim" {
  return raw === "sim" ? "sim" : "real";
}

function formatAge(nowMs: number, receivedAtMs: number): string {
  const ageS = Math.max(0, (nowMs - receivedAtMs) / 1000);
  return `${ageS.toFixed(ageS < 10 ? 1 : 0)}s`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "n/a";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function NavLiveWindow({ runtime }: NavLiveWindowProps): JSX.Element {
  const connectionService = runtime.getService<ConnectionService>(CONNECTION_SERVICE_ID);
  const navigationService = runtime.getService<NavigationService>(NAVIGATION_SERVICE_ID);
  const nav2Config = runtime.getPackageConfig<Record<string, unknown>>("nav2");
  const [connection, setConnection] = useState<ConnectionState>(connectionService.getState());
  const [frame, setFrame] = useState<SnapshotFrame | null>(() => {
    const snapshot = navigationService.getState().lastSnapshot;
    return snapshot ? { snapshot, receivedAtMs: Date.now() } : null;
  });
  const [nowMs, setNowMs] = useState(Date.now());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const fallbackAttemptedRef = useRef(false);

  const simFallbackTarget = useMemo<NavLiveTarget>(() => {
    const host = String(nav2Config.ws_sim_host ?? runtime.env.wsSimHost ?? "localhost").trim() || "localhost";
    const port = String(nav2Config.ws_sim_port ?? runtime.env.wsDefaultPort ?? "8766").trim() || "8766";
    return { preset: "sim", host, port };
  }, [nav2Config.ws_sim_host, nav2Config.ws_sim_port, runtime.env.wsDefaultPort, runtime.env.wsSimHost]);

  const applyTarget = useCallback(
    async (target: NavLiveTarget): Promise<void> => {
      connectionService.setPreset(target.preset);
      connectionService.setHost(target.host);
      connectionService.setPort(target.port);
      await connectionService.connect();
    },
    [connectionService]
  );

  const trySimFallback = useCallback(
    async (reason: unknown): Promise<boolean> => {
      const current = connectionService.getState();
      const alreadyOnSim =
        current.preset === "sim" &&
        current.host.trim() === simFallbackTarget.host &&
        current.port.trim() === simFallbackTarget.port;
      if (fallbackAttemptedRef.current || alreadyOnSim) return false;
      fallbackAttemptedRef.current = true;
      try {
        setError(`Primary Nav Live target failed (${String(reason)}). Trying simulation ${simFallbackTarget.host}:${simFallbackTarget.port}.`);
        await applyTarget(simFallbackTarget);
        return true;
      } catch (fallbackError) {
        if (mountedRef.current) setError(String(fallbackError));
        return false;
      }
    },
    [applyTarget, connectionService, simFallbackTarget]
  );

  useEffect(() => {
    document.title = "Cockpit Nav Live";
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => connectionService.subscribe((next) => setConnection(next)), [connectionService]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const target: NavLiveTarget = {
      preset: normalizePreset(params.get("preset")),
      host: String(params.get("host") ?? connectionService.getState().host).trim(),
      port: String(params.get("port") ?? connectionService.getState().port).trim()
    };
    applyTarget(target).catch((connectError: unknown) => {
      if (!mountedRef.current) return;
      void trySimFallback(connectError);
    });
  }, [applyTarget, connectionService, trySimFallback]);

  const requestFrame = useCallback(async (): Promise<void> => {
    if (inFlightRef.current) return;
    const currentConnection = connectionService.getState();
    if (!currentConnection.connected) {
      setError(currentConnection.connecting ? "Connecting to Nav Live backend..." : currentConnection.lastError);
      return;
    }
    inFlightRef.current = true;
    setLoading(true);
    try {
      const next = await navigationService.requestSnapshot();
      if (!mountedRef.current) return;
      setFrame({ snapshot: next, receivedAtMs: Date.now() });
      setError("");
    } catch (snapshotError) {
      if (!mountedRef.current) return;
      const fallbackStarted = await trySimFallback(snapshotError);
      if (!fallbackStarted) setError(String(snapshotError));
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current) setLoading(false);
    }
  }, [connectionService, navigationService, trySimFallback]);

  useEffect(() => {
    void requestFrame();
    const timer = window.setInterval(() => {
      void requestFrame();
    }, NAV_LIVE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [requestFrame]);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const activeLayers = useMemo(() => frame?.snapshot.layers ?? {}, [frame]);
  const imageSrc = frame?.snapshot.imageBase64
    ? `data:${frame.snapshot.mime};base64,${frame.snapshot.imageBase64}`
    : "";
  const statusTone = connection.connected ? "ok" : connection.connecting ? "warn" : "bad";
  const statusText = connection.connected ? "Connected" : connection.connecting ? "Connecting" : "Disconnected";

  return (
    <main className="nav-live-root">
      <header className="nav-live-header">
        <div className="nav-live-title-block">
          <strong>Nav Live</strong>
          <span>{connection.host}:{connection.port}</span>
        </div>
        <div className="nav-live-status-row">
          <span className={`nav-live-status ${statusTone}`}>{statusText}</span>
          <span className={`nav-live-status ${loading ? "warn" : "ok"}`}>{loading ? "Refreshing" : "1 Hz"}</span>
          {frame ? <span className="nav-live-status neutral">Age {formatAge(nowMs, frame.receivedAtMs)}</span> : null}
        </div>
      </header>

      <section className="nav-live-viewer">
        {imageSrc ? (
          <img className="nav-live-image" src={imageSrc} alt="Nav2 live snapshot" draggable={false} />
        ) : (
          <div className="nav-live-empty">Awaiting Nav2 snapshot</div>
        )}
      </section>

      <footer className="nav-live-footer">
        <div className="nav-live-meta">
          <span>Frame {frame?.snapshot.frameId || "n/a"}</span>
          <span>
            Size {frame?.snapshot.width || 0}x{frame?.snapshot.height || 0}
          </span>
          <span>{formatBytes(frame?.snapshot.imageSizeBytes ?? 0)}</span>
        </div>
        <div className="nav-live-layers" aria-label="Snapshot layers">
          {LAYER_ORDER.map((layer) => (
            <span key={layer} className={`nav-live-layer ${activeLayers[layer] ? "on" : "off"}`}>
              {layer}
            </span>
          ))}
        </div>
        {error ? <div className="nav-live-error">{error}</div> : connection.lastError ? <div className="nav-live-error">{connection.lastError}</div> : null}
      </footer>
    </main>
  );
}
