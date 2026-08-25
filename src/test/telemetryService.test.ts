import { describe, expect, it, vi } from "vitest";
import { TelemetryService } from "../packages/nav2/modules/telemetry/service/impl/TelemetryService";

describe("TelemetryService RTK state", () => {
  it("keeps the active RTK source name and catalog synchronized", () => {
    let onState: ((message: Record<string, unknown>) => void) | undefined;
    let onRtkState: ((message: Record<string, unknown>) => void) | undefined;
    const dispatcher = {
      subscribeRobotStatus: vi.fn(() => () => undefined),
      subscribeState: vi.fn((callback: (message: Record<string, unknown>) => void) => {
        onState = callback;
        return () => undefined;
      }),
      subscribeNavTelemetry: vi.fn(() => () => undefined),
      subscribeNavEvent: vi.fn(() => () => undefined),
      subscribeNavAlerts: vi.fn(() => () => undefined),
      subscribeRobotPose: vi.fn(() => () => undefined),
      subscribeAck: vi.fn(() => () => undefined),
      subscribeRtkSourceState: vi.fn((callback: (message: Record<string, unknown>) => void) => {
        onRtkState = callback;
        return () => undefined;
      })
    };
    const eventBus = {
      on: vi.fn(() => () => undefined)
    };
    const service = new TelemetryService(dispatcher as never, eventBus as never);

    onState?.({
      op: "state",
      rtk_source_state: {
        active_source_id: "casisa",
        active_source_label: "CASISA",
        connected: true
      },
      rtk_sources: [
        {
          id: "casisa",
          label: "CASISA",
          host: "rtk2go.com",
          port: 2101,
          mountpoint: "CASISA"
        }
      ]
    });

    expect(service.getSnapshot()).toMatchObject({
      rtkSourceState: {
        active_source_id: "casisa",
        active_source_label: "CASISA",
        connected: true
      },
      rtkSources: [
        {
          id: "casisa",
          label: "CASISA",
          host: "rtk2go.com",
          port: 2101,
          mountpoint: "CASISA"
        }
      ]
    });

    onRtkState?.({
      op: "rtk_source_state",
      rtk_source_state: {
        active_source_id: "base-sur",
        active_source_label: "Base Sur",
        connected: false
      },
      rtk_sources: [
        { id: "casisa", label: "CASISA" },
        { id: "base-sur", label: "Base Sur" }
      ]
    });

    expect(service.getSnapshot()).toMatchObject({
      rtkSourceState: {
        active_source_id: "base-sur",
        active_source_label: "Base Sur",
        connected: false
      },
      rtkSources: [
        { id: "casisa", label: "CASISA" },
        { id: "base-sur", label: "Base Sur" }
      ]
    });
  });

  it("keeps battery percentage, voltage and state synchronized from nav telemetry", () => {
    let onNavTelemetry: ((message: Record<string, unknown>) => void) | undefined;
    const dispatcher = {
      subscribeRobotStatus: vi.fn(() => () => undefined),
      subscribeState: vi.fn(() => () => undefined),
      subscribeNavTelemetry: vi.fn((callback: (message: Record<string, unknown>) => void) => {
        onNavTelemetry = callback;
        return () => undefined;
      }),
      subscribeNavEvent: vi.fn(() => () => undefined),
      subscribeNavAlerts: vi.fn(() => () => undefined),
      subscribeRobotPose: vi.fn(() => () => undefined),
      subscribeAck: vi.fn(() => () => undefined),
      subscribeRtkSourceState: vi.fn(() => () => undefined)
    };
    const eventBus = {
      on: vi.fn(() => () => undefined)
    };
    const service = new TelemetryService(dispatcher as never, eventBus as never);

    onNavTelemetry?.({
      op: "nav_telemetry",
      connected: true,
      mode: "auto",
      battery_pct: 92.0,
      battery_voltage_v: 61.87,
      battery_state: "OK",
      battery_mission_state: "OK",
      battery_return_home_recommended: false,
      battery_recovered_voltage_v: 61.95,
      battery_loaded_voltage_v: 61.87,
      battery_present: true,
      battery_updated_age_s: 0.6
    });

    expect(service.getSnapshot().robotStatus).toMatchObject({
      batteryPct: 92.0,
      batteryVoltageV: 61.87,
      batteryState: "OK",
      batteryMissionState: "OK",
      batteryReturnHomeRecommended: false,
      batteryRecoveredVoltageV: 61.95,
      batteryLoadedVoltageV: 61.87,
      batteryPresent: true,
      batteryUpdatedAgeS: 0.6,
      mode: "auto",
      connected: true
    });
  });

  it("updates robot position and heading from compact nav telemetry", () => {
    let onNavTelemetry: ((message: Record<string, unknown>) => void) | undefined;
    const dispatcher = {
      subscribeRobotStatus: vi.fn(() => () => undefined),
      subscribeState: vi.fn(() => () => undefined),
      subscribeNavTelemetry: vi.fn((callback: (message: Record<string, unknown>) => void) => {
        onNavTelemetry = callback;
        return () => undefined;
      }),
      subscribeNavEvent: vi.fn(() => () => undefined),
      subscribeNavAlerts: vi.fn(() => () => undefined),
      subscribeRobotPose: vi.fn(() => () => undefined),
      subscribeAck: vi.fn(() => () => undefined),
      subscribeRtkSourceState: vi.fn(() => () => undefined)
    };
    const eventBus = {
      on: vi.fn(() => () => undefined)
    };
    const service = new TelemetryService(dispatcher as never, eventBus as never);

    onNavTelemetry?.({
      op: "nav_telemetry",
      robot_pose: {
        lat: -31.48581,
        lon: -64.24102,
        heading_deg: 127.5
      }
    });

    expect(service.getSnapshot().robotPose).toEqual({
      lat: -31.48581,
      lon: -64.24102,
      headingDeg: 127.5
    });
  });

  it("preserves battery fallback values when extended fields are missing", () => {
    let onNavTelemetry: ((message: Record<string, unknown>) => void) | undefined;
    const dispatcher = {
      subscribeRobotStatus: vi.fn(() => () => undefined),
      subscribeState: vi.fn(() => () => undefined),
      subscribeNavTelemetry: vi.fn((callback: (message: Record<string, unknown>) => void) => {
        onNavTelemetry = callback;
        return () => undefined;
      }),
      subscribeNavEvent: vi.fn(() => () => undefined),
      subscribeNavAlerts: vi.fn(() => () => undefined),
      subscribeRobotPose: vi.fn(() => () => undefined),
      subscribeAck: vi.fn(() => () => undefined),
      subscribeRtkSourceState: vi.fn(() => () => undefined)
    };
    const eventBus = {
      on: vi.fn(() => () => undefined)
    };
    const service = new TelemetryService(dispatcher as never, eventBus as never);

    onNavTelemetry?.({
      op: "nav_telemetry",
      connected: true,
      battery_pct: 75.0,
      battery_voltage_v: 60.4,
      battery_state: "LOW",
      battery_mission_state: "OK",
      battery_return_home_recommended: false,
      battery_recovered_voltage_v: 60.55,
      battery_loaded_voltage_v: 60.2
    });
    onNavTelemetry?.({
      op: "nav_telemetry",
      connected: true,
      battery_pct: 74.0
    });

    expect(service.getSnapshot().robotStatus).toMatchObject({
      batteryPct: 74.0,
      batteryVoltageV: 60.4,
      batteryState: "LOW",
      batteryMissionState: "OK",
      batteryReturnHomeRecommended: false,
      batteryRecoveredVoltageV: 60.55,
      batteryLoadedVoltageV: 60.2,
      connected: true
    });
  });
});
