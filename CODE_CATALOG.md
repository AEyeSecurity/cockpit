# Catálogo exhaustivo del código Cockpit

Estado: auditado archivo por archivo contra el repo anidado `cockpit`, `main` local en `f5cad0c` al comenzar la auditoría del 2026-08-16.

Alcance: los 175 archivos versionados ejecutables o de configuración: TypeScript/TSX, JavaScript, Rust/Tauri, CSS/HTML, tests, manifests y YAML/JSON runtime. Imágenes, fuentes, `.gitkeep`, README/PLAN y archivos de empaquetado no ejecutables quedan fuera. `package-lock.json` se incluye como lock generado. `public/vendor/mediamtx/reader.js` se identifica como vendor.

Fuente de verdad: cada archivo listado. La arquitectura y contratos principales se explican en `CODEBASE_REFERENCE.md`.

## 1. Build, configuración y hosts

| Archivo | Responsabilidad |
|---|---|
| `.env.example` | Variables de ejemplo para endpoints/config de desarrollo; no debe contener secrets reales. |
| `.vscode/cockpit.code-workspace` | Workspace VSCode distribuido con el proyecto. |
| `.vscode/tasks/compile-install-vsix.sh` | Build + package VSIX, descubre CLI/perfil VSCode e instala/verifica la extensión. Modifica la instalación local. |
| `package.json` | Scripts, dependencias y manifiesto de extensión: comandos, views, keybinding y configuración `cockpit.config`. |
| `package-lock.json` | Resolución reproducible npm; generado, no editar manualmente. |
| `tsconfig.json` | Configuración TypeScript de webview/app/tests. |
| `tsconfig.node.json` | Config TypeScript de Vite/Node. |
| `vite.config.ts` | Build Vite, Vitest, aliases y assets. |
| `index.html` | Shell HTML de Vite. |
| `legacy/index.monolith.html` | UI monolítica histórica conservada como referencia, no shell modular vigente. |
| `start.sh` | Libera puertos 5173/7681 y arranca PTY + Vite con cleanup por trap. |
| `pty-server.js` | WebSocket localhost que crea PTY bash local o SSH a `salus`, transmite resize/datos y OSC7 cwd. |
| `scripts/run-vscode-tests.mjs` | Descarga/lanza VSCode Electron y ejecuta suite de extensión. |
| `config/modules.yaml` | Habilitación de paquete/módulos nav2 en formato vigente. |
| `config/dispatchers.yaml` | Catálogo declarativo histórico de dispatchers/ops; el runtime modular registra código directamente. |
| `config/transports.yaml` | Catálogo declarativo histórico de transports/endpoints env. |
| `public/config/modules.yaml` | Toggle legacy público por módulo, leído como compatibilidad por el loader. |
| `public/vendor/mediamtx/reader.js` | Cliente WebRTC/WHEP de MediaMTX vendorizado; no es lógica Cockpit propia. |

### Host Tauri opcional

| Archivo | Responsabilidad |
|---|---|
| `src-tauri/Cargo.toml` | Crate Tauri 2 y dependencias opener/serde. |
| `src-tauri/build.rs` | Ejecuta `tauri_build::build`. |
| `src-tauri/src/lib.rs` | Construye la app y plugin opener. |
| `src-tauri/src/main.rs` | Main desktop que llama `cockpit_lib::run`; oculta consola Windows release. |
| `src-tauri/tauri.conf.json` | Ventana, comandos dev/build, bundle e iconos. CSP está en `null`. |
| `src-tauri/capabilities/default.json` | Capacidades/permisos Tauri por ventana. |

Tauri existe pero el flujo normal del repo es extensión VSCode/webview; no ejecutar `tauri:build` sin pedido explícito.

## 2. Entrada y shells de aplicación

