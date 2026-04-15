import { describe, expect, it } from "vitest";
import { calculateProtractorAngleDeg, snapToCartesianAxis } from "../packages/nav2/modules/map/frontend/protractor";
import type { GeoPoint } from "../packages/nav2/modules/map/frontend/mapGeometry";

function point(lat: number, lng: number): GeoPoint {
  return { lat, lng };
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
