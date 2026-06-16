export type RobotStatus = 'ok' | 'warning' | 'stopped';

export type LatLng = { lat: number; lng: number; yawDeg?: number };

export type CameraDetection = {
  id: string;
  label: string;
  score: number;
  // Caja normalizada [0..1] respecto del frame.
  bbox: { x: number; y: number; w: number; h: number };
};

export interface RobotState {
  name: string;
  serial: string;

  // ---- Conexión real con el gateway ----
  backendConnected: boolean;
  backendConnecting: boolean;
  backendUrl: string;
  backendError: string;
  host: string;
  port: string;

  // ---- Estado derivado (semáforo) ----
  status: RobotStatus;
  statusLabel: string;

  // ---- Telemetría real ----
  battery: number | null;
  gpsFixed: boolean;
  gpsLabel: string;
  rtk: boolean;
  connection: 'excelente' | 'buena' | 'pobre' | 'sin_señal';
  speedKmh: number;
  steeringDeg: number;
  /** Velocidad de crucero objetivo para el manejo manual (m/s), ajustable con +/-. */
  targetSpeedMs: number;
  mode: 'autonomo' | 'manual';
  controlLocked: boolean;
  controlLockReason: string;
  goalActive: boolean;
  /** Resultado de la última acción enviada al backend (ACK), igual que el cockpit. */
  lastStatus: { text: string; level: 'info' | 'error'; ts: number } | null;

  // ---- Posición / mapa ----
  position: LatLng | null;
  headingDeg: number;
  /** Ruta calculada por el backend (mission/active chunk) para dibujar. */
  route: LatLng[];
  /** Waypoints que carga el operador (no es la ruta del backend). */
  waypoints: LatLng[];
  /** Selección local de waypoints, igual que el cockpit original. */
  selectedWaypointIndexes: number[];

  // ---- Misión ----
  mission: {
    name: string;
    active: boolean;
    paused: boolean;
    progress: number;
    remainingMeters: number;
    etaMinutes: number;
    currentWaypoint: number;
    totalWaypoints: number;
  } | null;

  // ---- Cámara ----
  cameraFrameUrl: string | null;
  cameraConnected: boolean;
  detections: CameraDetection[];
  detectionsActive: boolean;

  // ---- Alertas ----
  alerts: { id: string; level: 'info' | 'warning' | 'critical'; text: string }[];
}
