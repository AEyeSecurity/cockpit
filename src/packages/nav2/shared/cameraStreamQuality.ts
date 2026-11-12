import { useEffect, useState, useSyncExternalStore } from "react";
import type { ModuleContext } from "../../../core/types/module";
import { CORE_EVENTS } from "../../../core/events/topics";
import { readCameraStreamConfig, supportsNormalCameraQuality, type CameraStreamQuality } from "./cameraStreamConfig";

const STORAGE_KEY = "cockpit.camera.streamQuality";
function readSavedQuality(): CameraStreamQuality {
  try { return window.localStorage.getItem(STORAGE_KEY) === "normal" ? "normal" : "saving"; }
  catch { return "saving"; }
}
let quality = readSavedQuality();
const listeners = new Set<() => void>();
export const cameraStreamQuality = {
  getSnapshot: () => quality,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  set(next: CameraStreamQuality) {
    quality = next;
    try { window.localStorage.setItem(STORAGE_KEY, next); } catch { /* Memory still works without storage. */ }
    listeners.forEach(listener => listener());
  }
};

/** Shared by the sidebar, workspace and map; never opens an inactive feed. */
export function useCameraStreamConfig(runtime: ModuleContext) {
  const requestedQuality = useSyncExternalStore(cameraStreamQuality.subscribe, cameraStreamQuality.getSnapshot);
  const [, setRevision] = useState(0);
  useEffect(() => runtime.eventBus.on<{ packageId?: unknown }>(CORE_EVENTS.packageConfigUpdated, payload => {
    if (payload?.packageId === "nav2") setRevision(value => value + 1);
  }), [runtime]);
  const normalAvailable = supportsNormalCameraQuality(runtime);
  const effectiveQuality = normalAvailable ? requestedQuality : "saving";
  return { config: readCameraStreamConfig(runtime, effectiveQuality), quality: effectiveQuality, normalAvailable };
}
