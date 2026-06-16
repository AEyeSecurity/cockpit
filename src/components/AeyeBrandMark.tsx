import { useEffect, useRef, useState } from 'react';

type EyeOffset = { x: number; y: number };

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function AeyeBrandMark() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const targetRef = useRef<EyeOffset>({ x: 0, y: 0 });
  const [eyeOffset, setEyeOffset] = useState<EyeOffset>({ x: 0, y: 0 });

  useEffect(() => {
    const commit = (): void => {
      frameRef.current = null;
      setEyeOffset(targetRef.current);
    };

    const schedule = (): void => {
      if (frameRef.current === null) {
        frameRef.current = window.requestAnimationFrame(commit);
      }
    };

    const onMouseMove = (event: MouseEvent): void => {
      const rect = rootRef.current?.getBoundingClientRect();
      const cx = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
      const cy = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
      const dx = event.clientX - cx;
      const dy = event.clientY - cy;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const strength = clamp(distance / Math.max(window.innerWidth, window.innerHeight), 0.18, 1);
      targetRef.current = {
        x: clamp((dx / distance) * 26 * strength, -26, 26),
        y: clamp((dy / distance) * 16 * strength, -16, 16),
      };
      schedule();
    };

    const onMouseLeave = (): void => {
      targetRef.current = { x: 0, y: 0 };
      schedule();
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseleave', onMouseLeave);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseleave', onMouseLeave);
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
      }
    };
  }, []);

  return (
    <div ref={rootRef} className="aeye-brand-photo" aria-hidden="true">
      <img src="/assets/aeye-shield-v3.png" alt="" className="aeye-brand-photo-img" draggable={false} />
      <svg className="aeye-brand-eye-layer" viewBox="0 0 220 100" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <clipPath id="aeye-brand-eye-clip">
            <path d="M5,50 C5,50 55,8 110,8 C165,8 215,50 215,50 C215,50 165,92 110,92 C55,92 5,50 5,50 Z" />
          </clipPath>
          <radialGradient id="aeye-brand-iris" cx="42%" cy="36%" r="70%">
            <stop offset="0%" stopColor="#fff27a" />
            <stop offset="55%" stopColor="#ffdd00" />
            <stop offset="100%" stopColor="#a17e00" />
          </radialGradient>
          <filter id="aeye-brand-glow" x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur stdDeviation="2.6" result="blur" />
            <feFlood floodColor="#caa500" floodOpacity="0.8" result="color" />
            <feComposite in="color" in2="blur" operator="in" result="glow" />
            <feMerge>
              <feMergeNode in="glow" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <path
          d="M5,50 C5,50 55,8 110,8 C165,8 215,50 215,50 C215,50 165,92 110,92 C55,92 5,50 5,50 Z"
          fill="#000"
        />
        <g clipPath="url(#aeye-brand-eye-clip)" filter="url(#aeye-brand-glow)" transform={`translate(${eyeOffset.x} ${eyeOffset.y})`}>
          <circle cx="110" cy="50" r="38" fill="url(#aeye-brand-iris)" />
          <circle cx="110" cy="50" r="15" fill="#000" />
          <circle cx="96" cy="36" r="8" fill="rgba(255,255,255,0.92)" />
        </g>
        <path
          d="M5,50 C5,50 55,8 110,8 C165,8 215,50 215,50 C215,50 165,92 110,92 C55,92 5,50 5,50 Z"
          fill="none"
          stroke="#ffdd00"
          strokeWidth="5"
          filter="url(#aeye-brand-glow)"
        />
      </svg>
    </div>
  );
}
