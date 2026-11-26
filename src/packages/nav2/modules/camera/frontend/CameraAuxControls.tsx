import { useEffect, useState } from "react";
import type { CameraFeaturesData, CameraSweepRange, NavigationService } from "../../navigation/service/impl/NavigationService";

const previewBounds = { minimum: -90, maximum: 90 };
const minimumSpan = 2;

export function CameraAuxControls({ service, connected, controlLocked, onSweepStart }: {
  service: NavigationService | null;
  connected: boolean;
  controlLocked: boolean;
  onSweepStart?: () => void;
}): JSX.Element {
  const [state, setState] = useState<CameraFeaturesData | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selection, setSelection] = useState<CameraSweepRange | null>(null);
  useEffect(() => {
    setState(null);
    setError("");
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
  const sweepUnavailableReason = !connected || !service ? ""
    : !state ? error ? "No se pudo consultar el estado del paneo." : "Consultando el estado del paneo…"
    : !state.supported ? "El rover no informó soporte para el paneo."
    : "";
  const unavailable = !connected || !service || !state?.supported;
  const cannotStart = unavailable || busy || controlLocked;
  const bounds = state?.sweepBounds ?? previewBounds;
  const validBounds = bounds.maximum - bounds.minimum >= minimumSpan;
  const minimumAngle = Math.max(bounds.minimum, Math.min(selection?.minimum ?? bounds.minimum, bounds.maximum - minimumSpan));
  const maximumAngle = Math.min(bounds.maximum, Math.max(selection?.maximum ?? bounds.maximum, minimumAngle + minimumSpan));
  const position = (angle: number) => (angle - bounds.minimum) / (bounds.maximum - bounds.minimum) * 100;
  const label = (value: number | undefined): string => value === 1 ? "Encendida" : value === 0 ? "Apagada" : "Sin confirmar";
  return <div className="cv-camera-aux" aria-label="Paneo y luces">
    <details className="cv-camera-action-section" open>
      <summary>Paneo <span>Cámara móvil</span></summary>
      <div className="cv-camera-action-body">
        {validBounds && <fieldset className="cv-camera-sweep-range" disabled={busy || state?.sweepRunning}>
          <legend>{state?.sweepBounds ? "Rango de paneo" : "Vista previa del rango de paneo"}</legend>
          <div className="cv-camera-sweep-values" aria-hidden="true">
            <span>Mínimo <strong>{minimumAngle}°</strong></span>
            <span>Máximo <strong>{maximumAngle}°</strong></span>
          </div>
          <div className="cv-camera-sweep-track">
            <div className="cv-camera-sweep-rail" aria-hidden="true">
              <div style={{ left: `${position(minimumAngle)}%`, right: `${100 - position(maximumAngle)}%` }} />
            </div>
            <input aria-label="Ángulo mínimo" aria-valuetext={`${minimumAngle} grados`}
              type="range" min={bounds.minimum} max={bounds.maximum} step={1} value={minimumAngle}
              onChange={(event) => setSelection({
                minimum: Math.min(event.currentTarget.valueAsNumber, maximumAngle - minimumSpan), maximum: maximumAngle
              })} />
            <input aria-label="Ángulo máximo" aria-valuetext={`${maximumAngle} grados`}
              type="range" min={bounds.minimum} max={bounds.maximum} step={1} value={maximumAngle}
              onChange={(event) => setSelection({
                minimum: minimumAngle, maximum: Math.max(event.currentTarget.valueAsNumber, minimumAngle + minimumSpan)
              })} />
          </div>
        </fieldset>}
        <p className="cv-camera-action-hint">{!validBounds ? "El preset Frente no deja espacio suficiente para el paneo."
          : state?.sweepBounds ? "0° es el frente." : "0° es el frente. Este backend usa el rango fijo de −90° a +90°."}</p>
        <div className="cv-camera-preset-row">
          <button className="cv-camera-action-button" type="button"
            disabled={cannotStart || !validBounds || state?.sweepRunning}
            onClick={() => {
              onSweepStart?.();
              void run(() => state?.sweepBounds
                ? service!.sweepCamera(true, { minimum: minimumAngle, maximum: maximumAngle })
                : service!.sweepCamera(true));
            }}>Iniciar paneo</button>
          <button className="cv-camera-action-button" type="button" disabled={!connected || !service || busy}
            onClick={() => void run(() => service!.sweepCamera(false))}>Detener paneo</button>
        </div>
        {sweepUnavailableReason && <p className="cv-camera-action-hint" role="status">{sweepUnavailableReason}</p>}
        {state?.sweepRunning && <p className="cv-ptz-inline-note" role="status">{state.sweepPhase === "recovering" ? "Reintentando paneo en unos segundos…" : state.sweepPhase === "centering" ? "Buscando la posición inicial…" : state.sweepPhase === "moving_left" ? "Buscando límite izquierdo…" : state.sweepPhase === "sweeping_left" ? "Paneando hacia la izquierda…" : "Paneando hacia la derecha…"}</p>}
      </div>
    </details>
    <details className="cv-camera-action-section">
      <summary>Luces <span>Móvil / fija</span></summary>
      <div className="cv-camera-action-body">
        {(["mobile", "fixed"] as const).map((lens) => <div className="cv-camera-light-row" key={lens}>
          <div><strong>{lens === "mobile" ? "Móvil" : "Fija"}</strong>
            <span>{label(lens === "mobile" ? state?.mobileLight : state?.fixedLight)}</span></div>
          <button className="cv-camera-action-button" type="button" disabled={cannotStart}
            aria-label={`Encender luz ${lens === "mobile" ? "móvil" : "fija"}`}
            title={lens === "mobile" ? "Luz blanca fija; activa modo nocturno" : "Luz fija"}
            onClick={() => void run(() => service!.setCameraLight(lens, true))}>Encender</button>
          <button className="cv-camera-action-button" type="button" disabled={!connected || !service || busy}
            aria-label={`Apagar luz ${lens === "mobile" ? "móvil" : "fija"}`}
            title={lens === "mobile" ? "Restaurar la configuración anterior" : "Apagar luz"}
            onClick={() => void run(() => service!.setCameraLight(lens, false))}>Apagar</button>
        </div>)}
        <p>La móvil activa modo nocturno. Al apagar recupera su configuración anterior.</p>
      </div>
    </details>
    {error && <p className="cv-ptz-inline-note" role="alert">{error}</p>}
  </div>;
}
