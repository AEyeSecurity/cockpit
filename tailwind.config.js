/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Tema operativo oscuro basado en el frontend original del cockpit.
        brand: {
          DEFAULT: '#ffdd00',
          soft: 'rgba(255, 221, 0, 0.12)',
          ring: '#ffdd00',
          ink: '#a17e00',
        },
        ink: {
          DEFAULT: '#f3f6fb',
          soft: '#c8d0d8',
          faint: '#89939f',
        },
        edge: {
          DEFAULT: '#202936',
          soft: '#111720',
        },
        surface: {
          base: '#020407',
          panel: '#070b10',
          sunken: '#0c1118',
        },
        ok: '#00e676',
        warn: '#ffdd00',
        danger: '#ff174d',
      },
      boxShadow: {
        card: '0 16px 34px -22px rgba(0,0,0,0.88), inset 0 1px 0 rgba(255,255,255,0.05)',
        pop: '0 24px 70px -28px rgba(0,0,0,0.92)',
        marker: '0 10px 24px -8px rgba(0,0,0,0.78)',
      },
      fontFamily: {
        sans: ['Manrope', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      letterSpacing: {
        kicker: '0.12em',
      },
      keyframes: {
        rise: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        pulseDot: {
          '0%': { boxShadow: '0 0 0 0 rgba(0,230,118,0.48)' },
          '70%': { boxShadow: '0 0 0 6px rgba(0,230,118,0)' },
          '100%': { boxShadow: '0 0 0 0 rgba(0,230,118,0)' },
        },
      },
      animation: {
        rise: 'rise 0.45s cubic-bezier(0.22,1,0.36,1) both',
        pulseDot: 'pulseDot 2s ease-out infinite',
      },
    },
  },
  plugins: [],
};
