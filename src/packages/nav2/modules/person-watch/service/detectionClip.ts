import type { RecordingsDispatcher } from "../../recordings/frontend";
import type { PersonAlert } from "./PersonWatchService";

const recordingCameras = new Map([["cam3", "main"], ["cam4", "mobile"], ["cam5", "rear"]]);
const CONTEXT_MS = 5000;

export type FindDetectionClip = (target: Pick<PersonAlert, "camera_id" | "frame_ms">) => Promise<string | undefined>;

export function detectionClipFinder(dispatcher: RecordingsDispatcher, managed: boolean): FindDetectionClip {
  return async ({ camera_id, frame_ms }) => {
    const camera = recordingCameras.get(camera_id);
    if (!camera || frame_ms === undefined) return;
    const start = frame_ms - CONTEXT_MS;
    const end = frame_ms + CONTEXT_MS;
    const result = await dispatcher.execute("recordings_list", {
      camera, start: new Date(start).toISOString(), end: new Date(end).toISOString()
    });
    if (!Array.isArray(result.items)) return;
    const item = result.items.find((row) => row && row.camera === camera && typeof row.start === "string"
      && Math.abs(Date.parse(row.start) - start) <= 1
      && typeof row.duration === "number" && Number.isFinite(row.duration)
      && Math.abs(row.duration * 1000 - (end - start)) <= 1);
    if (typeof item?.url !== "string") return;
    const url = new URL(item.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !url.search) return;
    return managed ? `/operation/recordings${url.pathname}${url.search}&view=inline` : url.href;
  };
}
