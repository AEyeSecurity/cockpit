import { describe, expect, it } from "vitest";
import {
  calculateProtractorAngleDeg,
  snapToAngleIncrement,
  snapToCartesianAxis
} from "../packages/nav2/modules/map/frontend/protractor";
import type { GeoPoint } from "../packages/nav2/modules/map/frontend/mapGeometry";

function point(lat: number, lng: number): GeoPoint {
  return { lat, lng };
}

function polarPoint(angleDeg: number, length = 0.001): GeoPoint {
  const rad = (angleDeg * Math.PI) / 180;
  return {
    lat: Math.sin(rad) * length,
    lng: Math.cos(rad) * length
  };
}

function pointAngleDeg(value: GeoPoint): number {
  let angle = (Math.atan2(value.lat, value.lng) * 180) / Math.PI;
  while (angle < 0) angle += 360;
  while (angle >= 360) angle -= 360;
  return angle;
}

describe("calculateProtractorAngleDeg", () => {
  const vertex = point(0, 0);

  it("returns 0 degrees", () => {
    const angle = calculateProtractorAngleDeg(vertex, point(0, 0.001), point(0, 0.002));
    expect(angle).not.toBeNull();
    expect(angle ?? -1).toBeCloseTo(0, 5);
  });

  it("returns 45 degrees", () => {
    const angle = calculateProtractorAngleDeg(vertex, point(0, 0.001), point(0.001, 0.001));
    expect(angle).not.toBeNull();
    expect(angle ?? -1).toBeCloseTo(45, 3);
  });

  it("returns 90 degrees", () => {
    const angle = calculateProtractorAngleDeg(vertex, point(0, 0.001), point(0.001, 0));
    expect(angle).not.toBeNull();
    expect(angle ?? -1).toBeCloseTo(90, 3);
  });

  it("returns 180 degrees", () => {
    const angle = calculateProtractorAngleDeg(vertex, point(0, 0.001), point(0, -0.001));
    expect(angle).not.toBeNull();
    expect(angle ?? -1).toBeCloseTo(180, 3);
  });

  it("returns null for degenerate arm", () => {
    const angle = calculateProtractorAngleDeg(vertex, point(0, 0.001), point(0, 0.000000001));
    expect(angle).toBeNull();
  });
});

describe("snapToCartesianAxis", () => {
  const vertex = point(0, 0);

  it("snaps point near Y axis", () => {
    const snapped = snapToCartesianAxis(vertex, point(0.001, 0.0001), 12);
    expect(snapped.lat).toBeGreaterThan(0);
    expect(Math.abs(snapped.lng)).toBeLessThan(0.000001);
  });

  it("snaps point near X axis", () => {
    const snapped = snapToCartesianAxis(vertex, point(0.0001, 0.001), 12);
    expect(snapped.lng).toBeGreaterThan(0);
    expect(Math.abs(snapped.lat)).toBeLessThan(0.000001);
  });

  it("keeps point when outside threshold", () => {
    const raw = point(0.001, 0.001);
    const snapped = snapToCartesianAxis(vertex, raw, 12);
    expect(snapped.lat).toBeCloseTo(raw.lat, 8);
    expect(snapped.lng).toBeCloseTo(raw.lng, 8);
  });
});

describe("snapToAngleIncrement", () => {
  const vertex = point(0, 0);

  it("snaps near 12 degrees", () => {
    const snapped = snapToAngleIncrement(vertex, polarPoint(10), 12, 12, 0.05);
    expect(pointAngleDeg(snapped)).toBeCloseTo(12, 5);
  });

  it("snaps near 24 degrees", () => {
    const snapped = snapToAngleIncrement(vertex, polarPoint(19), 12, 12, 0.05);
    expect(pointAngleDeg(snapped)).toBeCloseTo(24, 5);
  });

  it("does not snap when threshold is strict", () => {
    const raw = polarPoint(10);
    const snapped = snapToAngleIncrement(vertex, raw, 12, 1, 0.05);
    expect(snapped.lat).toBeCloseTo(raw.lat, 8);
    expect(snapped.lng).toBeCloseTo(raw.lng, 8);
  });

  it("does not snap when arm is below minimum", () => {
    const raw = polarPoint(10, 0.00000001);
    const snapped = snapToAngleIncrement(vertex, raw, 12, 12, 0.05);
    expect(snapped.lat).toBeCloseTo(raw.lat, 12);
    expect(snapped.lng).toBeCloseTo(raw.lng, 12);
  });
});
