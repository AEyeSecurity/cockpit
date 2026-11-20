import { CameraRoverMap } from "./CameraRoverMap";
import { CameraQualityButton } from "./CameraQualityButton";
import { useCameraStreamConfig } from "../../../shared/cameraStreamQuality";
import { ShellCommands } from "../../../../../app/shellCommands";
import { useEffect, useRef, useState } from "react";
import "./styles.css";
import { SecondaryCameraTile } from "./SecondaryCameraTile";
import { CameraAuxControls } from "./CameraAuxControls";
import type { CockpitModule, ModuleContext } from "../../../../../core/types/module";
import { CameraDispatcher } from "../dispatcher/impl/CameraDispatcher";
import {
  CameraVisionService,
  type CameraVisionState,
  type Detection
} from "../service/impl/CameraVisionService";
import { ConnectionService, type ConnectionState } from "../../navigation/service/impl/ConnectionService";
import {
  NavigationService,
  type CameraPtzStateData,
  type NavigationState
} from "../../navigation/service/impl/NavigationService";
import { CameraStreamSurface, type CameraStreamStatus } from "../../../shared/CameraStreamSurface";
import { isCameraFeedConfigured, orientCameraPtzDelta } from "../../../shared/cameraStreamConfig";

const TRANSPORT_ID = "transport.ws.core";
const DISPATCHER_ID = "dispatcher.camera";
const SERVICE_ID = "service.camera-vision";
const NAVIGATION_SERVICE_ID = "service.navigation";
const CONNECTION_SERVICE_ID = "service.connection";

function PtzDirectionIcon({ rotation }: { rotation: number }): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ transform: `rotate(${rotation}deg)` }}
    >
      <path d="M12 5v14" />
      <path d="M7.5 10.5 12 5l4.5 5.5" />
    </svg>
  );
}

const PTZ_DIRECTIONS = [
  { rotation: -45, label: "Arriba e izquierda", pan: 1, tilt: 1 },
  { rotation: 0, label: "Arriba", pan: 0, tilt: 1 },
  { rotation: 45, label: "Arriba y derecha", pan: -1, tilt: 1 },
  { rotation: -90, label: "Izquierda", pan: 1, tilt: 0 },
  null,
  { rotation: 90, label: "Derecha", pan: -1, tilt: 0 },
  { rotation: -135, label: "Abajo e izquierda", pan: 1, tilt: -1 },
  { rotation: 180, label: "Abajo", pan: 0, tilt: -1 },
  { rotation: 135, label: "Abajo y derecha", pan: -1, tilt: -1 }
] as const;

const VISION_DATA_URL = "http://localhost:8088/data";
const VISION_DATA_POLL_INTERVAL_MS = 100;
const MIN_DETECTION_CONFIDENCE = 0.35;
const OVERLAY_MIN_CONFIDENCE = 0.50;
const ALERT_HOLD_MS = 500;
const PTZ_PAN_STEP_DEG = 15;
const PTZ_TILT_STEP_DEG = 10;
const PTZ_ZOOM_STEP = 0.5;
const PTZ_STATE_POLL_INTERVAL_MS = 2000;
const PTZ_SAVE_CONFIRM_WINDOW_MS = 4000;

type DetectionZone = "left" | "center" | "right";
type RiskLevel = "normal" | "low" | "medium" | "high";

interface AlertDetection extends Detection {
  zone: DetectionZone;
}

interface CameraAlertState {
  risk: RiskLevel;
  detections: AlertDetection[];
  mainDetection: AlertDetection | null;
  lastJsonMs: number;
  lastDetectionMs: number;
}

const NORMAL_ALERT_STATE: CameraAlertState = {
  risk: "normal",
  detections: [],
  mainDetection: null,
  lastJsonMs: 0,
  lastDetectionMs: 0
};

const RELEVANT_CENTER_LABELS = new Set([
  "person",
  "persona",
  "car",
  "auto",
  "vehicle",
  "vehiculo",
  "truck",
  "bus",
  "motorcycle",
  "bicycle",
  "obstacle",
  "obstaculo"
]);