| Archivo | Responsabilidad |
|---|---|
| `src/main.tsx` | Bootstrap React: elige shell browser/VSCode/NavLive, carga runtime y monta root. |
| `src/app/AppShell.tsx` | Shell standalone: slots, panels, splitter, toolbar/footer, status, dialogs, console y comandos. |
| `src/app/VscodeWebviewShell.tsx` | Shell proyectable del webview VSCode, slots y mensajes host-command. |
| `src/app/layout/GlobalDialogHost.tsx` | Renderiza cola global alert/confirm/prompt de DialogService. |
| `src/app/layout/KeybindingHost.tsx` | Escucha teclado, normaliza combos y ejecuta commands respetando inputs/when. |
| `src/app/layout/ModalHost.tsx` | Renderiza contribución modal activa. |
| `src/app/layout/ZoomHost.tsx` | Controla Ctrl/Cmd+wheel y sincroniza zoom global. |
| `src/app/shellCommands.ts` | IDs/callbacks y registro de comandos del shell con aliases legacy. |
| `src/app/zoomController.ts` | Clamp, persistencia y aplicación de zoom al host o documento. |
| `src/app/base.css` | Reset/layout base y variables comunes. |
| `src/app/design.css` | Design system visual, componentes y estados globales. |

## 3. Núcleo modular

### Bootstrap y packages

| Archivo | Responsabilidad |
|---|---|
| `src/core/bootstrap/bootstrapApp.ts` | Crea config, DI, registries, router/transport manager, carga packages y arranca servicios. |
| `src/core/bootstrap/packageCatalog.ts` | Descubre `src/packages/*/index` + `config.json`, valida pares y construye catálogo. |
| `src/core/bootstrap/packageManager.ts` | Scoping de ids, overrides, módulos, contribuciones, commands, servicios, dispatchers y transports por package. |
| `src/core/bootstrap/registerCoreSettingsUi.tsx` | Estado/UI de Settings global/package, parse/validación/saves y contribuciones modal/sidebar. |

### Commands, DI y eventos

| Archivo | Responsabilidad |
|---|---|
| `src/core/commands/types.ts` | Contratos `Disposable`, descriptor/handler/registry. |
| `src/core/commands/commandRegistry.ts` | Registry con colisión, execute y unregister. |
| `src/core/di/container.ts` | Contenedor key/value simple. |
| `src/core/events/eventBus.ts` | Pub/sub tipado por topic. |
| `src/core/events/topics.ts` | Constantes de eventos NAV y CORE. |

### Configuración

| Archivo | Responsabilidad |
|---|---|
| `src/core/config/envConfig.ts` | Lee variables Vite y límites de transporte/timeout. |
| `src/core/config/moduleConfigLoader.ts` | Parsea YAML nuevo/legacy, carga config y resuelve enable package/módulo. |
| `src/core/config/packageConfigLoader.ts` | Valida schema de settings, mergea override y persiste/reset por package. |
| `src/core/config/globalNotificationConfig.ts` | Normaliza, carga y guarda preferencias de notificaciones core. |

### Contribuciones y slots

| Archivo | Responsabilidad |
|---|---|
| `src/core/contributions/types.ts` | Contratos para slots `sidebar/workspace/console/footer/modal/toolbar`. |
| `src/core/contributions/contributionRegistry.ts` | Registry ordenado de contribuciones UI. |
| `src/core/contributions/useSlot.ts` | Hook React que observa contribuciones de un slot. |

### Keybindings

| Archivo | Responsabilidad |
|---|---|
| `src/core/keybindings/types.ts` | Descriptor, contexto y registry de combinaciones. |
| `src/core/keybindings/keybindingRegistry.ts` | Registro/resolución por combo y cláusula `when`. |
| `src/core/keybindings/normalizeKey.ts` | Normaliza modifiers/keys/numpad a forma canónica. |
| `src/core/keybindings/whenClause.ts` | Evalúa expresiones booleanas simples sobre context keys. |

### Registries y tipos

| Archivo | Responsabilidad |
|---|---|
| `src/core/registries/orderedRegistry.ts` | Base ordenada con detección de ids duplicados. |
| `src/core/registries/serviceRegistry.ts` | Registry de factories/instancias de servicios. |
| `src/core/registries/dispatcherRegistry.ts` | Registry de dispatchers y prioridad. |
| `src/core/registries/transportRegistry.ts` | Registry de transports. |
| `src/core/types/module.ts` | Contratos runtime, packages/modules, catálogo, config/schema y registries. |
| `src/core/types/settings.ts` | Tipo de settings de notificaciones core. |

## 4. Bridge de host VSCode

