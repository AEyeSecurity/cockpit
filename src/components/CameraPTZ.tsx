import {
  ArrowDown,
  ArrowDownLeft,
  ArrowDownRight,
  ChevronDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpLeft,
  ArrowUpRight,
  Camera,
  Minimize2,
  ZoomIn,
} from 'lucide-react';
import { useState } from 'react';

type CameraPTZProps = {
  disabled: boolean;
  onPan: (angleDeg: number) => void;
  onZoomToggle: () => void;
  onMinimize?: () => void;
};

// Geometría del control (px). Dos óvalos horizontales concéntricos (más anchos que altos):
// el interno envuelve N/S/E/W y el externo las diagonales. Radios X/Y separados → elipse.
const WIDTH = 194;
const HEIGHT = 178;
const CX = WIDTH / 2;
const CY = HEIGHT / 2;
// Contenido a tamaño normal: los óvalos se abren para llenar la caja (antes el
// contenido había quedado achicado dentro de un panel grande).
const RX_INNER = 50; // radio horizontal interno (E/W)
const RY_INNER = 48; // radio vertical interno (N/S)
const RX_OUTER = 82; // radio horizontal externo (diagonales)
const RY_OUTER = 78; // radio vertical externo (diagonales)
// Los botones diagonales quedan centrados sobre la elipse exterior.
const DIAG_OUT = 1;
const DXO = Math.round(RX_OUTER * Math.SQRT1_2 * DIAG_OUT); // proyección 45° + leve empuje hacia afuera
const DYO = Math.round(RY_OUTER * Math.SQRT1_2 * DIAG_OUT);

// Convención de ángulos del cockpit: N=0, W=+90, S=180, E=−90 (antihorario desde el norte).
const NODES: { key: string; label: string; angle: number; icon: typeof ArrowUp; dx: number; dy: number }[] = [
  { key: 'n', label: 'N', angle: 0, icon: ArrowUp, dx: 0, dy: -RY_INNER },
  { key: 's', label: 'S', angle: 180, icon: ArrowDown, dx: 0, dy: RY_INNER },
  { key: 'e', label: 'E', angle: -90, icon: ArrowRight, dx: RX_INNER, dy: 0 },
  { key: 'w', label: 'O', angle: 90, icon: ArrowLeft, dx: -RX_INNER, dy: 0 },
  { key: 'nw', label: 'NO', angle: 45, icon: ArrowUpLeft, dx: -DXO, dy: -DYO },
  { key: 'ne', label: 'NE', angle: -45, icon: ArrowUpRight, dx: DXO, dy: -DYO },
  { key: 'sw', label: 'SO', angle: 135, icon: ArrowDownLeft, dx: -DXO, dy: DYO },
  { key: 'se', label: 'SE', angle: -135, icon: ArrowDownRight, dx: DXO, dy: DYO },
];

export function CameraPTZ({ disabled, onPan, onZoomToggle, onMinimize }: CameraPTZProps) {
  const [open, setOpen] = useState(true);

  return (
    <div>
      <div className="flex items-center gap-2 px-3 py-2">
        <button className="flex min-w-0 flex-1 items-center gap-2 text-left" type="button" onClick={() => setOpen((v) => !v)}>
          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-surface-sunken text-ink-soft">
            <Camera size={13} />
          </span>
          <h2 className="text-[11px] font-extrabold uppercase text-ink">Cámara PTZ</h2>
          <ChevronDown size={14} className={`ml-auto text-ink-faint transition ${open ? 'rotate-180' : ''}`} />
        </button>
        {onMinimize ? (
          <button className="ctl h-7 w-7 shrink-0 text-ink-soft" type="button" aria-label="Cambiar cámara" title="Cambiar cámara" onClick={onMinimize}>
            <Minimize2 size={13} />
          </button>
        ) : null}
      </div>

      {open ? (
      <div className="px-3 pb-2">
      <div className="relative mx-auto" style={{ width: WIDTH, height: HEIGHT }}>
        {/* Óvalos guía (elipses horizontales): líneas finas gris azulado */}
        <span
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 border border-slate-400/20"
          style={{ width: RX_OUTER * 2, height: RY_OUTER * 2, borderRadius: '50%' }}
        />
        <span
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 border border-slate-400/20"
          style={{ width: RX_INNER * 2, height: RY_INNER * 2, borderRadius: '50%' }}
        />

        {NODES.map(({ key, label, angle, icon: Icon, dx, dy }) => (
          // El span posiciona (translate -50%); el botón conserva su transform de hover.
          <span key={key} className="absolute" style={{ left: CX + dx, top: CY + dy, transform: 'translate(-50%, -50%)' }}>
            <button
              type="button"
              disabled={disabled}
              title={`Mover ${label}`}
              onClick={() => onPan(angle)}
                className="ctl flex h-[36px] w-[36px] flex-col items-center justify-center gap-0 rounded-md text-ink-soft disabled:opacity-30"
              >
                <Icon size={14} strokeWidth={1.9} />
                <span className="text-[8px] font-bold tracking-wide">{label}</span>
            </button>
          </span>
        ))}

        {/* ZOOM central (circular) */}
        <span className="absolute" style={{ left: CX, top: CY, transform: 'translate(-50%, -50%)' }}>
          <button
            type="button"
            disabled={disabled}
            title="Alternar zoom de cámara"
            onClick={onZoomToggle}
              className="grid h-[52px] w-[52px] place-items-center rounded-full border-2 border-brand bg-surface-sunken/80 text-brand shadow-[0_0_18px_-7px_rgba(255,221,0,0.55)] transition hover:bg-surface-sunken active:scale-95 disabled:opacity-40"
            >
              <span className="flex flex-col items-center gap-0">
                <ZoomIn size={17} />
                <span className="text-[8px] font-extrabold uppercase tracking-wider">Zoom</span>
            </span>
          </button>
        </span>
      </div>
      </div>
      ) : null}
    </div>
  );
}