function parseVisionDataDetections(payload: unknown): Detection[] {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;
  const camera = root.camera && typeof root.camera === "object" ? root.camera as Record<string, unknown> : {};
  const ai = root.ai && typeof root.ai === "object" ? root.ai as Record<string, unknown> : {};
  const width = Number(camera.width ?? 0);
  const height = Number(camera.height ?? 0);
  const detections = Array.isArray(ai.detections) ? ai.detections : [];
  if (width <= 0 || height <= 0) return [];

  return detections
    .map((raw): Detection | null => {
      if (!raw || typeof raw !== "object") return null;
      const det = raw as Record<string, unknown>;
      const bbox = det.bbox && typeof det.bbox === "object" ? det.bbox as Record<string, unknown> : null;
      if (!bbox) return null;
      const cx = Number(bbox.cx);
      const cy = Number(bbox.cy);
      const boxW = Number(bbox.width);
      const boxH = Number(bbox.height);
      if (![cx, cy, boxW, boxH].every(Number.isFinite) || boxW <= 0 || boxH <= 0) return null;
      const confidence = Math.max(0, Math.min(1, Number(det.score ?? 0)));
      if (confidence < MIN_DETECTION_CONFIDENCE) return null;
      return {
        class: String(det.label || "objeto"),
        confidence,
        bbox: {
          x: Math.max(0, Math.min(1, (cx - boxW / 2) / width)),
          y: Math.max(0, Math.min(1, (cy - boxH / 2) / height)),
          w: Math.max(0, Math.min(1, boxW / width)),
          h: Math.max(0, Math.min(1, boxH / height))
        }
      };
    })
    .filter((det): det is Detection => det !== null);
}

function classifyZone(det: Detection): DetectionZone {
  const centerX = det.bbox.x + det.bbox.w / 2;
  if (centerX < 0.33) return "left";
  if (centerX > 0.66) return "right";
  return "center";
}

function formatPresetLabel(preset: string): string {
  const normalized = preset.trim().toLowerCase();
  if (!normalized) return "Manual";
  if (normalized === "home") return "Home";
  if (normalized === "front") return "Front";
  if (normalized === "left") return "Left";
  if (normalized === "right") return "Right";
  if (normalized === "rear") return "Rear";
  return preset;
}

function detectionDisplayLabel(label: string): string {
  const normalized = label.trim().toLowerCase();
  if (normalized === "person" || normalized === "persona" || normalized === "pedestrian") return "Persona";
  if (normalized === "cone" || normalized === "cono" || normalized === "traffic cone") return "Cono";
  if (normalized === "car" || normalized === "auto" || normalized === "vehicle" || normalized === "vehiculo") return "Auto";
  if (normalized === "truck" || normalized === "camion") return "Camion";
  if (normalized === "bus") return "Bus";
  if (normalized === "bicycle" || normalized === "bicicleta") return "Bicicleta";
  if (normalized === "motorcycle" || normalized === "moto") return "Moto";
  if (normalized === "obstacle" || normalized === "obstaculo") return "Obstaculo";
  if (!label.trim()) return "Objeto";
  return label.trim().charAt(0).toUpperCase() + label.trim().slice(1);
}

function riskRank(risk: RiskLevel): number {
  if (risk === "high") return 3;
  if (risk === "medium") return 2;
  if (risk === "low") return 1;
  return 0;
}

function riskForDetection(det: AlertDetection): RiskLevel {
  const label = det.class.trim().toLowerCase();
  if (det.zone === "center" && RELEVANT_CENTER_LABELS.has(label)) return "high";
  if (det.zone === "center") return "medium";
  return "low";
}

function buildAlertState(detections: Detection[], lastJsonMs: number): CameraAlertState {
  const alertDetections = detections
    .map((det): AlertDetection => ({ ...det, zone: classifyZone(det) }))
    .sort((a, b) => {
      const riskDiff = riskRank(riskForDetection(b)) - riskRank(riskForDetection(a));
      return riskDiff !== 0 ? riskDiff : b.confidence - a.confidence;
    });

  if (alertDetections.length === 0) {
    return { ...NORMAL_ALERT_STATE, lastJsonMs };
  }

  const mainDetection = alertDetections[0];
  return {
    risk: riskForDetection(mainDetection),
    detections: alertDetections,
    mainDetection,
    lastJsonMs,
    lastDetectionMs: lastJsonMs
  };
}

