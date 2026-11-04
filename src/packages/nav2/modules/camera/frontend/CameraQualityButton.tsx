import type { ModuleContext } from "../../../../../core/types/module";
import { cameraStreamQuality, useCameraStreamConfig } from "../../../shared/cameraStreamQuality";

export function CameraQualityButton({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const { quality, normalAvailable } = useCameraStreamConfig(runtime);
  return <div className="stack">
    <button type="button" className="button-primary" disabled={!normalAvailable}
      aria-label="Calidad de transmisión" aria-pressed={quality === "normal"}
      onClick={() => cameraStreamQuality.set(quality === "normal" ? "saving" : "normal")}>
      {quality === "normal" ? "Calidad normal" : "Ahorro de datos"}
    </button>
    <p className="muted" role="status">{normalAvailable
      ? `Cambiar a ${quality === "normal" ? "Ahorro de datos" : "Calidad normal"}. Se aplica a las tres cámaras en este navegador.`
      : "Calidad normal no disponible: requiere configurar los streams WebRTC."}</p>
  </div>;
}
