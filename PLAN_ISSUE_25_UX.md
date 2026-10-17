# Issue #25: editor de rutas en el workspace

Plan para GPT-6 Luna. Decisión del usuario: **opción 2**, editor en una pestaña del workspace y sidebar de navegación reducido. Este plan reemplaza la parte de UX del plan inicial del issue; la implementación existente de inserción, historial y persistencia es el punto de partida.

## Resultado que debe ver el usuario

El sidebar debe responder tres preguntas de un vistazo: **qué ruta está cargada**, **si tiene cambios pendientes** y **qué acción de ejecución está disponible**. La edición detallada vive en la pestaña **Editor de rutas**. No dejar una matriz de iconos, controles diminutos ni un candado repetido por botón.

Propuesta de jerarquía:

```text
SIDEBAR DE NAVEGACIÓN                 WORKSPACE · EDITOR DE RUTAS
Conexión y control                    Ronda noche   · Cambios sin guardar
Ruta: Ronda noche · 20 puntos         [Guardar cambios] [Guardar como…] [Abrir ruta]
[Editar ruta]                         20 puntos · 1 HOME · Patrulla lista
Ejecución: [Iniciar patrulla]         [Añadir punto al final] [Deshacer] [Rehacer]
           [Cancelar] (si activa)    1  HOME      …  [Editar]
                                     2  Recorrido …  [Editar]
                                     …
                                     5  Recorrido …  [Editar]
                                     [+ Insertar punto entre 5 y 6]
                                     6  Recorrido …  [Editar]
                                     …
                                     [Configurar patrulla] [Más opciones]
```

El ejemplo es jerarquía, no una exigencia de layout literal. En el workspace usar etiquetas completas en español y espacios táctiles cómodos. Las coordenadas, orientación, segmento y acciones se muestran como información secundaria legible. El detalle de un punto seleccionado abre un panel o sección contextual; solo ahí aparecen mover, eliminar, HOME y acciones especiales. Agrupar configuración avanzada de patrulla por segmento: **recorrido principal**, **salida desde HOME**, **regreso a HOME** y **punto de reingreso**, con explicación breve de cada uno. Las opciones destructivas se separan del flujo principal y exigen confirmación cuando se descartan cambios.

## Flujos obligatorios

1. **Ruta nueva:** el estado vacío explica «Todavía no hay puntos» y presenta **Añadir primer punto en el mapa** y **Abrir ruta guardada**. Sin botones inactivos en masa. Al añadir, abrir la pestaña Mapa e indicar claramente «Haz clic en el mapa para colocar el punto». Tras colocarlo, seleccionar el punto nuevo y volver automáticamente al editor; mantener la misma conducta en ambos renderizadores. El usuario puede volver al mapa desde el editor para añadir otro punto.
2. **Insertar entre 5 y 6:** la acción debe estar visualmente *entre* las filas 5 y 6, o surgir al seleccionar el punto 5 como **Insertar después de 5**. Al activarla, abrir el mapa, destacar el tramo elegido e indicar «Insertando entre 5 y 6» con **Cancelar inserción** visible. El siguiente clic coloca el punto en la posición 6; los puntos anteriores y posteriores conservan identidad, atributos y orden. Escape o el botón cancelan sin modificar la ruta y devuelven al editor. Tras insertar, volver al editor, seleccionar el punto nuevo y mostrar **Cambios sin guardar**.
3. **Editar ruta guardada:** abrir una ruta por nombre, editar puntos o perfil de patrulla, **Guardar cambios** sobre la misma o **Guardar como…** otra. Pedir confirmación al sobrescribir otra ruta. Antes de abrir otra o borrar la actual, advertir si se perderán cambios. Distinguir «guardada en Cockpit» de archivos enviados al robot.
4. **Edición puntual:** seleccionar una fila permite moverla una posición, editar atributos/acciones y eliminarla, con botones de texto y confirmación proporcionada. Deshacer/rehacer reflejan una edición real. La lista y el mapa muestran la misma secuencia y selección.
5. **Patrulla:** el editor muestra si están completos recorrido, HOME y reingreso. La inserción, eliminación o movimiento en un segmento mantiene coherente su orden; HOME y reingreso se conservan por identidad. Si una operación deja la patrulla incompleta, explicar qué falta antes de habilitar **Iniciar patrulla**.
6. **Control bloqueado o misión activa:** el editor sigue siendo visible y permite consultar la ruta. Mostrar **un** aviso de estado que explique por qué no se puede colocar/editar/ejecutar, en lugar de candados por control. Nunca hacer que una edición del borrador cambie la misión ya iniciada. Mantener **Cancelar misión** y **Volver a HOME** accesibles en el sidebar según el estado real.

