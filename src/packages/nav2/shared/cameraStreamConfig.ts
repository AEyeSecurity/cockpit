import type { ModuleContext } from "../../../core/types/module";

export type CameraStreamTransport = "mjpeg" | "webrtc";

export interface CameraStreamRuntimeConfig {
  transport: CameraStreamTransport;
  mjpegUrl: string;
  webrtcUrl: string;
  webrtcReceiveAudio?: boolean;
  mobileWebrtcUrl?: string;
  reverseWebrtcUrl?: string;
  ptzEnabled?: boolean;
  ptzPanInverted?: boolean;
  ptzZoomEnabled?: boolean;
  ptzRotationDeg: 0 | 180;
  probeTimeoutMs: number;
  loadTimeoutMs: number;
}

interface Nav2CameraConfig {
  camera_mobile_webrtc_url?: unknown;
  camera_reverse_webrtc_url?: unknown;
  camera_ptz_enabled?: unknown;
  camera_ptz_pan_inverted?: unknown;
  camera_ptz_zoom_enabled?: unknown;
  camera_transport?: unknown;
  camera_mjpeg_url?: unknown;
  camera_webrtc_url?: unknown;
  camera_normal_webrtc_url?: unknown;
  camera_mobile_normal_webrtc_url?: unknown;
  camera_reverse_normal_webrtc_url?: unknown;
  camera_webrtc_receive_audio?: unknown;
  camera_ptz_rotation_deg?: unknown;
  camera_probe_timeout_ms?: unknown;
  camera_load_timeout_ms?: unknown;
}

const DEFAULT_CAMERA_MJPEG_URL = "http://localhost:8089/stream.mjpg";

function normalizeUrl(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeTransport(value: unknown): CameraStreamTransport {
  return String(value ?? "").trim().toLowerCase() === "webrtc" ? "webrtc" : "mjpeg";
}

function parsePositiveInt(value: unknown, fallback: number, minimum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.round(parsed));
}

function readNav2CameraConfig(runtime: ModuleContext): Nav2CameraConfig {
  const config = runtime.getPackageConfig<Record<string, unknown>>("nav2") as Nav2CameraConfig;
  if (!runtime.env.managed) return config;
  return {
    ...config,
    camera_mjpeg_url: "/operation/mjpeg",
    camera_webrtc_url: new URL("/operation/camera/cam3/whep", window.location.origin).href,
    camera_mobile_webrtc_url: new URL("/operation/camera/cam4/whep", window.location.origin).href,
    camera_reverse_webrtc_url: new URL("/operation/camera/cam5/whep", window.location.origin).href,
    camera_normal_webrtc_url: new URL("/operation/camera/cam3_normal/whep", window.location.origin).href,
    camera_mobile_normal_webrtc_url: new URL("/operation/camera/cam4_normal/whep", window.location.origin).href,
    camera_reverse_normal_webrtc_url: new URL("/operation/camera/cam5_normal/whep", window.location.origin).href
  };
}

export type CameraStreamQuality = "saving" | "normal";

export function supportsNormalCameraQuality(runtime: ModuleContext): boolean {
  const config = readNav2CameraConfig(runtime);
  return normalizeTransport(config.camera_transport) === "webrtc"
    && Boolean(normalizeUrl(config.camera_webrtc_url))
    && Boolean(normalizeUrl(config.camera_normal_webrtc_url))
    && (!normalizeUrl(config.camera_mobile_webrtc_url) || Boolean(normalizeUrl(config.camera_mobile_normal_webrtc_url)))
    && (!normalizeUrl(config.camera_reverse_webrtc_url) || Boolean(normalizeUrl(config.camera_reverse_normal_webrtc_url)));
}

export function readCameraStreamConfig(runtime: ModuleContext, quality: CameraStreamQuality = "saving"): CameraStreamRuntimeConfig {
  const config = readNav2CameraConfig(runtime);
  const normal = quality === "normal" && supportsNormalCameraQuality(runtime);
  return {
    mobileWebrtcUrl: normalizeUrl(config.camera_mobile_webrtc_url) ? normalizeUrl(normal ? config.camera_mobile_normal_webrtc_url : config.camera_mobile_webrtc_url) : "",
    reverseWebrtcUrl: normalizeUrl(config.camera_reverse_webrtc_url) ? normalizeUrl(normal ? config.camera_reverse_normal_webrtc_url : config.camera_reverse_webrtc_url) : "",
    ptzEnabled: config.camera_ptz_enabled !== false,
    ptzPanInverted: config.camera_ptz_pan_inverted === true,
    ptzZoomEnabled: config.camera_ptz_zoom_enabled !== false,
    transport: normalizeTransport(config.camera_transport),
    mjpegUrl: normalizeUrl(config.camera_mjpeg_url) || DEFAULT_CAMERA_MJPEG_URL,
    webrtcUrl: normalizeUrl(normal ? config.camera_normal_webrtc_url : config.camera_webrtc_url),
    webrtcReceiveAudio: config.camera_webrtc_receive_audio === true,
    ptzRotationDeg: Number(config.camera_ptz_rotation_deg) === 180 ? 180 : 0,
    probeTimeoutMs: parsePositiveInt(config.camera_probe_timeout_ms, Number(runtime.env.cameraProbeTimeoutMs ?? 3000), 500),
    loadTimeoutMs: parsePositiveInt(config.camera_load_timeout_ms, Number(runtime.env.cameraLoadTimeoutMs ?? 7000), 1000)
  };
}

export function isCameraFeedConfigured(config: CameraStreamRuntimeConfig): boolean {
  return config.transport === "webrtc" ? config.webrtcUrl.length > 0 : config.mjpegUrl.length > 0;
}

export function orientCameraPtzDelta<T extends object>(
  input: T,
  rotationDeg: 0 | 180,
  panInverted = false
): T {
  if (rotationDeg !== 180 && !panInverted) return input;
  const axes = input as { panDeg?: number; tiltDeg?: number };
  return {
    ...input,
    ...(axes.panDeg === undefined ? {} : { panDeg: axes.panDeg * ((rotationDeg === 180) !== panInverted ? -1 : 1) }),
    ...(axes.tiltDeg === undefined || rotationDeg !== 180 ? {} : { tiltDeg: -axes.tiltDeg })
  };
}
