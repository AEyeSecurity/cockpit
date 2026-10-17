import { useEffect, useMemo, useState } from "react";
import { CameraStreamSurface, type CameraStreamStatus } from "../../../shared/CameraStreamSurface";
import type { CameraStreamRuntimeConfig } from "../../../shared/cameraStreamConfig";

export function SecondaryCameraTile({ title, description, config, url, autoStart = false, startRequest = 0 }: {
  title: string; description: string; config: CameraStreamRuntimeConfig; url: string; autoStart?: boolean; startRequest?: number;
}): JSX.Element {
  const [requested, setRequested] = useState(autoStart);
  useEffect(() => { if (startRequest > 0) setRequested(true); }, [startRequest]);
  const [status, setStatus] = useState<CameraStreamStatus | null>(null);
  const stream = useMemo(() => ({ ...config, transport: "webrtc" as const, webrtcUrl: url, webrtcReceiveAudio: true }), [config, url]);
  return <section className="cv-secondary-tile" aria-label={`Cámara ${title}`}>
    <header><div><strong>{title}</strong><span>{description}</span></div>
      {url && <button type="button" onClick={() => setRequested(value => !value)}>{requested ? "Detener" : "Ver video"}</button>}
    </header>
    <div className="cv-secondary-video">
      {url && requested && <CameraStreamSurface isActive config={stream} className="cv-secondary-frame" alt={`Cámara ${title}`} onStatusChange={setStatus} />}
      {!url ? <p>Cámara pendiente de conectar</p> : !requested ? <p>Video pausado para ahorrar datos</p> : !status?.connected ? <p>{status?.error ? "Sin señal · reintentando" : "Conectando…"}</p> : null}
    </div>
  </section>;
}
