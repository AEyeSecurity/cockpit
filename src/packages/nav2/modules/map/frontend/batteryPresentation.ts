export type BatteryTone = "ok" | "warn" | "critical" | "off";

export interface BatteryPresentationInput {
  batteryPct: number | null;
  batteryVoltageV: number | null;
  connected: boolean;
  lowBatteryActive: boolean;
  batteryState: string;
  batteryMissionState: string;
  batteryReturnHomeRecommended: boolean | null;
  batteryPresent: boolean | null;
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
    batteryVoltageV,
    connected,
    lowBatteryActive,
    batteryState,
    batteryMissionState,
    batteryReturnHomeRecommended,
    batteryPresent
  } = input;
  const normalizedBatteryState = String(batteryState ?? "").trim().toUpperCase();
  const normalizedMissionState = String(batteryMissionState ?? "").trim().toUpperCase();
  const voltageText = formatVoltage(batteryVoltageV);

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
  if (batteryVoltageV === null) {
    return {
      tone: "off",
      badgeLabel: "Telemetry Lost",
      detail: "Battery telemetry unavailable",
      contextualVoltageText: null
    };
  }
  if (lowBatteryActive) {
    return {
      tone: "critical",
      badgeLabel: "Returning Home",
      detail: "Mission will return to HOME on low battery",
      contextualVoltageText: voltageText ? `Return-home trigger active · ${voltageText}` : "Return-home trigger active"
    };
  }
  if (batteryReturnHomeRecommended === true || normalizedMissionState === "LOW_ENERGY_GO_HOME") {
    return {
      tone: "critical",
      badgeLabel: "Return Home",
      detail: "Mission will return to HOME on low battery",
      contextualVoltageText: voltageText ? `Return-home trigger active · ${voltageText}` : "Return-home trigger active"
    };
  }
  if (normalizedBatteryState === "BELOW_MINIMUM" || (batteryVoltageV !== null && batteryVoltageV < 44.5)) {
    return {
      tone: "critical",
      badgeLabel: "Below Minimum",
      detail: "Battery is below the specified 44.5 V minimum",
      contextualVoltageText: voltageText
    };
  }
  if (normalizedBatteryState === "CRITICAL" || (batteryVoltageV !== null && batteryVoltageV <= 45)) {
    return {
      tone: "critical",
      badgeLabel: "Critical",
      detail: "Battery is at the 45 V controller protection zone",
      contextualVoltageText: voltageText
    };
  }
  if (normalizedBatteryState === "LOW" || (batteryVoltageV !== null && batteryVoltageV <= 47)) {
    return {
      tone: "warn",
      badgeLabel: "Low",
      detail: "Battery is in the low-voltage operating zone",
      contextualVoltageText: voltageText
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
