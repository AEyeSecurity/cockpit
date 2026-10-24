# Prueba de navegación lateral — 2026-10-22

Rama de prueba: `feat/simplificar-interfaz`, creada desde `main`.

La barra lateral agrupa Operación, Estado del robot y Cámara arriba;
Diagnóstico y Configuración abajo. El botón de nombres expande las etiquetas.
Configuración permite editar directamente en el panel lateral.

Los accesos superiores Diagnostics, RTK, Processes y Debug se retiran.
Diagnóstico conserva consola, telemetría, terminal e información general de
navegación. Estado del robot permite consultar el catálogo y estado RTK.
La cámara conserva su vista de trabajo y controles PTZ existentes.

La selección y edición RTK, los procesos administrados y las capturas rosbag
no se ofrecen en esta navegación: el protocolo de `salus_robot/salus_web`
actual no admite esas operaciones. Los módulos y servicios históricos se
conservan para una revisión posterior; ocultar sus accesos no migra el backend.
Las pestañas de información no implementadas tampoco se ofrecen.

Se conserva el host modular y los controles de bloqueo de movimiento.
Validación local: build web y suite Vitest; revisión visual sin robot conectado.
No se compila Tauri ni se valida hardware. Esta prueba no cambia el despliegue.

La segunda iteración retira también los indicadores superiores de conexión,
ruta, cámara y conteo histórico de alertas. Se conservan los paneles de estado,
el indicador de conexión inferior y los bloqueos de operación. El zoom global
se encuentra en Configuración → Apariencia. Se eliminan las suscripciones del
shell que sólo alimentaban estos indicadores, sin alterar la proyección VSCode.

Grabaciones: nueva sección lateral y biblioteca de videos con filtros locales
por cámara y fecha. Es sólo la interfaz preparatoria, sin archivos de ejemplo
ni llamadas a operaciones inventadas. `salus_web` todavía no ofrece catálogo ni
descarga de videos. El estado pendiente se diferencia de una biblioteca vacía.
Falta definir carpeta, política de grabación y servicio de acceso en la Jetson.

Integración aprobada por el operador el 2026-10-24 junto con la biblioteca de
rutas compartidas y su ajuste visual. La interfaz de Grabaciones sigue indicando
explícitamente que su backend no está conectado; no se presenta como funcional.
Se conserva el soporte Docker Compose incorporado posteriormente en `main`.


Actualización 2026-10-24: Grabaciones integra recordings_status/list/start/stop
por el WebSocket existente y descarga MP4 por enlaces HTTP firmados temporales.
Inicio/parada manual requiere tomar el control existente en Operación. La parada
manual no cancela captura por misión. La biblioteca distingue error de servicio y
lista vacía; las URLs se renuevan antes de descargar. La fecha es local y las
consultas incluyen zona horaria. Videos de hasta diez minutos por entrada.
La captura automática y los 30 segundos posteriores pertenecen al backend y no
requieren que Cockpit permanezca abierto.
