import { useEffect, useRef, useState } from "react";
import type { CameraStreamRuntimeConfig } from "./cameraStreamConfig";

declare global {
  interface Window {
    MediaMTXWebRTCReader?: MediaMTXWebRTCReaderConstructor;
  }
}

interface MediaMTXWebRTCReaderInstance {
  close: () => void;
}

interface MediaMTXWebRTCReaderConstructor {
  new (config: {
    url: string;
    onError?: (error: string) => void;
    onTrack?: (event: RTCTrackEvent) => void;
  }): MediaMTXWebRTCReaderInstance;
}

export interface CameraStreamStatus {
  connected: boolean;
  connecting: boolean;
  error: string;
  lastFrameMs: number;
  transport: "mjpeg" | "webrtc";
}

interface CameraStreamSurfaceProps {
  isActive: boolean;
  config: CameraStreamRuntimeConfig;
  className: string;
  alt: string;
  onStatusChange?: (status: CameraStreamStatus) => void;
}

const MEDIAMTX_READER_SCRIPT = "/vendor/mediamtx/reader.js";
const MJPEG_RETRY_DELAY_MS = 1000;
const MJPEG_STALE_RECONNECT_MS = 3000;

let mediamtxReaderLoader: Promise<void> | null = null;

function appendCacheBust(url: string): string {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}_=${Date.now()}`;
}

function loadMediaMTXReader(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("window unavailable"));
  }
  if (window.MediaMTXWebRTCReader) {
    return Promise.resolve();
  }
  if (!mediamtxReaderLoader) {
    mediamtxReaderLoader = new Promise<void>((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>(`script[data-mediamtx-reader="true"]`);
      if (existing) {
        existing.addEventListener("load", () => resolve(), { once: true });
        existing.addEventListener("error", () => reject(new Error("failed to load MediaMTX reader")), { once: true });
        return;
      }
      const script = document.createElement("script");
      script.src = MEDIAMTX_READER_SCRIPT;
      script.async = true;
      script.dataset.mediamtxReader = "true";
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("failed to load MediaMTX reader"));
      document.head.appendChild(script);
    }).then(() => {
      if (!window.MediaMTXWebRTCReader) {
        throw new Error("MediaMTX reader unavailable");
      }
    });
  }
  return mediamtxReaderLoader;
}

function startVideoFrameMonitor(video: HTMLVideoElement, onFrame: () => void): () => void {
  let stopped = false;
  let callbackHandle = 0;

  if (typeof video.requestVideoFrameCallback === "function") {
    const tick: VideoFrameRequestCallback = () => {
      if (stopped) return;
      onFrame();
      callbackHandle = video.requestVideoFrameCallback?.(tick) ?? 0;
    };
    callbackHandle = video.requestVideoFrameCallback(tick);
    return () => {
      stopped = true;
      if (callbackHandle && typeof video.cancelVideoFrameCallback === "function") {
        video.cancelVideoFrameCallback(callbackHandle);
      }
    };
  }

  const intervalId = window.setInterval(() => {
    if (stopped) return;
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !video.ended) {
      onFrame();
    }
  }, 250);

  return () => {
    stopped = true;
    window.clearInterval(intervalId);
  };
}

export function CameraStreamSurface({
  isActive,
  config,
  className,
  alt,
  onStatusChange
}: CameraStreamSurfaceProps): JSX.Element | null {
  const [mjpegSrc, setMjpegSrc] = useState("");
  const [status, setStatus] = useState<CameraStreamStatus>({
    connected: false,
    connecting: false,
    error: "",
    lastFrameMs: 0,
    transport: config.transport
  });
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    setStatus({
      connected: false,
      connecting: false,
      error: "",
      lastFrameMs: 0,
      transport: config.transport
    });
  }, [isActive, config.transport, config.mjpegUrl, config.webrtcUrl]);

  useEffect(() => {
    onStatusChange?.(status);
  }, [onStatusChange, status]);

  useEffect(() => {
    if (!isActive) {
      setMjpegSrc("");
      setStatus({
        connected: false,
        connecting: false,
        error: "",
        lastFrameMs: 0,
        transport: "mjpeg"
      });
      return;
    }
    if (config.transport !== "mjpeg") {
      setMjpegSrc("");
      return;
    }
    if (!config.mjpegUrl) {
      setMjpegSrc("");
      setStatus({
        connected: false,
        connecting: false,
        error: "not configured",
        lastFrameMs: 0,
        transport: "mjpeg"
      });
      return;
    }

    setStatus((previous) => ({
      ...previous,
      connected: false,
      connecting: true,
      error: "",
      lastFrameMs: 0,
      transport: "mjpeg"
    }));
    setMjpegSrc(appendCacheBust(config.mjpegUrl));
    return () => setMjpegSrc("");
  }, [isActive, config.mjpegUrl, config.transport]);

  useEffect(() => {
    if (!isActive || config.transport !== "mjpeg" || !config.mjpegUrl || mjpegSrc) return;
    const timer = window.setTimeout(() => {
      setStatus((previous) => ({ ...previous, connecting: true, error: "" }));
      setMjpegSrc(appendCacheBust(config.mjpegUrl));
    }, MJPEG_RETRY_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [isActive, config.mjpegUrl, config.transport, mjpegSrc]);

  useEffect(() => {
    if (!isActive || config.transport !== "mjpeg" || !mjpegSrc || status.lastFrameMs === 0) return;
    const timer = window.setTimeout(() => {
      setMjpegSrc("");
      setStatus((previous) => ({ ...previous, connected: false, connecting: true }));
    }, MJPEG_STALE_RECONNECT_MS);
    return () => window.clearTimeout(timer);
  }, [isActive, config.transport, mjpegSrc, status.lastFrameMs]);

  useEffect(() => {
    if (!isActive) {
      setStatus({
        connected: false,
        connecting: false,
        error: "",
        lastFrameMs: 0,
        transport: "webrtc"
      });
      return;
    }
    if (config.transport !== "webrtc") return;
    if (!config.webrtcUrl) {
      setStatus({
        connected: false,
        connecting: false,
        error: "not configured",
        lastFrameMs: 0,
        transport: "webrtc"
      });
      return;
    }

    let active = true;
    let clearFrameMonitor = (): void => undefined;
    let reader: MediaMTXWebRTCReaderInstance | null = null;
    const loadTimer = window.setTimeout(() => {
      if (!active) return;
      setStatus((previous) => previous.connected ? previous : {
        ...previous,
        connected: false,
        connecting: false,
        error: "load timeout",
        transport: "webrtc"
      });
    }, config.loadTimeoutMs);

    setStatus({
      connected: false,
      connecting: true,
      error: "",
      lastFrameMs: 0,
      transport: "webrtc"
    });

    void loadMediaMTXReader()
      .then(() => {
        if (!active) return;
        const video = videoRef.current;
        const Reader = window.MediaMTXWebRTCReader;
        if (!video || !Reader) {
          throw new Error("video surface unavailable");
        }

        const bootstrapStream = new MediaStream();
        video.srcObject = bootstrapStream;
        reader = new Reader({
          url: config.webrtcUrl,
          onError: (error) => {
            if (!active) return;
            setStatus((previous) => ({
              ...previous,
              connected: false,
              connecting: false,
              error,
              transport: "webrtc"
            }));
          },
          onTrack: (event) => {
            if (!active) return;
            const incomingStream = event.streams[0];
            if (incomingStream) {
              if (video.srcObject !== incomingStream) {
                video.srcObject = incomingStream;
              }
            } else {
              const currentStream = video.srcObject instanceof MediaStream ? video.srcObject : bootstrapStream;
              currentStream.addTrack(event.track);
              video.srcObject = currentStream;
            }
            void video.play().catch(() => undefined);
            clearFrameMonitor();
            clearFrameMonitor = startVideoFrameMonitor(video, () => {
              if (!active) return;
              setStatus({
                connected: true,
                connecting: false,
                error: "",
                lastFrameMs: Date.now(),
                transport: "webrtc"
              });
            });
          }
        });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setStatus({
          connected: false,
          connecting: false,
          error: String(error),
          lastFrameMs: 0,
          transport: "webrtc"
        });
      });

    return () => {
      active = false;
      window.clearTimeout(loadTimer);
      clearFrameMonitor();
      reader?.close();
      const video = videoRef.current;
      if (video) {
        video.pause();
        video.srcObject = null;
      }
    };
  }, [isActive, config.loadTimeoutMs, config.transport, config.webrtcUrl]);

  if (config.transport === "webrtc") {
    return (
      <video
        ref={videoRef}
        className={className}
        aria-label={alt}
        autoPlay
        muted
        playsInline
      />
    );
  }

  if (!mjpegSrc) return null;

  return (
    <img
      src={mjpegSrc}
      className={className}
      alt={alt}
      draggable={false}
      onLoad={() => {
        setStatus({
          connected: true,
          connecting: false,
          error: "",
          lastFrameMs: Date.now(),
          transport: "mjpeg"
        });
      }}
      onError={() => {
        setStatus({
          connected: false,
          connecting: false,
          error: "stream unavailable",
          lastFrameMs: 0,
          transport: "mjpeg"
        });
        setMjpegSrc("");
      }}
    />
  );
}
