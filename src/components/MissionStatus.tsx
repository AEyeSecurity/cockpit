import { ChevronDown, Clock, MapPin, Route } from 'lucide-react';
import { useState } from 'react';
import type { RobotState } from '../types';

type MissionStatusProps = {
  mission: RobotState['mission'];
};

export function MissionStatus({ mission }: MissionStatusProps) {
  const [open, setOpen] = useState(true);

  return (
    <section className="panel shrink-0 overflow-hidden">
      <button className="flex w-full items-center gap-2 px-3 py-2 text-left" type="button" onClick={() => setOpen((v) => !v)}>
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-surface-sunken text-ink-soft">
          <Route size={13} />
        </span>
        <h2 className="text-[11px] font-extrabold uppercase text-ink">Estado de la misión</h2>
        <ChevronDown size={14} className={`ml-auto text-ink-faint transition ${open ? 'rotate-180' : ''}`} />
      </button>

      {open ? (
      <div className="px-3 pb-3">
      {mission ? (
        <>
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-brand-soft text-brand">
                <Route size={16} />
              </span>
              <p className="truncate text-[14px] font-extrabold text-ink">{mission.name}</p>
            </div>
            <span
              className={`shrink-0 rounded px-2 py-1 text-[9px] font-extrabold uppercase tracking-wider ${
                mission.paused ? 'bg-warn/15 text-warn' : mission.active ? 'bg-brand-soft text-brand' : 'bg-surface-sunken text-ink-faint'
              }`}
            >
              {mission.paused ? 'Pausada' : mission.active ? 'Activa' : 'Inactiva'}
            </span>
          </div>

          <div className="mb-3">
            <div className="mb-1.5 flex items-center justify-between text-[12px] font-semibold text-ink-soft">
              <span>
                Progreso
                {mission.totalWaypoints > 0 ? (
                  <span className="ml-2 text-ink-faint">· PR {mission.currentWaypoint}/{mission.totalWaypoints}</span>
                ) : null}
              </span>
              <span className="font-extrabold text-ink">{mission.progress}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-sunken">
              <div
                className={`h-full rounded-full transition-[width] duration-500 ${mission.paused ? 'bg-warn' : 'bg-brand'}`}
                style={{ width: `${mission.progress}%` }}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 border-t border-edge pt-3">
            <div>
              <div className="flex items-center gap-1.5 text-ink-faint">
                <MapPin size={13} />
                <span className="text-[9px] font-bold uppercase tracking-wide">Distancia restante</span>
              </div>
              <p className="mt-1.5 text-[18px] font-extrabold leading-none text-ink">
                {mission.remainingMeters}
                <span className="ml-1 text-[12px] font-bold text-ink-faint">m</span>
              </p>
            </div>
            <div>
              <div className="flex items-center gap-1.5 text-ink-faint">
                <Clock size={13} />
                <span className="text-[9px] font-bold uppercase tracking-wide">Llegada est.</span>
              </div>
              <p className="mt-1.5 text-[18px] font-extrabold leading-none text-ink">
                {mission.etaMinutes.toFixed(1)}
                <span className="ml-1 text-[12px] font-bold text-ink-faint">min</span>
              </p>
            </div>
          </div>
        </>
      ) : (
        <div className="grid place-items-center rounded-md border border-dashed border-edge py-7 text-[13px] font-semibold text-ink-faint">
          Sin misión activa
        </div>
      )}
      </div>
      ) : null}
    </section>
  );
}
