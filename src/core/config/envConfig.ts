export interface EnvConfig {
  appName: string;
  managed?: boolean;
  operatorUser?: boolean;
  wsUrl: string;
  wsRealHost?: string;
  wsSimHost?: string;
  wsDefaultPort?: string;
  rosbridgeUrl: string;
  httpBaseUrl: string;
  googleMapsApiKey: string;
  cameraIframeUrl: string;
  cameraProbeTimeoutMs?: number;
  cameraLoadTimeoutMs?: number;
}

export function managedEnvConfig(): EnvConfig {
  const ws = new URL("/operation/", window.location.origin);
  ws.protocol = ws.protocol === "https:" ? "wss:" : "ws:";
  return {
    ...loadEnvConfig(),
    managed: true,
    wsUrl: new URL("navigation", ws).href,
    rosbridgeUrl: new URL("rosbridge", ws).href,
    httpBaseUrl: "/operation",
    cameraIframeUrl: "/operation/mjpeg",
    wsRealHost: window.location.hostname,
    wsSimHost: window.location.hostname,
    wsDefaultPort: window.location.port || "443"
  };
}

function parsePositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

export function loadEnvConfig(env: ImportMetaEnv = import.meta.env): EnvConfig {
  const wsRealHost = env.VITE_WS_REAL_HOST ?? "localhost";
  const wsSimHost = env.VITE_WS_SIM_HOST ?? "localhost";
  const wsDefaultPort = env.VITE_WS_DEFAULT_PORT ?? "8766";

  return {
    appName: env.VITE_APP_NAME ?? "Cockpit Desktop",
    wsUrl: env.VITE_WS_URL ?? `ws://${wsRealHost}:${wsDefaultPort}`,
    wsRealHost,
    wsSimHost,
    wsDefaultPort,
    rosbridgeUrl: env.VITE_ROSBRIDGE_URL ?? "ws://localhost:9090",
    httpBaseUrl: env.VITE_HTTP_BASE_URL ?? "http://localhost:8080",
    googleMapsApiKey: env.VITE_GOOGLE_MAPS_API_KEY ?? "",
    cameraIframeUrl: env.VITE_CAMERA_IFRAME_URL ?? "http://localhost:8088/",
    cameraProbeTimeoutMs: parsePositiveInt(env.VITE_CAMERA_PROBE_TIMEOUT_MS, 3000),
    cameraLoadTimeoutMs: parsePositiveInt(env.VITE_CAMERA_LOAD_TIMEOUT_MS, 7000)
  };
}
