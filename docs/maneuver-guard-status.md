# Estado de bloqueo por geometría de navegación

Cambio preparado sobre `migration/salus-robot-cockpit` en `383f3ce`, separado
del checkout activo de cámara y de Cockpit main. No cambia el host modular.

El backend salus_robot publica estados `PENDING`, `WAITING_DATA`,
`WAITING_RETRY`, `RECOVERING`, `NEEDS_OPERATOR` y `CLEAR`. La rama de migración
usaba nombres anteriores `BLOCKED_*`; ahora el panel de navegación y el mapa
comparten la presentación de los estados ROS vigentes. `CLEAR` se proyecta
como ausencia de bloqueo, para que la recuperación no deje una alarma residual.

`PLANNER_U_TURN`, `PLANNER_LOOP` y `MANEUVER_GEOMETRY_INVALID` identifican la
espera por geometría. La UI muestra la causa del backend y el plazo restante,
sin añadir un presupuesto de retries ni un temporizador de autorización local.
El bloqueo final se muestra como error y conserva la instrucción del operador
contenida en `blocked_reason_text`. La UI no acredita checkpoints, modifica
metas ni envía un resume automático. Cancelar y enviar una misión revisada
siguen siendo acciones explícitas existentes.

El estado de ruta se refresca cada tres heartbeats de conexión, sin consultas
superpuestas, porque `blocked_*` llega por get_state y no por telemetría compacta.
Se conserva el heartbeat de control actual. La presentación es común al mapa y
al panel; este último incorpora un estado visible junto a START/CANCEL.

Verificación: `npm run build` y `npm run test`: 172 pruebas aprobadas, una
omitida. Incluye DOM del panel y del mapa con causa de giro en U, espera sin
retries ficticios, CLEAR, actualización periódica y consultas no superpuestas.
No se compiló Tauri ni se conectó a hardware. La evidencia backend y las
limitaciones físicas están en ADR 0016 de salus_robot.
