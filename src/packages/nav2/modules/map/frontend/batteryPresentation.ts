export type BatteryTone = "ok" | "warn" | "critical" | "off";

export interface BatteryPresentationInput {
  batteryPct: number | null;
  connected: boolean;
  lowBatteryActive: boolean;
  batteryState: string;
  batteryMissionState: string;
  batteryReturnHomeRecommended: boolean | null;
  batteryPresent: boolean | null;
  batteryRecoveredVoltageV: number | null;
  batteryLoadedVoltageV: number | null;
}

export interface BatteryPresentation {
  tone: BatteryTone;
  badgeLabel: string;
  detail: string;
  contextualVoltageText: string | null;
}

function formatVoltage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  return `${value.toFixed(2)} V`;
}

export function getBatteryPresentation(input: BatteryPresentationInput): BatteryPresentation {
  const {
    batteryPct,
    connected,
    lowBatteryActive,
    batteryState,
    batteryMissionState,
    batteryReturnHomeRecommended,
    batteryPresent,
    batteryRecoveredVoltageV,
    batteryLoadedVoltageV
  } = input;
  const normalizedBatteryState = String(batteryState ?? "").trim().toUpperCase();
  const normalizedMissionState = String(batteryMissionState ?? "").trim().toUpperCase();
  const underLoad =
    normalizedBatteryState === "OK" &&
    batteryLoadedVoltageV !== null &&
    batteryRecoveredVoltageV !== null &&
    Number.isFinite(batteryLoadedVoltageV) &&
    Number.isFinite(batteryRecoveredVoltageV) &&
    batteryLoadedVoltageV < batteryRecoveredVoltageV - 0.4;

  if (batteryPresent === false || !connected || normalizedBatteryState === "UNAVAILABLE") {
    return {
      tone: "off",
      badgeLabel: "Telemetry Lost",
      detail: "Battery telemetry unavailable",
      contextualVoltageText: null
    };
  }
  if (normalizedBatteryState === "STALE" || normalizedBatteryState === "LINK_STALE") {
    return {
      tone: "off",
      badgeLabel: "Telemetry Lost",
      detail: "Battery telemetry unavailable",
      contextualVoltageText: null
    };
  }
  if (normalizedBatteryState === "SUSPECT") {
    return {
      tone: "off",
      badgeLabel: "Sensor Check",
      detail: "Battery reading marked suspect",
      contextualVoltageText: null
    };
  }
  if (lowBatteryActive) {
    return {
      tone: "critical",
      badgeLabel: "Returning Home",
      detail: "Mission will return to HOME on low battery",
      contextualVoltageText: formatVoltage(
        batteryRecoveredVoltageV ?? batteryLoadedVoltageV
      )
        ? `Return-home trigger active · ${formatVoltage(
            batteryRecoveredVoltageV ?? batteryLoadedVoltageV
          )}`
        : "Return-home trigger active"
    };
  }
  if (batteryReturnHomeRecommended === true || normalizedMissionState === "LOW_ENERGY_GO_HOME") {
    return {
      tone: "critical",
      badgeLabel: "Return Home",
      detail: "Mission will return to HOME on low battery",
      contextualVoltageText: formatVoltage(
        batteryRecoveredVoltageV ?? batteryLoadedVoltageV
      )
        ? `Return-home trigger active · ${formatVoltage(
            batteryRecoveredVoltageV ?? batteryLoadedVoltageV
          )}`
        : "Return-home trigger active"
    };
  }
  if (normalizedBatteryState === "LOW") {
    return {
      tone: "warn",
      badgeLabel: "Watching",
      detail: "Low energy trend detected",
      contextualVoltageText: null
    };
  }
  if (underLoad) {
    return {
      tone: "warn",
      badgeLabel: "Under Load",
      detail: "Voltage sag under traction",
      contextualVoltageText: formatVoltage(batteryLoadedVoltageV)
        ? `Under-load voltage · ${formatVoltage(batteryLoadedVoltageV)}`
        : null
    };
  }
  if (batteryPct === null || !Number.isFinite(batteryPct)) {
    return {
      tone: "off",
      badgeLabel: "Telemetry Lost",
      detail: "Battery telemetry unavailable",
      contextualVoltageText: null
    };
  }
  return {
    tone: "ok",
    badgeLabel: "Normal",
    detail: "Battery stable",
    contextualVoltageText: null
  };
}
