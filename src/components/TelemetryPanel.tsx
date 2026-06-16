import { ChevronDown, Gauge as GaugeIcon } from 'lucide-react';
import { useState } from 'react';
import type { RobotStateWithActions } from '../hooks/useRobotState';

type TelemetryPanelProps = {
  robot: RobotStateWithActions;
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// Toda la geometria deriva de un unico centro (GAUGE_CX/CY), un unico rango
// angular (START..START+SWEEP) y un unico radio de arco. Ticks, numeros y aguja
// se posicionan con la misma formula angular -> alineacion radial garantizada.
const SPEED_MAX_KMH = 20;
const GAUGE_CX = 120;
const GAUGE_CY = 130;
const GAUGE_START_ANGLE = 180;
const GAUGE_SWEEP_ANGLE = 180;
const ARC_RADIUS = 109;
const ARC_STROKE = 12;
const ARC_INNER_RADIUS = ARC_RADIUS - ARC_STROKE / 2;
// Ticks mayores: marca blanca corta pegada al borde interno del arco.
const MAJOR_TICK_OUTER_RADIUS = ARC_INNER_RADIUS - 1;
const MAJOR_TICK_INNER_RADIUS = ARC_INNER_RADIUS - 13;
// Ticks menores: corona fina, mas corta e interna.
const MINOR_TICK_OUTER_RADIUS = ARC_INNER_RADIUS - 2;
const MINOR_TICK_INNER_RADIUS = ARC_INNER_RADIUS - 7;
// Numeros: semicirculo prolijo, radio constante, por dentro de los ticks y por
// fuera del alcance de la aguja (asi el 0 nunca queda tapado).
const LABEL_RADIUS = ARC_INNER_RADIUS - 22;
// Ticks menores cada 0.5 km/h para la corona densa premium.
const MINOR_STEP = 0.5;
const TICK_COUNT = Math.round(SPEED_MAX_KMH / MINOR_STEP);

function gaugePoint(angleDeg: number, radius: number): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180;
  return {
    x: GAUGE_CX + Math.cos(rad) * radius,
    y: GAUGE_CY + Math.sin(rad) * radius,
  };
}

function angleForValue(value: number): number {
  return GAUGE_START_ANGLE + (value / SPEED_MAX_KMH) * GAUGE_SWEEP_ANGLE;
}

