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

const TRANSPORT_ID = "transport.ws.core";
const DISPATCHER_ID = "dispatcher.camera";
const SERVICE_ID = "service.camera-vision";

// ---------------------------------------------------------------------------
// Canvas overlay drawing
// ---------------------------------------------------------------------------

const BBOX_COLOR = "#55ff7f";
const LABEL_BG = "#55ff7f";
const LABEL_TEXT = "#000000";
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

  return (
    <li className="cv-det-item">
      <div className="cv-det-row">
        <span className="cv-det-index">{index + 1}</span>
        <span className="cv-det-label">{det.class}</span>
        <span className={`cv-det-conf ${confClass}`}>{pct}%</span>
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
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Main workspace view
// ---------------------------------------------------------------------------

const SNAP_URL = "http://localhost:8089/snap.jpg";

function CameraVisionWorkspaceView({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const service = runtime.services.getService<CameraVisionService>(SERVICE_ID);
  const [state, setState] = useState<CameraVisionState>(service.getState());
  const [snapSrc, setSnapSrc] = useState<string>("");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => service.subscribe((next) => setState(next)), [service]);

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

  // Redraw bounding boxes whenever detections change
  useEffect(() => {
    const canvas = canvasRef.current;
    const imgEl = imgRef.current;
    if (!canvas) return;
    const natW = imgEl?.naturalWidth ?? 0;
    const natH = imgEl?.naturalHeight ?? 0;
    renderOverlay(canvas, state.currentDetections, natW, natH);
  }, [state.currentDetections]);

  const detCountText = `${state.detectionCount} obj${state.detectionCount !== 1 ? "s" : ""}`;

  return (
    <div className="cv-root">
      <div className="cv-body">

        {/* ── Camera viewport ──────────────────────────────────────── */}
        <div className="cv-viewport">
          {snapSrc ? (
            <img
              ref={imgRef}
              src={snapSrc}
              className="cv-frame"
              alt="Camera stream"
              draggable={false}
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
        </div>

        {/* ── Right panel ──────────────────────────────────────────── */}
        <div className="cv-panel">

          {/* Detections list */}
          <div className="cv-panel-section cv-panel-detections">
            <div className="cv-panel-header">
              <span>Detections</span>
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

          {/* Status */}
          <div className="cv-panel-section cv-panel-status">
            <div className="cv-panel-header">Status</div>

            <div className="cv-status-grid">
              <span className="cv-status-key">Camera</span>
              <StatusBadge active={state.connected} label={state.connected ? "connected" : "disconnected"} />

              <span className="cv-status-key">Detections</span>
              <StatusBadge active={state.detectionsActive} label={state.detectionsActive ? "active" : "no data"} />

              <span className="cv-status-key">FPS</span>
              <span className="cv-status-val">{state.fps != null ? `${state.fps}` : "—"}</span>

              <span className="cv-status-key">Objects</span>
              <span className="cv-status-val">{detCountText}</span>
            </div>
          </div>

        </div>
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
