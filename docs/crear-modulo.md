# Cómo crear un paquete nuevo

Esta guía reemplaza el flujo antiguo “por módulo suelto”.  
En el estado actual del repo, la unidad de extensión es **paquete** (`src/packages/<id>`).

## Qué es un paquete

Un paquete agrupa en un mismo lugar:

- frontend (uno o más módulos UI)
- services
- dispatchers
- transports
- configuración (`config.json`)

El core descubre paquetes automáticamente y los carga sin editar catálogos estáticos.

## Estructura mínima

```text
src/packages/mi-paquete/
  index.ts
  config.json
  frontend/
    mi-feature/
      index.tsx
      styles.css
  services/
    impl/
      MiService.ts
  dispatcher/
    impl/
      MiDispatcher.ts
  transport/
    impl/
      MiTransport.ts   # solo si aplica
```

## Paso 1: crear `config.json` del paquete

`config.json` es obligatorio. Debe cumplir schema:

```json
{
  "values": {
    "api_host": "localhost",
    "api_port": 8766,
    "feature_enabled": true
  },
  "settings": {
    "title": "Mi Paquete",
    "fields": [
      { "key": "api_host", "label": "API Host", "type": "string" },
      { "key": "api_port", "label": "API Port", "type": "number" },
      { "key": "feature_enabled", "label": "Feature enabled", "type": "boolean" }
    ]
  }
}
```

Reglas importantes:

- cada `fields[i].key` debe existir en `values`
- tipos válidos: `string | number | boolean | json`
- el orden de render en settings es el orden natural del array `fields`
- si falta o es inválido, el paquete no carga

## Paso 2: crear `index.ts` del paquete

El entrypoint exporta `createPackage(): CockpitPackage`.

```ts
import type { CockpitPackage } from "../../core/types/module";
import { createMiFeatureModule } from "./frontend/mi-feature";

export function createPackage(): CockpitPackage {
  return {
    id: "mi-paquete",
    version: "1.0.0",
    enabledByDefault: true,
    modules: [createMiFeatureModule()]
  };
}
```

## Paso 3: crear módulos frontend dentro del paquete

Cada módulo frontend exporta `CockpitModule` y registra contribuciones en `register(ctx)`.

Orden recomendado en `register(ctx)`:

1. transport (si aplica)
2. dispatcher
3. service
4. UI (sidebar/workspace/console/toolbar/modal/footer)

## Paso 4: IDs y scope

Definí IDs locales y estables:

- `transport.ws.core`
- `dispatcher.robot`
- `service.navigation`
- `sidebar.navigation`

El `PackageManager` aplica namespacing por paquete en runtime (`<packageId>.<id>`), evitando colisiones entre paquetes.

## Paso 5: configuración de activación

Usá `config/modules.yaml`:

```yaml
packages:
  mi-paquete:
    enabled: true
    modules:
      mi-feature: true
```

También se soportan toggles legacy en `modules`, pero el formato recomendado es `packages`.

## Paso 6: consumir configuración del paquete en runtime

Desde cualquier módulo/service:

```ts
const cfg = ctx.getPackageConfig<Record<string, unknown>>("mi-paquete");
```

Persistencia:

- base versionada: `src/packages/mi-paquete/config.json`
- override local: `packages/mi-paquete.json` (Tauri config dir)
- API runtime: `setPackageConfig` y `resetPackageConfig`

## Paso 7: estilo y sidebar colapsable

Reglas:

- estilos específicos del paquete van en `src/packages/<id>/frontend/<feature>/styles.css`
- `src/app/base.css` solo para shell/tokens/utilidades globales

Sidebar colapsable:

- ya no existe colapsado implícito por `.panel-card + h3/h4`
- usar `CollapsibleSection`:

```tsx
import { CollapsibleSection } from "../../../../app/layout/CollapsibleSection";

<CollapsibleSection title="Mi sección">
  {/* contenido del paquete */}
</CollapsibleSection>
```

## Paso 8: validación

```bash
npm run test
npm run build
npm run tauri:dev
```

Checklist:

- el paquete carga y registra UI/servicios esperados
- puede deshabilitarse por YAML sin romper la app
- frontend consume solo services
- no hay acceso directo a transport/dispatcher desde componentes
