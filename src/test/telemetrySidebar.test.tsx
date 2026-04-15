import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModuleContext } from "../core/types/module";
import type { SensorInfoState } from "../packages/nav2/modules/navigation/service/impl/SensorInfoService";
import { TelemetrySidebarPanel } from "../packages/nav2/modules/telemetry/frontend";

function createSensorInfoState(
  snapshot: Record<string, unknown>
): SensorInfoState {
  return {
    activeTab: "general",
    open: true,
    intervals: {
      general: 0.1,
      topics: 0.1,
      pixhawk_gps: 0.1,
      lidar: 0.1,
      camera: 0.1
    },
    loading: {
      general: false,
      topics: false,
      pixhawk_gps: false,
      lidar: false,
      camera: false
    },
    implemented: {
      general: true,
      topics: true,
      pixhawk_gps: true,
      lidar: false,
      camera: false
    },
    errors: {
      general: "",
      topics: "",
      pixhawk_gps: "",
      lidar: "",
      camera: ""
    },
    payloads: {
      general: {
        op: "sensor_info",
        tab: "general",
        ok: true,
        implemented: true,
        snapshot
      }
    },
    topics: {
      search: "",
      selectedTopic: "",
      selectedType: "",
      pendingTopic: "",
      historyText: "",
      truncated: false,
      catalog: []
    }
  };
}

describe("TelemetrySidebarPanel", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens sensor info and renders datum, RTK source, and yaw diagnostics from the general snapshot", async () => {
    const sensorInfo = {
      getState: vi.fn(() =>
        createSensorInfoState({
          datum: {
            already_set: true,
            datum_lat: -31.4858037,
            datum_lon: -64.241057,
            last_set_source: "sim_global_v2_fixed",
            last_set_epoch_ms: null
          },
          rtk_source_state: {
            connected: true,
            active_source_label: "RTK FIXED",
            rtcm_age_s: null,
            received_count: null,
            last_error: ""
          },
          diagnostics: {
            yaw_delta_deg: 0.1234,
            diferencias: 0.5678
          }
        })
      ),
      subscribe: vi.fn((listener: (state: SensorInfoState) => void) => {
        listener(sensorInfo.getState());
        return () => undefined;
      }),
      open: vi.fn().mockResolvedValue(undefined),
      setActiveTab: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined)
    };

    const runtime = {
      services: {
        getService: vi.fn((id: string) => {
          if (id === "service.sensor-info") return sensorInfo;
          if (id === "service.navigation" || id === "service.connection") return {};
          throw new Error(`unexpected service ${id}`);
        })
      }
    } as unknown as ModuleContext;

    const { unmount } = render(<TelemetrySidebarPanel runtime={runtime} />);

    await waitFor(() => {
      expect(sensorInfo.open).toHaveBeenCalledTimes(1);
    });
    expect(sensorInfo.setActiveTab).toHaveBeenCalledWith("general");

    expect(screen.getByText("set")).toBeInTheDocument();
    expect(screen.getByText("-31.485804")).toBeInTheDocument();
    expect(screen.getByText("-64.241057")).toBeInTheDocument();
    expect(screen.getByText("sim_global_v2_fixed")).toBeInTheDocument();
    expect(screen.getByText("yes")).toBeInTheDocument();
    expect(screen.getByText("RTK FIXED")).toBeInTheDocument();
    expect(screen.getByText("0.12 deg")).toBeInTheDocument();
    expect(screen.getByText("0.568")).toBeInTheDocument();

    unmount();

    await waitFor(() => {
      expect(sensorInfo.close).toHaveBeenCalledTimes(1);
    });
  });
});
