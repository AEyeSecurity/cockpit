export function batteryChargeWarning(percentage: number | null): "warn" | "critical" | null {
  if (percentage === null || !Number.isFinite(percentage) || percentage < 0 || percentage > 100) return null;
  if (percentage <= 10) return "critical";
  return percentage <= 30 ? "warn" : null;
}
