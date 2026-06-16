import { ChevronDown, Clock, Crosshair, Layers, MapPin, ShieldAlert, ShieldCheck, User } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { CameraDetection } from '../types';

type DetectionsPanelProps = {
  detections: CameraDetection[];
  detectionsActive: boolean;
  cameraConnected: boolean;
};

type Zone = 'left' | 'center' | 'right';
type Risk = 'normal' | 'low' | 'medium' | 'high';

// Mismas reglas que el cockpit original.
const RELEVANT_CENTER = new Set(['person', 'persona', 'pedestrian', 'car', 'auto', 'vehicle', 'vehiculo', 'truck', 'camion', 'bus', 'obstacle', 'obstaculo']);

function classifyZone(det: CameraDetection): Zone {
  const centerX = det.bbox.x + det.bbox.w / 2;
  if (centerX < 0.33) return 'left';
  if (centerX > 0.66) return 'right';
  return 'center';
}

function zoneLabel(zone: Zone): string {
  if (zone === 'left') return 'Izquierda';
  if (zone === 'right') return 'Derecha';
  return 'Centro';
}

function displayLabel(label: string): string {
  const n = label.trim().toLowerCase();
  if (n === 'person' || n === 'persona' || n === 'pedestrian') return 'Persona';
  if (n === 'cone' || n === 'cono' || n === 'traffic cone') return 'Cono';
  if (n === 'car' || n === 'auto' || n === 'vehicle' || n === 'vehiculo') return 'Auto';
  if (n === 'truck' || n === 'camion') return 'Camion';
  if (n === 'bus') return 'Bus';
  if (n === 'bicycle' || n === 'bicicleta') return 'Bicicleta';
  if (n === 'motorcycle' || n === 'moto') return 'Moto';
  if (n === 'obstacle' || n === 'obstaculo') return 'Obstaculo';
  if (!label.trim()) return 'Objeto';
  return label.trim().charAt(0).toUpperCase() + label.trim().slice(1);
}

function riskForZone(det: CameraDetection, zone: Zone): Risk {
  if (zone === 'center' && RELEVANT_CENTER.has(det.label.trim().toLowerCase())) return 'high';
  if (zone === 'center') return 'medium';
  return 'low';
}

function riskRank(risk: Risk): number {
  return risk === 'high' ? 3 : risk === 'medium' ? 2 : risk === 'low' ? 1 : 0;
}

function riskLabel(risk: Risk): string {
  if (risk === 'high') return 'Riesgo alto';
  if (risk === 'medium') return 'Riesgo medio';
  if (risk === 'low') return 'Riesgo bajo';
  return 'Normal';
}

function Row({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 border-t border-edge/60 py-1.5 first:border-t-0">
      <span className="text-ink-faint">{icon}</span>
      <span className="text-[11px] font-medium text-ink-soft">{label}</span>
      <strong className="ml-auto truncate text-[11px] font-bold text-ink" title={value}>{value}</strong>
    </div>
  );
}

