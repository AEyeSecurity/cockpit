# Cockpit — referencia del codebase

Estado: actual al commit local `f5cad0c`, auditado el 2026-08-16.

Alcance: arquitectura, módulos, contrato WebSocket SALUS, runtime VSCode y validación del repositorio `cockpit/`.

Fuente de verdad: `package.json`, `src/`, `AGENTS.md`, tests y backend ROS `../src/map_tools/map_tools/web_zone_server.py`.

Para cobertura archivo por archivo de los 175 ejecutables/config versionados, consultar [CODE_CATALOG.md](CODE_CATALOG.md).

## 1. Estado del repositorio

`cockpit/` es un repositorio Git independiente del monorepo ROS. En la auditoría estaba en `main`, limpio y un commit por delante de `origin/main`. No confundirlo con:

- `../cockpit-main/`: clon atrasado 26 commits y con cambios locales;
- `../cockpit_simple/`: Vite simplificado ignorado por el repo ROS padre;
- `../cockpit_claude_repo/`: revisión/diseño independiente.

## 2. Producto y stack

Cockpit es el host modular de operación de SALUS:

- React 18 + TypeScript + Vite;
- extensión VSCode como host actual;
- WebSocket/HTTP/WebRTC para integración con robot, cámara y servicios;
- Vitest + Testing Library;
- dependencias Tauri aún presentes en el manifest, aunque `PLAN.md` describe la migración a VSCode y `AGENTS.md` pide no compilar Tauri en el flujo normal.

Comandos normales:

```bash
npm run dev
npm run build
npm test
npm run build:extension
npm run test:extension
```

Después de cambios normales ejecutar `npm run build` y `npm test`. No ejecutar `tauri:build` salvo pedido explícito.

## 3. Invariantes de arquitectura

La extensión se hace por paquetes y módulos bajo `src/packages/<packageId>`. El shell conserva los slots:

- `sidebar`;
- `workspace`;
- `console`;
- `toolbar`;
- `footer`;
- `modal`.

Flujo principal:

```text
React frontend / slot contributions
  -> services (estado y casos de uso)
  -> dispatchers (mensajes y routing)
  -> transports (WebSocket/HTTP)
  -> web_zone_server ROS
```

Una función nueva de Nav2 debe entrar en `src/packages/nav2/modules/...`, registrar contribuciones y respetar las capas. Evitar acoplarla directamente a `AppShell` o a componentes core.

## 4. Estructura

### Aplicación y host

- `src/main.tsx`: entrada webview.
- `src/app/AppShell.tsx`: shell visual y slots.
- `src/app/VscodeWebviewShell.tsx`: adaptación a contenedores VSCode.
- `src/extension/extension.ts`: activación, comandos, webviews y bridge del host.
- `src/platform/host/`: config, dialogs, notifications, terminal VSCode, foco y zoom.

### Núcleo

- `src/core/bootstrap`: catálogo y activación de paquetes.
- `src/core/di`: contenedor de dependencias.
- `src/core/registries`: servicios, dispatchers y transports.
- `src/core/contributions`: contribuciones a slots.
- `src/core/commands`, `events`, `keybindings`, `config`.

### Paquete core

- runtime base: `DispatchRouter`, `TransportManager`, services comunes;
- UI base: paneles, toolbar, footer, console, dialogs y metrics.

### Paquete nav2

- `navigation`: conexión, modo real/sim, control manual, waypoints, rutas, patrulla, HOME, snapshots y perfiles.
- `map`: Leaflet, robot/waypoints/zones, HUD de misión/batería y transportes HTTP/Google Maps.
- `camera`: estado PTZ/presets y frames/detecciones recibidos por bridge.
- `debug`: sesiones de misión, explicaciones y generación de reportes.
- `processes`: consola/gestión de procesos.
- `telemetry`: paneles y estado de telemetría.
- `protocol`: normalización de mensajes WebSocket.

## 5. Configuración Nav2

`src/packages/nav2/config.json` contiene defaults editables:

- WebSocket real `100.66.15.45:8766` y sim `localhost:8766`;
- fuente RTK inicial;
- transporte/caminos de cámara WebRTC/MJPEG;
- centro y zoom de mapa;
- límites/defaults de velocidad y dirección manual;
- intervalo del loop manual.

No incrustar secretos aquí. URLs o hosts pueden ser defaults, pero credenciales de cámara/RTK deben permanecer en backend/env seguro.

## 6. Protocolo WebSocket

`src/packages/nav2/protocol/messages.ts` define un envelope flexible:

```ts
{
  op: string,
  requestId?: string,
  request?: string,
  payload?: unknown,
  meta?: Record<string, unknown>
}
```

Compatibilidad relevante:

- al enviar, `requestId` también se codifica como `client_req_id`;
- el payload object se aplana sin pisar campos reservados;
- al recibir, acepta `requestId`, `client_req_id`, `clientReqId` o `request_id` en nivel superior o payload;
- `ok` y `error` también se recuperan desde payload.

`WebSocketTransport` reconecta con backoff de 2 a 15 segundos y emite cambios de conexión. Mensajes JSON malformados se ignoran.

Toda modificación de `op` o payload debe compararse con `../src/map_tools/map_tools/web_zone_server.py` y cubrirse en `src/test/nav2Protocol.test.ts` o tests del service correspondiente.

## 7. Navegación y misiones

`NavigationService` es el estado principal de operación. Mantiene:

- conexión y modo real/sim;
- waypoints en cola, selección y persistencia local;
- rutas guardadas;
- route mission y patrol mission;
- HOME, loop, return/depart y punto de reentrada;
- acciones por waypoint;
- modo manual, teclas, velocidad y ángulo Ackermann;
- lock de control/heartbeat;
- snapshot, recording y últimos estados.

### Contrato de waypoints

Cada waypoint contiene lat/lon (los campos internos se llaman históricamente `x/y`), yaw opcional, role y actions. Acciones soportadas:

- `brake_hold` con `duration_s` y `brake_pct`;
- `set_navigation_profile` con `urban` o `rural`.

### Patrulla

La UI arma un perfil con:

- `loopWaypoints`;
- `homeWaypoint`;
- `returnWaypoints`;
- `departWaypoints`;
- `departEntryLoopIndex`.

Debe mantenerse alineado con `SetPatrolMissionLL`/`GetPatrolMissionState` del backend. `patrolPresentation.ts` y `patrolProfileReadiness.ts` concentran presentación y validación de preparación.

### Manual Ackermann

La UI convierte ángulo de steer a yaw-rate con wheelbase `0.94 m` y envía comandos periódicos mientras las teclas están activas. El backend sigue siendo responsable del watchdog y límites finales; no tratar la UI como barrera de seguridad.

## 8. Mapa y batería

El módulo mapa combina Leaflet con:

- pose del robot;
- waypoints/route/patrol;
- zonas y overlays;
- estado de retorno y HOME;
- tarjeta de batería.

`batteryPresentation.ts` separa la etiqueta/SOC de operador del estado de misión. No usar un porcentaje visual aislado para decidir return-home; el backend publica la recomendación específica mediante la telemetría de guardia.

## 9. Cámara

Hay dos caminos que no deben confundirse:

- video primario WebRTC/MJPEG configurado en `cameraStreamConfig.ts`/`CameraStreamSurface.tsx`;
- frames/detecciones bridged por WebSocket para overlays y estado.

`CameraVisionService` mantiene buffer de 10 frames, empareja detecciones dentro de 250 ms, considera cámara stale a 3 s y detecciones stale a 2 s. El parser tolera varios formatos YOLO/`vision_msgs`, pero tiene TODO explícito para confirmar coordenadas absolutas y contrato final.

PTZ/presets se envían por ops al backend; al guardar HOME la UI exige confirmación adicional, cubierta por test.

## 10. Debug de misión

El módulo debug consume sesiones `mission.*`, eventos, controller status/telemetry, rosout y Behavior Tree logs. `MissionReportGenerator` produce explicación humana. Un contrato histórico importante es iniciar una sesión con `GOAL_ACCEPTED`; una request rechazada no debe aparecer como misión iniciada.

`missionExplanations.check.test.tsx` prueba registros reales y exige explicación para cada tipo conocido. Al agregar un evento backend, actualizar su explicación y el test.

## 11. Runtime VSCode

El host registra comandos `cockpit.*`, webview principal y vistas sidebar/console. El bridge host/webview maneja requests/responses para:

- leer/escribir/remover config;
- notificaciones y dialogs;
- foco;
- terminal integrada;
- zoom;
- proyección de toolbar/footer.

`PLAN.md` sigue siendo una guía de migración y puede contener objetivos ya aplicados o parcialmente pendientes. Verificar código y `package.json` antes de asumir que una etapa está completa.

## 12. Tests y resultado observado

El 2026-08-16:

```text
33 test files passed
151 tests passed
```

El comando fue `npm test`. Hubo warnings no fatales:

- JSDOM no implementa `HTMLCanvasElement.getContext` sin paquete canvas, disparado por xterm;
- algunos updates de React en settings modal no estaban envueltos en `act(...)`;
- tests negativos del package catalog imprimen errores esperados.

El exit code fue 0. Estos warnings son deuda de harness, no fallas funcionales.

`npm run build` también terminó con exit code 0. Vite advirtió que el chunk principal ronda 1.7 MB minificado, por encima del umbral de 500 kB; es deuda de particionado/carga, no una falla de compilación.

## 13. Riesgos y reglas de cambio

- El repo local está adelantado a `origin/main`; inspeccionar el commit local antes de publicar.
- No trabajar sobre `cockpit-main/` por accidente.
- Cambios de backend deben validar el envelope, lifecycle y casing de fields.
- No duplicar estado de seguridad en frontend; backend ROS conserva autoridad.
- Mantener acciones de waypoint serializables y persistibles al guardar/cargar rutas.
- No introducir credenciales en `config.json`, tests, snapshots ni documentación.
- No compilar Tauri en el flujo normal indicado por `AGENTS.md`.
- Después de editar: `npm run build` y `npm test`.

## 14. Puntos de entrada para tareas frecuentes

| Tarea | Empezar por |
|---|---|
| Conexión WebSocket | `navigation/transport/impl/WebSocketTransport.ts`, `protocol/messages.ts` |
| Goal/ruta/patrulla/manual | `navigation/service/impl/NavigationService.ts` |
| UI navegación | `navigation/frontend/index.tsx` |
| Mapa/HUD | `map/frontend/index.tsx`, `batteryPresentation.ts`, `patrolPresentation.ts` |
| Cámara/video | `CameraStreamSurface.tsx`, `CameraVisionService.ts`, `camera/frontend/index.tsx` |
| Sesiones/reportes | `debug/service/impl/MissionService.ts`, `MissionReportGenerator.ts` |
| Host VSCode | `extension/extension.ts`, `platform/host/*`, `VscodeWebviewShell.tsx` |
| Registro de módulos | `packages/nav2/index.tsx`, `core/bootstrap/*` |