function CameraSidebar({ runtime, onSweepStart }: { runtime: ModuleContext; onSweepStart: () => void }): JSX.Element {
  let navigationService: NavigationService | null = null;
  let connectionService: ConnectionService | null = null;
  try {
    navigationService = runtime.services.getService<NavigationService>(NAVIGATION_SERVICE_ID);
  } catch {
    navigationService = null;
  }
  try {
    connectionService = runtime.services.getService<ConnectionService>(CONNECTION_SERVICE_ID);
  } catch {
    connectionService = null;
  }
  const { config: cameraConfig } = useCameraStreamConfig(runtime);
  const [navigationState, setNavigationState] = useState<NavigationState | null>(navigationService?.getState() ?? null);
  const [connectionState, setConnectionState] = useState<ConnectionState | null>(connectionService?.getState() ?? null);
  const [ptzState, setPtzState] = useState<CameraPtzStateData | null>(null);
  const [ptzError, setPtzError] = useState<string>("");
  const [ptzBusy, setPtzBusy] = useState<boolean>(false);
  const [armedSavePreset, setArmedSavePreset] = useState<string | null>(null);
  const presetSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!navigationService) return;
    return navigationService.subscribe((next) => setNavigationState(next));
  }, [navigationService]);
  useEffect(() => {
    if (!connectionService) return;
    return connectionService.subscribe((next) => setConnectionState(next));
  }, [connectionService]);

  const navBackendConnected = connectionState?.connected === true;
  const ptzDisabled = !navigationService || !navBackendConnected;
  const ptzCommandDisabled = ptzDisabled || ptzBusy;
  const clearPresetSaveArm = (): void => {
    if (presetSaveTimerRef.current) {
      clearTimeout(presetSaveTimerRef.current);
      presetSaveTimerRef.current = null;
    }
    setArmedSavePreset(null);
  };

  const armPresetSave = (preset: string): void => {
    if (presetSaveTimerRef.current) {
      clearTimeout(presetSaveTimerRef.current);
    }
    setArmedSavePreset(preset);
    presetSaveTimerRef.current = setTimeout(() => {
      presetSaveTimerRef.current = null;
      setArmedSavePreset((current) => (current === preset ? null : current));
    }, PTZ_SAVE_CONFIRM_WINDOW_MS);
  };

  useEffect(() => {
    if (cameraConfig.ptzEnabled === false || !navigationService || !navBackendConnected) {
      setPtzState(null);
      clearPresetSaveArm();
      if (!navBackendConnected) {
        setPtzError("Conectá el rover para orientar la cámara.");
      } else {
        setPtzError("");
      }
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const refresh = async (): Promise<void> => {
      try {
        const next = await navigationService.readCameraPtzState();
        if (cancelled) return;
        setPtzState(next);
        setPtzError(next.ok ? "" : next.error || "PTZ unavailable");
      } catch (error) {
        if (!cancelled) setPtzError(String(error));
      } finally {
        if (!cancelled) {
          timer = setTimeout(() => void refresh(), PTZ_STATE_POLL_INTERVAL_MS);
        }
      }
    };

    void refresh();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [cameraConfig.ptzEnabled, connectionState?.host, connectionState?.port, navBackendConnected, navigationService]);

  useEffect(
    () => () => {
      if (presetSaveTimerRef.current) {
        clearTimeout(presetSaveTimerRef.current);
      }
    },
    []
  );

  const runPtzAction = async (
    action: () => Promise<CameraPtzStateData>,
    successText?: string
  ): Promise<void> => {
    if (!navigationService) return;
    if (!navBackendConnected) {
      const text = "Conectá el rover para orientar la cámara.";
      setPtzError(text);
      runtime.eventBus.emit("console.event", {
        level: "warn",
        text,
        timestamp: Date.now()
      });
      return;
    }
    setPtzBusy(true);
    try {
      const next = await action();
      setPtzState(next);
      setPtzError(next.ok ? "" : next.error || "");
      if (successText) {
        runtime.eventBus.emit("console.event", {
          level: "info",
          text: successText,
          timestamp: Date.now()
        });
      }
    } catch (error) {
      setPtzError(String(error));
      runtime.eventBus.emit("console.event", {
        level: "error",
        text: `Camera PTZ failed: ${String(error)}`,
        timestamp: Date.now()
      });
    } finally {
      setPtzBusy(false);
    }
  };

  const movePtz = async (input: {
    relative: boolean;
    panDeg?: number;
    tiltDeg?: number;
    zoomLevel?: number;
  }): Promise<void> => {
    const orientedInput = orientCameraPtzDelta(input, cameraConfig.ptzRotationDeg, cameraConfig.ptzPanInverted);
    await runPtzAction(() => navigationService!.moveCameraPtz(orientedInput));
  };

  const goPreset = async (preset: string): Promise<void> => {
    await runPtzAction(
      () => navigationService!.goCameraPreset(preset),
      `Camera preset ${formatPresetLabel(preset)}`
    );
  };

  const savePreset = async (preset: string, saveZoom: boolean): Promise<void> => {
    clearPresetSaveArm();
    await runPtzAction(
      () => navigationService!.saveCameraPreset(preset, saveZoom),
      `Camera preset ${formatPresetLabel(preset)} saved`
    );
  };

  const handlePresetSaveClick = (preset: string, saveZoom: boolean): void => {
    if (armedSavePreset === preset) {
      void savePreset(preset, saveZoom);
      return;
    }
    armPresetSave(preset);
  };

  const toggleZoom = async (): Promise<void> => {
    if (!navigationService) return;
    if (!navBackendConnected) {
      const text = "Conectá el rover para orientar la cámara.";
      setPtzError(text);
      runtime.eventBus.emit("console.event", {
        level: "warn",
        text,
        timestamp: Date.now()
      });
      return;
    }
    setPtzBusy(true);
    try {
      await navigationService.toggleCameraZoom();
      const next = await navigationService.readCameraPtzState();
      setPtzState(next);
      setPtzError(next.ok ? "" : next.error || "");
    } catch (error) {
      setPtzError(String(error));
      runtime.eventBus.emit("console.event", {
        level: "error",
        text: `Camera zoom failed: ${String(error)}`,
        timestamp: Date.now()
      });
    } finally {
      setPtzBusy(false);
    }
  };

  return <div className="cv-camera-sidebar">
    <button type="button" className="button-primary" onClick={() => void runtime.commands.execute(ShellCommands.openWorkspace, "workspace.camera")}>Ver cámaras</button>
    <details className="cv-camera-action-section" open>
      <summary>Calidad de video</summary>
      <div className="cv-camera-action-body"><CameraQualityButton runtime={runtime} /></div>
    </details>
    {cameraConfig.ptzEnabled !== false && <details className="cv-camera-action-section" open>
      <summary>PTZ · Cámara móvil</summary>
      <div className="cv-camera-action-body">
        {ptzError ? (
          <div className="cv-ptz-inline-note" role="status">
            {ptzError}
          </div>
        ) : null}
        <div className="cv-camera-direction-grid" role="group" aria-label="Orientación de la cámara">
          {PTZ_DIRECTIONS.map((direction) => direction ? (
            <button key={direction.rotation} type="button" className="cv-camera-action-button"
              aria-label={direction.label} title={direction.label} disabled={ptzCommandDisabled}
              onClick={() => void movePtz({
                relative: true,
                panDeg: direction.pan ? direction.pan * PTZ_PAN_STEP_DEG : undefined,
                tiltDeg: direction.tilt ? direction.tilt * PTZ_TILT_STEP_DEG : undefined
              })}>
              <span aria-hidden="true"><PtzDirectionIcon rotation={direction.rotation} /></span>
            </button>
          ) : (
            <button key="home" type="button" className="cv-camera-action-button"
              title="Volver a la posición inicial" disabled={ptzCommandDisabled}
              onClick={() => void goPreset("home")}>Inicio</button>
          ))}
        </div>
        {cameraConfig.ptzZoomEnabled !== false && <>
        <div className="cv-camera-zoom-row">
          <button
            type="button"
            className="cv-camera-action-button"
            disabled={ptzCommandDisabled}
            onClick={() => void movePtz({ relative: true, zoomLevel: -PTZ_ZOOM_STEP })}
          >
            Zoom -
          </button>
          <button
            type="button"
            className="cv-camera-action-button"
            disabled={ptzCommandDisabled}
            onClick={() => void toggleZoom()}
          >
            Alternar zoom
          </button>
          <button
            type="button"
            className="cv-camera-action-button"
            disabled={ptzCommandDisabled}
            onClick={() => void movePtz({ relative: true, zoomLevel: PTZ_ZOOM_STEP })}
          >
            Zoom +
          </button>
        </div>
        </>}
        <div className="cv-camera-preset-row">
          {["front", "right", "rear", "left"].map((preset) => (
            <button
              key={preset}
              type="button"
              className={`cv-camera-action-button${ptzState?.activePreset === preset ? " is-active" : ""}`}
              disabled={ptzCommandDisabled}
              onClick={() => void goPreset(preset)}
            >
              {cameraConfig.ptzZoomEnabled === false ? ({ front: "Frente", right: "Derecha", rear: "Atrás", left: "Izquierda" } as Record<string, string>)[preset] : formatPresetLabel(preset)}
            </button>
          ))}
        </div>
        <details className="cv-camera-preset-settings"><summary>Guardar posiciones</summary>
        <div className="cv-camera-preset-row">
          {[
            ...(cameraConfig.ptzZoomEnabled !== false ? [{ preset: "home", saveZoom: true }] : []),
            { preset: "front", saveZoom: false },
            { preset: "rear", saveZoom: false },
            { preset: "left", saveZoom: false },
            { preset: "right", saveZoom: false }
          ].map(({ preset, saveZoom }) => {
            const armed = armedSavePreset === preset;
            return (
              <button
                key={preset}
                type="button"
                className={`cv-camera-action-button${armed ? " is-armed" : ""}`}
                disabled={ptzCommandDisabled}
                onClick={() => handlePresetSaveClick(preset, saveZoom)}
                title={
                  armed
                    ? `Confirm save ${formatPresetLabel(preset)}`
                    : `Save current camera as ${formatPresetLabel(preset)}`
                }
              >
                {cameraConfig.ptzZoomEnabled === false
                  ? `${armed ? "Confirmar" : "Guardar"} ${({ front: "Frente", right: "Derecha", rear: "Atrás", left: "Izquierda" } as Record<string, string>)[preset]}`
                  : armed ? `Confirm ${formatPresetLabel(preset)}` : `Set ${formatPresetLabel(preset)}`}
              </button>
            );
          })}
        </div>
        </details>
      </div>
    </details>}
    {cameraConfig.ptzEnabled !== false && <CameraAuxControls service={navigationService} connected={navBackendConnected}
      controlLocked={navigationState?.controlLocked !== false}
      onSweepStart={onSweepStart} />}
  </div>;
}

function CameraVisionWorkspaceView({ runtime, sweepEvents }: { runtime: ModuleContext; sweepEvents: EventTarget }): JSX.Element {
  const service = runtime.services.getService<CameraVisionService>(SERVICE_ID);
  let connectionService: ConnectionService | null;
  try {
    connectionService = runtime.services.getService<ConnectionService>(CONNECTION_SERVICE_ID);
  } catch {
    connectionService = null;
  }
  const [state, setState] = useState<CameraVisionState>(service.getState());
  const { config: cameraConfig } = useCameraStreamConfig(runtime);
  const [mobileStartRequest, setMobileStartRequest] = useState(0);
  const [videoRequested, setVideoRequested] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState | null>(connectionService?.getState() ?? null);
  const [streamStatus, setStreamStatus] = useState<CameraStreamStatus>({
    connected: false,
    connecting: false,
    error: "",
    lastFrameMs: 0,
    transport: cameraConfig.transport
  });
  const lastCameraStampRef = useRef<number>(0);
  const fpsWindowRef = useRef<{ startedMs: number; frames: number }>({ startedMs: Date.now(), frames: 0 });
  const [cameraFps, setCameraFps] = useState<number>(0);
  const [visionDetections, setVisionDetections] = useState<Detection[]>([]);
  const [alertState, setAlertState] = useState<CameraAlertState>(NORMAL_ALERT_STATE);

  useEffect(() => service.subscribe((next) => setState(next)), [service]);
  useEffect(() => connectionService?.subscribe(setConnectionState), [connectionService]);
  useEffect(() => {
    const start = () => setMobileStartRequest((value) => value + 1);
    sweepEvents.addEventListener("start", start);
    return () => sweepEvents.removeEventListener("start", start);
  }, [sweepEvents]);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function pollVisionData(): Promise<void> {
      try {
        const response = await fetch(`${runtime.env.managed ? "/operation/vision" : VISION_DATA_URL}?_=${Date.now()}`, { cache: "no-store" });
        if (!response.ok) throw new Error(`vision data ${response.status}`);
        const payload = await response.json() as unknown;
        if (cancelled) return;
        const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
        const camera = root.camera && typeof root.camera === "object" ? root.camera as Record<string, unknown> : {};
        const cameraStamp = Number(camera.stamp ?? 0);
        const cameraAgeSec = Number(camera.age_sec ?? Number.NaN);
        const now = Date.now();
        if (Number.isFinite(cameraStamp) && cameraStamp > 0 && cameraStamp !== lastCameraStampRef.current) {
          lastCameraStampRef.current = cameraStamp;
          const windowState = fpsWindowRef.current;
          windowState.frames += 1;
          const elapsed = now - windowState.startedMs;
          if (elapsed >= 1000) {
            setCameraFps(Math.round((windowState.frames * 1000) / elapsed));
            fpsWindowRef.current = { startedMs: now, frames: 0 };
          }
        }
        const detections = parseVisionDataDetections(payload);
        setVisionDetections(detections);
        setAlertState((previous) => {
          const next = buildAlertState(detections, now);
          if (next.detections.length > 0) return next;
          if (previous.risk !== "normal" && now - previous.lastDetectionMs <= ALERT_HOLD_MS) {
            return { ...previous, lastJsonMs: now };
          }
          return next;
        });
      } catch {
        if (!cancelled) setVisionDetections([]);
      } finally {
        if (!cancelled) {
          timer = setTimeout(() => void pollVisionData(), VISION_DATA_POLL_INTERVAL_MS);
        }
      }
    }

    void pollVisionData();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const serviceAlertState = state.detectionsActive && state.currentDetections.length > 0
    ? buildAlertState(state.currentDetections, state.lastDetectionMs || Date.now())
    : NORMAL_ALERT_STATE;
  const liveAlertState = alertState.detections.length > 0 || alertState.risk !== "normal"
    ? alertState
    : serviceAlertState;
  // Video transport and PTZ control are independent capabilities. Simulation
  // deliberately has no stream, but exposes the same PTZ contract as hardware.
  const videoEnabled = connectionState?.preset !== "sim" && isCameraFeedConfigured(cameraConfig);
  const feedOnline = state.connected || streamStatus.connected;
  const fpsLabel = cameraFps > 0 ? `${cameraFps} FPS` : streamStatus.transport === "webrtc" ? "WEBRTC" : "LIVE";
  const showVideo = videoEnabled && videoRequested;

  return (
    <div className="cv-root cv-html-root">
      <div className="cv-body cv-html-body">
        <section className="cv-main cv-html-main cv-camera-grid">
          <div className="cv-camera-primary">
            <header className="cv-grid-heading"><strong>Panorámica</strong><span>Principal · fija</span></header>
            <div className="cv-viewport-shell cv-html-stage">
              <div className={`cv-viewport cv-html-viewport cv-alert-${alertState.risk}${!feedOnline ? " cv-viewport--no-signal" : ""}`}>
                {showVideo ? (
                  <CameraStreamSurface
                    isActive={showVideo}
                    config={cameraConfig}
                    className="cv-frame"
                    alt="Camera stream"
                    onStatusChange={setStreamStatus}
                  />
                ) : null}
                {!feedOnline ? (
                  <div className="cv-no-signal">
                    <div className="cv-no-signal-shell">
                      <div className="cv-no-signal-text">
                        {!videoEnabled
                          ? "Camera unavailable"
                          : !videoRequested
                            ? "Video pausado"
                            : videoEnabled
                          ? streamStatus.connecting
                            ? "Connecting camera stream"
                            : streamStatus.error
                              ? `Camera ${streamStatus.error}`
                              : "Awaiting camera stream"
                          : "Camera unavailable"}
                      </div>
                      {videoEnabled ? (
                        <button
                          type="button"
                          className="cv-camera-request-btn"
                          onClick={() => setVideoRequested((current) => !current)}
                        >
                          {videoRequested ? "Detener" : "Ver video"}
                        </button>
                      ) : null}
                    </div>
                  </div>
                ) : null}
                {feedOnline && liveAlertState.detections.some(d => d.confidence >= OVERLAY_MIN_CONFIDENCE) ? (
                  <div className="cv-overlay" aria-hidden="true">
                    {liveAlertState.detections.filter(d => d.confidence >= OVERLAY_MIN_CONFIDENCE).map((det, index) => {
                      const left = `${Math.max(0, Math.min(1, det.bbox.x)) * 100}%`;
                      const top = `${Math.max(0, Math.min(1, det.bbox.y)) * 100}%`;
                      const width = `${Math.max(0, Math.min(1, det.bbox.w)) * 100}%`;
                      const height = `${Math.max(0, Math.min(1, det.bbox.h)) * 100}%`;
                      const label = `${detectionDisplayLabel(det.class)} ${(det.confidence * 100).toFixed(0)}%`;
                      return (
                        <div
                          className="cv-detection-box"
                          key={`${det.class}-${det.confidence}-${index}`}
                          style={{ left, top, width, height }}
                        >
                          <span className="cv-detection-label">{label}</span>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
                {feedOnline ? <div className="cv-html-rec">● {fpsLabel}</div> : null}
              </div>
            </div>
          </div>
          <div className="cv-secondary-grid">
            <SecondaryCameraTile startRequest={mobileStartRequest} title="Móvil" description="Secundaria · movimiento" config={cameraConfig} url={cameraConfig.mobileWebrtcUrl ?? ""} />
            <SecondaryCameraTile title="Reversa" description="Secundaria · vista trasera" config={cameraConfig} url={cameraConfig.reverseWebrtcUrl ?? ""} />
            <CameraRoverMap runtime={runtime} connected={connectionState?.connected === true} />
          </div>
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Module registration
// ---------------------------------------------------------------------------

export function createCameraModule(): CockpitModule {
  return {
    id: "camera",
    version: "1.0.0",
    enabledByDefault: true,
    register(ctx: ModuleContext): void {
      // Share the existing WebSocket transport (transport.ws.core).
      // DispatchRouter fans out all incoming messages to every dispatcher
      // registered on the same transport, so no transport change is needed.
      const dispatcher = new CameraDispatcher(DISPATCHER_ID, TRANSPORT_ID);
      ctx.dispatchers.registerDispatcher({
        id: dispatcher.id,
        dispatcher
      });

      const service = new CameraVisionService(dispatcher);
      const sweepEvents = new EventTarget();
      ctx.services.registerService({
        id: SERVICE_ID,
        service
      });

      ctx.contributions.register({
        id: "sidebar.camera",
        slot: "sidebar",
        label: "Cámara",
        render: () => <CameraSidebar runtime={ctx} onSweepStart={() => sweepEvents.dispatchEvent(new Event("start"))} />
      });

      ctx.contributions.register({
        id: "workspace.camera",
        slot: "workspace",
        label: "Camera",
        render: () => <CameraVisionWorkspaceView runtime={ctx} sweepEvents={sweepEvents} />
      });
    }
  };
}
