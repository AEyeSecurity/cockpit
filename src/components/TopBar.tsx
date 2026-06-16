import { Battery, Camera, Route } from 'lucide-react';
import { AeyeBrandMark } from './AeyeBrandMark';
import type { RobotState } from '../types';

type TopBarProps = {
  robot: RobotState;
};

export function TopBar({ robot }: TopBarProps) {
  const alerts = robot.alerts.filter((alert) => alert.level !== 'info').length;
  const connDot = robot.backendConnected ? 'bg-ok' : robot.backendConnecting ? 'bg-warn' : 'bg-danger';
  const connText = robot.backendConnected ? 'CONECTADO' : robot.backendConnecting ? 'CONECTANDO' : 'SIN CONEXION';

  return (
    <header className="topbar flex h-[56px] shrink-0 items-center gap-3 px-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <div className="brand-mark grid h-12 w-12 shrink-0 place-items-center">
          <AeyeBrandMark />
        </div>
        <div className="min-w-0">
          <h1 className="truncate text-[22px] font-extrabold leading-none text-brand">A-EYE 01</h1>
          <p className="mt-0.5 truncate text-[12px] font-semibold text-ink-soft">Inteligencia de mision y control</p>
        </div>
      </div>

      <div className="ml-auto flex min-w-0 items-center gap-2">
        <span className="status-chip">
          <span className={`h-2 w-2 rounded-full ${robot.backendConnected ? 'animate-pulseDot' : ''} ${connDot}`} />
          {connText}
        </span>
        {robot.mission ? (
          <span className="status-chip hidden lg:inline-flex">
            <Route size={15} className="text-ink-faint" />
            {robot.mission.name}
          </span>
        ) : null}
        <span className="status-chip hidden lg:inline-flex">
          <Camera size={15} className={robot.cameraConnected ? 'text-ok' : 'text-ink-faint'} />
          Camara: {robot.cameraConnected ? 'En vivo' : 'Sin señal'}
        </span>
        <span className="status-chip">
          <span className={`h-2 w-2 rounded-full ${alerts > 0 ? 'bg-danger' : 'bg-ok'}`} />
          Alertas: {alerts}
        </span>
        <span className="status-chip">
          <Battery size={16} className={robot.battery !== null && robot.battery > 0 && robot.battery < 20 ? 'text-danger' : 'text-ok'} />
          {robot.battery === null ? '—' : `${Math.round(robot.battery)}%`}
        </span>
      </div>
    </header>
  );
}