| Archivo | Responsabilidad |
|---|---|
| `src/extension/extension.ts` | Host de extensión: panel/webviews/sidebar tree, comandos, status bar/toolbar projections, RPC config/dialog/terminal/focus/zoom y lifecycle. |
| `src/platform/host/bridge.ts` | RPC webview↔extension correlacionado y eventos projection/sidebar/console. |
| `src/platform/host/configFs.ts` | Persistencia vía RPC `cockpit.config` con fallback localStorage/memory. |
| `src/platform/host/dialogs.ts` | Alert/confirm/prompt vía host con fallback. |
| `src/platform/host/notifications.ts` | Notificación host VSCode. |
| `src/platform/host/terminal.ts` | Abre/revela/envía texto a terminal integrada vía RPC. |
| `src/platform/host/webviewZoom.ts` | Ajusta zoom CSS/document del webview. |
| `src/platform/host/windowFocus.ts` | Consulta foco del host para política de notificaciones. |
| `src/types/mediamtx-reader.d.ts` | Tipos del reader MediaMTX vendor. |
| `src/vite-env.d.ts` | Tipos de entorno Vite/assets. |

## 5. Package `core` — runtime y UI base

### Registro y configuración

| Archivo | Responsabilidad |
|---|---|
| `src/packages/core/config.json` | Package config sin values propios; expone tab Settings Core. |
| `src/packages/core/index.ts` | Registra módulos runtime/UI/metrics y contribuciones base. |

### Dispatcher/transport runtime

| Archivo | Responsabilidad |
|---|---|
| `src/packages/core/modules/runtime/dispatcher/base/Dispatcher.ts` | Contrato dispatcher y clase base con `send/request/sendRaw`. |
| `src/packages/core/modules/runtime/dispatcher/DispatchRouter.ts` | Enruta inbound por transport a múltiples dispatchers y outbound al manager. |
| `src/packages/core/modules/runtime/transport/base/Transport.ts` | Contrato connect/disconnect/send/handlers/status/context. |
| `src/packages/core/modules/runtime/transport/manager/TransportManager.ts` | Lifecycle de transports, fanout receive/status y métricas byte/message. |
| `src/packages/core/modules/runtime/service/base/ServiceContext.ts` | Contexto mínimo para servicios con events/dispatchers. |

### Servicios base

| Archivo | Responsabilidad |
|---|---|
| `src/packages/core/modules/runtime/service/impl/DialogService.ts` | Cola global de alert/confirm/prompt con preferencia por dialogs nativos del host. |
| `src/packages/core/modules/runtime/service/impl/SystemNotificationService.ts` | Notifica conexión, fin de ruta, obstáculos y recordatorios con foco/cooldown/config. |

### Métricas

| Archivo | Responsabilidad |
|---|---|
| `src/packages/core/modules/metrics/service/impl/MetricsService.ts` | Agrega tráfico de todos los transports y emite snapshots. |
| `src/packages/core/modules/metrics/frontend/index.tsx` | Contribución footer de bytes/mensajes y registro del módulo. |
| `src/packages/core/modules/metrics/frontend/styles.css` | Estilos del indicador de métricas. |

### Hosts UI reutilizables

| Archivo | Responsabilidad |
|---|---|
| `src/packages/core/modules/ui/frontend/Panel.tsx` | Host de contribuciones sidebar con glyph/tooltip. |
| `src/packages/core/modules/ui/frontend/PanelSection.tsx` | Sección visual no colapsable. |
| `src/packages/core/modules/ui/frontend/PanelCollapsibleSection.tsx` | Sección accesible colapsable controlada. |
| `src/packages/core/modules/ui/frontend/WorkspacePanel.tsx` | Tabs y host del slot workspace. |
| `src/packages/core/modules/ui/frontend/ConsolePanel.tsx` | Tabs y host del slot console. |
| `src/packages/core/modules/ui/frontend/Footer.tsx` | Ordena/renderiza contribuciones footer. |
| `src/packages/core/modules/ui/frontend/ToolbarMenu.tsx` | Menú/acciones toolbar y proyección de estado. |
| `src/packages/core/modules/ui/frontend/ToolbarMenuItem.tsx` | Item individual de toolbar. |
| `src/packages/core/modules/ui/frontend/DiagnosticsModal.tsx` | Modal que contiene contribuciones console. |
| `src/packages/core/modules/ui/frontend/LogConsoleTab.tsx` | Consola de eventos normalizados de TelemetryService. |
| `src/packages/core/modules/ui/frontend/TerminalConsoleTab.tsx` | Terminal xterm multipestaña, PTY local/SSH, resize, OSC7 y reconnect. |

