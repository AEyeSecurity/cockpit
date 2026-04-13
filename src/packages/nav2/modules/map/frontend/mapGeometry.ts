export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface ProjectedPoint {
  x: number;
  y: number;
}

const EARTH_RADIUS_M = 6378137;

export function clampLatitude(lat: number): number {
  return Math.max(-85.05112878, Math.min(85.05112878, Number(lat)));
}

export function normalizeLongitude(lng: number): number {
  let value = Number(lng);
  while (value <= -180) value += 360;
  while (value > 180) value -= 360;
  return value;
}

export function projectMercator(point: GeoPoint): ProjectedPoint {
  const latRad = (clampLatitude(point.lat) * Math.PI) / 180;
  const lngRad = (normalizeLongitude(point.lng) * Math.PI) / 180;
  return {
    x: EARTH_RADIUS_M * lngRad,
    y: EARTH_RADIUS_M * Math.log(Math.tan(Math.PI / 4 + latRad / 2))
  };
}

export function unprojectMercator(point: ProjectedPoint): GeoPoint {
  const lng = (point.x / EARTH_RADIUS_M) * (180 / Math.PI);
  const lat = (2 * Math.atan(Math.exp(point.y / EARTH_RADIUS_M)) - Math.PI / 2) * (180 / Math.PI);
  return {
    lat: clampLatitude(lat),
    lng: normalizeLongitude(lng)
  };
}

export function haversineDistanceMeters(a: GeoPoint, b: GeoPoint): number {
  const lat1 = (Number(a.lat) * Math.PI) / 180;
  const lat2 = (Number(b.lat) * Math.PI) / 180;
  const dLat = lat2 - lat1;
  const dLng = ((Number(b.lng) - Number(a.lng)) * Math.PI) / 180;
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function polylineDistanceMeters(points: GeoPoint[]): number {
  if (points.length < 2) return 0;
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += haversineDistanceMeters(points[index - 1], points[index]);
  }
  return total;
}

export function polygonAreaSqMeters(points: GeoPoint[]): number {
  if (points.length < 3) return 0;
  const projected = points.map((point) => projectMercator(point));
  let area = 0;
  for (let index = 0; index < projected.length; index += 1) {
    const current = projected[index];
    const next = projected[(index + 1) % projected.length];
    area += current.x * next.y - next.x * current.y;
  }
  return Math.abs(area / 2);
}

export function normalizeYawDeg(yawDeg: number): number {
  let yaw = Number(yawDeg || 0);
  while (yaw <= -180) yaw += 360;
  while (yaw > 180) yaw -= 360;
  return yaw;
}

export function yawDegFromLatLng(origin: GeoPoint, target: GeoPoint): number {
  const refLat = Number(origin.lat);
  const metersPerDegLat = 111320;
  const metersPerDegLon = metersPerDegLat * Math.max(1e-6, Math.abs(Math.cos((refLat * Math.PI) / 180)));
  const eastM = (Number(target.lng) - Number(origin.lng)) * metersPerDegLon;
  const northM = (Number(target.lat) - Number(origin.lat)) * metersPerDegLat;
  return normalizeYawDeg((Math.atan2(northM, eastM) * 180) / Math.PI);
}

export function formatDistanceMeters(meters: number): string {
  if (!Number.isFinite(meters) || meters <= 0) return "0 m";
  return meters >= 1000 ? `${(meters / 1000).toFixed(3)} km` : `${meters.toFixed(1)} m`;
}

export function formatAreaSqMeters(area: number): string {
  if (!Number.isFinite(area) || area <= 0) return "0 m²";
  return area >= 1_000_000 ? `${(area / 1_000_000).toFixed(3)} km²` : `${area.toFixed(1)} m²`;
}

export function formatAngleDegrees(angleDeg: number): string {
  if (!Number.isFinite(angleDeg)) return "n/a";
  return `${angleDeg.toFixed(1)}°`;
}
