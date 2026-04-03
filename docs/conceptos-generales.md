# Terminología del repo

Este documento explica, en lenguaje simple, qué significa cada término importante dentro de este proyecto.

## AppShell

`AppShell` es la estructura principal de la app (el "marco" de la UI).

En este repo, `AppShell` organiza:

- toolbar superior
- selector y panel lateral
- workspace central
- consola inferior
- host de modales y diálogos globales
- footer

No contiene lógica de negocio del robot. Solo organiza y conecta vistas registradas.

## Módulo

Un módulo es un bloque funcional autocontenido (por ejemplo `navigation`, `map`, `telemetry`).

Cada módulo puede registrar:

- UI (paneles, tabs, vistas, menús, modales, footer)
- services
- dispatchers
- transports
- estilos CSS propios (`src/modules/<modulo>/styles.css`)

Los módulos se cargan desde `moduleCatalog.ts` y se habilitan/deshabilitan por `config/modules.yaml`.

Regla de estilos:

- cada módulo importa su propio `./styles.css` en `index.tsx`
- `src/app/base.css` queda para estilos globales/base compartidos

## Registry (registries)

Un registry es una lista dinámica donde los módulos “publican” cosas.

Idea simple:

- el core crea registries vacíos
- cada módulo registra sus contribuciones
- `AppShell` y el runtime consumen lo registrado

Ejemplos en este repo:

- `sidebarPanelRegistry`
- `workspaceViewRegistry`
- `consoleTabRegistry`
- `toolbarMenuRegistry`
- `modalRegistry`
- `footerItemRegistry`
- `serviceRegistry`
- `dispatcherRegistry`
- `transportRegistry`

Todos usan un patrón ordenado por `order` + `id` para mantener consistencia.

Ejemplo simple:

```ts
ctx.registries.sidebarPanelRegistry.registerSidebarPanel({
  id: "sidebar.mi-modulo",
  label: "Mi Módulo",
  order: 30,
  render: (runtime) => <MiPanel runtime={runtime} />
});
```

Detalle del ejemplo:

- `id`: identificador único del panel.
- `label`: texto visible en el selector lateral.
- `order`: prioridad de orden en el listado.
- `render(runtime)`: función que devuelve el componente a mostrar.

Después, `AppShell` lista automáticamente los panels del registry y los muestra en el selector lateral.

## Capa Frontend

Son los componentes React/TSX.

Responsabilidad:

- renderizar UI
- escuchar estado de servicios
- disparar acciones del usuario

Regla:

- frontend habla con `Service`, no con `Dispatcher` ni `Transport`.

## Capa Service

Un `Service` implementa lógica de negocio del dominio.

Hace cosas como:

- validar inputs
- transformar datos
- mantener estado de feature
- coordinar llamadas a dispatchers

Ejemplo: `NavigationService`, `MapService`, `TelemetryService`.

## Capa Dispatcher

Un `Dispatcher` conoce operaciones de backend (`op`) y cómo pedir/suscribirse mensajes.

Hace cosas como:

- `request(...)` por operación
- `subscribe(...)` a eventos entrantes
- `handleIncoming(...)` para publicar mensajes a suscriptores

Base en este repo:

- `DispatcherBase` (`src/dispatcher/base/Dispatcher.ts`)

Por qué existe esta capa (y qué problema resuelve):

- En WebSocket, todos los mensajes llegan por el mismo canal.
- Sin dispatcher, cada componente/service tendría que filtrar mensajes manualmente (`if op === ...`), manejar correlación de requests y timeouts por su cuenta.
- Eso genera código repetido, acoplamiento alto y errores de routing.

El dispatcher centraliza ese trabajo:

- mapea mensajes por `op`
- expone métodos semánticos (`requestGoal`, `requestMap`, etc.)
- unifica request/response y suscripciones
- oculta detalles del canal (WS/HTTP/ROS) a la capa de negocio

Ejemplo WebSocket:

- Llega un stream mezclado: `state`, `robot_pose`, `nav_alerts`, `ack`.
- `RobotDispatcher` publica cada `op` al subscriber correcto.
- `NavigationService` se suscribe solo a lo que necesita (`state`, `ack`, etc.) sin parsear todo el stream.

## Capa Transport

Un `Transport` es el adaptador técnico del canal (WebSocket, HTTP, ROS bridge, etc.).

Expone:

- `connect`
- `disconnect`
- `send`
- `recv`

No debe tener lógica de negocio del robot.

Base en este repo:

- interfaz `Transport` (`src/transport/base/Transport.ts`)

## Por qué se usan IDs en `Transport` y `Dispatcher`

Los IDs (`transport.ws.core`, `dispatcher.robot`, etc.) no son solo nombres: son la forma de enlazar piezas en runtime.

Problemas que resuelven:

- Evitar colisiones: si dos módulos intentan registrar el mismo ID, el registry falla temprano.
- Routing correcto: `DispatchRouter` necesita saber qué dispatcher está asociado a qué `transportId`.
- Desacople entre módulos: un módulo puede pedir un service/dispatcher por ID sin importar su implementación concreta.
- Reemplazo controlado: podés cambiar una implementación (por ejemplo otro transport WS) manteniendo el mismo ID público.
- Activación/desactivación dinámica: al cargar módulos por config, los IDs permiten registrar/omitir piezas sin romper referencias.

Ejemplo concreto:

- `RobotDispatcher` declara `transportId = "transport.ws.core"`.
- Cuando hace `request(...)`, el router envía por ese transport exacto.
- Si el ID no existiera o estuviera duplicado, los mensajes podrían salir por el canal incorrecto o no salir.

## Bases de cada capa (con extractos reales)

Esta sección muestra el “contrato base” que usa cada capa.

## Base de Frontend: `AppShell`

