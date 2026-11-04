import { useId } from "react";
import type { ModuleContext } from "../../../../../core/types/module";
import { cameraStreamQuality, useCameraStreamConfig } from "../../../shared/cameraStreamQuality";

export function CameraQualityButton({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const { quality, normalAvailable } = useCameraStreamConfig(runtime);
  const id = useId();
  return <div className="cv-quality-control">
    <div className="cv-quality-switch" role="radiogroup" aria-label="Calidad de transmisión"
      aria-describedby={`${id}-hint`} data-quality={quality}>
      <span className="cv-quality-switch-thumb" aria-hidden="true" />
      <label className="cv-quality-option" data-selected={quality === "saving"}>
        <input type="radio" name={id} value="saving" checked={quality === "saving"}
          onChange={() => cameraStreamQuality.set("saving")} />
        <span>Ahorro de datos</span>
      </label>
      <label className="cv-quality-option" data-selected={quality === "normal"} data-disabled={!normalAvailable}>
        <input type="radio" name={id} value="normal" checked={quality === "normal"} disabled={!normalAvailable}
          onChange={() => cameraStreamQuality.set("normal")} />
        <span>Transmisión normal</span>
      </label>
    </div>
    <p id={`${id}-hint`} className="muted cv-quality-hint" role="status">{normalAvailable
      ? "Se aplica a las tres cámaras en este navegador."
      : "Transmisión normal no disponible: requiere configurar los streams WebRTC."}</p>
  </div>;
}