## 6. Package `nav2`: registro y protocolo

| Archivo | Responsabilidad |
|---|---|
| `src/packages/nav2/config.json` | Defaults/schema de endpoints real/sim, RTK, cámara, mapa y control manual. Incluye defaults operativos, no secrets. |
| `src/packages/nav2/index.tsx` | Registra módulos camera/debug/map/navigation/processes/telemetry. |
| `src/packages/nav2/protocol/messages.ts` | Normaliza envelope: request ids/aliases, payload flattening, encode/decode y type guard. |
| `src/packages/nav2/protocol/Nav2DispatcherBase.ts` | Correlación request/response, timeout y dispatch de mensajes no correlacionados. |

## 7. Módulo navigation

### Transporte, dispatcher y services

| Archivo | Responsabilidad |
|---|---|
| `src/packages/nav2/modules/navigation/transport/impl/WebSocketTransport.ts` | WebSocket SALUS con handlers, disconnect intencional/remoto y reconexión exponential backoff. |
| `src/packages/nav2/modules/navigation/dispatcher/impl/RobotDispatcher.ts` | Métodos de ops robot/nav/camera/RTK/procesos sobre protocolo común. |
| `src/packages/nav2/modules/navigation/service/impl/ConnectionService.ts` | Host/port/preset real-sim, persistencia, connect/disconnect y estado lost/error. |
| `src/packages/nav2/modules/navigation/service/impl/NavigationService.ts` | Estado/acciones centrales: goals, waypoints, rutas, patrulla/HOME, manual Ackermann/heartbeat, snapshots, rosbag y PTZ. |
| `src/packages/nav2/modules/navigation/service/impl/SensorInfoService.ts` | Polling/tab/catálogo e historial textual de información de sensores. |

### UI y helpers

| Archivo | Responsabilidad |
|---|---|
| `src/packages/nav2/modules/navigation/commands.ts` | IDs de comandos navigation. |
| `src/packages/nav2/modules/navigation/patrolProfileReadiness.ts` | Explica readiness de HOME/loop/entry para patrulla estructurada. |
| `src/packages/nav2/modules/navigation/routeMissionActivity.ts` | Normaliza estados y preserva snapshot activo ante `idle` transitorio. |
| `src/packages/nav2/modules/navigation/frontend/index.tsx` | Módulo/UI principal: conexión, sidebar navegación, manual, waypoints, rutas/patrulla, datums/zonas/RTK, modals, toolbar/footer y commands. |
| `src/packages/nav2/modules/navigation/frontend/NavLiveWindow.tsx` | Ventana popup que refresca snapshots sin solapar requests y conserva último frame válido. |
| `src/packages/nav2/modules/navigation/frontend/styles.css` | Estilos de sidebar/modals/manual/nav-live. |

## 8. Módulo map

| Archivo | Responsabilidad |
|---|---|
| `src/packages/nav2/modules/map/dispatcher/impl/MapDispatcher.ts` | Ops de estado/zonas/datums/waypoint files mediante WS SALUS. |
| `src/packages/nav2/modules/map/service/impl/MapService.ts` | Estado de mapa, tools, zonas y datums con persistencia/fetch al backend. |
| `src/packages/nav2/modules/map/transport/impl/GoogleMapsTransport.ts` | Transport adapter de geocoding/map proveedor; actualmente secundario al mapa Leaflet. |
| `src/packages/nav2/modules/map/transport/impl/HttpTransport.ts` | Transport request HTTP genérico para mensajes Nav2. |
| `src/packages/nav2/modules/map/frontend/index.tsx` | Workspace Leaflet/HUD: robot, waypoints, rutas/patrulla, HOME, zones, protractor, batería y detecciones. |
| `src/packages/nav2/modules/map/frontend/batteryPresentation.ts` | Convierte telemetría/guard/return-home en label/detail/tone. |
| `src/packages/nav2/modules/map/frontend/patrolPresentation.ts` | Prioriza fase backend o readiness local y construye card de patrulla. |
| `src/packages/nav2/modules/map/frontend/protractor.ts` | Ángulo y snap cartesiano de herramienta de medición. |
| `src/packages/nav2/modules/map/frontend/styles.css` | Leaflet overrides, HUD, cards, icons y tools. |

