import { describe, expect, it } from "vitest";
import { getBatteryPresentation } from "../packages/nav2/modules/map/frontend/batteryPresentation";

describe("batteryPresentation", () => {
  it("marks return-home recommendation clearly before route latch", () => {
    const presentation = getBatteryPresentation({
      batteryPct: 24,
      connected: true,
      lowBatteryActive: false,
      batteryState: "OK",
      batteryMissionState: "LOW_ENERGY_GO_HOME",
      batteryReturnHomeRecommended: true,
      batteryPresent: true,
      batteryRecoveredVoltageV: 56.9,
      batteryLoadedVoltageV: 56.2
    });

    expect(presentation.tone).toBe("critical");
    expect(presentation.badgeLabel).toBe("Return Home");
    expect(presentation.detail).toContain("return to HOME");
    expect(presentation.contextualVoltageText).toContain("56.90 V");
  });

  it("marks returning home when low battery already latched in mission", () => {
    const presentation = getBatteryPresentation({
      batteryPct: 18,
      connected: true,
      lowBatteryActive: true,
      batteryState: "OK",
      batteryMissionState: "LOW_ENERGY_GO_HOME",
      batteryReturnHomeRecommended: true,
      batteryPresent: true,
      batteryRecoveredVoltageV: 56.8,
      batteryLoadedVoltageV: 56.0
    });

    expect(presentation.tone).toBe("critical");
    expect(presentation.badgeLabel).toBe("Returning Home");
  });

  it("detects under-load sag separately from low battery", () => {
    const presentation = getBatteryPresentation({
      batteryPct: 88,
      connected: true,
      lowBatteryActive: false,
      batteryState: "OK",
      batteryMissionState: "OK",
      batteryReturnHomeRecommended: false,
      batteryPresent: true,
      batteryRecoveredVoltageV: 60.1,
      batteryLoadedVoltageV: 59.4
    });

    expect(presentation.tone).toBe("warn");
    expect(presentation.badgeLabel).toBe("Under Load");
    expect(presentation.detail).toBe("Voltage sag under traction");
    expect(presentation.contextualVoltageText).toContain("59.40 V");
  });

  it("surfaces suspect telemetry as sensor check", () => {
    const presentation = getBatteryPresentation({
      batteryPct: 88,
      connected: true,
      lowBatteryActive: false,
      batteryState: "SUSPECT",
      batteryMissionState: "",
      batteryReturnHomeRecommended: null,
      batteryPresent: true,
      batteryRecoveredVoltageV: null,
      batteryLoadedVoltageV: null
    });

    expect(presentation.tone).toBe("off");
    expect(presentation.badgeLabel).toBe("Sensor Check");
  });

  it("falls back to telemetry lost when telemetry is unavailable", () => {
    const presentation = getBatteryPresentation({
      batteryPct: null,
      connected: false,
      lowBatteryActive: false,
      batteryState: "UNAVAILABLE",
      batteryMissionState: "",
      batteryReturnHomeRecommended: null,
      batteryPresent: null,
      batteryRecoveredVoltageV: null,
      batteryLoadedVoltageV: null
    });

    expect(presentation.tone).toBe("off");
    expect(presentation.badgeLabel).toBe("Telemetry Lost");
  });
});
