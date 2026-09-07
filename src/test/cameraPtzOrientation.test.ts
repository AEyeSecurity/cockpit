import { describe, expect, it } from "vitest";
import { orientCameraPtzDelta } from "../packages/nav2/shared/cameraStreamConfig";

describe("camera PTZ orientation", () => {
  it("inverts pan and tilt for a camera image rotated 180 degrees", () => {
    expect(orientCameraPtzDelta(
      { relative: true, panDeg: 15, tiltDeg: -10, zoomLevel: 0.5 },
      180
    )).toEqual({
      relative: true,
      panDeg: -15,
      tiltDeg: 10,
      zoomLevel: 0.5
    });
  });

  it("preserves normal orientation and non-directional controls", () => {
    const input = { relative: true, zoomLevel: 0.5 };
    expect(orientCameraPtzDelta(input, 0)).toBe(input);
    expect(orientCameraPtzDelta(input, 180)).toEqual(input);
  });
});
