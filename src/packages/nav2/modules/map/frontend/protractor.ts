import { projectMercator, type GeoPoint, unprojectMercator } from "./mapGeometry";

const DEFAULT_MIN_ARM_METERS = 0.05;
const DEFAULT_SNAP_THRESHOLD_DEG = 12;
const DEFAULT_SNAP_STEP_DEG = 12;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeAngleDeg(value: number): number {
  let angle = value % 360;
  if (angle < 0) angle += 360;
  return angle;
}

function shortestAngleDistanceDeg(a: number, b: number): number {
  const delta = Math.abs(normalizeAngleDeg(a) - normalizeAngleDeg(b));
  return Math.min(delta, 360 - delta);
}

export function calculateProtractorAngleDeg(
  vertex: GeoPoint,
  armA: GeoPoint,
  armB: GeoPoint,
  minArmMeters = DEFAULT_MIN_ARM_METERS
): number | null {
  const origin = projectMercator(vertex);
  const first = projectMercator(armA);
  const second = projectMercator(armB);

  const vectorA = {
    x: first.x - origin.x,
    y: first.y - origin.y
  };
  const vectorB = {
    x: second.x - origin.x,
    y: second.y - origin.y
  };
  const lengthA = Math.hypot(vectorA.x, vectorA.y);
  const lengthB = Math.hypot(vectorB.x, vectorB.y);
  if (!Number.isFinite(lengthA) || !Number.isFinite(lengthB)) return null;
  if (lengthA < minArmMeters || lengthB < minArmMeters) return null;

  const denominator = lengthA * lengthB;
  if (!Number.isFinite(denominator) || denominator <= 0) return null;
  const cosine = clamp((vectorA.x * vectorB.x + vectorA.y * vectorB.y) / denominator, -1, 1);
  const angle = (Math.acos(cosine) * 180) / Math.PI;
  if (!Number.isFinite(angle)) return null;
  return angle;
}

export function snapToCartesianAxis(
  vertex: GeoPoint,
  rawPoint: GeoPoint,
  thresholdDeg = DEFAULT_SNAP_THRESHOLD_DEG,
  minArmMeters = DEFAULT_MIN_ARM_METERS
): GeoPoint {
  return snapToAngleIncrement(vertex, rawPoint, 90, thresholdDeg, minArmMeters);
}

export function snapToAngleIncrement(
  vertex: GeoPoint,
  rawPoint: GeoPoint,
  stepDeg = DEFAULT_SNAP_STEP_DEG,
  thresholdDeg = DEFAULT_SNAP_THRESHOLD_DEG,
  minArmMeters = DEFAULT_MIN_ARM_METERS
): GeoPoint {
  const origin = projectMercator(vertex);
  const target = projectMercator(rawPoint);
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  const length = Math.hypot(dx, dy);
  if (!Number.isFinite(length) || length < minArmMeters) return rawPoint;

  const step = Number.isFinite(stepDeg) ? Math.max(0.0001, Math.abs(stepDeg)) : DEFAULT_SNAP_STEP_DEG;
  const angleDeg = normalizeAngleDeg((Math.atan2(dy, dx) * 180) / Math.PI);
  const snapIndex = Math.round(angleDeg / step);
  const candidateCount = Math.max(1, Math.round(360 / step));
  const rawCandidateDeg = snapIndex * step;
  const closestAxisDeg = normalizeAngleDeg(rawCandidateDeg % (candidateCount * step));
  let closestDistanceDeg = shortestAngleDistanceDeg(angleDeg, closestAxisDeg);
  if (closestDistanceDeg > thresholdDeg) return rawPoint;
  const snappedRad = (closestAxisDeg * Math.PI) / 180;
  return unprojectMercator({
    x: origin.x + Math.cos(snappedRad) * length,
    y: origin.y + Math.sin(snappedRad) * length
  });
}
