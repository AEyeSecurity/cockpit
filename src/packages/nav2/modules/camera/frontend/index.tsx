import { useEffect, useRef, useState } from "react";
import "./styles.css";
import type { CockpitModule, ModuleContext } from "../../../../../core/types/module";
import { CameraDispatcher } from "../dispatcher/impl/CameraDispatcher";
import {
  CameraVisionService,
  type BBox,
  type CameraVisionState,
  type Detection
} from "../service/impl/CameraVisionService";
import { ConnectionService, type ConnectionState } from "../../navigation/service/impl/ConnectionService";
import { NavigationService, type NavigationState } from "../../navigation/service/impl/NavigationService";

const TRANSPORT_ID = "transport.ws.core";
const DISPATCHER_ID = "dispatcher.camera";
const SERVICE_ID = "service.camera-vision";
const NAVIGATION_SERVICE_ID = "service.navigation";
const CONNECTION_SERVICE_ID = "service.connection";

// ---------------------------------------------------------------------------
// Canvas overlay drawing
// ---------------------------------------------------------------------------

const BBOX_COLOR = "#8be3ff";
const LABEL_BG = "rgba(7, 17, 26, 0.92)";
const LABEL_TEXT = "#e8fbff";
const BBOX_LINE_WIDTH = 2;
const FONT = "bold 11px monospace";
const LABEL_PAD_X = 5;
const LABEL_PAD_Y = 3;
const LABEL_HEIGHT = 17;

/**
 * Draw a single detection bounding box + label on the canvas context.
 * drawX/drawY/drawW/drawH describe the image's actual rendered region within
 * the canvas (after accounting for letterboxing from object-fit: contain).
 */
function drawDetection(
  ctx: CanvasRenderingContext2D,
  det: Detection,
  drawX: number,
  drawY: number,
  drawW: number,
  drawH: number
): void {
  const bbox: BBox = det.bbox;
  const px = drawX + bbox.x * drawW;
  const py = drawY + bbox.y * drawH;
  const pw = bbox.w * drawW;
  const ph = bbox.h * drawH;

  // Bounding box
  ctx.strokeStyle = BBOX_COLOR;
  ctx.lineWidth = BBOX_LINE_WIDTH;
  ctx.strokeRect(px, py, pw, ph);

  // Label
  const label = `${det.class}  ${(det.confidence * 100).toFixed(0)}%`;
  ctx.font = FONT;
  const metrics = ctx.measureText(label);
  const labelW = metrics.width + LABEL_PAD_X * 2;
  const lx = px;
  const ly = py - LABEL_HEIGHT;

  ctx.fillStyle = LABEL_BG;
  ctx.fillRect(lx, ly < 0 ? py : ly, labelW, LABEL_HEIGHT - LABEL_PAD_Y);

  ctx.fillStyle = LABEL_TEXT;
  ctx.fillText(label, lx + LABEL_PAD_X, ly < 0 ? py + LABEL_HEIGHT - LABEL_PAD_Y - 3 : ly + LABEL_HEIGHT - LABEL_PAD_Y - 2);
}

/**
 * Render all detection overlays onto the canvas.
 * Computes the actual image draw region accounting for object-fit: contain.
 */
