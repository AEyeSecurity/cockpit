# Ejemplo Completo: Módulo Ficticio para IA

Este documento está pensado para que otra IA pueda implementar un módulo nuevo en este repo sin adivinar convenciones.

## Objetivo del ejemplo

Crear un módulo ficticio llamado `diagnostics` que:

- use el transport WS existente (`transport.ws.core`)
- cree su propio dispatcher
- cree su propio service
- agregue UI mínima (sidebar + item en toolbar)
- pueda activarse/desactivarse desde `config/modules.yaml`

## Contexto mínimo del repo

- Arquitectura: `Frontend -> Services -> Dispatchers -> Transports`
- La UI consume services, nunca dispatchers/transports directos.
- Un módulo se define como `CockpitModule` en `src/modules/<modulo>/index.tsx`.
- Registro dinámico vía registries (`ctx.registries.*`).
- Catálogo central: `src/core/bootstrap/moduleCatalog.ts`.

## Archivos a crear

```text
src/dispatcher/impl/DiagnosticsDispatcher.ts
src/services/impl/DiagnosticsService.ts
src/modules/diagnostics/index.tsx
src/modules/diagnostics/styles.css
```

## Archivos a modificar

```text
src/core/bootstrap/moduleCatalog.ts
config/modules.yaml
```

## Paso 1: Dispatcher

Archivo: `src/dispatcher/impl/DiagnosticsDispatcher.ts`

```ts
import type { IncomingPacket } from "../../core/types/message";
import { DispatcherBase } from "../base/Dispatcher";

export class DiagnosticsDispatcher extends DispatcherBase {
  constructor(id: string, transportId: string) {
    super(id, transportId, ["diag_status", "ack"]);
  }

  handleIncoming(message: IncomingPacket): void {
    this.publish(message.op, message);
  }

  async requestPing(): Promise<IncomingPacket> {
    return this.request("diag_ping", {}, { timeoutMs: 3000 });
  }

  subscribeStatus(callback: (message: IncomingPacket) => void): () => void {
    return this.subscribe("diag_status", callback);
  }
}
```

## Paso 2: Service

Archivo: `src/services/impl/DiagnosticsService.ts`

```ts
import type { DiagnosticsDispatcher } from "../../dispatcher/impl/DiagnosticsDispatcher";

export interface DiagnosticsState {
  healthy: boolean;
  lastPingMs: number | null;
  lastError: string;
}

type Listener = (state: DiagnosticsState) => void;

export class DiagnosticsService {
  private readonly listeners = new Set<Listener>();
  private state: DiagnosticsState = {
    healthy: false,
    lastPingMs: null,
    lastError: ""
  };

  constructor(private readonly dispatcher: DiagnosticsDispatcher) {
    this.dispatcher.subscribeStatus((message) => {
      this.state = {
        ...this.state,
        healthy: message.ok !== false,
        lastError: message.error ? String(message.error) : ""
      };
      this.emit();
    });
  }

  getState(): DiagnosticsState {
    return { ...this.state };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  async ping(): Promise<void> {
    const started = Date.now();
    const response = await this.dispatcher.requestPing();
    if (response.ok === false) {
      this.state = {
        ...this.state,
        healthy: false,
        lastError: String(response.error ?? "diag_ping failed")
      };
      this.emit();
      throw new Error(this.state.lastError);
    }
    this.state = {
      ...this.state,
      healthy: true,
      lastPingMs: Date.now() - started,
      lastError: ""
    };
    this.emit();
  }

  private emit(): void {
    const snapshot = this.getState();
    this.listeners.forEach((listener) => listener(snapshot));
  }
}
```

## Paso 3: Módulo + UI

Archivo: `src/modules/diagnostics/index.tsx`