## 9. Módulo camera y shared stream

| Archivo | Responsabilidad |
|---|---|
| `src/packages/nav2/modules/camera/dispatcher/impl/CameraDispatcher.ts` | Recibe frames/detecciones/estado PTZ y envía ops de cámara. |
| `src/packages/nav2/modules/camera/service/impl/CameraVisionService.ts` | Buffer/correlación temporal frame-detecciones, normalización bbox/class/score y staleness. |
| `src/packages/nav2/modules/camera/frontend/index.tsx` | Workspace cámara: feed, PTZ/presets, detecciones por zona/riesgo y alertas. |
| `src/packages/nav2/modules/camera/frontend/styles.css` | Layout, rail, overlay, alertas y controles PTZ. |
| `src/packages/nav2/shared/cameraStreamConfig.ts` | Resuelve transport WebRTC/MJPEG, URLs/timeouts y si el feed está configurado. |
| `src/packages/nav2/shared/CameraStreamSurface.tsx` | Superficie reusable: carga reader MediaMTX, WHEP o MJPEG con watchdog/retry/status. |

## 10. Módulo debug/misiones

| Archivo | Responsabilidad |
|---|---|
| `src/packages/nav2/modules/debug/dispatcher/impl/MissionDispatcher.ts` | Ops de sesiones, status, download y rosbag. |
| `src/packages/nav2/modules/debug/service/impl/MissionService.ts` | API/state de sesiones y grabación. |
| `src/packages/nav2/modules/debug/transport/impl/RosBridgeTransport.ts` | Transport rosbridge genérico conservado para compatibilidad/config histórica. |
| `src/packages/nav2/modules/debug/frontend/index.tsx` | Parsea JSONL, construye sesiones/timeline/explicaciones, UI record/list/detail y registra módulo. |
| `src/packages/nav2/modules/debug/report/MissionReportGenerator.ts` | Agrupa errores, genera recomendaciones y exporta reporte PDF con jsPDF. |
| `src/packages/nav2/modules/debug/frontend/styles.css` | Timeline, sesiones, record modal y reporte visual. |

## 11. Módulo processes

| Archivo | Responsabilidad |
|---|---|
| `src/packages/nav2/modules/processes/commands.ts` | IDs de comandos del módulo. |
| `src/packages/nav2/modules/processes/dispatcher/impl/ProcessesDispatcher.ts` | Ops list/start/stop/reload y eventos output/finished. |
| `src/packages/nav2/modules/processes/service/impl/ProcessesService.ts` | Catálogo/estado/output buffers y lifecycle de procesos remotos. |
| `src/packages/nav2/modules/processes/frontend/ansi.tsx` | Parser ANSI basic/256/truecolor y strip seguro para clipboard. |
| `src/packages/nav2/modules/processes/frontend/index.tsx` | Modal catálogo/detalle/output, follow-tail, copy y acciones. |
| `src/packages/nav2/modules/processes/frontend/styles.css` | Layout/status/output del process manager. |

## 12. Módulo telemetry

| Archivo | Responsabilidad |
|---|---|
| `src/packages/nav2/modules/telemetry/service/impl/TelemetryService.ts` | Normaliza state/nav events/pose/GPS/RTK/batería/control lock y mantiene snapshot/event log. |
| `src/packages/nav2/modules/telemetry/frontend/index.tsx` | Sidebar y console: métricas, chips, cards y timeline de eventos. |
| `src/packages/nav2/modules/telemetry/frontend/styles.css` | Estilos de métricas/eventos/estados telemetry. |

## 13. Tests Vitest — 34 archivos

