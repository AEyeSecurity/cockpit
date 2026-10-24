# Rutas del robot

Las rutas con nombre se guardan en la biblioteca del robot conectado mediante
`salus_web`. Todos los operadores conectados pueden verlas, cargarlas, editarlas
y eliminarlas. Se requiere el backend con `list_routes`, `get_route`,
`save_route`, `delete_route` y eventos `routes_changed`.

Guardar y cargar son asíncronos. La UI confirma guardado sólo tras el ack del
robot; las revisiones detectan ediciones simultáneas. Ante conflicto, conservar
el borrador y recargar o guardar una copia. Sin conexión se puede editar un
borrador y exportarlo, pero no guardar en el robot. Cambiar de robot vacía el
catálogo anterior y conserva los puntos como borrador sin asociación remota.

«Importar rutas de esta PC» permite seleccionar rutas locales y cambiar nombres
de destino. Muestra el endpoint conectado, conserva las copias originales e
informa resultados por ruta; las confirmadas se deseleccionan para reintentar
únicamente las restantes. Nunca sobrescribe nombres existentes. Si cambia la
conexión durante el lote, se detiene la importación hacia esa sesión.
Exportar/importar JSON permite respaldar el borrador y volver a compartirlo.

Pruebas: `sharedRouteLibrary.test.ts`, `services.test.ts` y
`navigationSidebar.test.tsx`; validación habitual `npm run build` y `npm run test`.
El despliegue requiere montar almacenamiento estable de la Jetson: ver contrato
y runbook de `salus_robot`. Una compilación local no actualiza el robot.
