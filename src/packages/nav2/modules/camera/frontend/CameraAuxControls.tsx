import { useEffect, useState } from "react";
import type { CameraFeaturesData, NavigationService } from "../../navigation/service/impl/NavigationService";

export function CameraAuxControls({ service, connected, controlLocked, onSweepStart }: {
  service: NavigationService | null;
  connected: boolean;
  controlLocked: boolean;
  onSweepStart?: () => void;
}): JSX.Element {
  const [state, setState] = useState<CameraFeaturesData | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setState(null);
    if (!service || !connected) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async (): Promise<void> => {
      try {
        const next = await service.readCameraFeatures();
        if (!disposed) { setState(next); if (next.error) setError(next.error); else if (next.sweepRunning && next.sweepPhase !== "recovering") setError(""); }
      } catch {
        if (!disposed) { setState(null); setError("Controles de cámara sin enlace"); }
      } finally {
        if (!disposed) timer = setTimeout(() => void poll(), 1500);
      }
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [service, connected]);

  const run = async (action: () => Promise<CameraFeaturesData>): Promise<void> => {
    setBusy(true);
    try { const next = await action(); setState(next); setError(next.error); }
    catch (failure) { setError(String(failure)); }
    finally { setBusy(false); }
  };
  const unavailable = !connected || !service || !state?.supported;
  const cannotStart = unavailable || busy || controlLocked;
  const label = (value: number | undefined): string => value === 1 ? "Encendida" : value === 0 ? "Apagada" : "Sin confirmar";
  return <div className="cv-camera-aux" aria-label="Paneo y luces">
    <div className="cv-ptz-preset-row cv-camera-sweep-row">
      <button className="cv-ptz-preset-btn" type="button"
        title="Paneo desde Frente, 90° a cada lado, hasta detener"
        disabled={cannotStart || state?.sweepRunning}
        onClick={() => { onSweepStart?.(); void run(() => service!.sweepCamera(true)); }}>Iniciar paneo</button>
      <button className="cv-ptz-preset-btn" type="button" disabled={!connected || !service || busy}
        onClick={() => void run(() => service!.sweepCamera(false))}>Detener paneo</button>
    </div>
    {state?.sweepRunning && <p className="cv-ptz-inline-note" role="status">{state.sweepPhase === "recovering" ? "Reintentando paneo en unos segundos…" : state.sweepPhase === "centering" ? "Centrando al frente…" : state.sweepPhase === "moving_left" ? "Buscando límite izquierdo…" : state.sweepPhase === "sweeping_left" ? "Paneando hacia la izquierda…" : "Paneando hacia la derecha…"}</p>}
    <details className="cv-camera-light-details">
      <summary>Luces <span>Móvil / fija</span></summary>
      <div className="cv-camera-light-body">
        {(["mobile", "fixed"] as const).map((lens) => <div className="cv-camera-light-row" key={lens}>
          <div><strong>{lens === "mobile" ? "Móvil" : "Fija"}</strong>
            <span>{label(lens === "mobile" ? state?.mobileLight : state?.fixedLight)}</span></div>
          <button className="cv-ptz-preset-btn" type="button" disabled={cannotStart}
            aria-label={`Encender luz ${lens === "mobile" ? "móvil" : "fija"}`}
            title={lens === "mobile" ? "Luz blanca fija; activa modo nocturno" : "Luz fija"}
            onClick={() => void run(() => service!.setCameraLight(lens, true))}>Encender</button>
          <button className="cv-ptz-preset-btn" type="button" disabled={!connected || !service || busy}
            aria-label={`Apagar luz ${lens === "mobile" ? "móvil" : "fija"}`}
            title={lens === "mobile" ? "Restaurar la configuración anterior" : "Apagar luz"}
            onClick={() => void run(() => service!.setCameraLight(lens, false))}>Apagar</button>
        </div>)}
        <p>La móvil activa modo nocturno. Al apagar recupera su configuración anterior.</p>
      </div>
    </details>
    {controlLocked && <p className="cv-ptz-inline-note">Tomá el control para encender o iniciar.</p>}
    {error && <p className="cv-ptz-inline-note" role="alert">{error}</p>}
  </div>;
}
