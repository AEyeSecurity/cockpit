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

## Navegación: rutas y patrullas

El sidebar muestra la ruta actual y separa **Iniciar ruta** (recorrido simple) de
**Iniciar patrulla** (HOME, recorrido principal, salida, regreso y reingreso).
Durante una misión permite **Cancelar misión** y, cuando corresponde,
**Volver a HOME**. El editor se abre desde **Ruta actual → Editar / añadir puntos**.

En **Editor de rutas**:

1. Pulsa **Nueva ruta** o **Abrir ruta guardada…**. Las rutas con nombre se guardan
   localmente en Cockpit, dentro del almacenamiento del origen del navegador;
   `localhost` y `127.0.0.1` tienen listas independientes.
2. Usa **Añadir primer punto en el mapa** o **Añadir punto al final**. Para insertar
   entre dos puntos, selecciona el anterior y pulsa **Insertar entre…**. El mapa
   señala el tramo; un clic coloca el punto y devuelve al editor. Puedes cancelar
   la colocación sin modificar la ruta.
3. Selecciona un punto para ajustar orientación automática o fija, moverlo,
   eliminarlo, marcar HOME, asignarlo a un segmento de patrulla o configurar sus
   **Acciones al llegar**. Mantén Shift para seleccionar varios o usa
   **Seleccionar área en el mapa**. Deshacer y rehacer operan sobre las ediciones.
4. Configura **Patrulla** con recorrido principal, HOME y reingreso. El editor
   indica qué falta para poder iniciarla. Salida y regreso pueden editarse o
   vaciarse por separado.
5. Pulsa **Guardar cambios** para actualizar la ruta abierta o **Guardar como…**
   para crear otra. El editor indica si hay cambios pendientes y pide confirmación
   antes de descartarlos.

En el mapa, **Seguir al robot** mantiene su posición centrada mientras llegan
nuevas coordenadas. Pulsa el botón de nuevo o arrastra el mapa para detener el
seguimiento.

Las acciones al llegar a un waypoint incluyen una pausa (`brake_hold`) y cambios
de perfil rural o urbano. La pausa solicita su duración en segundos y envía
`brake_pct: 100`; el perfil rural reduce la inflación del costmap sin desactivar
la detección de obstáculos, y el urbano restaura el perfil predeterminado.

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
