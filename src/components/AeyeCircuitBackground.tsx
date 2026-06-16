import { useEffect, useRef } from 'react';

type Segment = { x1: number; y1: number; x2: number; y2: number };
type Point = { x: number; y: number };
type Pulse = {
  phase: number;
  speed: number;
  size: number;
  bright: number;
  segIdx: number;
  lastCycle: number;
};
type Particle = { x: number; y: number; vx: number; vy: number; r: number; a: number };

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function AeyeCircuitBackground() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }

    let raf = 0;
    let width = 0;
    let height = 0;
    let startedAt = 0;
    let circuit: { segs: Segment[]; nodes: Point[] } = { segs: [], nodes: [] };
    let pulses: Pulse[] = [];
    const particles: Particle[] = Array.from({ length: 14 }, () => ({
      x: Math.random(),
      y: Math.random(),
      vx: (Math.random() - 0.5) * 0.00006,
      vy: (Math.random() - 0.5) * 0.00006,
      r: 0.4 + Math.random() * 1.0,
      a: 0.025 + Math.random() * 0.09,
    }));

    const buildCircuit = (w: number, h: number): void => {
      const segs: Segment[] = [];
      const nodes: Point[] = [];
      const cx = w / 2;
      const cy = h / 2;
      const safeR = Math.min(w, h) * 0.42;

      for (let t = 0; t < 88; t += 1) {
        const zone = t % 4;
        const edgeZone = 0.36;
        let x = 0;
        let y = 0;
        if (zone === 0) {
          x = Math.random() * w * edgeZone;
          y = Math.random() * h * edgeZone;
        } else if (zone === 1) {
          x = w * (1 - edgeZone) + Math.random() * w * edgeZone;
          y = Math.random() * h * edgeZone;
        } else if (zone === 2) {
          x = Math.random() * w * edgeZone;
          y = h * (1 - edgeZone) + Math.random() * h * edgeZone;
        } else {
          x = w * (1 - edgeZone) + Math.random() * w * edgeZone;
          y = h * (1 - edgeZone) + Math.random() * h * edgeZone;
        }

        if (Math.hypot(x - cx, y - cy) < safeR) {
          continue;
        }

        let horiz = Math.random() < 0.5;
        let dx = horiz ? (Math.random() < 0.5 ? 1 : -1) : 0;
        let dy = horiz ? 0 : Math.random() < 0.5 ? 1 : -1;
        nodes.push({ x, y });

        let px = x;
        let py = y;
        const steps = 4 + Math.floor(Math.random() * 7);
        for (let s = 0; s < steps; s += 1) {
          const len = Math.min(w, h) * (0.04 + Math.random() * 0.13);
          let nx = clamp(px + dx * len, 8, w - 8);
          let ny = clamp(py + dy * len, 8, h - 8);
          let mx = (px + nx) / 2;
          let my = (py + ny) / 2;

          if (Math.hypot(mx - cx, my - cy) < safeR * 0.88) {
            const turnX = dy * (Math.random() < 0.5 ? 1 : -1);
            const turnY = dx * (Math.random() < 0.5 ? 1 : -1);
            nx = clamp(px + turnX * len, 8, w - 8);
            ny = clamp(py + turnY * len, 8, h - 8);
            mx = (px + nx) / 2;
            my = (py + ny) / 2;
            if (Math.hypot(mx - cx, my - cy) < safeR * 0.88) {
              break;
            }
            dx = turnX;
            dy = turnY;
          }

          segs.push({ x1: px, y1: py, x2: nx, y2: ny });
          nodes.push({ x: nx, y: ny });
          px = nx;
          py = ny;

          horiz = !horiz;
          dx = horiz ? (Math.random() < 0.5 ? 1 : -1) : 0;
          dy = horiz ? 0 : Math.random() < 0.5 ? 1 : -1;
        }
      }

      circuit = { segs, nodes };
      pulses = Array.from({ length: 22 }, () => ({
        phase: Math.random() * 12,
        speed: 0.08 + Math.random() * 0.22,
        size: 2.5 + Math.random() * 4,
        bright: 0.5 + Math.random() * 0.5,
        segIdx: segs.length > 0 ? Math.floor(Math.random() * segs.length) : 0,
        lastCycle: -1,
      }));
    };

    const resize = (): void => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      buildCircuit(width, height);
    };

    const draw = (time: number): void => {
      const w = width;
      const h = height;
      const cx = w / 2;
      const cy = h / 2;
      const auraY = h * 0.49;
      const safeR = Math.min(w, h) * 0.42;
      const maxDim = Math.max(w, h);
      const glowPulse = 0.5 + Math.sin(time * 0.72) * 0.5;

      ctx.clearRect(0, 0, w, h);

      const base = ctx.createLinearGradient(0, 0, w, h);
      base.addColorStop(0, '#020407');
      base.addColorStop(0.5, '#05080d');
      base.addColorStop(1, '#010306');
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, w, h);

      const grid = 30;
      for (let gx = grid / 2; gx < w; gx += grid) {
        for (let gy = grid / 2; gy < h; gy += grid) {
          const dC = Math.hypot(gx - cx, gy - auraY);
          const fade = clamp((dC - safeR * 0.75) / (Math.min(w, h) * 0.48), 0, 1);
          if (fade < 0.06) {
            continue;
          }
          ctx.fillStyle = `rgba(255,221,0,${fade * 0.045})`;
          ctx.fillRect(gx, gy, 1, 1);
        }
      }

      for (const seg of circuit.segs) {
        const mx = (seg.x1 + seg.x2) / 2;
        const my = (seg.y1 + seg.y2) / 2;
        const dC = Math.hypot(mx - cx, my - auraY);
        const fade = clamp((dC - safeR) / (maxDim * 0.28), 0, 1);
        ctx.strokeStyle = `rgba(255,221,0,${0.018 + fade * 0.072})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(seg.x1, seg.y1);
        ctx.lineTo(seg.x2, seg.y2);
        ctx.stroke();
      }

      for (const node of circuit.nodes) {
        const dC = Math.hypot(node.x - cx, node.y - auraY);
        const fade = clamp((dC - safeR) / (maxDim * 0.28), 0, 1);
        ctx.fillStyle = `rgba(255,221,0,${0.032 + fade * 0.14})`;
        ctx.beginPath();
        ctx.arc(node.x, node.y, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }

      for (const pulse of pulses) {
        if (circuit.segs.length === 0) {
          break;
        }
        const raw = time * pulse.speed + pulse.phase;
        const cycle = Math.floor(raw);
        const t = raw % 1;
        if (cycle !== pulse.lastCycle) {
          pulse.lastCycle = cycle;
          pulse.segIdx = Math.floor(Math.random() * circuit.segs.length);
        }

        const seg = circuit.segs[pulse.segIdx];
        const px = seg.x1 + (seg.x2 - seg.x1) * t;
        const py = seg.y1 + (seg.y2 - seg.y1) * t;
        const dC = Math.hypot(px - cx, py - auraY);
        const fade = Math.max(0, (dC - safeR * 0.58) / (maxDim * 0.32));
        if (fade < 0.08) {
          continue;
        }
        const bright = pulse.bright * Math.min(1, fade);

        for (let trail = 2; trail >= 0; trail -= 1) {
          const tt = t - trail * 0.09;
          if (tt < 0) {
            continue;
          }
          const tx = seg.x1 + (seg.x2 - seg.x1) * tt;
          const ty = seg.y1 + (seg.y2 - seg.y1) * tt;
          const trailBright = bright * (0.38 - trail * 0.11);
          if (trailBright < 0.02) {
            continue;
          }
          const glow = ctx.createRadialGradient(tx, ty, 0, tx, ty, pulse.size * (1 + trail * 0.6));
          glow.addColorStop(0, `rgba(255,242,122,${trailBright * 0.8})`);
          glow.addColorStop(0.5, `rgba(255,221,0,${trailBright * 0.32})`);
          glow.addColorStop(1, 'rgba(255,221,0,0)');
          ctx.fillStyle = glow;
          ctx.beginPath();
          ctx.arc(tx, ty, pulse.size * (1 + trail * 0.6), 0, Math.PI * 2);
          ctx.fill();
        }

        const head = ctx.createRadialGradient(px, py, 0, px, py, pulse.size + 3);
        head.addColorStop(0, `rgba(255,246,183,${bright})`);
        head.addColorStop(0.35, `rgba(255,221,0,${bright * 0.55})`);
        head.addColorStop(1, 'rgba(255,221,0,0)');
        ctx.fillStyle = head;
        ctx.beginPath();
        ctx.arc(px, py, pulse.size + 3, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.save();
      ctx.strokeStyle = 'rgba(255,221,0,0.2)';
      ctx.lineWidth = 1.5;
      const cornerSize = Math.min(w, h) * 0.055;
      const cornerPad = Math.min(w, h) * 0.024;
      const corners = [
        [cornerPad, cornerPad, 1, 1],
        [w - cornerPad, cornerPad, -1, 1],
        [cornerPad, h - cornerPad, 1, -1],
        [w - cornerPad, h - cornerPad, -1, -1],
      ] as const;
      for (const [x, y, sx, sy] of corners) {
        ctx.beginPath();
        ctx.moveTo(x + sx * cornerSize, y);
        ctx.lineTo(x, y);
        ctx.lineTo(x, y + sy * cornerSize);
        ctx.stroke();
        ctx.globalAlpha = 0.45;
        ctx.beginPath();
        ctx.moveTo(x + sx * cornerSize * 0.35, y + sy * 2.5);
        ctx.lineTo(x + sx * cornerSize * 0.35, y + sy * 8);
        ctx.moveTo(x + sx * 2.5, y + sy * cornerSize * 0.35);
        ctx.lineTo(x + sx * 8, y + sy * cornerSize * 0.35);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      ctx.restore();

      const aura = ctx.createRadialGradient(cx, auraY, 0, cx, auraY, maxDim * 0.55);
      aura.addColorStop(0, `rgba(255,221,0,${0.3 + glowPulse * 0.3})`);
      aura.addColorStop(0.18, 'rgba(202,165,0,0.14)');
      aura.addColorStop(0.44, 'rgba(82,67,0,0.06)');
      aura.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = aura;
      ctx.fillRect(0, 0, w, h);

      const scanY = (time * 0.055 % 1) * h;
      const scan = ctx.createLinearGradient(0, scanY - h * 0.18, 0, scanY + h * 0.18);
      scan.addColorStop(0, 'rgba(255,221,0,0)');
      scan.addColorStop(0.5, 'rgba(255,221,0,0.014)');
      scan.addColorStop(1, 'rgba(255,221,0,0)');
      ctx.fillStyle = scan;
      ctx.fillRect(0, Math.max(0, scanY - h * 0.18), w, h * 0.36);

      for (const particle of particles) {
        particle.x += particle.vx;
        particle.y += particle.vy;
        if (particle.x < 0) particle.x = 1;
        if (particle.x > 1) particle.x = 0;
        if (particle.y < 0) particle.y = 1;
        if (particle.y > 1) particle.y = 0;
        const twinkle = 0.55 + Math.sin(time * 1.7 + particle.x * 31 + particle.y * 27) * 0.3;
        ctx.beginPath();
        ctx.arc(particle.x * w, particle.y * h, particle.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,221,0,${particle.a * twinkle})`;
        ctx.fill();
      }

      const vignette = ctx.createRadialGradient(cx, auraY, h * 0.25, cx, auraY, h * 0.9);
      vignette.addColorStop(0, 'rgba(0,0,0,0)');
      vignette.addColorStop(0.58, 'rgba(0,0,0,0.20)');
      vignette.addColorStop(1, 'rgba(0,0,0,0.84)');
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, w, h);
    };

    const frame = (ts: number): void => {
      if (!startedAt) {
        startedAt = ts;
      }
      draw((ts - startedAt) / 1000);
      raf = window.requestAnimationFrame(frame);
    };

    resize();
    window.addEventListener('resize', resize);
    raf = window.requestAnimationFrame(frame);

    return () => {
      window.removeEventListener('resize', resize);
      window.cancelAnimationFrame(raf);
    };
  }, []);

  return <canvas ref={canvasRef} className="aeye-circuit-bg" aria-hidden="true" />;
}
