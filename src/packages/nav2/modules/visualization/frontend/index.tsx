import { useEffect, useMemo, useRef, useState } from "react";
import "./styles.css";
import type { CockpitModule, ModuleContext } from "../../../../../core/types/module";
import type { ConnectionService, ConnectionState } from "../../navigation/service/impl/ConnectionService";

const CONNECTION_SERVICE_ID = "service.connection";

export type RosboardWorkspaceStatus = "idle" | "connecting" | "ready" | "error";

export function resolveRosboardIframeUrl(input: { preset: string; realUrl: string; simUrl: string }): string {
  const real = String(input.realUrl ?? "").trim();
  const sim = String(input.simUrl ?? "").trim();
  if (input.preset === "sim") {
    return sim || real;
  }
  return real;
}

function parsePositiveTimeout(value: unknown, fallback: number, min: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.round(parsed));
}

function appendCacheBust(url: string, token: string): string {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}_ts=${encodeURIComponent(token)}`;
}

export function RosboardWorkspaceView({ runtime }: { runtime: ModuleContext }): JSX.Element {
  let connectionService: ConnectionService | null = null;
  try {
    connectionService = runtime.services.getService<ConnectionService>(CONNECTION_SERVICE_ID);
  } catch {
    connectionService = null;
  }

  const [connectionState, setConnectionState] = useState<ConnectionState | null>(
    connectionService ? connectionService.getState() : null
  );
  const [frameSrc, setFrameSrc] = useState("");
  const [status, setStatus] = useState<RosboardWorkspaceStatus>("idle");
  const [errorText, setErrorText] = useState("");
  const [reloadNonce, setReloadNonce] = useState(0);
  const loadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!connectionService) return;
    return connectionService.subscribe((next) => setConnectionState(next));
  }, [connectionService]);

  const preset = connectionState?.preset === "sim" ? "sim" : "real";
  const targetUrl = useMemo(
    () =>
      resolveRosboardIframeUrl({
        preset,
        realUrl: runtime.env.rosboardIframeUrlReal,
        simUrl: runtime.env.rosboardIframeUrlSim
      }),
    [preset, runtime.env.rosboardIframeUrlReal, runtime.env.rosboardIframeUrlSim]
  );

  const configured = targetUrl.length > 0;
  const probeTimeoutMs = parsePositiveTimeout(runtime.env.rosboardProbeTimeoutMs, 3000, 500);
  const loadTimeoutMs = parsePositiveTimeout(runtime.env.rosboardLoadTimeoutMs, 7000, 1000);

  const clearLoadTimeout = (): void => {
    if (!loadTimeoutRef.current) return;
    clearTimeout(loadTimeoutRef.current);
    loadTimeoutRef.current = null;
  };

  useEffect(() => {
    clearLoadTimeout();
    if (!configured) {
      setFrameSrc("");
      setStatus("idle");
      setErrorText("no configurado. define VITE_ROSBOARD_IFRAME_URL_REAL o VITE_ROSBOARD_IFRAME_URL_SIM");
      return;
    }

    let cancelled = false;
    setStatus("connecting");
    setErrorText("");
    setFrameSrc("");

    const connect = async (): Promise<void> => {
      let probeOk = true;
      let probeError = "";
      let controller: AbortController | null = null;
      let probeTimeoutId: ReturnType<typeof setTimeout> | null = null;

      try {
        if (typeof AbortController !== "undefined") {
          controller = new AbortController();
          probeTimeoutId = setTimeout(() => {
            controller?.abort();
          }, probeTimeoutMs);
        }

        await fetch(targetUrl, {
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

      if (cancelled) return;
      if (!probeOk) {
        setStatus("error");
        setErrorText(probeError);
        setFrameSrc("");
        return;
      }

      const src = appendCacheBust(targetUrl, `${Date.now()}-${reloadNonce}`);
      setFrameSrc(src);
      loadTimeoutRef.current = setTimeout(() => {
        setStatus("error");
        setErrorText("blocked by iframe policy or load timeout");
        setFrameSrc("");
      }, loadTimeoutMs);
    };

    void connect();
    return () => {
      cancelled = true;
      clearLoadTimeout();
    };
  }, [configured, loadTimeoutMs, probeTimeoutMs, reloadNonce, targetUrl]);

  const overlayText = !configured
    ? `ROSBoard ${errorText}`
    : status === "connecting"
      ? "ROSBoard connecting"
      : status === "error"
        ? `ROSBoard ${errorText}`
        : "";

  return (
    <div className="rosboard-workspace">
      <div className="rosboard-toolbar">
        <div className="rosboard-meta">
          <span className="rosboard-badge">preset: {preset}</span>
          <span className="rosboard-target">{configured ? targetUrl : "sin URL"}</span>
        </div>
        <button
          type="button"
          className="rosboard-reload-btn"
          onClick={() => {
            setReloadNonce((value) => value + 1);
          }}
          disabled={status === "connecting"}
        >
          Reload
        </button>
      </div>

      <div className="rosboard-frame-wrap">
        {frameSrc ? (
          <iframe
            className="rosboard-frame"
            src={frameSrc}
            title="ROSBoard"
            loading="lazy"
            onLoad={() => {
              clearLoadTimeout();
              setStatus("ready");
              setErrorText("");
            }}
            onError={() => {
              clearLoadTimeout();
              setStatus("error");
              setErrorText("load error");
              setFrameSrc("");
            }}
          />
        ) : (
          <div className="rosboard-frame-placeholder" />
        )}
        {overlayText ? <div className="rosboard-overlay visible">{overlayText}</div> : null}
      </div>
    </div>
  );
}

export function createVisualizationModule(): CockpitModule {
  return {
    id: "visualization",
    version: "1.0.0",
    enabledByDefault: true,
    register(ctx: ModuleContext): void {
      ctx.contributions.register({
        id: "workspace.rosboard",
        slot: "workspace",
        label: "ROSBoard",
        render: () => <RosboardWorkspaceView runtime={ctx} />
      });
    }
  };
}
