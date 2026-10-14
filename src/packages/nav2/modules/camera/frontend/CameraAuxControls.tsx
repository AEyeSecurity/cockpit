import { useEffect, useState } from "react";
import type { CameraFeaturesData, NavigationService } from "../../navigation/service/impl/NavigationService";

export function CameraAuxControls({ service, connected, controlLocked }: {
  service: NavigationService | null;
  connected: boolean;
  controlLocked: boolean;
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
        if (!disposed) { setState(next); setError(next.error); }
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
  return <section className="cv-panel-section cv-camera-aux" aria-label="Paneo y luces">
    <h3>Paneo y luces</h3>
    <p>Recorrido completo de izquierda a derecha de la cámara móvil.</p>
    <div className="cv-camera-aux-buttons">
      <button type="button" disabled={cannotStart || state?.sweepRunning}
        onClick={() => void run(() => service!.sweepCamera(true))}>Iniciar paneo</button>
      <button type="button" disabled={!connected || !service || busy}
        onClick={() => void run(() => service!.sweepCamera(false))}>Detener paneo</button>
    </div>
    {state?.sweepRunning && <p role="status">{state.sweepPhase === "moving_left" ? "Buscando extremo izquierdo…" : "Paneando hacia la derecha…"}</p>}
    {(["mobile", "fixed"] as const).map((lens) => <div className="cv-camera-aux-light" key={lens}>
      <strong>Luz {lens === "mobile" ? "móvil" : "fija"}</strong>
      <span>{label(lens === "mobile" ? state?.mobileLight : state?.fixedLight)}</span>
      <div className="cv-camera-aux-buttons">
        <button type="button" disabled={cannotStart}
          onClick={() => void run(() => service!.setCameraLight(lens, true))}>Encender luz {lens === "mobile" ? "móvil" : "fija"}</button>
        <button type="button" disabled={!connected || !service || busy}
          onClick={() => void run(() => service!.setCameraLight(lens, false))}>Apagar luz {lens === "mobile" ? "móvil" : "fija"}</button>
      </div>
    </div>)}
    <p>Las luces quedan fijas hasta apagarlas. La móvil fuerza modo nocturno; al apagar restaura su configuración anterior. Estado de la última orden aceptada.</p>
    {controlLocked && <p>Tomá el control para iniciar el paneo o encender las luces.</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
