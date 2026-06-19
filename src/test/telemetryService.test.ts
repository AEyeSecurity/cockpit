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
});