```tsx
import { useEffect, useState } from "react";
import "./styles.css";
import type { CockpitModule, ModuleContext } from "../../core/types/module";
import { DiagnosticsDispatcher } from "../../dispatcher/impl/DiagnosticsDispatcher";
import { DiagnosticsService } from "../../services/impl/DiagnosticsService";

const TRANSPORT_ID = "transport.ws.core";
const DISPATCHER_ID = "dispatcher.diagnostics";
const SERVICE_ID = "service.diagnostics";

function DiagnosticsSidebarPanel({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const service = runtime.registries.serviceRegistry.getService<DiagnosticsService>(SERVICE_ID);
  const [state, setState] = useState(service.getState());

  useEffect(() => service.subscribe((next) => setState(next)), [service]);

  return (
    <div className="panel-card">
      <h3>Diagnostics</h3>
      <div className={`status-pill ${state.healthy ? "ok" : "bad"}`}>
        {state.healthy ? "healthy" : "unhealthy"}
      </div>
      <p className="muted">last ping: {state.lastPingMs == null ? "n/a" : `${state.lastPingMs} ms`}</p>
      {state.lastError ? <p className="muted">error: {state.lastError}</p> : null}
      <button
        type="button"
        onClick={async () => {
          try {
            await service.ping();
            runtime.eventBus.emit("console.event", {
              level: "info",
              text: "Diagnostics ping OK",
              timestamp: Date.now()
            });
          } catch (error) {
            runtime.eventBus.emit("console.event", {
              level: "error",
              text: `Diagnostics ping failed: ${String(error)}`,
              timestamp: Date.now()
            });
          }
        }}
      >
        Ping
      </button>
    </div>
  );
}

export function createDiagnosticsModule(): CockpitModule {
  return {
    id: "diagnostics",
    version: "1.0.0",
    enabledByDefault: true,
    register(ctx: ModuleContext): void {
      // Guard: si no existe transport base, no registrar este módulo.
      if (!ctx.registries.transportRegistry.has(TRANSPORT_ID)) return;

      const dispatcher = new DiagnosticsDispatcher(DISPATCHER_ID, TRANSPORT_ID);
      ctx.registries.dispatcherRegistry.registerDispatcher({
        id: DISPATCHER_ID,
        order: 45,
        dispatcher
      });

      const service = new DiagnosticsService(dispatcher);
      ctx.registries.serviceRegistry.registerService({
        id: SERVICE_ID,
        order: 45,
        service
      });

      ctx.registries.sidebarPanelRegistry.registerSidebarPanel({
        id: "sidebar.diagnostics",
        label: "Diagnostics",
        order: 45,
        render: (runtime) => <DiagnosticsSidebarPanel runtime={runtime} />
      });

      ctx.registries.toolbarMenuRegistry.registerToolbarMenu({
        id: "toolbar.diagnostics",
        label: "Diagnostics",
        order: 45,
        items: [
          {
            id: "diagnostics.ping",
            label: "Run ping",
            onSelect: async ({ runtime }) => {
              const diagnostics = runtime.registries.serviceRegistry.getService<DiagnosticsService>(SERVICE_ID);
              await diagnostics.ping();
            }
          }
        ]
      });
    }
  };
}
```

Archivo: `src/modules/diagnostics/styles.css` (mínimo)

```css
.diagnostics-root {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
```

Nota de arquitectura CSS:

- Estilos del módulo `diagnostics` viven en `src/modules/diagnostics/styles.css`.
- `src/app/base.css` solo debe tener estilos base compartidos.

## Paso 4: Registrar en catálogo

Editar `src/core/bootstrap/moduleCatalog.ts`:

1. Importar `createDiagnosticsModule`.
2. Agregarlo en `getModuleCatalog()`.

## Paso 5: Habilitar módulo

Editar `config/modules.yaml`:

```yaml
modules:
  diagnostics: true
```

## Paso 6: Verificar

```bash
npm run test
npm run build
npm run tauri:dev
```

## Checklist para IA (aceptación)

- IDs únicos (`dispatcher.*`, `service.*`, `sidebar.*`, `toolbar.*`)
- UI consume solo `DiagnosticsService`
- `DiagnosticsDispatcher` no contiene lógica de UI
- módulo deshabilitable por `config/modules.yaml`
- sin cambios en core fuera de `moduleCatalog.ts` y config

## Errores típicos (que una IA debe evitar)

- Instanciar transport nuevo innecesario cuando ya hay uno utilizable.
- Llamar dispatcher desde componentes en vez de hacerlo desde service.
- No manejar `response.ok === false` en service.
- Olvidar emitir eventos de error/info para trazabilidad.
