import { describe, expect, it } from "vitest";
import { getBatteryPresentation } from "../packages/nav2/modules/map/frontend/batteryPresentation";

const normalInput = {
  batteryPct: 60,
  batteryVoltageV: 50,
  connected: true,
  lowBatteryActive: false,
  batteryState: "OK",
  batteryMissionState: "OK",
  batteryReturnHomeRecommended: false,
  batteryPresent: true
};

describe("batteryPresentation", () => {
  it("marks return-home recommendation clearly before route latch", () => {
    const presentation = getBatteryPresentation({
      ...normalInput,
      batteryPct: 14,
      batteryVoltageV: 46.4,
      batteryMissionState: "LOW_ENERGY_GO_HOME",
      batteryReturnHomeRecommended: true
    });

    expect(presentation.tone).toBe("critical");
    expect(presentation.badgeLabel).toBe("Return Home");
    expect(presentation.detail).toContain("return to HOME");
    expect(presentation.contextualVoltageText).toContain("46.40 V");
  });

  it("marks returning home when low battery is already latched in mission", () => {
    const presentation = getBatteryPresentation({
      ...normalInput,
      batteryPct: 14,
      batteryVoltageV: 46.4,
      lowBatteryActive: true,
      batteryMissionState: "LOW_ENERGY_GO_HOME",
      batteryReturnHomeRecommended: true
    });

    expect(presentation.tone).toBe("critical");
    expect(presentation.badgeLabel).toBe("Returning Home");
  });

  it("marks the 47 V band as low without treating 48 V as low", () => {
    const low = getBatteryPresentation({
      ...normalInput,
      batteryPct: 20,
      batteryVoltageV: 47,
      batteryState: "LOW"
    });
    const normal = getBatteryPresentation({
      ...normalInput,
      batteryPct: 35,
      batteryVoltageV: 48
    });

    expect(low.tone).toBe("warn");
    expect(low.badgeLabel).toBe("Low");
    expect(normal.tone).toBe("ok");
  });

  it("surfaces the VOTOL and Pylontech critical bands", () => {
    const critical = getBatteryPresentation({
      ...normalInput,
      batteryPct: 5,
      batteryVoltageV: 45,
      batteryState: "CRITICAL"
    });
    const belowMinimum = getBatteryPresentation({
      ...normalInput,
      batteryPct: 0,
      batteryVoltageV: 44.4,
      batteryState: "BELOW_MINIMUM"
    });

    expect(critical.badgeLabel).toBe("Critical");
    expect(belowMinimum.badgeLabel).toBe("Below Minimum");
  });

  it("surfaces suspect telemetry as sensor check", () => {
    const presentation = getBatteryPresentation({
      ...normalInput,
      batteryState: "SUSPECT"
    });

    expect(presentation.tone).toBe("off");
    expect(presentation.badgeLabel).toBe("Sensor Check");
  });

  it("falls back to telemetry lost when telemetry is unavailable", () => {
    const presentation = getBatteryPresentation({
      ...normalInput,
      batteryPct: null,
      batteryVoltageV: null,
      connected: false,
      batteryState: "UNAVAILABLE",
      batteryPresent: null
    });

    expect(presentation.tone).toBe("off");
    expect(presentation.badgeLabel).toBe("Telemetry Lost");
  });
});
