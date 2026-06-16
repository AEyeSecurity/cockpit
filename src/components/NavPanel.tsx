import {
  ChevronDown,
  Flag,
  Link2,
  Lock,
  MapPin,
  Pause,
  Play,
  Plus,
  Shuffle,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { useState } from 'react';
import type { RobotStateWithActions } from '../hooks/useRobotState';
import { ConfirmDialog } from './ConfirmDialog';
import { ManualControl } from './ManualControl';

type MapMode = 'idle' | 'addWaypoint' | 'goal';

type NavPanelProps = {
  robot: RobotStateWithActions;
  mapMode: MapMode;
  onSetMapMode: (mode: MapMode) => void;
};

export function NavPanel({ robot, mapMode, onSetMapMode }: NavPanelProps) {
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [showConnection, setShowConnection] = useState(true);
  const [showControlMode, setShowControlMode] = useState(true);
  const [showWaypoints, setShowWaypoints] = useState(true);
  const [showNavigationActions, setShowNavigationActions] = useState(true);
  const [showManualControls, setShowManualControls] = useState(true);

  const connected = robot.backendConnected;
  const locked = robot.controlLocked;
  const canDrive = connected && !locked; // controles habilitados solo si conectado y sin lock
  const manual = robot.mode === 'manual';
  const hasWaypoints = robot.waypoints.length > 0;
  const missionActive = Boolean(robot.mission?.active);
  const missionPaused = Boolean(robot.mission?.paused);

  return (
    <>
      <aside className="panel nav-panel hidden w-[250px] shrink-0 flex-col overflow-hidden xl:w-[270px] 2xl:w-[290px] lg:flex">
        <div className="border-b border-edge px-4 py-2">
          <h2 className="text-[11px] font-extrabold uppercase text-ink">Navegación / Control</h2>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
          {/* ---- Connection (real) ---- */}
          <div className="mb-2.5 rounded-md border border-edge bg-surface-sunken/35 p-2.5">
            <button className={`flex h-7 w-full items-center justify-between ${showConnection ? 'mb-2.5' : ''}`} onClick={() => setShowConnection((v) => !v)} type="button">
              <span className="flex items-center gap-2.5">
                <Link2 size={15} className="text-ok" />
                <span className="text-[12px] font-extrabold uppercase tracking-[0.06em] text-ink">Conexión</span>
              </span>
              <ChevronDown size={14} className={`text-ink-faint transition ${showConnection ? 'rotate-180' : ''}`} />
            </button>

            {showConnection ? (
              <div className="border-t border-edge pt-2.5">
                <div className="mb-2.5 flex items-center gap-1.5 text-[11px] font-semibold">
                    <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-ok' : robot.backendConnecting ? 'bg-warn' : 'bg-danger'}`} />
                    <span className={connected ? 'text-ok' : robot.backendConnecting ? 'text-warn' : 'text-danger'}>
                      {connected ? 'Conectado' : robot.backendConnecting ? 'Conectando…' : 'Desconectado'}
                    </span>
                </div>
                {connected || robot.backendConnecting ? (
                  <button
                    onClick={robot.disconnect}
                    type="button"
                    className="brand-motion min-h-[36px] w-full rounded-md border border-brand-ring px-3 py-1.5 text-[12px] font-extrabold text-slate-950 transition active:scale-[0.99]"
                  >
                    Desconectar
                  </button>
                ) : (
                  <button onClick={robot.connect} type="button" className="brand-motion min-h-[36px] w-full rounded-md px-3 py-1.5 text-[12px] font-extrabold text-slate-950 transition active:scale-[0.99]">
                    Conectar
                  </button>
                )}
              </div>
            ) : null}
          </div>

          {/* ---- Control mode (real toggle) ---- */}
          <div className="mb-2.5 rounded-md border border-edge bg-surface-sunken/35 p-2.5">
            <button className={`flex h-7 w-full items-center justify-between ${showControlMode ? 'mb-2.5' : ''}`} onClick={() => setShowControlMode((v) => !v)} type="button">
              <span className="flex items-center gap-2.5">
                <Shuffle size={15} className="text-ink-faint" />
                <span className="text-[12px] font-extrabold uppercase tracking-[0.06em] text-ink">Modo de control</span>
              </span>
              <ChevronDown size={14} className={`text-ink-faint transition ${showControlMode ? 'rotate-180' : ''}`} />
            </button>
            {showControlMode ? (
              <div className="grid grid-cols-2 gap-1.5 rounded-md bg-black/20 p-1.5">
                {(['autonomo', 'manual'] as const).map((value) => {
                  const active = robot.mode === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      disabled={value === 'manual' ? !canDrive : !connected}
                      onClick={() => robot.setManualMode(value === 'manual')}
                      className={`min-h-[34px] rounded-md px-2 text-[10px] font-extrabold uppercase tracking-[0.04em] transition disabled:cursor-not-allowed disabled:opacity-60 ${
                        active ? 'brand-motion text-slate-950' : 'border border-edge/60 bg-surface-panel/55 text-ink-soft hover:border-brand-ring/60 hover:bg-surface-panel hover:text-ink'
                      }`}
                    >
                      {value === 'autonomo' ? 'Autónomo' : 'Manual'}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>

          {/* ---- Waypoints (dinámicos; ocultos en modo manual) ---- */}
          {!manual ? (
          <>
          <div className={`flex items-center justify-between border border-edge bg-surface-sunken/35 px-2.5 py-2.5 ${showWaypoints ? 'mb-0 rounded-t-md border-b-0' : 'mb-2.5 rounded-md'}`}>
            <button className="flex h-7 min-w-0 items-center gap-2 text-left" onClick={() => setShowWaypoints((v) => !v)} type="button">
              <MapPin size={14} className="shrink-0 text-ink-faint" />
              <span className="text-[12px] font-extrabold uppercase tracking-[0.06em] text-ink">Puntos de ruta</span>
              <span className="grid h-5 min-w-5 place-items-center rounded bg-surface-sunken px-1.5 text-[11px] font-extrabold text-ink-soft">{robot.waypoints.length}</span>
              <ChevronDown size={14} className={`shrink-0 text-ink-faint transition ${showWaypoints ? 'rotate-180' : ''}`} />
            </button>
            <div className="flex items-center gap-1.5">
              <span className="group relative inline-grid">
                <button
                  type="button"
                  aria-label="Agregar desde el mapa"
                  onClick={() => onSetMapMode(mapMode === 'addWaypoint' ? 'idle' : 'addWaypoint')}
                  className={`grid h-7 w-7 place-items-center rounded-md transition ${
                    mapMode === 'addWaypoint' ? 'brand-motion text-slate-950' : 'border border-edge/60 bg-surface-panel/55 text-ink-soft hover:border-brand-ring/60 hover:bg-surface-sunken hover:text-brand'
                  }`}
                >
                  <Plus size={15} />
                </button>
                <span className="pointer-events-none absolute bottom-[calc(100%+8px)] right-0 z-50 whitespace-nowrap rounded-md border border-edge bg-surface-panel px-2.5 py-1.5 text-[11px] font-bold text-ink-soft opacity-0 shadow-card transition group-hover:opacity-100">
                  Agregar desde el mapa
                </span>
              </span>
              <button
                type="button"
                aria-label="Borrar todos los puntos"
                disabled={!hasWaypoints}
                onClick={robot.clearWaypoints}
                className="grid h-7 w-7 place-items-center rounded-md border border-edge/50 bg-surface-panel/35 text-ink-faint transition hover:border-edge hover:bg-surface-sunken hover:text-danger disabled:cursor-not-allowed disabled:opacity-55"
              >
                <Trash2 size={13} />
              </button>
            </div>
          </div>

          {showWaypoints ? (
          <ul className="mb-2.5 flex flex-col gap-1.5 rounded-b-md border border-edge bg-surface-sunken/25 p-2.5">
            {robot.waypoints.length === 0 ? (
              <li className="flex min-h-[48px] items-center justify-center rounded-md border border-dashed border-edge px-2.5 py-2.5 text-center text-[11px] font-semibold leading-snug text-ink-faint">
                {mapMode === 'addWaypoint' ? 'Toca el mapa para agregar puntos' : 'Sin puntos · usa + para agregar desde el mapa'}
              </li>
            ) : (
              robot.waypoints.map((wp, index) => (
                <li key={`${wp.lat}-${wp.lng}-${index}`} className="group flex min-h-[40px] items-center gap-2.5 rounded-md px-2.5 py-1.5 transition hover:bg-surface-sunken">
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-brand-soft text-[12px] font-bold text-brand">{index + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12px] font-bold text-ink">PR-{String(index + 1).padStart(2, '0')}</span>
                    <span className="block truncate text-[11px] font-medium text-ink-faint">{wp.lat.toFixed(5)}, {wp.lng.toFixed(5)}</span>
                  </span>
                  <button type="button" onClick={() => robot.removeWaypoint(index)} className="grid h-7 w-7 place-items-center rounded-md text-ink-faint hover:text-danger" title="Quitar">
                    <X size={14} />
                  </button>
                </li>
              ))
            )}
          </ul>
          ) : null}
          </>
          ) : null}

          {/* ---- Manual controls OR autonomous actions ---- */}
          {manual ? (
            <>
              <div className={`flex items-center justify-between border border-edge bg-surface-sunken/35 px-2.5 py-2.5 ${showManualControls ? 'mb-0 rounded-t-md border-b-0' : 'rounded-md'}`}>
                <button className="flex h-7 min-w-0 items-center gap-2 text-left" onClick={() => setShowManualControls((v) => !v)} type="button">
                  <Square size={14} className="shrink-0 text-ink-faint" />
                  <span className="text-[12px] font-extrabold uppercase tracking-[0.06em] text-ink">Control manual</span>
                  <span className="rounded bg-surface-sunken px-1.5 py-0.5 text-[11px] font-bold text-ink-soft">{robot.targetSpeedMs.toFixed(1)} m/s</span>
                  <ChevronDown size={14} className={`shrink-0 text-ink-faint transition ${showManualControls ? 'rotate-180' : ''}`} />
                </button>
              </div>
              {showManualControls ? (
                <ManualControl disabled={!canDrive} speedMs={robot.targetSpeedMs} onCommand={robot.sendManualCommand} showHeader={false} />
              ) : null}
            </>
          ) : (
            <>
              <div className="rounded-md border border-edge bg-surface-sunken/35 p-2.5">
                <button className={`flex h-7 w-full items-center justify-between px-0.5 ${showNavigationActions ? 'mb-2.5' : ''}`} onClick={() => setShowNavigationActions((v) => !v)} type="button">
                  <span className="flex items-center gap-2.5">
                    <Flag size={14} className="text-ink-faint" />
                    <span className="text-[12px] font-extrabold uppercase tracking-[0.06em] text-ink">Acciones de navegación</span>
                  </span>
                  <ChevronDown size={14} className={`text-ink-faint transition ${showNavigationActions ? 'rotate-180' : ''}`} />
                </button>
                {showNavigationActions ? (
                  <div className="flex flex-col gap-1.5">
                  <ActionRow
                    icon={<Flag size={14} />}
                    label="Enviar destino"
                    active={mapMode === 'goal'}
                    disabled={!canDrive}
                    onClick={() => onSetMapMode(mapMode === 'goal' ? 'idle' : 'goal')}
                  />
                  <ActionRow icon={<Play size={14} />} label="Iniciar ruta" disabled={!canDrive || !hasWaypoints} onClick={robot.startRoute} />
                  <ActionRow icon={<Pause size={14} />} label="Pausar ruta" disabled={!canDrive || !missionActive || missionPaused} onClick={robot.pauseRoute} />
                  <ActionRow
                    icon={<Square size={13} />}
                    label="Cancelar ruta"
                    danger
                    disabled={!canDrive || (!robot.mission && !robot.goalActive)}
                    onClick={() => setConfirmCancel(true)}
                  />
                  </div>
                ) : null}
              </div>
            </>
          )}

          {/* Estado de la última acción / bloqueo de controles (ACK del backend). */}
          {locked ? (
            <p className="mt-2 flex items-center gap-2 rounded-md border border-warn/40 bg-warn/10 px-2.5 py-2 text-[11px] font-bold uppercase tracking-wide text-warn">
              <Lock size={13} /> Controles bloqueados{robot.controlLockReason ? ` · ${robot.controlLockReason}` : ''}
            </p>
          ) : robot.lastStatus ? (
            <p
              className={`mt-2 rounded-md px-2.5 py-2 text-[11px] font-semibold ${
                robot.lastStatus.level === 'error' ? 'border border-danger/40 bg-danger/10 text-danger' : 'border border-ok/30 bg-ok/10 text-ok'
              }`}
            >
              {robot.lastStatus.text}
            </p>
          ) : null}

        </div>
      </aside>

      <ConfirmDialog
        open={confirmCancel}
        title="Cancelar ruta"
        message="La ruta activa se cancelará y el robot se detendrá."
        confirmLabel="Cancelar ruta"
        cancelLabel="Mantener ruta"
        tone="danger"
        onCancel={() => setConfirmCancel(false)}
        onConfirm={() => {
          robot.cancelRoute();
          setConfirmCancel(false);
        }}
      />
    </>
  );
}

function ActionRow({
  icon,
  label,
  onClick,
  danger,
  active,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex min-h-[36px] w-full items-center justify-between rounded-md border px-2.5 text-left text-[11px] font-extrabold uppercase tracking-[0.04em] transition disabled:cursor-not-allowed ${
        active
          ? 'border-brand-ring bg-brand-soft text-brand shadow-card'
          : danger
            ? 'border-danger/35 bg-danger/[0.055] text-danger hover:border-danger/55 hover:bg-danger/[0.09] disabled:border-danger/20 disabled:bg-danger/[0.035] disabled:text-danger/55'
            : 'border-edge bg-surface-panel/75 text-ink hover:border-brand-ring/70 hover:bg-surface-sunken hover:text-brand disabled:border-edge/55 disabled:bg-surface-sunken/45 disabled:text-ink-faint'
      }`}
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <span
          className={`grid h-6 w-6 shrink-0 place-items-center rounded ${
            active
              ? 'brand-motion text-slate-950'
              : danger
                ? 'bg-danger/[0.09] text-danger'
                : 'bg-black/20 text-ink-faint'
          }`}
        >
          {icon}
        </span>
        <span className="truncate">{label}</span>
      </span>
    </button>
  );
}