export function DetectionsPanel({ detections, detectionsActive, cameraConnected }: DetectionsPanelProps) {
  const [open, setOpen] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const [lastSeenMs, setLastSeenMs] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (detectionsActive && detections.length > 0) {
      setLastSeenMs(Date.now());
    }
  }, [detections, detectionsActive]);

  const active = detectionsActive ? detections : [];
  const ranked = [...active]
    .map((det) => ({ det, zone: classifyZone(det) }))
    .sort((a, b) => {
      const diff = riskRank(riskForZone(b.det, b.zone)) - riskRank(riskForZone(a.det, a.zone));
      return diff !== 0 ? diff : b.det.score - a.det.score;
    });
  const main = ranked[0] ?? null;
  const risk: Risk = main ? riskForZone(main.det, main.zone) : 'normal';

  const statusLabel = !cameraConnected ? 'Desconectado' : riskLabel(risk);
  const statusOk = cameraConnected && risk === 'normal';
  const ageLabel = lastSeenMs > 0 ? `${Math.max(0, now - lastSeenMs)} ms` : 'Esperando';

  return (
    <section className="panel shrink-0 overflow-hidden">
      <button className="flex w-full items-center gap-2 px-3 py-2" onClick={() => setOpen((v) => !v)} type="button">
        <span className="grid h-6 w-6 place-items-center rounded-md bg-surface-sunken text-ink-soft">
          <Crosshair size={13} />
        </span>
        <h2 className="text-[11px] font-extrabold uppercase text-ink">Detecciones</h2>
        <span className="ml-auto rounded-full bg-brand-soft/15 px-2 py-0.5 text-[10px] font-extrabold text-brand">{active.length} ACTIVAS</span>
        <ChevronDown size={14} className={`text-ink-faint transition ${open ? 'rotate-180' : ''}`} />
      </button>

      {open ? (
        <div className="px-3 pb-3">
          {/* Tarjeta de estado */}
          <div className="rounded-md border border-edge bg-surface-sunken/20 p-2.5">
            <div className="mb-1.5 flex items-center gap-2">
              {statusOk ? <ShieldCheck size={14} className="text-ok" /> : <ShieldAlert size={14} className={cameraConnected ? 'text-warn' : 'text-danger'} />}
              <strong className="text-[11px] font-bold text-ink-soft">
                Estado: <span className={!cameraConnected ? 'text-danger' : statusOk ? 'text-ok' : 'text-warn'}>{statusLabel}</span>
              </strong>
              {active.length > 0 ? (
                <span className="ml-auto flex items-center gap-1.5 rounded-full bg-brand-soft/15 px-1.5 py-0.5 text-[9px] font-bold uppercase text-brand">
                  <span className="h-1 w-1 rounded-full bg-brand" />
                  Activa
                </span>
              ) : null}
            </div>
            <Row icon={<User size={13} />} label="Objeto principal" value={main ? displayLabel(main.det.label) : 'Ninguno'} />
            <Row icon={<Layers size={13} />} label="Tipo de deteccion" value={main ? 'YOLO + Rastreador' : 'Ninguno'} />
            <Row icon={<ShieldCheck size={13} />} label="Confianza" value={main ? `${Math.round(main.det.score * 100)}%` : '—'} />
            <Row icon={<MapPin size={13} />} label="Zona" value={main ? zoneLabel(main.zone) : '—'} />
            <Row icon={<Clock size={13} />} label="Ultima actualizacion" value={ageLabel} />
          </div>

          {/* Detecciones activas */}
          <div className="mt-2 rounded-md border border-edge bg-surface-sunken/30 p-2.5">
            <div className="mb-1.5 flex items-center justify-between">
              <strong className="kicker">Detecciones activas</strong>
              <span className="grid h-4 min-w-4 place-items-center rounded-full bg-brand px-1 text-[10px] font-extrabold text-slate-950">{active.length}</span>
            </div>
            {ranked.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                {ranked.map(({ det, zone }, index) => {
                  const percent = Math.round(det.score * 100);
                  return (
                    <div key={`${det.id}-${index}`} className="flex items-center gap-2">
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
                      <strong className="text-[11px] font-bold text-ink">{displayLabel(det.label)}</strong>
                      <div className="ml-1 h-1 flex-1 overflow-hidden rounded-full bg-surface-sunken">
                        <span className="block h-full rounded-full bg-brand" style={{ width: `${percent}%` }} />
                      </div>
                      <span className="text-[10px] font-bold text-ink-soft">{percent}%</span>
                      <span className="rounded bg-surface-panel px-1.5 py-0.5 text-[9px] font-bold uppercase text-ink-faint">{zoneLabel(zone)}</span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="py-0.5 text-[11px] font-semibold text-brand/80">Sin detecciones activas</p>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}