| Archivo | Cobertura principal |
|---|---|
| `src/test/setupTests.ts` | Instala JSDOM, mocks y cleanup compartido. |
| `src/test/appShell.test.tsx` | Commands/keybindings zoom, hosts/toolbar/modals/console y diálogo de desconexión. |
| `src/test/batteryPresentation.test.ts` | Return-home, returning, sag, sensor suspect y telemetry lost. |
| `src/test/cameraPresetSave.test.tsx` | Confirmación de segundo click antes de guardar HOME. |
| `src/test/cameraVisionService.test.ts` | MIME/data URL PNG y compatibilidad JPEG legacy. |
| `src/test/collapsibleSection.test.tsx` | Toggle mouse/Enter/Space y estado inicial. |
| `src/test/dialogService.test.ts` | Alert/confirm/prompt host y fallbacks queued. |
| `src/test/dispatchRouter.test.ts` | Fanout por transport, aislamiento y sendRaw. |
| `src/test/integration.test.ts` | Persistencia config, toggles y registro core/nav2/settings. |
| `src/test/mapProtractor.test.ts` | Ángulos 0/45/90/180, degeneración y snap XY. |
| `src/test/mapWorkspaceHud.test.tsx` | Orden/estado cards Patrol/Battery y Escape en selección. |
| `src/test/metricsService.test.ts` | Agregación consistente de tráfico multi-transport. |
| `src/test/missionExplanations.check.test.tsx` | Fallback legible, rechazo como fallo y explicación de todos los records conocidos. |
| `src/test/nav2Protocol.test.ts` | Flattening/aliases, correlación por requestId/client_req_id/ack y timeout. |
| `src/test/navLiveWindow.test.tsx` | Refresh periódico no solapado y last-valid-frame. |
| `src/test/navigationEventFormatting.test.ts` | Texto operador para goals, segmentos/loops, freno/manual y conversion errors. |
| `src/test/navigationSidebar.test.tsx` | Agrupación de controles, enablement HOME/patrulla y requisitos faltantes. |
| `src/test/normalizeKey.test.ts` | Normalización numpad zoom. |
| `src/test/packageCatalog.test.ts` | Discovery válido y rechazo de config/schema incompleto. |
| `src/test/packageConfigLoader.test.ts` | Normalización/schema y shallow override. |
| `src/test/patrolPresentation.test.ts` | Requisitos parciales/ready y precedencia de fase backend. |
| `src/test/processesAnsi.test.ts` | ANSI plain/basic/256/truecolor/unsupported/strip. |
| `src/test/processesModal.test.tsx` | Detail/output/copy y política de autoscroll. |
| `src/test/processesService.test.ts` | Catalog/reload/start/error/output/reset/stop. |
| `src/test/registries.test.ts` | Orden/colisión/unregister y toggles package/módulo. |
| `src/test/routeMissionActivity.test.ts` | Idle transitorio, actividad de goal e historial de ruta. |
| `src/test/rtkSourceModal.test.tsx` | Error de save y prevención de autofill de credenciales. |
| `src/test/services.test.ts` | 35 contratos integrados de connection/navigation/map/mission/manual/lock/persistencia/patrulla. |
| `src/test/settingsModal.test.tsx` | Apertura/tabs, validación numérica y save global. |
| `src/test/sidebarHost.test.tsx` | El host Panel no auto-colapsa secciones. |
| `src/test/systemNotificationService.test.ts` | Foco, route completion, obstacle cooldown y bytes reminder. |
| `src/test/telemetryService.test.ts` | Sincronización RTK y batería con fields extendidos/fallback. |
| `src/test/transports.test.ts` | Lifecycle WS/RosBridge/HTTP y disconnect remoto. |
| `src/test/zoomController.test.ts` | Clamp, fallback document y persistencia/restauración. |

## 14. Tests de extensión VSCode

| Archivo | Cobertura |
|---|---|
| `src/test-extension/suite/index.cjs` | Bootstrap Mocha de la suite Electron. |
| `src/test-extension/suite/extension.test.cjs` | Activa la extensión, verifica commands/views/config y apertura del panel. |

Se ejecutan mediante `scripts/run-vscode-tests.mjs` y `npm run test:extension`; no forman parte de los 151 tests Vitest observados en `npm test`.

## 15. Cobertura y límites

- Los 175 archivos ejecutables/config definidos en el alcance aparecen por ruta en este catálogo.
- Los 197 archivos totales versionados incluyen además assets, fonts, iconos, README/PLAN/AGENTS, `.gitignore`, `.vscodeignore` y `.gitkeep`.
- `legacy/index.monolith.html`, transports declarativos/RosBridge y Tauri están catalogados, pero no son necesariamente la ruta de producto vigente.
- La autoridad de seguridad/misión permanece en ROS; la UI representa y solicita, no reemplaza watchdogs, collision monitor o controller.
- Los defaults de host/RTK/cámara en `config.json` deben revisarse por ambiente. No son prueba de conectividad actual.
