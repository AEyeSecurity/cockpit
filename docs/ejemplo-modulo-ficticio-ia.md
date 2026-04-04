# Ejemplo completo para IA: crear un paquete nuevo

Este documento está pensado para que otra IA implemente un paquete nuevo en este repo sin adivinar convenciones.

## Objetivo del ejemplo

Crear un paquete ficticio `diagnostics` que:

- registre frontend + service + dispatcher
- reutilice el transport WS existente
- exponga configuración en el modal global desde `config.json`
- pueda habilitarse/deshabilitarse por `config/modules.yaml`

## 1) Archivos a crear

```text
src/packages/diagnostics/
  index.ts
  config.json
  frontend/
    diagnostics/
      index.tsx
      styles.css
  services/
    impl/
      DiagnosticsService.ts
  dispatcher/
    impl/
      DiagnosticsDispatcher.ts
```

## 2) `config.json` del paquete

```json
{
  "values": {
    "ping_timeout_ms": 3000,
    "auto_refresh": true
  },
  "settings": {
    "title": "Diagnostics",
    "fields": [
      {
        "key": "ping_timeout_ms",
        "label": "Ping timeout (ms)",
        "type": "number"
      },
      {
        "key": "auto_refresh",
        "label": "Auto refresh",
        "type": "boolean"
      }
    ]
  }
}
```

## 3) Entry point del paquete

Archivo: `src/packages/diagnostics/index.ts`

```ts
import type { CockpitPackage } from "../../core/types/module";
import { createDiagnosticsModule } from "./frontend/diagnostics";

export function createPackage(): CockpitPackage {
  return {
    id: "diagnostics",
    version: "1.0.0",
    enabledByDefault: true,
    modules: [createDiagnosticsModule()]
  };
}
```

## 4) Dispatcher

Archivo: `src/packages/diagnostics/dispatcher/impl/DiagnosticsDispatcher.ts`

```ts
import type { IncomingPacket } from "../../../../core/types/message";
import { DispatcherBase } from "../../../../dispatcher/base/Dispatcher";

export class DiagnosticsDispatcher extends DispatcherBase {
  constructor(id: string, transportId: string) {
    super(id, transportId, ["diag.status", "ack"]);
  }

  handleIncoming(message: IncomingPacket): void {
    this.publish(message.op, message);
  }

  requestPing(timeoutMs: number): Promise<IncomingPacket> {
    return this.request("diag.ping", {}, { timeoutMs });
  }

  subscribeStatus(callback: (message: IncomingPacket) => void): () => void {
    return this.subscribe("diag.status", callback);
  }
}
```

## 5) Service

Archivo: `src/packages/diagnostics/services/impl/DiagnosticsService.ts`

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

  async ping(timeoutMs: number): Promise<void> {
    const started = Date.now();
    const response = await this.dispatcher.requestPing(timeoutMs);
    if (response.ok === false) {
      this.state = {
        ...this.state,
        healthy: false,
        lastError: String(response.error ?? "diag.ping failed")
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

## 6) Módulo frontend del paquete

Archivo: `src/packages/diagnostics/frontend/diagnostics/index.tsx`

```tsx
import { useEffect, useState } from "react";
import { CollapsibleSection } from "../../../../app/layout/CollapsibleSection";
import type { CockpitModule, ModuleContext } from "../../../../core/types/module";
import { DiagnosticsDispatcher } from "../../dispatcher/impl/DiagnosticsDispatcher";
import { DiagnosticsService } from "../../services/impl/DiagnosticsService";
import "./styles.css";

const TRANSPORT_ID = "transport.ws.core";
const DISPATCHER_ID = "dispatcher.diagnostics";
const SERVICE_ID = "service.diagnostics";

function DiagnosticsSidebar({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const service = runtime.registries.serviceRegistry.getService<DiagnosticsService>(SERVICE_ID);
  const [state, setState] = useState(service.getState());
  const cfg = runtime.getPackageConfig<Record<string, unknown>>("diagnostics");
  const pingTimeoutMs = Number(cfg.ping_timeout_ms ?? 3000);

  useEffect(() => service.subscribe((next) => setState(next)), [service]);

  return (
    <CollapsibleSection title="Diagnostics">
      <div className={`status-pill ${state.healthy ? "ok" : "bad"}`}>
        {state.healthy ? "healthy" : "unhealthy"}
      </div>
      <p className="muted">last ping: {state.lastPingMs == null ? "n/a" : `${state.lastPingMs} ms`}</p>
      {state.lastError ? <p className="muted">error: {state.lastError}</p> : null}
      <button
        type="button"
        onClick={async () => {
          await service.ping(pingTimeoutMs);
        }}
      >
        Ping
      </button>
    </CollapsibleSection>
  );
}

export function createDiagnosticsModule(): CockpitModule {
  return {
    id: "diagnostics",
    version: "1.0.0",
    enabledByDefault: true,
    register(ctx: ModuleContext): void {
      if (!ctx.registries.transportRegistry.has(TRANSPORT_ID)) return;

      const dispatcher = new DiagnosticsDispatcher(DISPATCHER_ID, TRANSPORT_ID);
      ctx.registries.dispatcherRegistry.registerDispatcher({
        id: DISPATCHER_ID,
        dispatcher
      });

      const service = new DiagnosticsService(dispatcher);
      ctx.registries.serviceRegistry.registerService({
        id: SERVICE_ID,
        service
      });

      ctx.registries.sidebarPanelRegistry.registerSidebarPanel({
        id: "sidebar.diagnostics",
        label: "Diagnostics",
        render: (runtime) => <DiagnosticsSidebar runtime={runtime} />
      });
    }
  };
}
```

## 7) Estilos del módulo frontend

Archivo: `src/packages/diagnostics/frontend/diagnostics/styles.css`

```css
.diagnostics-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
```

## 8) Habilitación por YAML

Editar `config/modules.yaml`:

```yaml
packages:
  diagnostics:
    enabled: true
    modules:
      diagnostics: true
```

## 9) Checklist para IA

- `config.json` válido (schema `values + settings.fields`)
- `createPackage()` exportado en `src/packages/<id>/index.ts`
- frontend consume service, no dispatcher/transport directo
- IDs estables y sin colisiones dentro del paquete
- sidebar colapsable con `CollapsibleSection`
- `npm run test` y `npm run build` en verde

## Errores comunes a evitar

- crear el paquete sin `config.json` (no carga)
- usar rutas antiguas (`src/modules/*`, `src/services/impl/*` global) para features del paquete
- meter lógica de negocio en componentes React
- acoplar el frontend a formato de mensajes de transport