function arcPath(radius: number): string {
  const start = gaugePoint(GAUGE_START_ANGLE, radius);
  const end = gaugePoint(GAUGE_START_ANGLE + GAUGE_SWEEP_ANGLE, radius);
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 0 1 ${end.x} ${end.y}`;
}

function SpeedometerGauge({ valueKmh }: { valueKmh: number }) {
  const displayValue = Math.max(0, valueKmh);
  const clamped = clamp(displayValue, 0, SPEED_MAX_KMH);
  const needleAngle = angleForValue(clamped);
  // Aguja fina y corta: la punta queda por dentro del radio de los numeros para
  // no taparlos (sobre todo el 0). Pequeno contrapeso detras del perno.
  const needleTip = gaugePoint(needleAngle, LABEL_RADIUS - 8);
  const needleTail = gaugePoint(needleAngle + 180, 13);
  const needleLeft = gaugePoint(needleAngle + 90, 3.6);
  const needleRight = gaugePoint(needleAngle - 90, 3.6);
  const ticks = Array.from({ length: TICK_COUNT + 1 }, (_, index) => {
    const value = index * MINOR_STEP;
    const angle = angleForValue(value);
    const major = Number.isInteger(value) && value % 5 === 0;
    return {
      value,
      major,
      inner: gaugePoint(angle, major ? MAJOR_TICK_INNER_RADIUS : MINOR_TICK_INNER_RADIUS),
      outer: gaugePoint(angle, major ? MAJOR_TICK_OUTER_RADIUS : MINOR_TICK_OUTER_RADIUS),
      label: gaugePoint(angle, LABEL_RADIUS),
    };
  });

  return (
    <div className="relative">
      <svg className="mx-auto block h-[140px] w-full" viewBox="0 0 240 180" role="img" aria-label={`Velocidad ${displayValue.toFixed(1)} kilometros por hora`}>
        <defs>
          {/* Gradiente sobrio que sigue el arco: verde -> ambar -> naranja -> rojo. */}
          <linearGradient id="telemetry-speed-arc" x1="26" x2="214" y1="130" y2="130" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#008f4c" />
            <stop offset="34%" stopColor="#b89600" />
            <stop offset="62%" stopColor="#b64c12" />
            <stop offset="100%" stopColor="#b61233" />
          </linearGradient>
          {/* Aro metalico del perno: luz arriba, sombra abajo. */}
          <linearGradient id="telemetry-hub-ring" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#5d6875" />
            <stop offset="48%" stopColor="#252c35" />
            <stop offset="100%" stopColor="#060a10" />
          </linearGradient>
          <radialGradient id="telemetry-hub" cx="40%" cy="30%" r="80%">
            <stop offset="0%" stopColor="#202733" />
            <stop offset="58%" stopColor="#0c1118" />
            <stop offset="100%" stopColor="#020407" />
          </radialGradient>
          <linearGradient id="telemetry-needle" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="100%" stopColor="#c4cbd4" />
          </linearGradient>
          <filter id="telemetry-needle-shadow" x="-60%" y="-60%" width="220%" height="220%">
            <feDropShadow dx="0" dy="2" stdDeviation="2" floodColor="#000000" floodOpacity="0.6" />
          </filter>
          <filter id="telemetry-number-soft" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="1" stdDeviation="1.1" floodColor="#000000" floodOpacity="0.92" />
          </filter>
        </defs>

        {/* Marco tecnico gris que encapsula y contornea el gradiente:
            asiento oscuro + bisel gris + canal gris recessed. */}
        <path d={arcPath(ARC_RADIUS)} fill="none" stroke="#05070a" strokeWidth={ARC_STROKE + 9} strokeLinecap="round" />
        <path d={arcPath(ARC_RADIUS)} fill="none" stroke="#313b46" strokeWidth={ARC_STROKE + 6} strokeLinecap="round" />
        <path d={arcPath(ARC_RADIUS)} fill="none" stroke="#141b24" strokeWidth={ARC_STROKE + 3} strokeLinecap="round" />
        <path
          d={arcPath(ARC_RADIUS)}
          fill="none"
          stroke="url(#telemetry-speed-arc)"
          strokeWidth={ARC_STROKE}
          strokeLinecap="round"
          opacity="0.9"
        />

        {ticks.map((tick) => (
          <g key={tick.value}>
            <line
              x1={tick.inner.x}
              y1={tick.inner.y}
              x2={tick.outer.x}
              y2={tick.outer.y}
              stroke={tick.major ? '#d5dce5' : '#7d8793'}
              strokeWidth={tick.major ? 3.4 : 1}
              strokeLinecap="round"
              opacity={tick.major ? 0.86 : 0.42}
            />
            {tick.major ? (
              <text
                x={tick.label.x}
                y={tick.label.y}
                textAnchor="middle"
                dominantBaseline="central"
                className="fill-ink text-[14px] font-extrabold"
                filter="url(#telemetry-number-soft)"
                style={{ fontFamily: '"Arial Narrow", "Roboto Condensed", Inter, sans-serif' }}
              >
                {tick.value}
              </text>
            ) : null}
          </g>
        ))}

        {/* Aguja blanca ahusada con sombra, exactamente desde el centro. */}
        <polygon
          points={`${needleTail.x},${needleTail.y} ${needleLeft.x},${needleLeft.y} ${needleTip.x},${needleTip.y} ${needleRight.x},${needleRight.y}`}
          fill="url(#telemetry-needle)"
          stroke="#ffffff"
          strokeWidth="0.6"
          strokeLinejoin="round"
          filter="url(#telemetry-needle-shadow)"
        />
        {/* Perno central pequeno y moderno: aro metalico + nucleo mate. */}
        <circle cx={GAUGE_CX} cy={GAUGE_CY} r="11" fill="url(#telemetry-hub-ring)" stroke="#020407" strokeWidth="1" />
        <circle cx={GAUGE_CX} cy={GAUGE_CY} r="7" fill="url(#telemetry-hub)" stroke="#0c1118" strokeWidth="0.8" />
        <circle cx={GAUGE_CX} cy={GAUGE_CY - 2} r="2.6" fill="#ffffff" opacity="0.08" />
      </svg>

      {/* Lectura integrada: solo el numero de velocidad, sin caja. */}
      <div className="-mt-3 flex min-h-[24px] items-baseline justify-center gap-1.5 tabular-nums" style={{ fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif' }}>
        <span className="text-[16px] font-black leading-none text-ink">
          {displayValue.toFixed(1)}
        </span>
        <span className="text-[16px] font-black uppercase leading-none text-ink-faint">KM/H</span>
      </div>
    </div>
  );
}

function LinearGauge({ label, value, unit, fraction, marks }: { label: string; value: string; unit: string; fraction: number; marks: string[] }) {
  const pct = clamp(fraction, 0, 1) * 100;
  return (
    <div>
      <div className="mb-2 flex items-end justify-between">
        <span className="text-[12px] font-semibold text-ink-soft">{label}</span>
        <span className="text-[15px] font-extrabold text-ink">
          {value}
          <span className="ml-1 text-[11px] font-bold text-ink-faint">{unit}</span>
        </span>
      </div>
      <div className="slider">
        <div className="slider-fill" style={{ width: `${pct}%` }} />
        <div className="slider-thumb" style={{ left: `${pct}%` }} />
      </div>
      <div className="mt-2 flex justify-between text-[10px] font-semibold text-ink-faint">
        {marks.map((mark) => (
          <span key={mark}>{mark}</span>
        ))}
      </div>
    </div>
  );
}

export function TelemetryPanel({ robot }: TelemetryPanelProps) {
  const [open, setOpen] = useState(true);
  const speedKmh = Math.max(0, robot.speedKmh);
  const speedMs = speedKmh / 3.6;
  const steering = clamp(robot.steeringDeg, -30, 30);

  return (
    <section className="panel shrink-0 overflow-hidden">
      <button className="flex w-full items-center gap-2 px-3 py-2 text-left" type="button" onClick={() => setOpen((v) => !v)}>
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-surface-sunken text-ink-soft">
          <GaugeIcon size={13} />
        </span>
        <h2 className="text-[11px] font-extrabold uppercase text-ink">Telemetría</h2>
        <span className="ml-auto flex items-center gap-2">
          <ChevronDown size={14} className={`text-ink-faint transition ${open ? 'rotate-180' : ''}`} />
        </span>
      </button>

      {open ? (
        <div className="px-3 pb-3">
          <div className="flex flex-col gap-4">
            <SpeedometerGauge valueKmh={speedKmh} />
            <LinearGauge label="Velocidad" value={speedMs.toFixed(2)} unit="m/s" fraction={speedMs / 3} marks={['0', '1.0', '2.0', '3.0']} />
            <LinearGauge label="Ángulo de dirección" value={steering.toFixed(1)} unit="°" fraction={(steering + 30) / 60} marks={['-30°', '-15°', '0°', '15°', '30°']} />
          </div>

          {/* Velocidad objetivo del manejo manual: perilla arrastrable. */}
          {robot.mode === 'manual' ? (
            <div className="mt-4 rounded-md border border-edge bg-surface-sunken/35 px-3 py-3">
              <div className="mb-2 flex items-end justify-between">
                <span className="text-[12px] font-semibold text-ink-soft">Velocidad objetivo</span>
                <span className="text-[15px] font-extrabold text-ink">
                  {robot.targetSpeedMs.toFixed(1)}
                  <span className="ml-1 text-[11px] font-bold text-ink-faint">m/s</span>
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={0.8}
                step={0.05}
                value={robot.targetSpeedMs}
                onChange={(event) => robot.setTargetSpeed(Number(event.target.value))}
                aria-label="Velocidad objetivo"
                className="range-knob"
                style={{ '--fill': `${(robot.targetSpeedMs / 0.8) * 100}%` } as React.CSSProperties}
              />
              <div className="mt-2 flex justify-between text-[10px] font-semibold text-ink-faint">
                <span>0</span>
                <span>0.4</span>
                <span>0.8 m/s</span>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

    </section>
  );
}
