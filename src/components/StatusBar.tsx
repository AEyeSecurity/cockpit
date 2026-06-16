import type { RobotState } from '../types';

type StatusBarProps = {
  robot: RobotState;
};

export function StatusBar({ robot }: StatusBarProps) {
  const operational = robot.backendConnected && robot.status !== 'stopped';
  const health = !robot.backendConnected ? { label: 'Sin conexión', tone: 'bg-danger' } : robot.status === 'ok' ? { label: 'Bueno', tone: 'bg-ok' } : robot.status === 'warning' ? { label: 'Regular', tone: 'bg-warn' } : { label: 'Crítico', tone: 'bg-danger' };

  return (
    <footer className="statusbar hidden h-[28px] shrink-0 items-center gap-4 px-3 text-[10px] font-semibold lg:flex">
      <span className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${operational ? 'animate-pulseDot bg-ok' : robot.backendConnecting ? 'bg-warn' : 'bg-danger'}`} />
        <span className="font-bold uppercase tracking-wide text-ink">
          {operational ? 'Operativo' : robot.backendConnecting ? 'Conectando' : 'Sin conexión'}
        </span>
      </span>

      <span className="h-3 w-px bg-edge" />
      <span className="text-ink-soft">Servidor <span className="font-bold text-ink">{robot.backendUrl}</span></span>
      <span className="text-ink-soft">Modo <span className="font-bold text-brand">{robot.mode === 'manual' ? 'Manual' : 'Autónomo'}</span></span>

      <span className="ml-auto flex items-center gap-2 text-ink-soft">
        Estado del sistema
        <span className="flex items-center gap-1.5 font-bold text-ink">
          <span className={`h-2 w-2 rounded-full ${health.tone}`} />
          {health.label}
        </span>
      </span>
    </footer>
  );
}
