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

Acciones disponibles:

- `Brake`: agrega `brake_hold` al waypoint seleccionado.
- La UI pide `duration_s` para definir cuántos segundos frena antes de continuar.
- `brake_pct` se envía como `100`.
- `Rural profile`: activa el perfil rural al alcanzar el waypoint; reduce la
  inflación del costmap sin desactivar la detección de obstáculos.
- `Urban profile`: restaura el perfil urbano, que es el valor predeterminado.

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

Para conmutar el perfil de navegación, el formato es:

```json
{"type": "set_navigation_profile", "profile": "rural"}
```

El backend ROS conserva estas acciones al guardar/cargar rutas y las ejecuta en
`route_executor` durante misiones `set_route_ll`.

## Estado RTK (Nav2, main)

El modal `RTK · Antena` usa la identidad y el estado publicados por el backend
en `rtk_source_state`, junto al catálogo `rtk_sources`. No supone una base
CASISA ni deduce recepción de correcciones a partir del nombre del fix GPS.
Se retiraron los ajustes locales `rtk_default_source_id` y
`rtk_default_source_label`: la selección de base pertenece al backend.

- `connected` indica conexión NTRIP, no recepción de correcciones.
- El indicador de recepción requiere `receiving_rtcm=true`, una fuente activa
  y `rtcm_age_s` válido dentro de `rtcm_stale_timeout_s`.
- El modal detecta un `status_sequence` sin cambios durante 5 segundos o la
  desconexión del backend y deja de mostrar recepción activa.
- Los errores de conexión se muestran en el modal. Las credenciales no forman
  parte del catálogo ni de la telemetría; se configuran y persisten en el robot.

Recibir RTCM no equivale a obtener RTK Fixed. El receptor puede seguir en fix
autónomo o RTK Float según las condiciones de recepción. En SALUS, el protocolo,
la configuración privada y el arranque automático están documentados en
`ROS2_SALUS/docs/rtk-ntrip.md` del repositorio backend.

Validación del 2026-08-26: `npm run build` correcto; `npm run test` con Node 24
reportó 153 pruebas correctas y 1 omitida. Incluye pruebas del estado RTK y del
modal ante handshake, correcciones válidas y latido congelado. Con Node 26 se
observó un fallo ajeno a RTK en `localStorage` de la prueba del AppShell. No se
compiló Tauri.
