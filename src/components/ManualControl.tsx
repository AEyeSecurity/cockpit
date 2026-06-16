import { Octagon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

type ManualControlProps = {
  disabled: boolean;
  speedMs: number;
  onCommand: (linearX: number, angularZ: number, brake?: boolean) => void;
  showHeader?: boolean;
};

const MAX_ANGULAR = 0.7;
const REPEAT_MS = 120;

const ARROW_TO_WASD: Record<string, string> = {
  arrowup: 'w',
  arrowdown: 's',
  arrowleft: 'a',
  arrowright: 'd',
};

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
}

export function ManualControl({ disabled, speedMs, onCommand, showHeader = true }: ManualControlProps) {
  const [activeKeys, setActiveKeys] = useState<string[]>([]);
  const [braking, setBraking] = useState(false);
  const speedRef = useRef(speedMs);
  speedRef.current = speedMs;
  const pressedRef = useRef<Set<string>>(new Set());
  const timerRef = useRef<number | null>(null);
  const brakingRef = useRef(false);

  const stopTimer = (): void => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const recompute = (): void => {
    const pressed = pressedRef.current;
    setActiveKeys([...pressed]);
    const linear = (pressed.has('w') ? 1 : 0) + (pressed.has('s') ? -1 : 0);
    const angular = (pressed.has('a') ? 1 : 0) + (pressed.has('d') ? -1 : 0);

    if (disabled || brakingRef.current || (linear === 0 && angular === 0)) {
      stopTimer();
      if (!brakingRef.current) onCommand(0, 0, false);
      return;
    }
    const tick = (): void => onCommand(linear * speedRef.current, angular * MAX_ANGULAR, false);
    tick();
    stopTimer();
    timerRef.current = window.setInterval(tick, REPEAT_MS);
  };

  const startBrake = (): void => {
    if (disabled || brakingRef.current) return;
    brakingRef.current = true;
    setBraking(true);
    stopTimer();
    onCommand(0, 0, true);
  };

  const endBrake = (): void => {
    if (!brakingRef.current) return;
    brakingRef.current = false;
    setBraking(false);
    onCommand(0, 0, false);
    recompute();
  };

  useEffect(() => {
    if (disabled) {
      pressedRef.current.clear();
      brakingRef.current = false;
      setActiveKeys([]);
      setBraking(false);
      stopTimer();
      return;
    }
    const down = (event: KeyboardEvent): void => {
      if (isTypingTarget(event.target)) return;
      if (event.key === ' ' || event.code === 'Space') {
        event.preventDefault();
        startBrake();
        return;
      }
      const key = ARROW_TO_WASD[event.key.toLowerCase()] ?? event.key.toLowerCase();
      if (!'wasd'.includes(key) || key.length !== 1) return;
      event.preventDefault();
      if (pressedRef.current.has(key)) return;
      pressedRef.current.add(key);
      recompute();
    };
    const up = (event: KeyboardEvent): void => {
      if (event.key === ' ' || event.code === 'Space') {
        endBrake();
        return;
      }
      const key = ARROW_TO_WASD[event.key.toLowerCase()] ?? event.key.toLowerCase();
      if (!pressedRef.current.has(key)) return;
      pressedRef.current.delete(key);
      recompute();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      stopTimer();
    };
  }, [disabled]); // eslint-disable-line react-hooks/exhaustive-deps

  const keycap = (key: string, label: string) => (
    <span
      className={`grid h-9 w-9 place-items-center rounded-lg border text-sm font-bold transition ${
        activeKeys.includes(key) ? 'border-brand bg-brand text-slate-950 shadow-card' : 'border-edge bg-surface-sunken text-ink-soft'
      }`}
    >
      {label}
    </span>
  );

  return (
    <div className={showHeader ? 'rounded-xl border border-brand-ring bg-brand-soft/40 p-3' : 'rounded-b-md border border-edge bg-brand-soft/30 p-3'}>
      {showHeader ? (
        <div className="mb-2.5 flex items-center justify-between">
          <span className="text-xs font-bold uppercase tracking-kicker text-brand">Control manual</span>
          <span className="text-[11px] font-semibold text-ink-faint">{speedMs.toFixed(1)} m/s</span>
        </div>
      ) : null}

      {/* Diagrama de teclas: se iluminan al presionar. Se maneja con el teclado. */}
      <div className="grid grid-cols-3 gap-1.5" style={{ gridTemplateAreas: '". w ." "a s d"' }}>
        <span style={{ gridArea: 'w' }} className="justify-self-center">{keycap('w', 'W')}</span>
        <span style={{ gridArea: 'a' }} className="justify-self-center">{keycap('a', 'A')}</span>
        <span style={{ gridArea: 's' }} className="justify-self-center">{keycap('s', 'S')}</span>
        <span style={{ gridArea: 'd' }} className="justify-self-center">{keycap('d', 'D')}</span>
      </div>

      <button
        type="button"
        disabled={disabled}
        onPointerDown={startBrake}
        onPointerUp={endBrake}
        onPointerLeave={endBrake}
        className={`mt-3 flex w-full items-center justify-center gap-2 rounded-xl border py-3 text-sm font-extrabold uppercase tracking-wide transition disabled:opacity-40 ${
          braking ? 'border-danger bg-danger text-white shadow-card' : 'border-danger/40 bg-danger/[0.07] text-danger'
        }`}
      >
        <Octagon size={18} />
        Parar
      </button>

      <p className="mt-2 text-[11px] font-medium leading-snug text-ink-faint">
        W/S avanza · A/D gira · también flechas · <span className="font-bold text-ink-soft">Espacio = frenar</span>. Velocidad: usa −/+ en Telemetría.
      </p>
    </div>
  );
}
