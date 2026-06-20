![Cockpit Logo](./logo2.png)

# Cockpit Modular Desktop

Aplicación desktop modular para tooling de robótica, construida con **React + TypeScript + Tauri**.

## Stack

- Frontend: React + TSX (Vite)
- Runtime desktop: Tauri 2
- Comunicación backend: WebSocket / HTTP
- Arquitectura: `Frontend -> Services -> Dispatchers -> Transports`

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

## Navegación: Action Waypoints

El módulo Nav2 permite programar acciones sobre waypoints de ruta. Desde la barra
de ruta, seleccionar uno o más waypoints y usar `ACTION WAYPOINT`.

Acción disponible hoy:

- `Brake`: agrega `brake_hold` al waypoint seleccionado.
- La UI pide `duration_s` para definir cuántos segundos frena antes de continuar.
- `brake_pct` se envía como `100`.

Formato enviado al bridge WebSocket de SALUS:

```json
{
  "lat": -31.0,
  "lon": -64.0,
  "actions": [
    {"type": "brake_hold", "duration_s": 5, "brake_pct": 100}
  ]
}
```

El backend ROS conserva estas acciones al guardar/cargar rutas y las ejecuta en
`route_executor` durante misiones `set_route_ll`.