No hay una clase abstracta de frontend; la base estructural es `AppShell`, que consume registries y renderiza hosts dinámicos.

Extracto:

```ts
const toolbarMenus = runtime.registries.toolbarMenuRegistry.list();
const sidebarPanels = runtime.registries.sidebarPanelRegistry.list();
const workspaceViews = runtime.registries.workspaceViewRegistry.list();
const consoleTabs = runtime.registries.consoleTabRegistry.list();
```

Qué significa:

- la UI no está hardcodeada
- se construye con lo que registran los módulos

Detalle de variables:

- `toolbarMenus`: menús de la barra superior registrados por módulos.
- `sidebarPanels`: paneles laterales disponibles.
- `workspaceViews`: vistas centrales para el área principal.
- `consoleTabs`: tabs de la consola inferior.

## Base de Service: `ServiceContext` + convención de servicio

En este repo no hay `ServiceBase` abstracto obligatorio.
La base formal para servicios es el contexto compartido:

```ts
export interface ServiceContext {
  dispatcherRegistry: DispatcherRegistry;
  eventBus: EventBus;
}
```

Además, por convención los services exponen:

- `getState()`
- `subscribe(listener)`
- métodos de negocio (`sendGoal`, `loadMap`, etc.)

Detalle de variables:

- `dispatcherRegistry`: permite resolver dispatchers y llamar operaciones backend.
- `eventBus`: permite publicar/escuchar eventos internos desacoplados.

## Base de Dispatcher: `Dispatcher` / `DispatcherBase`

Contrato principal:

```ts
export interface Dispatcher {
  id: string;
  transportId: string;
  ops: string[];
  handleIncoming(message: IncomingPacket): void;
  request(op: string, payload?: MessagePayload): Promise<IncomingPacket>;
  subscribe(op: string, callback: (message: IncomingPacket) => void): () => void;
}
```

Base reusable:

```ts
export abstract class DispatcherBase implements Dispatcher {
  async request(op: string, payload?: MessagePayload): Promise<IncomingPacket> { ... }
  protected publish(op: string, message: IncomingPacket): void { ... }
}
```

Qué significa:

- todos los dispatchers comparten mecánica de `request/subscribe`
- cada dispatcher concreto solo define `ops` y helpers de dominio

Detalle de variables y funciones:

- `id`: identificador único del dispatcher.
- `transportId`: identifica el transport por el que envía/recibe.
- `ops`: lista de operaciones que procesa o publica.
- `handleIncoming(message)`: punto de entrada de mensajes entrantes desde router.
- `request(op, payload)`: envío de request con espera de respuesta.
- `subscribe(op, callback)`: suscripción por operación.
- `DispatcherBase.request(...)`: implementación común para delegar en `DispatchRouter`.
- `DispatcherBase.publish(...)`: utilitario para notificar suscriptores del `op`.

## Base de Transport: `Transport`

Contrato técnico mínimo:

```ts
export interface Transport {
  id: string;
  kind: string;
  connect(ctx: TransportContext): Promise<void>;
  disconnect(): Promise<void>;
  send(packet: OutgoingPacket): Promise<void>;
  recv(handler: TransportReceiveHandler): () => void;
}
```

Qué significa:

- cualquier protocolo nuevo debe adaptarse a este contrato
- el resto de capas no depende de implementación concreta

Detalle de variables y funciones:

- `id`: identificador único del transport.
- `kind`: tipo de implementación (`websocket`, `http`, etc.).
- `connect(ctx)`: inicia la conexión técnica con contexto de entorno.
- `disconnect()`: corta la conexión activa.
- `send(packet)`: envía paquete saliente.
- `recv(handler)`: registra callback de entrada y devuelve función de unsubscribe.

## Base de Registries: `OrderedRegistry`

Todos los registries especializados se apoyan en esta base:

```ts
export class OrderedRegistry<T extends RegistryItem> {
  register(item: T): void { ... }
  has(id: string): boolean { ... }
  get(id: string): T | undefined { ... }
  list(): T[] { ... }
}
```

Qué significa:

- evita colisiones de IDs
- garantiza orden estable en la UI/runtime
- permite habilitar/deshabilitar módulos sin romper el core

Detalle de funciones:

- `register(item)`: agrega item; falla si existe el mismo `id`.
- `has(id)`: informa si un `id` ya está registrado.
- `get(id)`: devuelve el item puntual o `undefined`.
- `list()`: devuelve items ordenados por `order` y luego por `id`.

## DispatchRouter

`DispatchRouter` conecta dispatchers con transports.

Funciones clave:

- enrutar mensajes entrantes por `transportId` + `op`
- resolver request/response por `requestId`
- manejar timeouts de requests

Es la pieza central del “message routing”.

## TransportManager

`TransportManager` administra transports registrados.

Funciones:

- registrar y obtener transports
- conectar/desconectar transports
- enviar/recibir mensajes
- medir tráfico TX/RX por transport

## Bootstrapping

`bootstrapApp()` arma el runtime al iniciar:

1. carga env y config
2. crea registries, router, transport manager, event bus
3. registra servicios globales (ej. diálogo)
4. ejecuta `register()` de módulos habilitados
5. conecta transports y bindea dispatchers

Archivo: `src/core/bootstrap/bootstrapApp.ts`

## EventBus

`EventBus` es un canal interno pub/sub para eventos de UI y runtime.

Sirve para comunicación desacoplada entre partes de la app sin acoplar componentes directamente.

## Runtime

`AppRuntime` / `ModuleContext` es el contexto compartido que reciben módulos.

Incluye:

- config/env
- registries
- transport manager
- dispatch router
- event bus
- contenedor DI

Con eso, cada módulo puede registrarse e integrarse sin tocar el core.