function renderOverlay(
  canvas: HTMLCanvasElement,
  detections: Detection[],
  imgNaturalW: number,
  imgNaturalH: number
): void {
  const containerW = canvas.clientWidth;
  const containerH = canvas.clientHeight;

  canvas.width = containerW;
  canvas.height = containerH;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.clearRect(0, 0, containerW, containerH);
  if (detections.length === 0) return;

  // Compute the rendered image region (letterboxed inside the container)
  const natW = imgNaturalW > 0 ? imgNaturalW : 640;
  const natH = imgNaturalH > 0 ? imgNaturalH : 480;
  const containerAspect = containerW / containerH;
  const imageAspect = natW / natH;

  let drawW: number, drawH: number, drawX: number, drawY: number;
  if (containerAspect > imageAspect) {
    // Letterbox on left + right
    drawH = containerH;
    drawW = drawH * imageAspect;
    drawX = (containerW - drawW) / 2;
    drawY = 0;
  } else {
    // Letterbox on top + bottom
    drawW = containerW;
    drawH = drawW / imageAspect;
    drawX = 0;
    drawY = (containerH - drawH) / 2;
  }

  for (const det of detections) {
    drawDetection(ctx, det, drawX, drawY, drawW, drawH);
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function formatPercent(value: number): string {
  return `${Math.round(clamp01(value) * 100)}%`;
}

function getDetectionCenter(det: Detection): { x: number; y: number } | null {
  const centerX = det.bbox.x + det.bbox.w / 2;
  const centerY = det.bbox.y + det.bbox.h / 2;
  if (!Number.isFinite(centerX) || !Number.isFinite(centerY)) return null;
  return { x: centerX, y: centerY };
}

function formatTimestamp(timestampMs: number): string {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return "Waiting";
  return new Date(timestampMs).toLocaleTimeString();
}

// ---------------------------------------------------------------------------
// Detection list item
// ---------------------------------------------------------------------------

function DetectionListItem({ det, index }: { det: Detection; index: number }): JSX.Element {
  const pct = (det.confidence * 100).toFixed(0);
  const barWidth = `${Math.round(det.confidence * 100)}%`;
  const confClass =
    det.confidence >= 0.8 ? "cv-conf-high" :
    det.confidence >= 0.5 ? "cv-conf-mid" :
    "cv-conf-low";
  const center = getDetectionCenter(det);

  return (
    <li className="cv-det-item">
      <div className="cv-det-row">
        <span className="cv-det-index">{index + 1}</span>
        <span className="cv-det-label">{det.class}</span>
        <span className={`cv-det-conf ${confClass}`}>{pct}%</span>
      </div>
      <div className="cv-det-meta">
        {center ? <span className="cv-det-chip">X {formatPercent(center.x)}</span> : null}
        {center ? <span className="cv-det-chip">Y {formatPercent(center.y)}</span> : null}
        <span className="cv-det-chip">W {formatPercent(det.bbox.w)}</span>
        <span className="cv-det-chip">H {formatPercent(det.bbox.h)}</span>
      </div>
      <div className="cv-conf-bar-track">
        <div className={`cv-conf-bar ${confClass}`} style={{ width: barWidth }} />
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

function StatusBadge({ active, label }: { active: boolean; label: string }): JSX.Element {
  return (
    <span className={`cv-status-badge ${active ? "cv-status-ok" : "cv-status-off"}`}>
      <span className="cv-status-dot" aria-hidden="true" />
      {label}
    </span>
  );
}

function StatusCard({
  label,
  value,
  detail,
  tone = "neutral"
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: "neutral" | "ok" | "warn" | "off";
}): JSX.Element {
  return (
    <div className={`cv-status-card cv-status-card-${tone}`}>
      <span className="cv-status-card-label">{label}</span>
      <strong className="cv-status-card-value">{value}</strong>
      {detail ? <span className="cv-status-card-detail">{detail}</span> : null}
    </div>
  );
}

function PtzButton({
  icon,
  label,
  title,
  className,
  onClick
}: {
  icon: string;
  label: string;
  title: string;
  className?: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`cv-ptz-btn${className ? ` ${className}` : ""}`}
      onClick={onClick}
      title={title}
      aria-label={title}
    >
      <span className="cv-ptz-btn-shell">
        <span className="cv-ptz-btn-arrow" aria-hidden="true">
          {icon}
        </span>
        <span className="cv-ptz-btn-caption">{label}</span>
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main workspace view
// ---------------------------------------------------------------------------

const SNAP_URL = "http://localhost:8089/snap.jpg";

function CameraVisionWorkspaceView({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const service = runtime.services.getService<CameraVisionService>(SERVICE_ID);
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
  const [state, setState] = useState<CameraVisionState>(service.getState());
  const [navigationState, setNavigationState] = useState<NavigationState | null>(navigationService?.getState() ?? null);
  const [connectionState, setConnectionState] = useState<ConnectionState | null>(connectionService?.getState() ?? null);
  const [snapSrc, setSnapSrc] = useState<string>("");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => service.subscribe((next) => setState(next)), [service]);
  useEffect(() => {
    if (!navigationService) return;
    return navigationService.subscribe((next) => setNavigationState(next));
  }, [navigationService]);
  useEffect(() => {
    if (!connectionService) return;
    return connectionService.subscribe((next) => setConnectionState(next));
  }, [connectionService]);

  // Direct snapshot polling — bypasses WebSocket/ROS entirely
  useEffect(() => {
    let cancelled = false;
    function poll(): void {
      if (cancelled) return;
      const img = new Image();
      img.onload = () => { if (!cancelled) { setSnapSrc(img.src); poll(); } };
      img.onerror = () => { if (!cancelled) setTimeout(poll, 300); };
      img.src = `${SNAP_URL}?_=${Date.now()}`;
    }
    poll();
    return () => { cancelled = true; };
  }, []);

  const redrawOverlay = (): void => {
    const canvas = canvasRef.current;
    const imgEl = imgRef.current;
    if (!canvas) return;
    const natW = imgEl?.naturalWidth ?? 0;
    const natH = imgEl?.naturalHeight ?? 0;
    renderOverlay(canvas, state.currentDetections, natW, natH);
  };

  useEffect(() => {
    redrawOverlay();
  }, [snapSrc, state.currentDetections]);

  useEffect(() => {
    const handleResize = (): void => {
      redrawOverlay();
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, [snapSrc, state.currentDetections]);

  const detCountText = `${state.detectionCount} obj${state.detectionCount !== 1 ? "s" : ""}`;
  const frameResolution = state.currentFrame
    ? `${state.currentFrame.width} x ${state.currentFrame.height}`
    : "Snapshot feed";
  const detectionsLabel = state.detectionsActive ? "Tracking" : "Idle";
  const cameraEnabled = connectionService?.isCameraEnabled() ?? false;
  const streamOnline = navigationState?.cameraStreamConnected === true;
  const presetLabel = connectionState?.preset === "sim" ? "SIM" : connectionState?.preset === "real" ? "REAL" : "N/A";

  const pan = async (angleDeg: number): Promise<void> => {
    if (!navigationService) return;
    if (!connectionService?.isCameraEnabled()) {
      runtime.eventBus.emit("console.event", {
        level: "warn",
        text: "Camera disabled in current preset",
        timestamp: Date.now()
      });
      return;
    }
    try {
      await navigationService.panCamera(angleDeg);
    } catch (error) {
      runtime.eventBus.emit("console.event", {
        level: "error",
        text: `Camera pan failed: ${String(error)}`,
        timestamp: Date.now()
      });
    }
  };

  const toggleZoom = async (): Promise<void> => {
    if (!navigationService) return;
    try {
      await navigationService.toggleCameraZoom();
    } catch (error) {
      runtime.eventBus.emit("console.event", {
        level: "error",
        text: `Camera zoom failed: ${String(error)}`,
        timestamp: Date.now()
      });
    }
  };

  return (
    <div className="cv-root">
      <div className="cv-body">
        <section className="cv-main">
          <header className="cv-stage-header">
            <div className="cv-stage-copy">
              <span className="cv-stage-kicker">Primary feed</span>
              <h2 className="cv-stage-title">Perception Camera</h2>
              <p className="cv-stage-subtitle">
                Video en tiempo real con overlay de detecciones y lectura operativa rápida.
              </p>
            </div>
            <div className="cv-stage-status">
              <StatusBadge active={state.connected} label={state.connected ? "Camera online" : "Camera offline"} />
              <StatusBadge
                active={state.detectionsActive}
                label={state.detectionsActive ? "Detections live" : "Detections idle"}
              />
            </div>
          </header>

          <div className="cv-viewport-shell">
            <div className="cv-viewport-chrome">
              <span className="cv-viewport-title">Live vision stream</span>
              <div className="cv-viewport-meta">
                <span className="cv-viewport-chip">{frameResolution}</span>
                <span className="cv-viewport-chip">{state.fps > 0 ? `${state.fps} FPS` : "Awaiting FPS"}</span>
                <span className="cv-viewport-chip">{detCountText}</span>
              </div>
            </div>

            <div className="cv-viewport">
              {snapSrc ? (
                <img
                  ref={imgRef}
                  src={snapSrc}
                  className="cv-frame"
                  alt="Camera stream"
                  draggable={false}
                  onLoad={redrawOverlay}
                />
              ) : (
                <div className="cv-no-signal">
                  <div className="cv-no-signal-icon">⬛</div>
                  <div className="cv-no-signal-text">conectando...</div>
                  <div className="cv-no-signal-hint">
                    Iniciá: ./tools/launch_fast_cam.sh
                  </div>
                </div>
              )}
              <canvas ref={canvasRef} className="cv-overlay" />

              <div className="cv-viewport-hud">
                <div className="cv-hud-card">
                  <span className="cv-hud-label">Objects</span>
                  <strong className="cv-hud-value">{state.detectionCount}</strong>
                  <span className="cv-hud-detail">{detectionsLabel}</span>
                </div>
                <div className="cv-hud-card">
                  <span className="cv-hud-label">Last frame</span>
                  <strong className="cv-hud-value">{formatTimestamp(state.lastFrameMs)}</strong>
                  <span className="cv-hud-detail">{state.connected ? "Feed healthy" : "Waiting stream"}</span>
                </div>
                <div className="cv-hud-card">
                  <span className="cv-hud-label">Last detection</span>
                  <strong className="cv-hud-value">{formatTimestamp(state.lastDetectionMs)}</strong>
                  <span className="cv-hud-detail">
                    {state.detectionsActive ? "Overlay synchronized" : "No fresh detections"}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <aside className="cv-panel">
          <div className="cv-panel-section cv-panel-status">
            <div className="cv-panel-header">
              <span>System status</span>
              <span className="cv-panel-caption">vision</span>
            </div>

            <div className="cv-status-cards">
              <StatusCard
                label="Camera"
                value={state.connected ? "Online" : "Offline"}
                detail={state.connected ? "Frames arriving" : "No fresh frames"}
                tone={state.connected ? "ok" : "off"}
              />
              <StatusCard
                label="Detections"
                value={state.detectionsActive ? "Live" : "Idle"}
                detail={state.detectionsActive ? "Overlay updated" : "Awaiting detections"}
                tone={state.detectionsActive ? "warn" : "neutral"}
              />
              <StatusCard
                label="FPS"
                value={state.fps > 0 ? `${state.fps}` : "—"}
                detail="Current refresh"
                tone={state.fps > 0 ? "ok" : "neutral"}
              />
              <StatusCard
                label="Objects"
                value={String(state.detectionCount)}
                detail={detCountText}
                tone={state.detectionCount > 0 ? "warn" : "neutral"}
              />
            </div>
          </div>

          <div className="cv-panel-section cv-panel-ptz">
            <div className="cv-panel-header">
              <span>Camera PTZ</span>
              <span className="cv-panel-caption">pan / tilt / zoom</span>
            </div>
            {!navigationService ? (
              <div className="cv-panel-empty">PTZ no disponible: el módulo de navegación no está activo.</div>
            ) : (
              <div className="cv-ptz-panel">
                <div className="cv-ptz-topline">
                  <div className="cv-ptz-copy">
                    <span className="cv-ptz-kicker">Optical Control</span>
                    <strong className="cv-ptz-title">Camera Direction Pad</strong>
                    <p className="cv-ptz-description">
                      El control de cámara ahora vive junto a la vista principal para operar sin salir de la pestaña.
                    </p>
                  </div>
                  <div className="cv-ptz-badges">
                    <StatusBadge active={cameraEnabled} label={cameraEnabled ? "Camera enabled" : "Camera unavailable"} />
                    <StatusBadge active={streamOnline} label={streamOnline ? "Stream online" : "Stream standby"} />
                  </div>
                </div>

                <div className="cv-ptz-grid">
                  <PtzButton icon="↖" label="NW" title="Pan up-left" onClick={() => void pan(45)} />
                  <PtzButton icon="↑" label="North" title="Pan up" onClick={() => void pan(0)} />
                  <PtzButton icon="↗" label="NE" title="Pan up-right" onClick={() => void pan(-45)} />
                  <PtzButton icon="←" label="West" title="Pan left" onClick={() => void pan(90)} />
                  <PtzButton icon="◉" label="Zoom" title="Toggle zoom" className="cv-ptz-btn-center" onClick={() => void toggleZoom()} />
                  <PtzButton icon="→" label="East" title="Pan right" onClick={() => void pan(-90)} />
                  <PtzButton icon="↙" label="SW" title="Pan down-left" onClick={() => void pan(135)} />
                  <PtzButton icon="↓" label="South" title="Pan down" onClick={() => void pan(180)} />
                  <PtzButton icon="↘" label="SE" title="Pan down-right" onClick={() => void pan(-135)} />
                </div>

                <div className="cv-ptz-readout">
                  <div className="cv-ptz-stat">
                    <span className="cv-ptz-stat-label">Preset</span>
                    <strong className="cv-ptz-stat-value">{presetLabel}</strong>
                  </div>
                  <div className="cv-ptz-stat">
                    <span className="cv-ptz-stat-label">Camera</span>
                    <strong className="cv-ptz-stat-value">{cameraEnabled ? "Ready" : "Off path"}</strong>
                  </div>
                  <div className="cv-ptz-stat">
                    <span className="cv-ptz-stat-label">Stream</span>
                    <strong className="cv-ptz-stat-value">{streamOnline ? "Live" : "Idle"}</strong>
                  </div>
                </div>

                {!cameraEnabled ? (
                  <p className="cv-ptz-note">
                    El preset actual no expone cámara. Los controles mantienen el mismo comportamiento y avisarán en consola.
                  </p>
                ) : null}
              </div>
            )}
          </div>

          <div className="cv-panel-section cv-panel-detections">
            <div className="cv-panel-header">
              <span>Detections</span>
              <span className="cv-panel-caption">class / confidence / position</span>
              {state.detectionCount > 0 && (
                <span className="cv-det-count">{state.detectionCount}</span>
              )}
            </div>
            {state.currentDetections.length === 0 ? (
              <div className="cv-panel-empty">
                {state.detectionsActive ? "procesando..." : "sin detecciones"}
              </div>
            ) : (
              <ul className="cv-det-list">
                {state.currentDetections.map((det, i) => (
                  <DetectionListItem key={`${det.class}-${i}`} det={det} index={i} />
                ))}
              </ul>
            )}
          </div>
        </aside>
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
      ctx.services.registerService({
        id: SERVICE_ID,
        service
      });

      ctx.contributions.register({
        id: "workspace.camera",
        slot: "workspace",
        label: "Camera",
        render: () => <CameraVisionWorkspaceView runtime={ctx} />
      });
    }
  };
}
