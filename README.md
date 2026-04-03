![Cockpit Logo](./logo.png)

# Cockpit Modular Desktop

Aplicación desktop modular para tooling de robótica, construida con **React + TypeScript + Tauri**.

## Stack

- Frontend: React + TSX (Vite)
- Runtime desktop: Tauri 2
- Comunicación backend: WebSocket / HTTP
- Arquitectura: `Frontend -> Services -> Dispatchers -> Transports`

## Estructura rápida

- `src/app`: shell y layout (toolbar, sidebar, workspace, consola, modales, footer)
- `src/core`: bootstrap, config, tipos, registries, eventos
- `src/modules`: módulos funcionales (`navigation`, `map`, `telemetry`, `debug`, `settings`)
- `src/services`: lógica de negocio
- `src/dispatcher`: routing por operación backend
- `src/transport`: adaptadores de protocolo
- `src-tauri`: código Rust / empaquetado desktop
- `config/modules.yaml`: activar/desactivar módulos

## Requisitos

- Node.js 18+
- npm 9+
- Rust toolchain
- Dependencias de sistema para Tauri (según tu SO)

## Variables de entorno

Copiar y ajustar:

```bash
cp .env.example .env
```

## Comandos

```bash
npm install
npm run dev         # Frontend Vite
npm run tauri:dev   # App desktop en desarrollo
npm run build       # Build web
npm run tauri:build # Build desktop
npm run test        # Tests
```

## Modularidad

Los módulos se registran en `src/core/bootstrap/moduleCatalog.ts` y se habilitan/deshabilitan con `config/modules.yaml` sin tocar el core.

En cuanto a los estilos:
- Cada módulo en `src/modules/<modulo>` debe tener su propio `styles.css`.
- El `index.tsx` del módulo debe importar `./styles.css`.
- `src/app/base.css` se reserva para estilos base compartidos (shell/layout/tokens), no para estilos específicos de un módulo.
