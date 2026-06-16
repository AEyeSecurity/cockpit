import { CameraOff, Maximize2, Minimize2, SwitchCamera } from 'lucide-react';
import type { CameraDetection } from '../types';

type CameraPanelProps = {
  variant?: 'panel' | 'stage';
  frameUrl: string | null;
  cameraConnected: boolean;
  detections: CameraDetection[];
  detectionsActive: boolean;
  onSwap: () => void;
};

function detectionDisplayLabel(label: string): string {
  const normalized = label.trim().toLowerCase();
  if (normalized === 'person' || normalized === 'persona' || normalized === 'pedestrian') return 'Persona';
  if (normalized === 'car' || normalized === 'auto' || normalized === 'vehicle' || normalized === 'vehiculo') return 'Auto';
  if (normalized === 'truck' || normalized === 'camion') return 'Camion';
  if (normalized === 'bicycle' || normalized === 'bicicleta') return 'Bicicleta';
  if (normalized === 'motorcycle' || normalized === 'moto') return 'Moto';
  if (normalized === 'obstacle' || normalized === 'obstaculo') return 'Obstaculo';
  if (!label.trim()) return 'Objeto';
  return label.trim().charAt(0).toUpperCase() + label.trim().slice(1);
}

function CameraFeed({
  frameUrl,
  detections,
  detectionsActive,
}: {
  frameUrl: string | null;
  detections: CameraDetection[];
  detectionsActive: boolean;
}) {
  const main = detectionsActive ? detections[0] : null;
  return (
    <>
      {frameUrl ? (
        <>
          <img alt="Cámara en vivo" className="h-full w-full object-cover" src={frameUrl} />
          {detectionsActive
            ? detections.map((det) => (
                <div
                  key={det.id}
                  className="pointer-events-none absolute rounded-sm border-2 border-ok"
                  style={{ left: `${det.bbox.x * 100}%`, top: `${det.bbox.y * 100}%`, width: `${det.bbox.w * 100}%`, height: `${det.bbox.h * 100}%` }}
                >
                  <span className="absolute -top-5 left-0 rounded bg-ok px-1.5 py-0.5 text-[10px] font-bold uppercase text-white">
                    {detectionDisplayLabel(det.label)} {Math.round(det.score * 100)}%
                  </span>
                </div>
              ))
            : null}
          <span className="absolute bottom-2 left-2 rounded-md bg-black/55 px-2 py-0.5 text-[11px] font-semibold text-white backdrop-blur">
            {main ? `${detectionDisplayLabel(main.label)} ${Math.round(main.score * 100)}%` : 'Sin persona'}
          </span>
        </>
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2.5 text-ink-faint">
          <CameraOff size={42} strokeWidth={1.8} />
          <span className="text-[14px] font-semibold">Sin señal de cámara</span>
        </div>
      )}
    </>
  );
}

export function CameraPanel({
  variant = 'panel',
  frameUrl,
  cameraConnected,
  detections,
  detectionsActive,
  onSwap,
}: CameraPanelProps) {
  // ---- Vista grande (cámara en el área del mapa): solo el feed (el PTZ vive en la columna derecha) ----
  if (variant === 'stage') {
    return (
      <section className="panel relative flex min-h-[420px] flex-1 flex-col overflow-hidden lg:min-h-0">
        <div className="relative min-h-0 flex-1 overflow-hidden bg-black/80">
          <CameraFeed frameUrl={frameUrl} detections={detections} detectionsActive={detectionsActive} />
          <div className="absolute left-4 top-4 flex items-center gap-2">
            <span className="kicker bg-black/45 px-2 py-1 backdrop-blur">Cámara</span>
            <span className={`flex items-center gap-1.5 rounded-md bg-black/45 px-2 py-1 text-[11px] font-extrabold uppercase tracking-wider backdrop-blur ${cameraConnected ? 'text-ok' : 'text-ink-faint'}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${cameraConnected ? 'bg-ok' : 'bg-ink-faint'}`} />
              {cameraConnected ? 'En vivo' : 'Apagada'}
            </span>
          </div>
          <button
            className="ctl absolute right-4 top-4 grid h-10 w-10 place-items-center bg-black/55 text-ink-soft backdrop-blur"
            type="button"
            aria-label="Volver al mapa"
            title="Volver al mapa"
            onClick={onSwap}
          >
            <Minimize2 size={18} />
          </button>
        </div>
      </section>
    );
  }

  // ---- Vista chica (panel derecho): feed + un único botón para cambiar al mapa ----
  return (
    <section className="panel shrink-0 p-3.5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[11px] font-extrabold uppercase text-ink">Cámara</h2>
        <span className={`flex items-center gap-1.5 text-[10px] font-extrabold uppercase tracking-wider ${cameraConnected ? 'text-ok' : 'text-ink-faint'}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${cameraConnected ? 'bg-ok' : 'bg-ink-faint'}`} />
          {cameraConnected ? 'En vivo' : 'Apagada'}
        </span>
      </div>

      <div className="relative aspect-video overflow-hidden rounded-md border border-edge bg-black/80">
        <CameraFeed frameUrl={frameUrl} detections={detections} detectionsActive={detectionsActive} />
      </div>

      <button
        type="button"
        onClick={onSwap}
        className="ctl mt-3 flex h-8 w-full items-center justify-center gap-2 text-[10px] font-bold uppercase tracking-wide text-ink-soft"
      >
        <SwitchCamera size={14} />
        Ver en el mapa
        <Maximize2 size={13} className="ml-0.5" />
      </button>
    </section>
  );
}
