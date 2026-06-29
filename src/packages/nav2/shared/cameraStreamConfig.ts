import type { ModuleContext } from "../../../core/types/module";

export type CameraStreamTransport = "mjpeg" | "webrtc";

export interface CameraStreamRuntimeConfig {
  transport: CameraStreamTransport;
  mjpegUrl: string;
  webrtcUrl: string;
  probeTimeoutMs: number;
  loadTimeoutMs: number;
}

interface Nav2CameraConfig {
  camera_transport?: unknown;
  camera_mjpeg_url?: unknown;
  camera_webrtc_url?: unknown;
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
  return runtime.getPackageConfig<Record<string, unknown>>("nav2") as Nav2CameraConfig;
}

export function readCameraStreamConfig(runtime: ModuleContext): CameraStreamRuntimeConfig {
  const config = readNav2CameraConfig(runtime);
  return {
    transport: normalizeTransport(config.camera_transport),
    mjpegUrl: normalizeUrl(config.camera_mjpeg_url) || DEFAULT_CAMERA_MJPEG_URL,
    webrtcUrl: normalizeUrl(config.camera_webrtc_url),
    probeTimeoutMs: parsePositiveInt(config.camera_probe_timeout_ms, Number(runtime.env.cameraProbeTimeoutMs ?? 3000), 500),
    loadTimeoutMs: parsePositiveInt(config.camera_load_timeout_ms, Number(runtime.env.cameraLoadTimeoutMs ?? 7000), 1000)
  };
}

export function isCameraFeedConfigured(config: CameraStreamRuntimeConfig): boolean {
  return config.transport === "webrtc" ? config.webrtcUrl.length > 0 : config.mjpegUrl.length > 0;
}
