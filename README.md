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
- `src/packages`: paquetes funcionales (`src/packages/<packageId>`)
- `src/packages/<id>/frontend`: módulos UI del paquete
- `src/packages/<id>/services`: lógica de negocio del paquete
- `src/packages/<id>/dispatcher`: routing por operación backend del paquete
- `src/packages/<id>/transport`: adaptadores de protocolo del paquete
- `src-tauri`: código Rust / empaquetado desktop
- `config/modules.yaml`: activar/desactivar paquetes y módulos por paquete

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

Los paquetes se descubren automáticamente desde `src/packages/*` (index + `config.json`) y se registran sin hardcode del core.

Cada paquete define:

- `index.ts`/`index.tsx` con `createPackage(): CockpitPackage`
- `config.json` obligatorio con schema:
  - `values`: defaults efectivos
  - `settings.fields`: metadata para renderizar el modal global de configuración

Persistencia de config:

- Base: `src/packages/<id>/config.json`
- Override local editable: `packages/<id>.json` (Tauri config dir)
- Merge runtime: `{ ...values, ...override }`

Activación/desactivación:

- `config/modules.yaml` soporta:
  - `packages.<id>.enabled`
  - `packages.<id>.modules.<moduleId>`
- El orden de menús/paneles/tabs se define por orden de registro en runtime (sin `order`).

En cuanto a los estilos:
- Cada módulo frontend dentro de un paquete debe tener su propio `styles.css`.
- El `index.tsx` del módulo frontend debe importar `./styles.css`.
- `src/app/base.css` se reserva para estilos base compartidos (shell/layout/tokens), no para estilos específicos de un paquete/módulo.

## Documentación recomendada

- `docs/crear-modulo.md`: guía práctica para crear un paquete nuevo.
- `docs/ejemplo-modulo-ficticio-ia.md`: ejemplo completo orientado a implementación por IA.
- `docs/instrucciones-ia-paquetes.md`: checklist/prompt operativo para que una IA cree paquetes.
- `docs/conceptos-generales.md`: terminología y contratos base del repo.
