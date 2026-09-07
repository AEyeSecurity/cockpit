import { describe, expect, it } from "vitest";
import type { Nav2IncomingMessage } from "../packages/nav2/protocol/messages";
import { parseLidarPreview } from "../packages/nav2/modules/telemetry/service/impl/LidarPreviewService";

function preview(overrides: Partial<Nav2IncomingMessage> = {}): Nav2IncomingMessage {
  return {
    op: "scan_preview",
    frame_id: "base_footprint",
    stamp: { sec: 12, nanosec: 50 },
    angle_min: -Math.PI / 2,
    angle_increment: Math.PI / 180,
    range_min: 0.4,
    range_max: 12,
    ranges: [null, 2.5, 15, 0.1, 4],
    valid_count: 2,
    ...overrides
  };
}

describe("parseLidarPreview", () => {
  it("normalizes valid ranges and records local receipt time", () => {
    const result = parseLidarPreview(preview(), 1234);
    expect(result).not.toBeNull();
    expect(result?.status).toBe("live");
    expect(result?.receivedAtMs).toBe(1234);
    expect(result?.sourceStamp).toEqual({ sec: 12, nanosec: 50 });
    expect(result?.ranges).toEqual([null, 2.5, null, null, 4]);
    expect(result?.validCount).toBe(2);
  });

  it("rejects malformed or unbounded payloads", () => {
    expect(parseLidarPreview(preview({ frame_id: "" }))).toBeNull();
    expect(parseLidarPreview(preview({ angle_increment: 0 }))).toBeNull();
    expect(parseLidarPreview(preview({ range_max: 0.3 }))).toBeNull();
    expect(parseLidarPreview(preview({ ranges: [] }))).toBeNull();
    expect(parseLidarPreview(preview({ ranges: Array.from({ length: 721 }, () => 1) }))).toBeNull();
  });

  it("does not accept another websocket operation", () => {
    expect(parseLidarPreview(preview({ op: "nav_telemetry" }))).toBeNull();
  });
});
