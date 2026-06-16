import { useEffect, useRef, useState } from 'react';
import { AeyeCircuitBackground } from './AeyeCircuitBackground';

// Intro A-EYE: reproduce la animacion del ojo (mirada + parpadeo + escaneo) sobre
// el fondo de circuito y, al terminar, transiciona al cockpit. Port del HTML
// original "A-EYE Animation.html".

const SCAN_START = 5.5;
const SCAN_END = 7.0;
const EYE_PATH = 'M5,50 C5,50 55,8 110,8 C165,8 215,50 215,50 C215,50 165,92 110,92 C55,92 5,50 5,50 Z';

function ei(t: number): number {
  return t * t;
}
function eo(t: number): number {
  return t * (2 - t);
}
function eio(t: number): number {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}
function cl(v: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, v));
}
function mp(v: number, a: number, b: number, c: number, d: number, fn?: (t: number) => number): number {
  let t = cl((v - a) / (b - a), 0, 1);
  if (fn) {
    t = fn(t);
  }
  return c + (d - c) * t;
}

export function IntroAnimation({ onDone }: { onDone: () => void }) {
  const irisRef = useRef<SVGGElement | null>(null);
  const lidRef = useRef<SVGRectElement | null>(null);
  const scanRef = useRef<HTMLCanvasElement | null>(null);
  const [fading, setFading] = useState(false);
  const doneRef = useRef(false);

  const finish = (): void => {
    if (doneRef.current) {
      return;
    }
    doneRef.current = true;
    setFading(true);
    window.setTimeout(onDone, 650);
  };

  useEffect(() => {
    const scan = scanRef.current;
    const scanCtx = scan ? scan.getContext('2d') : null;
    let raf = 0;
    let startMs = 0;

    const eyeClip = (ctx: CanvasRenderingContext2D): void => {
      ctx.beginPath();
      ctx.moveTo(5, 50);
      ctx.bezierCurveTo(5, 50, 55, 8, 110, 8);
      ctx.bezierCurveTo(165, 8, 215, 50, 215, 50);
      ctx.bezierCurveTo(215, 50, 165, 92, 110, 92);
      ctx.bezierCurveTo(55, 92, 5, 50, 5, 50);
      ctx.closePath();
    };

    const frame = (ts: number): void => {
      if (!startMs) {
        startMs = ts;
      }
      const s = (ts - startMs) / 1000;

      let ix = 0;
      if (s < 0.8) ix = mp(s, 0, 0.8, 0, -1, eio);
      else if (s < 2.1) ix = -1;
      else if (s < 3.0) ix = mp(s, 2.1, 3.0, -1, 1, eio);
      else if (s < 4.3) ix = 1;
      else if (s < 5.2) ix = mp(s, 4.3, 5.2, 1, 0, eio);
      else ix = 0;

      let blink = 0;
      if (s >= 1.8 && s < 1.95) blink = mp(s, 1.8, 1.95, 0, 1, ei);
      else if (s >= 1.95 && s < 2.1) blink = mp(s, 1.95, 2.1, 1, 0, eo);
      else if (s >= 4.0 && s < 4.15) blink = mp(s, 4.0, 4.15, 0, 1, ei);
      else if (s >= 4.15 && s < 4.3) blink = mp(s, 4.15, 4.3, 1, 0, eo);

      if (irisRef.current) {
        irisRef.current.setAttribute('transform', `translate(${ix * 32},0)`);
      }
      if (lidRef.current) {
        lidRef.current.setAttribute('height', (blink * 96).toFixed(1));
      }

      if (scanCtx) {
        scanCtx.clearRect(0, 0, 220, 100);
        if (s >= SCAN_START && s <= SCAN_END) {
          const prog = (s - SCAN_START) / (SCAN_END - SCAN_START);
          const sy = 8 + (92 - 8) * prog;
          const al = Math.sin(prog * Math.PI) * 0.88;
          scanCtx.save();
          eyeClip(scanCtx);
          scanCtx.clip();
          const g1 = scanCtx.createLinearGradient(5, 0, 215, 0);
          g1.addColorStop(0, 'rgba(255,221,0,0)');
          g1.addColorStop(0.15, `rgba(255,221,0,${al * 0.5})`);
          g1.addColorStop(0.5, `rgba(255,242,122,${al})`);
          g1.addColorStop(0.85, `rgba(255,221,0,${al * 0.5})`);
          g1.addColorStop(1, 'rgba(255,221,0,0)');
          scanCtx.fillStyle = g1;
          scanCtx.fillRect(5, sy - 3, 210, 6);
          const g2 = scanCtx.createLinearGradient(5, 0, 215, 0);
          g2.addColorStop(0, 'rgba(255,246,183,0)');
          g2.addColorStop(0.5, `rgba(255,246,183,${al})`);
          g2.addColorStop(1, 'rgba(255,246,183,0)');
          scanCtx.fillStyle = g2;
          scanCtx.fillRect(5, sy - 0.5, 210, 1);
          scanCtx.restore();
        }
      }

      if (s < SCAN_END + 0.3) {
        raf = window.requestAnimationFrame(frame);
      } else {
        finish();
      }
    };

    raf = window.requestAnimationFrame(frame);
    return () => window.cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className={`aeye-intro ${fading ? 'is-done' : ''}`}
      role="presentation"
      onClick={finish}
      title="Saltar intro"
    >
      <AeyeCircuitBackground />
      <div className="aeye-intro-wrap">
        <img src="/assets/aeye-shield-v3.png" alt="A-EYE" className="aeye-intro-shield" draggable={false} />
        <div className="aeye-intro-eye">
          <svg viewBox="0 0 220 100" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <clipPath id="aeye-intro-clip">
                <path d={EYE_PATH} />
              </clipPath>
              <radialGradient id="aeye-intro-iris" cx="42%" cy="36%" r="70%">
                <stop offset="0%" stopColor="#fff27a" />
                <stop offset="55%" stopColor="#ffdd00" />
                <stop offset="100%" stopColor="#a17e00" />
              </radialGradient>
              <filter id="aeye-intro-glow" x="-80%" y="-80%" width="260%" height="260%">
                <feGaussianBlur stdDeviation="2.6" result="b" />
                <feFlood floodColor="#caa500" floodOpacity="0.8" result="c" />
                <feComposite in="c" in2="b" operator="in" result="g" />
                <feMerge>
                  <feMergeNode in="g" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>
            <path d={EYE_PATH} fill="#000" />
            <g ref={irisRef} clipPath="url(#aeye-intro-clip)" filter="url(#aeye-intro-glow)">
              <circle cx="110" cy="50" r="38" fill="url(#aeye-intro-iris)" />
              <circle cx="110" cy="50" r="15" fill="#000" />
              <circle cx="96" cy="36" r="8" fill="rgba(255,255,255,0.92)" />
            </g>
            <rect ref={lidRef} x="0" y="0" width="220" height="0" fill="#000" clipPath="url(#aeye-intro-clip)" />
            <path d={EYE_PATH} fill="none" stroke="#ffdd00" strokeWidth="4.5" filter="url(#aeye-intro-glow)" />
          </svg>
        </div>
        <canvas ref={scanRef} className="aeye-intro-scan" width={220} height={100} />
      </div>
    </div>
  );
}
