import type { Nav2IncomingMessage } from "../../../../protocol/messages";
import type { RobotDispatcher } from "../../../navigation/dispatcher/impl/RobotDispatcher";

const MAX_PREVIEW_BEAMS = 720;

export interface LidarPreviewState {
  status: "waiting" | "live";
  frameId: string;
  sourceStamp: { sec: number; nanosec: number } | null;
  receivedAtMs: number;
  angleMin: number;
  angleIncrement: number;
  rangeMin: number;
  rangeMax: number;
  ranges: Array<number | null>;
  validCount: number;
}

const WAITING_STATE: LidarPreviewState = {
  status: "waiting",
  frameId: "",
  sourceStamp: null,
  receivedAtMs: 0,
  angleMin: 0,
  angleIncrement: 0,
  rangeMin: 0,
  rangeMax: 0,
  ranges: [],
  validCount: 0
};

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sourceStamp(raw: unknown): { sec: number; nanosec: number } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const stamp = raw as Record<string, unknown>;
  const sec = finiteNumber(stamp.sec);
  const nanosec = finiteNumber(stamp.nanosec);
  if (sec === null || nanosec === null || sec < 0 || nanosec < 0 || nanosec >= 1_000_000_000) return null;
  return { sec, nanosec };
}

export function parseLidarPreview(
  message: Nav2IncomingMessage,
  receivedAtMs = Date.now()
): LidarPreviewState | null {
  if (message.op !== "scan_preview") return null;
  const frameId = typeof message.frame_id === "string" ? message.frame_id.trim() : "";
  const angleMin = finiteNumber(message.angle_min);
  const angleIncrement = finiteNumber(message.angle_increment);
  const rangeMin = finiteNumber(message.range_min);
  const rangeMax = finiteNumber(message.range_max);
  if (
    !frameId ||
    angleMin === null ||
    angleIncrement === null ||
    rangeMin === null ||
    rangeMax === null ||
    angleIncrement <= 0 ||
    rangeMin < 0 ||
    rangeMax <= rangeMin ||
    !Array.isArray(message.ranges) ||
    message.ranges.length === 0 ||
    message.ranges.length > MAX_PREVIEW_BEAMS
  ) {
    return null;
  }

  const ranges = message.ranges.map((raw) => {
    const range = finiteNumber(raw);
    return range !== null && range >= rangeMin && range <= rangeMax ? range : null;
  });
  const validCount = ranges.filter((range) => range !== null).length;
  return {
    status: "live",
    frameId,
    sourceStamp: sourceStamp(message.stamp),
    receivedAtMs,
    angleMin,
    angleIncrement,
    rangeMin,
    rangeMax,
    ranges,
    validCount
  };
}

export class LidarPreviewService {
  private readonly listeners = new Set<(state: LidarPreviewState) => void>();
  private state: LidarPreviewState = WAITING_STATE;

  constructor(robotDispatcher: RobotDispatcher) {
    robotDispatcher.subscribeScanPreview((message) => {
      const next = parseLidarPreview(message);
      if (!next) return;
      this.state = next;
      this.listeners.forEach((listener) => listener(this.getState()));
    });
  }

  getState(): LidarPreviewState {
    return { ...this.state, ranges: [...this.state.ranges] };
  }

  subscribe(listener: (state: LidarPreviewState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }
}