## Trabajo técnico

1. Trabajar únicamente en el worktree `/home/leosole/Desktop/SALUS-worktrees/cockpit-issue-25-route-editor`, rama `feat/issue-25-route-editor-sidebar`. Verificar `git status` y `git worktree list` antes de editar: otro agente puede estar trabajando en `main` u otra rama. No cambiar, limpiar ni hacer stash en el worktree ajeno.
2. Registrar desde el módulo `navigation` una contribución `slot: "workspace"` (por ejemplo `workspace.route-editor`), sin añadir un host nuevo ni parchear `AppShell`. Abrirla desde el sidebar mediante `ShellCommands.openWorkspace`. Usar `NavigationService` como estado y acciones compartidas entre editor y mapa. Separar el componente del sidebar en un archivo propio si ayuda a reducir `frontend/index.tsx`.
3. Reducir la sección WAYPOINTS y GESTIÓN DE RUTAS del sidebar a una tarjeta breve: nombre/borrador, cantidad de puntos, estado de guardado, **Editar ruta** y estado de ejecución. Conservar conexión, control manual y controles esenciales de misión, revisando duplicados. Mover guardado, lista, selección, deshacer/rehacer, HOME, acciones de waypoint y configuración de patrulla al editor. No esconder funciones existentes sin ofrecerlas allí.
4. Reutilizar `beginWaypointInsertion`, `insertWaypoint`, `cancelWaypointInsertion`, undo/redo y rutas con nombre. Hacer que el botón del editor abra `workspace.map`. Añadir en el mapa una indicación del hueco pendiente y una cancelación clara en ambos renderizadores. Evitar una inserción silenciosa en otro segmento. Revisar `reorderWaypoint`: hoy reordena la cola general y reconcilia el perfil, pero el orden interno del segmento de patrulla puede quedar intacto. Corregirlo antes de ofrecer **Mover arriba/abajo** sobre puntos de patrulla o presentar una acción explícita que preserve la secuencia ejecutada; cubrirlo con pruebas.
5. Diseñar estados vacíos, pendiente de colocación, selección simple/múltiple, ruta guardada limpia/sucia, patrulla incompleta/lista, bloqueo y misión activa. No depender de `title`/hover para explicar qué hace una acción. Mostrar mensajes de error y éxito cerca de la acción, además del evento de consola.
6. Estilos limitados al paquete `nav2`: jerarquía clara, texto suficiente, buen contraste, foco de teclado visible y vista utilizable en ancho reducido. Usar la tipografía y tokens existentes del proyecto. Evitar una columna de tres botones compactos, iconos sin texto y controles deshabilitados que llenen el estado vacío.

## Verificación y aceptación

- Actualizar `src/test/navigationSidebar.test.tsx`: los tests viejos esperan que todo esté en el sidebar y deben comprobar ahora el resumen, el botón que abre el workspace y la ejecución. Añadir pruebas de interfaz para la contribución del editor, estado vacío, guardado, confirmación de descarte, inserción pendiente/cancelación y controles contextualizados. No limitarse a verificar que el componente renderiza.
- Mantener y ampliar las pruebas de servicio en `src/test/services.test.ts`: ruta de 20 puntos, inserción entre 5 y 6, identidad/atributos, undo/redo, guardado/carga y orden real de segmentos de patrulla tras insertar o reordenar. Comparar el perfil que ejecutaría la patrulla con el orden presentado al usuario.
- Probar manualmente el flujo completo en navegador, con ruta vacía y una de 20 puntos, en tamaño normal y estrecho. Verificar mapa Leaflet y mapa abstracto si ambos están disponibles. Capturar o describir lo que se ve: un usuario debe poder descubrir cómo insertar entre 5 y 6 sin conocer la implementación.
- Ejecutar `npm run build` y `npm run test` desde el worktree propio. No compilar Tauri. Revisar diff y estado antes de publicar la rama. Dejar constancia de cualquier limitación real en el issue o PR.

No implementar un mapa duplicado dentro del editor: esta iteración usa la pestaña Mapa existente. El objetivo es que el paso de editor a mapa y de vuelta sea evidente para un usuario común.
