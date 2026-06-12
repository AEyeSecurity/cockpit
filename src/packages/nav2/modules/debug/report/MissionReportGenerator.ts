import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

// Minimal interfaces — structurally compatible with MissionSession and MissionJsonRecord
export interface ReportableSession {
  id: string;
  filename?: string;
  status: string;
  startedAt: string;
  endedAt: string;
  durationSec: number;
  commandCount: number;
  errorCount: number;
  warningCount: number;
  events: Array<{
    atMs: number;
    timestamp: string;
    type: string;
    description: string;
    severity: string;
  }>;
  records?: Array<Record<string, unknown>>;
}

// ─── helpers ────────────────────────────────────────────────────────────────

function formatDuration(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec < 1 ? "<1" : sec}s`;
}

function fmtDate(iso: string): string {
  return iso.replace("T", " ").slice(0, 19);
}

// ─── pattern matching ────────────────────────────────────────────────────────

type PatternKey =
  | "smoother_collision"
  | "smoother_abort"
  | "ackermann_saturated"
  | "bt_goal_updated_failure"
  | "goal_cancelled"
  | "goal_aborted"
  | "waypoint_failed"
  | "planner_out_of_costmap"
  | "sensor_out_of_bounds"
  | "costmap_clear_timeout"
  | "backup_abort"
  | "manual_watchdog_stop"
  | "manual_takeover"
  | "rtk_stale"
  | "zones_service_unavailable"
  | "camera_service_unavailable"
  | "keepout_filter_update";

function classifyEvent(event: ReportableSession["events"][number]): PatternKey | null {
  const d = event.description.toLowerCase();

  // Smoother
  if (d.includes("smoothed path leads to a collision")) return "smoother_collision";
  if (d.includes("aborting handle") && (d.includes("smooth") || d.includes("[smooth_path]"))) return "smoother_abort";

  // Controller
  if (d.includes("ackermann steer saturated")) return "ackermann_saturated";

  // Behavior Tree
  if (d.includes("behavior tree failure") && d.includes("goalupdated")) return "bt_goal_updated_failure";

  // Navigation goal outcomes
  if (d.includes("goal_result_aborted") || (d.includes("aborted") && (d.includes("navigatethroughposes") || d.includes("followwaypoints")))) return "goal_aborted";
  if (d.includes("goal_cancelled") || (d.includes("cancelled") && event.type !== "info" && d.includes("goal"))) return "goal_cancelled";
  if (d.includes("failed to process waypoint") || d.includes("waypoint") && d.includes("fail")) return "waypoint_failed";

  // Planner / costmap spatial failures
  if (d.includes("start pose is out of costmap") || (d.includes("failed to plan") && d.includes("out of costmap"))) return "planner_out_of_costmap";
  if (d.includes("sensor origin") && d.includes("out of map bounds")) return "sensor_out_of_bounds";
  if (d.includes("timed out") && d.includes("clear_entirely")) return "costmap_clear_timeout";

  // Recovery behaviors
  if (d.includes("aborting handle") && d.includes("backup")) return "backup_abort";

  // Safety / manual events
  if (d.includes("manual_watchdog_stop") || d.includes("manual watchdog forced stop")) return "manual_watchdog_stop";
  if (d.includes("manual_takeover") || d.includes("manual mode enabled")) return "manual_takeover";

  // GPS/RTK
  if (d.includes("rtcm stale")) return "rtk_stale";

  // Services
  if (d.includes("zones_manager") || d.includes("zones reload")) return "zones_service_unavailable";
  if (d.includes("camera_status")) return "camera_service_unavailable";

  // Costmap filters
  if ((d.includes("keepoutfilter") || d.includes("keepout filter")) && d.includes("mask")) return "keepout_filter_update";

  return null;
}

// ─── error group definitions ─────────────────────────────────────────────────

interface ErrorGroupDef {
  name: string;
  topic: string;
  severityLabel: "ERROR" | "WARN" | "INFO";
  component: string;
  category: string;
  criticality: "Crítico" | "Recuperable" | "Informativo";
  probableCause: string;
  solutions: string[];
  checksToValidate: string[];
}

const ERROR_GROUP_DEFS: Record<PatternKey, ErrorGroupDef> = {
  planner_out_of_costmap: {
    name: "Planificador: pose de inicio fuera del costmap",
    topic: "/rosout",
    severityLabel: "ERROR",
    component: "planner_server (GridBased)",
    category: "Navegación / Planner / Costmap",
    criticality: "Crítico",
    probableCause:
      "El planner global no puede generar ningún path porque la posición actual del robot " +
      "(estimada por GPS/odometría) cae fuera de los límites del costmap. " +
      "Causas comunes: (1) el robot se desplazó más allá del área cubierta por el mapa, " +
      "(2) el origen del costmap o el tamaño del mapa no están correctamente configurados, " +
      "(3) hay un salto de localización GPS que colocó el robot fuera del mapa. " +
      "Cuando este error ocurre, no se genera ningún plan (/plan = 0 mensajes) y el robot no se mueve.",
    solutions: [
      "Verificar los parámetros del costmap: origin_x, origin_y, width, height en nav2_params.yaml.",
      "Aumentar el tamaño del costmap global para cubrir el área de operación real del robot.",
      "Revisar si el GPS tiene un salto anómalo que mueve el robot virtualmente fuera del mapa.",
      "Verificar que el frame del mapa y el frame del robot estén correctamente transformados en TF.",
      "Usar robot_localization con EKF para fusionar GPS + odometría y reducir saltos de posición.",
    ],
    checksToValidate: [
      "ros2 topic echo /map_metadata — verificar resolución, ancho y alto del mapa.",
      "ros2 topic echo /global_costmap/costmap/info — verificar origin_x, origin_y, width, height.",
      "Visualizar en RViz la posición del robot sobre el costmap — confirmar que está dentro de los límites.",
      "Verificar ros2 topic echo /gps/fix en busca de saltos de posición > 5 metros.",
    ],
  },
  sensor_out_of_bounds: {
    name: "Origen de sensor fuera de los límites del costmap",
    topic: "/rosout",
    severityLabel: "WARN",
    component: "costmap_topic_collision_checker / local_costmap",
    category: "Navegación / Costmap / Sensores",
    criticality: "Recuperable",
    probableCause:
      "El origen del sensor (LIDAR, cámara de profundidad) está fuera del área del costmap, " +
      "por lo que el costmap no puede realizar raytracing para actualizar los obstáculos. " +
      "Frecuentemente co-ocurre con 'Start pose is out of costmap' — ambos son síntoma " +
      "de que el robot está posicionado fuera del área del mapa.",
    solutions: [
      "Resolver el error de planner_out_of_costmap — generalmente ambos se corrigen juntos.",
      "Verificar el tamaño del mapa local para que siempre cubra el robot y sus sensores.",
      "Revisar la transformación TF entre el frame del sensor y el frame del mapa.",
    ],
    checksToValidate: [
      "ros2 topic echo /local_costmap/costmap/info — verificar que cubre el área del sensor.",
      "Visualizar /scan en RViz sobre el costmap y confirmar que los puntos caen dentro del mapa.",
    ],
  },
  costmap_clear_timeout: {
    name: "Timeout al limpiar el costmap durante recovery",
    topic: "/rosout",
    severityLabel: "ERROR",
    component: "bt_navigator / costmap_service",
    category: "Navegación / Recovery / Costmap",
    criticality: "Crítico",
    probableCause:
      "El Behavior Tree intentó limpiar el costmap como parte de un comportamiento de recovery, " +
      "pero la llamada al servicio clear_entirely_global/local_costmap tardó más del timeout configurado. " +
      "Esto impide que el recovery complete, dejando al robot sin poder reintentar la navegación. " +
      "Puede indicar que el nodo del costmap está sobrecargado o no responde.",
    solutions: [
      "Aumentar el timeout del servicio de costmap en el BT: parámetro service_timeout_ms.",
      "Verificar la carga del sistema cuando ocurre el timeout — el costmap puede estar procesando un mapa grande.",
      "Revisar si el nodo del costmap está publicando en /global_costmap/costmap con frecuencia normal.",
      "Considerar separar el nodo del costmap en un proceso con mayor prioridad de CPU.",
    ],
    checksToValidate: [
      "ros2 service call /global_costmap/clear_entirely_global_costmap nav2_msgs/srv/ClearEntireCostmap — medir tiempo de respuesta.",
      "ros2 topic hz /global_costmap/costmap — verificar que publica normalmente.",
      "Revisar el BT XML para el parámetro service_timeout_ms del nodo ClearEntireCostmap.",
    ],
  },
  backup_abort: {
    name: "Abort del comportamiento de recovery BackUp",
    topic: "/rosout",
    severityLabel: "WARN",
    component: "nav2_behaviors / BackUp",
    category: "Navegación / Recovery",
    criticality: "Recuperable",
    probableCause:
      "El comportamiento de recovery BackUp (mover el robot hacia atrás para despejarse) " +
      "fue abortado. Puede ocurrir si: (1) hay un obstáculo detrás del robot, " +
      "(2) el cliente que inició el backup canceló el goal, " +
      "o (3) el BT tomó otra decisión de recovery. " +
      "Si ocurre junto con costmap_clear_timeout, el BT no puede completar ninguna rama de recovery.",
    solutions: [
      "Verificar que el espacio detrás del robot esté libre cuando se intenta el backup.",
      "Revisar el BT XML para asegurar que el backup tiene suficiente distancia y velocidad configurados.",
      "Considerar agregar un behavior de Wait antes del BackUp para dar tiempo al costmap a actualizarse.",
    ],
    checksToValidate: [
      "Inspeccionar la secuencia en el BT XML: qué se ejecuta antes y después del BackUp.",
      "Verificar parámetros backup_dist y backup_speed en nav2_params.yaml.",
    ],
  },
  goal_aborted: {
    name: "Goal de navegación abortado por Nav2",
    topic: "/nav_command_server/events",
    severityLabel: "ERROR",
    component: "nav_command_server / navigatethroughposes / followwaypoints",
    category: "Navegación",
    criticality: "Crítico",
    probableCause:
      "Nav2 agotó todos sus mecanismos de recovery y abortó el goal sin completarlo. " +
      "A diferencia de GOAL_CANCELLED (cancelación externa), GOAL_RESULT_ABORTED significa " +
      "que el stack de navegación interno decidió que no puede continuar. " +
      "Generalmente precede este evento una secuencia de: planner failure → BT recovery → timeout → abort.",
    solutions: [
      "Revisar la cadena de eventos BT que preceden al abort en la línea temporal.",
      "Verificar si hay errores del planner, del costmap, o del smoother antes del abort.",
      "Incrementar max_planning_retries en nav2_params.yaml para dar más oportunidades al planner.",
      "Revisar el BT XML para asegurar que todas las ramas de recovery están bien configuradas.",
    ],
    checksToValidate: [
      "Identificar qué error BT precede al abort en la línea temporal del informe.",
      "ros2 topic echo /navigate_through_poses/_action/status — observar la secuencia de estados.",
    ],
  },
  waypoint_failed: {
    name: "Fallo al procesar waypoint en FollowWaypoints",
    topic: "/rosout",
    severityLabel: "ERROR",
    component: "waypoint_follower",
    category: "Navegación / Waypoints",
    criticality: "Crítico",
    probableCause:
      "El nodo waypoint_follower no pudo procesar el waypoint indicado (usualmente waypoint 0, el primero). " +
      "Con stop_on_failure=true configurado, el primer fallo termina la misión completa sin reintentar. " +
      "Causas: el waypoint está fuera del costmap, el planner no puede generar un path hacia él, " +
      "o el waypoint tiene coordenadas inválidas.",
    solutions: [
      "Verificar que todos los waypoints de la misión estén dentro del área del mapa.",
      "Revisar las coordenadas GPS de los waypoints — pueden estar en un frame incorrecto.",
      "Cambiar stop_on_failure a false en el plugin del waypoint follower para permitir skip de waypoints.",
      "Agregar un margen de tolerancia (goal_checker_dist_tolerance) más amplio.",
    ],
    checksToValidate: [
      "Inspeccionar las coordenadas del waypoint 0 en el JSONL — verificar que están dentro del mapa.",
      "ros2 param get /waypoint_follower stop_on_failure — confirmar el valor actual.",
      "Visualizar los waypoints en RViz sobre el mapa para confirmar que son accesibles.",
    ],
  },
  manual_watchdog_stop: {
    name: "Parada forzada por watchdog de modo manual",
    topic: "/nav_command_server/events",
    severityLabel: "WARN",
    component: "nav_command_server",
    category: "Seguridad / Control Manual",
    criticality: "Recuperable",
    probableCause:
      "El watchdog de modo manual detectó que el operador no envió comandos dentro del intervalo " +
      "esperado y forzó una parada del robot como medida de seguridad. " +
      "Puede ocurrir si: (1) se perdió la conexión con el joystick/interfaz manual, " +
      "(2) el operador dejó de enviar comandos sin desactivar el modo manual, " +
      "o (3) la latencia de red hizo que los comandos llegaran fuera del timeout.",
    solutions: [
      "Revisar el parámetro manual_watchdog_timeout_s en la configuración del nav_command_server.",
      "Verificar la estabilidad de la conexión de red/joystick durante operación manual.",
      "Agregar un heartbeat explícito en la UI del cockpit para mantener vivo el modo manual.",
    ],
    checksToValidate: [
      "Revisar el parámetro watchdog_timeout en nav_command_server.",
      "Inspeccionar la latencia de red en el momento del evento en el log.",
    ],
  },
  manual_takeover: {
    name: "Toma de control manual durante misión autónoma",
    topic: "/nav_command_server/events",
    severityLabel: "INFO",
    component: "nav_command_server",
    category: "Seguridad / Control Manual",
    criticality: "Informativo",
    probableCause:
      "Un operador activó el modo manual durante una misión autónoma activa, " +
      "lo que cancela la navegación autónoma y entrega el control al operador. " +
      "Puede ser intencional (intervención de seguridad) o accidental (click involuntario).",
    solutions: [
      "Si fue intencional, verificar qué condición requirió la intervención manual.",
      "Si fue accidental, revisar la UX del botón de manual en el cockpit para evitar activaciones involuntarias.",
      "Agregar un log de razón al evento MANUAL_TAKEOVER para auditoría.",
    ],
    checksToValidate: [
      "Revisar si hay errores de navegación que precedan el takeover en la línea temporal.",
      "Verificar si el takeover fue desde la UI del cockpit o desde un dispositivo físico.",
    ],
  },
  smoother_collision: {
    name: "Colisión detectada en suavizado de trayectoria",
    topic: "/rosout",
    severityLabel: "ERROR",
    component: "smoother_server",
    category: "Navegación / Nav2 / Planificación",
    criticality: "Crítico",
    probableCause:
      "El smoother_server genera una versión suavizada del path que queda dentro del espacio de obstáculos del costmap. " +
      "Probable causa: el KeepoutFilter se actualiza en el mismo instante que el smoother intenta suavizar, " +
      "invalidando la trayectoria. También puede ocurrir si el global planner genera una ruta que roza obstáculos marginales " +
      "y el suavizador la amplifica.",
    solutions: [
      "Revisar inflation_radius en global_costmap — si está sobredimensionado agrega obstáculos virtuales que colapsan paths válidos.",
      "Reducir w_smooth o max_iterations en smoother_server dentro de nav2_params.yaml.",
      "Desactivar temporalmente do_refinement para aislar si el problema es el refinamiento iterativo.",
      "Verificar que la actualización de KeepoutFilter no ocurra durante una planificación activa.",
      "Revisar la trayectoria cruda (antes del smoother) en /plan — si ya colisiona, el problema es el planner, no el smoother.",
    ],
    checksToValidate: [
      "Visualizar /plan y el plan suavizado en RViz justo antes del error.",
      "Setear w_smooth=0 en nav2_params.yaml y verificar si la navegación procede.",
      "ros2 service call /smooth_path nav2_msgs/srv/SmoothPath con la ruta del JSONL y observar la respuesta.",
    ],
  },
  smoother_abort: {
    name: "Abort del action server de suavizado",
    topic: "/rosout",
    severityLabel: "WARN",
    component: "smoother_server",
    category: "Navegación / Nav2",
    criticality: "Recuperable",
    probableCause:
      "Consecuencia directa del error de colisión del smoother. El action server aborta el handle " +
      "porque no puede entregar un path válido al controlador.",
    solutions: [
      "Este error es síntoma secundario de smoother_collision — resolverlo elimina este abort.",
      "Verificar que el Behavior Tree tenga un nodo de recovery configurado para reintentar la planificación.",
    ],
    checksToValidate: [
      "Resolver smoother_collision y confirmar que este abort desaparece.",
    ],
  },
  ackermann_saturated: {
    name: "Saturación de dirección Ackermann",
    topic: "/rosout",
    severityLabel: "WARN",
    component: "vehicle_controller_server",
    category: "Control / Controlador físico",
    criticality: "Recuperable",
    probableCause:
      "Nav2 genera comandos cmd_vel con curvatura mayor a la que permite el modelo Ackermann configurado. " +
      "Los valores observados (-30.92° a -32.18°) superan el límite de 30°. " +
      "Puede indicar: wheelbase mal configurado, min_turning_radius incorrecto, o que la trayectoria requiere " +
      "una curva más cerrada que las capacidades del robot.",
    solutions: [
      "Revisar min_turning_radius en el plugin de controlador Nav2 (regulated_pure_pursuit o dwb_controller).",
      "Verificar que el wheelbase en nav2_params.yaml coincide con la medición real del robot.",
      "Considerar aumentar el límite de steer si el hardware lo soporta mecánicamente.",
      "Reducir max_vel_theta para que Nav2 no genere curvaturas tan altas.",
    ],
    checksToValidate: [
      "Publicar manualmente cmd_vel con angular_z=-0.65 y observar si el robot puede ejecutarlo.",
      "Medir el radio mínimo de giro real del robot y compararlo con el configurado.",
      "Revisar el parámetro min_turning_radius en nav2_params.yaml bajo el plugin del controlador.",
    ],
  },
  bt_goal_updated_failure: {
    name: "GoalUpdated FAILURE en cascada (Behavior Tree)",
    topic: "/behavior_tree_log",
    severityLabel: "WARN",
    component: "nav2_bt_navigator",
    category: "Navegación / Behavior Tree / Nav2",
    criticality: "Recuperable",
    probableCause:
      "El nodo GoalUpdated del BT detecta repetidamente que el goal fue invalidado. " +
      "Cuando el smoother aborta, el BT recibe el fallo y el nodo GoalUpdated se dispara " +
      "en cascada mientras intenta recuperar el estado. " +
      "El alto número de ocurrencias (51+) indica que el BT quedó en un loop de re-evaluación " +
      "sin salir del estado de falla.",
    solutions: [
      "Resolver smoother_collision — este flood es consecuencia directa de ese error.",
      "Revisar el árbol de comportamiento XML activo para verificar la posición del nodo GoalUpdated.",
      "Agregar un nodo de recovery con límite de reintentos (max_retries) para evitar loops infinitos.",
    ],
    checksToValidate: [
      "Resolver el error de colisión del smoother y verificar que el flood desaparece.",
      "Inspeccionar el BT XML: ros2 param get /bt_navigator default_bt_xml_filename",
    ],
  },
  goal_cancelled: {
    name: "Goal de navegación cancelado",
    topic: "/nav_command_server/events",
    severityLabel: "WARN",
    component: "nav_command_server / navigatethroughposes",
    category: "Navegación",
    criticality: "Crítico",
    probableCause:
      "El objetivo NavigateThroughPoses fue cancelado. " +
      "Se detectaron dos tipos de cancelación: (1) cancelación automática por fallo del BT (goal canceled), " +
      "y (2) cancelación explícita via servicio cancel_goal service. " +
      "La misión terminó sin completar el recorrido de 2 waypoints.",
    solutions: [
      "Revisar el campo 'reason' del evento GOAL_CANCELLED para determinar si fue manual o automático.",
      "Si fue automático, rastrear el BT failure que lo precede en la línea temporal.",
      "Implementar lógica de re-intento automático si el robot debe recuperarse solo.",
      "Verificar si la cancelación manual fue intencional o un error de la UI.",
    ],
    checksToValidate: [
      "Revisar el campo details.reason en el mensaje GOAL_CANCELLED del JSONL.",
      "Confirmar si la cancelación fue desde la UI del cockpit o via API ROS2.",
    ],
  },
  rtk_stale: {
    name: "Correcciones RTK desactualizadas (RTCM stale)",
    topic: "/rosout",
    severityLabel: "WARN",
    component: "rtk_bridge",
    category: "GPS / Localización",
    criticality: "Recuperable",
    probableCause:
      "El rtk_bridge no recibió correcciones RTCM en los últimos 5.5 segundos al inicio de la sesión. " +
      "Puede indicar: latencia en la conexión NTRIP al arrancar, pérdida temporal de conectividad, " +
      "o que el servidor NTRIP tardó en comenzar a transmitir. " +
      "Al momento del evento, GPS fix estaba disponible (gps_fix_available=true), " +
      "lo que sugiere que el fix era con precisión reducida (sin RTK).",
    solutions: [
      "Verificar conectividad al servidor NTRIP antes de iniciar la misión.",
      "Revisar max_stale_age_s en rtk_bridge.py — puede necesitar ajuste si el servidor NTRIP tiene latencia.",
      "Esperar a que gps_age_s baje y las correcciones RTK sean recientes antes de autorizar la misión.",
      "Agregar una precondición de misión que verifique que RTK esté activo.",
    ],
    checksToValidate: [
      "ros2 topic echo /gps/fix | grep covariance — RTK fix debe tener covariance < 0.01.",
      "Verificar logs de rtk_bridge para errores de conexión TCP/IP.",
      "Ping al servidor NTRIP desde el robot para confirmar conectividad.",
    ],
  },
  zones_service_unavailable: {
    name: "Servicio de zonas no disponible al conectar",
    topic: "/rosout",
    severityLabel: "WARN",
    component: "web_zone_server",
    category: "Infraestructura / Servicios ROS2",
    criticality: "Informativo",
    probableCause:
      "El web_zone_server intentó recargar las zonas desde disco (/zones_manager/reload_from_disk) " +
      "cuando un cliente WebSocket se conectó, pero el servicio no estaba disponible. " +
      "Probable causa: zones_manager tardó en iniciar o no estaba en el launch file activo.",
    solutions: [
      "Verificar que zones_manager esté incluido en el launch file y se inicie antes del web_zone_server.",
      "Agregar wait_for_service(timeout=5) en web_zone_server antes de llamar al servicio.",
      "Revisar si el timeout de recarga es adecuado para el tiempo de arranque del sistema.",
    ],
    checksToValidate: [
      "ros2 service list | grep zones_manager — verificar que el servicio existe después del arranque.",
      "Revisar el launch file para confirmar el orden de inicio de los nodos.",
    ],
  },
  camera_service_unavailable: {
    name: "Servicio de estado de cámara no disponible",
    topic: "/rosout",
    severityLabel: "WARN",
    component: "web_zone_server",
    category: "Hardware / Cámara",
    criticality: "Informativo",
    probableCause:
      "El nodo de cámara no había publicado su servicio /camara/camera_status " +
      "al momento en que web_zone_server intentó consultarlo.",
    solutions: [
      "Verificar que el nodo de cámara esté en el launch file y se inicie correctamente.",
      "Revisar si la cámara tiene errores de inicialización en sus propios logs.",
      "Este warning puede ser benigno si la cámara no es requerida para la misión en curso.",
    ],
    checksToValidate: [
      "ros2 service list | grep camera_status — verificar que el servicio existe.",
      "ros2 node list | grep camara — verificar que el nodo está activo.",
    ],
  },
  keepout_filter_update: {
    name: "Actualización de máscara KeepoutFilter",
    topic: "/rosout",
    severityLabel: "INFO",
    component: "global_costmap / local_costmap",
    category: "Navegación / Costmap",
    criticality: "Informativo",
    probableCause:
      "El costmap (global y local) recibió una nueva máscara del topic /keepout_filter_mask " +
      "al inicio de la sesión. Esta actualización ocurre justo antes del error del smoother, " +
      "lo que sugiere que la nueva máscara puede haber agregado obstáculos que invalidaron " +
      "la trayectoria planificada.",
    solutions: [
      "Verificar si la actualización de la máscara coincide temporalmente con el error del smoother.",
      "Considerar si las actualizaciones de KeepoutFilter durante navegación activa deberían " +
      "disparar un replanning automático.",
      "Revisar la frecuencia de publicación de /keepout_filter_mask — si es muy alta puede generar inestabilidad.",
    ],
    checksToValidate: [
      "Correlacionar el timestamp de keepout_filter_update con smoother_collision en la línea temporal.",
      "ros2 topic hz /keepout_filter_mask — verificar frecuencia de actualización.",
    ],
  },
};

// ─── group building ──────────────────────────────────────────────────────────

interface MatchedGroup {
  key: PatternKey;
  count: number;
  firstAt: string;
  lastAt: string;
  examples: string[];
}

function buildErrorGroups(session: ReportableSession): MatchedGroup[] {
  const groups = new Map<PatternKey, MatchedGroup>();

  for (const event of session.events) {
    const key = classifyEvent(event);
    if (!key) continue;

    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { key, count: 1, firstAt: event.timestamp, lastAt: event.timestamp, examples: [event.description] });
    } else {
      existing.count++;
      existing.lastAt = event.timestamp;
      if (existing.examples.length < 2) existing.examples.push(event.description);
    }
  }

  return Array.from(groups.values()).sort((a, b) => {
    const order: Record<string, number> = { Crítico: 0, Recuperable: 1, Informativo: 2 };
    return (order[ERROR_GROUP_DEFS[a.key].criticality] ?? 3) - (order[ERROR_GROUP_DEFS[b.key].criticality] ?? 3);
  });
}

function buildRecommendations(groups: MatchedGroup[]): string[] {
  const keys = new Set(groups.map((g) => g.key));
  const recs: string[] = [];

  // Máxima prioridad: el robot no puede planificar en absoluto
  if (keys.has("planner_out_of_costmap") || keys.has("sensor_out_of_bounds")) {
    recs.push(
      "PRIORIDAD MÁXIMA — El robot está fuera de los límites del costmap. " +
      "Ninguna navegación es posible mientras persista esta condición. " +
      "Verificar que el tamaño del mapa (width, height, origin_x/y) cubre el área real de operación. " +
      "Si el GPS tiene saltos, implementar fusión con odometría local mediante robot_localization (EKF)."
    );
  }

  if (keys.has("costmap_clear_timeout") || keys.has("backup_abort")) {
    recs.push(
      "PRIORIDAD ALTA — Los mecanismos de recovery de Nav2 están fallando (timeout en clear costmap, backup abortado). " +
      "Aumentar service_timeout_ms en el BT para el nodo ClearEntireCostmap. " +
      "Verificar que el costmap responde al servicio clear_entirely dentro del tiempo esperado."
    );
  }

  if (keys.has("goal_aborted") || keys.has("waypoint_failed")) {
    recs.push(
      "Nav2 abortó la misión después de agotar todos los mecanismos de recovery. " +
      "Revisar la cadena de eventos en la línea temporal para identificar el error raíz que desencadenó el abort. " +
      "Si el waypoint 0 falla, verificar que las coordenadas GPS del primer waypoint estén dentro del mapa."
    );
  }

  if (keys.has("smoother_collision")) {
    recs.push(
      "Revisar la configuración del smoother_server en nav2_params.yaml. " +
      "El error de colisión es causa raíz de los fallos en cascada (BT flood, goal cancel). " +
      "Verificar si el KeepoutFilter se actualiza justo antes del error. " +
      "Reducir inflation_radius o w_smooth como primer paso."
    );
  }

  if (keys.has("ackermann_saturated")) {
    recs.push(
      "Calibrar los límites de curvatura del controlador. " +
      "Los ángulos solicitados superan el límite físico configurado (30°). " +
      "Verificar que min_turning_radius en nav2_params.yaml coincide con el radio mínimo real del robot."
    );
  }

  if (keys.has("bt_goal_updated_failure")) {
    recs.push(
      "El flood de GoalUpdated en el BT es consecuencia de otro error subyacente. " +
      "Resolver el error raíz (smoother, planner, costmap) debería eliminar este flood. " +
      "Si persiste, revisar el BT XML y agregar un límite de reintentos (max_retries)."
    );
  }

  if (keys.has("rtk_stale")) {
    recs.push(
      "Implementar una precondición de misión que verifique que las correcciones RTK están activas " +
      "(RTCM age < 2s) antes de autorizar la navegación autónoma."
    );
  }

  if (keys.has("manual_watchdog_stop")) {
    recs.push(
      "Revisar el timeout del watchdog de modo manual. " +
      "Si la red tiene latencia variable, aumentar manual_watchdog_timeout_s o implementar " +
      "un heartbeat explícito desde la UI del cockpit."
    );
  }

  if (keys.has("zones_service_unavailable") || keys.has("camera_service_unavailable")) {
    recs.push(
      "Revisar el orden de inicio de los nodos en el launch file. " +
      "zones_manager y el nodo de cámara deben estar disponibles antes de que web_zone_server intente conectarse."
    );
  }

  recs.push(
    "Implementar una checklist de precondiciones pre-misión automatizada: " +
    "(1) GPS fix con RTK activo y estable, " +
    "(2) posición del robot dentro de los límites del costmap, " +
    "(3) path de prueba generado correctamente hacia el primer waypoint, " +
    "(4) todos los servicios ROS2 disponibles, " +
    "(5) costmap sin colisiones en la ruta planificada."
  );

  return recs;
}

// ─── PDF generation ──────────────────────────────────────────────────────────

type RGB = [number, number, number];

const C = {
  bg:        [13, 17, 23]    as RGB,
  error:     [220, 38, 38]   as RGB,
  warn:      [217, 119, 6]   as RGB,
  info:      [37, 99, 235]   as RGB,
  ok:        [22, 163, 74]   as RGB,
  text:      [17, 24, 39]    as RGB,
  muted:     [107, 114, 128] as RGB,
  cardBg:    [248, 250, 252] as RGB,
  border:    [226, 232, 240] as RGB,
  errorBg:   [254, 242, 242] as RGB,
  warnBg:    [255, 251, 235] as RGB,
  infoBg:    [239, 246, 255] as RGB,
  white:     [255, 255, 255] as RGB,
  evidenceBg:[243, 244, 246] as RGB,
};

function severityColor(sev: string): RGB {
  if (sev === "ERROR") return C.error;
  if (sev === "WARN") return C.warn;
  return C.info;
}

export function generateMissionReport(session: ReportableSession): Blob {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const W = 210;
  const H = 297;
  const ML = 14;
  const MR = 14;
  const contentW = W - ML - MR;
  const FOOTER_H = 14;
  const MAX_Y = H - FOOTER_H - 4;

  let y = 0;
  let pageN = 1;

  const addPage = (): void => {
    doc.addPage();
    pageN++;
    y = ML;
  };

  const ensure = (needed: number): void => {
    if (y + needed > MAX_Y) addPage();
  };

  const sf = (size: number, style: "normal" | "bold" | "italic" = "normal"): void => {
    doc.setFontSize(size);
    doc.setFont("helvetica", style);
  };

  const tc = (...rgb: RGB): void => { doc.setTextColor(rgb[0], rgb[1], rgb[2]); };
  const fc = (...rgb: RGB): void => { doc.setFillColor(rgb[0], rgb[1], rgb[2]); };
  const dc = (...rgb: RGB): void => { doc.setDrawColor(rgb[0], rgb[1], rgb[2]); };

  const txt = (content: string, x: number, ty: number, align: "left" | "center" | "right" = "left"): void => {
    doc.text(content, x, ty, { align });
  };

  const wrappedText = (content: string, x: number, ty: number, maxW: number): number => {
    const lines = doc.splitTextToSize(content, maxW) as string[];
    doc.text(lines, x, ty);
    return lines.length;
  };

  const divider = (dy: number, indent = 0): void => {
    dc(...C.border);
    doc.setLineWidth(0.2);
    doc.line(ML + indent, dy, W - MR - indent, dy);
  };

  // ── HEADER (page 1) ──────────────────────────────────────────────────────

  fc(...C.bg);
  doc.rect(0, 0, W, 32, "F");

  sf(16, "bold");
  tc(...C.white);
  txt("SALUS", ML, 12);

  sf(8);
  tc(180, 190, 200);
  txt("Sistema Autónomo de Logística Urbana Sustentable", ML, 18);

  sf(12, "bold");
  tc(...C.white);
  txt("Informe de Errores de Misión", ML, 27);

  // Generated at
  sf(7);
  tc(120, 130, 145);
  txt(`Generado: ${new Date().toLocaleString("es-AR")}`, W - MR, 27, "right");

  doc.setTextColor(0, 0, 0);
  y = 40;

  // ── SESSION INFO ─────────────────────────────────────────────────────────

  sf(8);
  tc(...C.muted);
  txt(`Sesión: ${session.id}`, ML, y);
  y += 4.5;
  txt(`Inicio: ${fmtDate(session.startedAt)}  ·  Fin: ${fmtDate(session.endedAt)}`, ML, y);
  if (session.filename) {
    y += 4;
    txt(`Archivo: ${session.filename}`, ML, y);
  }
  y += 7;

  // Status badge
  const statusColor: RGB =
    session.status === "completed" ? C.ok :
    session.status === "aborted"   ? C.error : C.warn;
  fc(...statusColor);
  doc.roundedRect(ML, y, 36, 7, 1.5, 1.5, "F");
  sf(7.5, "bold");
  tc(...C.white);
  txt(session.status.toUpperCase(), ML + 18, y + 4.7, "center");
  doc.setTextColor(0, 0, 0);
  y += 12;

  // ── SUMMARY CARDS ────────────────────────────────────────────────────────

  const cardW = (contentW - 6) / 4;
  const cards: Array<{ label: string; value: string; color: RGB }> = [
    { label: "Eventos",   value: String(session.commandCount), color: C.info },
    { label: "Duración",  value: formatDuration(session.durationSec), color: C.muted },
    { label: "Errores",   value: String(session.errorCount),   color: C.error },
    { label: "Warnings",  value: String(session.warningCount), color: C.warn },
  ];

  cards.forEach((card, i) => {
    const cx = ML + i * (cardW + 2);
    fc(...C.cardBg);
    dc(...C.border);
    doc.setLineWidth(0.3);
    doc.roundedRect(cx, y, cardW, 16, 2, 2, "FD");
    fc(...card.color);
    doc.rect(cx, y, 3, 16, "F");
    sf(7);
    tc(...C.muted);
    txt(card.label, cx + 5, y + 6);
    sf(12, "bold");
    tc(...card.color);
    txt(card.value, cx + 5, y + 13);
    doc.setTextColor(0, 0, 0);
  });

  y += 22;
  divider(y);
  y += 6;

  // ── CRITICAL TIMELINE TABLE ──────────────────────────────────────────────

  sf(11, "bold");
  tc(...C.text);
  txt("Línea Temporal Crítica", ML, y);
  y += 7;

  const criticalEvents = session.events.filter((e) => e.severity === "error" || e.severity === "warning");

  if (criticalEvents.length === 0) {
    sf(9, "italic");
    tc(...C.muted);
    txt("No se detectaron eventos críticos en esta sesión.", ML, y);
    y += 10;
  } else {
    const tableBody = criticalEvents.map((e) => [
      e.timestamp,
      e.severity.toUpperCase(),
      e.type,
      e.description.length > 90 ? `${e.description.slice(0, 87)}…` : e.description,
    ]);

    autoTable(doc, {
      startY: y,
      margin: { left: ML, right: MR },
      head: [["Tiempo", "Sev.", "Tipo", "Descripción"]],
      body: tableBody,
      styles:     { fontSize: 7.5, cellPadding: 2, overflow: "linebreak" },
      headStyles: { fillColor: C.bg, textColor: C.white, fontStyle: "bold", fontSize: 8 },
      columnStyles: { 0: { cellWidth: 16 }, 1: { cellWidth: 11 }, 2: { cellWidth: 18 }, 3: { cellWidth: "auto" } },
      didParseCell: (data) => {
        if (data.section !== "body") return;
        const ev = criticalEvents[data.row.index];
        if (!ev) return;
        if (ev.severity === "error") {
          data.cell.styles.fillColor = C.errorBg;
          if (data.column.index === 1) { data.cell.styles.textColor = C.error; data.cell.styles.fontStyle = "bold"; }
        } else if (ev.severity === "warning") {
          data.cell.styles.fillColor = C.warnBg;
          if (data.column.index === 1) { data.cell.styles.textColor = C.warn; data.cell.styles.fontStyle = "bold"; }
        }
      },
    });

    y = ((doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable?.finalY ?? y) + 8;
  }

  // ── ERROR GROUPS ─────────────────────────────────────────────────────────

  const errorGroups = buildErrorGroups(session);

  if (errorGroups.length > 0) {
    ensure(16);
    divider(y);
    y += 6;
    sf(11, "bold");
    tc(...C.text);
    txt("Errores Agrupados", ML, y);
    y += 8;

    errorGroups.forEach((group, i) => {
      const def = ERROR_GROUP_DEFS[group.key];
      const sc = severityColor(def.severityLabel);

      ensure(55);

      // Group header bar
      fc(...sc);
      doc.rect(ML, y, 3, 11, "F");
      fc(...C.cardBg);
      dc(...C.border);
      doc.setLineWidth(0.2);
      doc.rect(ML + 3, y, contentW - 3, 11, "FD");

      sf(9, "bold");
      tc(...C.text);
      txt(`${i + 1}. ${def.name}`, ML + 6, y + 4.5);
      sf(7);
      tc(...C.muted);
      txt(`[${def.criticality.toUpperCase()}]  ${def.topic}  ·  ${def.component}`, ML + 6, y + 9);
      doc.setTextColor(0, 0, 0);
      y += 14;

      // Meta row
      sf(7.5);
      tc(...C.muted);
      txt(
        `Frecuencia: ${group.count}   ·   Primera: ${group.firstAt}   ·   Última: ${group.lastAt}   ·   ${def.category}`,
        ML, y
      );
      y += 5.5;

      // Evidence box
      if (group.examples.length > 0) {
        const evidenceText = group.examples.map((e) => `• ${e}`).join("\n");
        const lines = doc.splitTextToSize(evidenceText, contentW - 6) as string[];
        const boxH = lines.length * 3.8 + 5;
        ensure(boxH + 2);
        fc(...C.evidenceBg);
        dc(...C.border);
        doc.setLineWidth(0.2);
        doc.roundedRect(ML, y, contentW, boxH, 1.5, 1.5, "FD");
        sf(7, "italic");
        tc(55, 65, 81);
        doc.text(lines, ML + 3, y + 4);
        doc.setTextColor(0, 0, 0);
        y += boxH + 4;
      }

      // Probable cause
      ensure(20);
      sf(8, "bold");
      tc(...C.text);
      txt("Causa probable:", ML, y);
      y += 4;
      sf(8);
      tc(55, 65, 81);
      const causeLines = doc.splitTextToSize(def.probableCause, contentW) as string[];
      ensure(causeLines.length * 3.8 + 2);
      doc.text(causeLines, ML, y);
      y += causeLines.length * 3.8 + 4;

      // Solutions
      ensure(12);
      sf(8, "bold");
      tc(...C.text);
      txt("Soluciones recomendadas:", ML, y);
      y += 4;
      def.solutions.forEach((sol, si) => {
        const solLines = doc.splitTextToSize(`${si + 1}. ${sol}`, contentW - 6) as string[];
        ensure(solLines.length * 3.8 + 2);
        sf(8);
        tc(55, 65, 81);
        doc.text(solLines, ML + 4, y);
        y += solLines.length * 3.8 + 1.5;
      });
      y += 3;

      // Validation tests
      ensure(12);
      sf(8, "bold");
      tc(...C.text);
      txt("Pruebas para validar:", ML, y);
      y += 4;
      def.checksToValidate.forEach((check) => {
        const checkLines = doc.splitTextToSize(`→ ${check}`, contentW - 6) as string[];
        ensure(checkLines.length * 3.8 + 2);
        sf(7.5, "italic");
        tc(...C.muted);
        doc.text(checkLines, ML + 4, y);
        y += checkLines.length * 3.8 + 1.5;
      });

      y += 7;
    });
  }

  // ── FINAL RECOMMENDATIONS ────────────────────────────────────────────────

  ensure(20);
  divider(y);
  y += 6;
  sf(11, "bold");
  tc(...C.text);
  txt("Recomendaciones Finales", ML, y);
  y += 8;

  buildRecommendations(errorGroups).forEach((rec, i) => {
    const lines = doc.splitTextToSize(rec, contentW - 8) as string[];
    ensure(lines.length * 4 + 4);

    fc(...C.infoBg);
    dc(...C.border);
    doc.setLineWidth(0.2);
    doc.roundedRect(ML, y - 1, contentW, lines.length * 4 + 4, 1.5, 1.5, "FD");
    fc(...C.info);
    doc.rect(ML, y - 1, 3, lines.length * 4 + 4, "F");

    sf(8, "bold");
    tc(...C.info);
    txt(`${i + 1}`, ML + 7, y + 2.5, "center");

    sf(8);
    tc(...C.text);
    const wrappedW = contentW - 14;
    const wrLines = doc.splitTextToSize(rec, wrappedW) as string[];
    doc.text(wrLines, ML + 12, y + 2.5);
    y += wrLines.length * 4 + 6;
  });

  // ── RAW OUTPUT ANNEX (verbatim JSONL from the robot) ─────────────────────

  const rawRecords = session.records ?? [];
  if (rawRecords.length > 0) {
    addPage();
    sf(11, "bold");
    tc(...C.text);
    txt("Anexo: Salida Cruda (JSONL)", ML, y + 4);
    y += 9;
    sf(7);
    tc(...C.muted);
    txt(`Registros tal cual fueron grabados por el robot · ${rawRecords.length} líneas · ${session.filename ?? session.id}`, ML, y);
    y += 6;

    doc.setFont("courier", "normal");
    doc.setFontSize(5.5);
    tc(55, 65, 81);
    const rawLineH = 2.6;
    for (const record of rawRecords) {
      const lines = doc.splitTextToSize(JSON.stringify(record), contentW) as string[];
      if (y + lines.length * rawLineH > MAX_Y) {
        addPage();
        doc.setFont("courier", "normal");
        doc.setFontSize(5.5);
        tc(55, 65, 81);
      }
      doc.text(lines, ML, y);
      y += lines.length * rawLineH + 0.8;
    }
    doc.setFont("helvetica", "normal");
    doc.setTextColor(0, 0, 0);
  }

  // ── FOOTERS on all pages ─────────────────────────────────────────────────

  const total = doc.getNumberOfPages();
  for (let p = 1; p <= total; p++) {
    doc.setPage(p);
    dc(...C.border);
    doc.setLineWidth(0.3);
    doc.line(ML, H - FOOTER_H + 2, W - MR, H - FOOTER_H + 2);
    sf(6.5);
    tc(...C.muted);
    txt(`SALUS Cockpit · Informe automático generado por el sistema`, ML, H - FOOTER_H + 6);
    txt(`${p} / ${total}`, W - MR, H - FOOTER_H + 6, "right");
  }

  return doc.output("blob");
}
