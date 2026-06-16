# Cockpit Simple SALUS-01

Aplicación web aislada para operar SALUS-01 en modo simple, con datos mock y una estructura lista para conectar luego a un WebSocket real.

## Requisitos

- Node.js 18 o superior.
- npm.

## Ejecutar

```bash
cd cockpit_simple
npm install
npm run dev
```

Vite mostrará la URL local para abrir el cockpit en el navegador.

## Backend de simulación

La app usa el mismo gateway WebSocket que el cockpit existente:

```bash
VITE_WS_URL=ws://localhost:8766
```

Para probar contra simulación, levantá el perfil global:

```bash
./tools/launch_sim_global_v2.sh
```

Ese launch publica el gateway `web_zone_server` en `ws://localhost:8766`. Si el backend no está disponible, la pantalla conserva datos mock y reintenta conectarse automáticamente.

## Estructura

- `src/types.ts`: contrato de datos principal.
- `src/hooks/useRobotState.ts`: único punto de estado global, mocks, derivación de estado y acciones.
- `src/components/`: componentes visuales, uno por archivo.
- `src/App.tsx`: layout principal responsive.
