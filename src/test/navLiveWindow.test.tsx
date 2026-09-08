import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppRuntime } from "../core/types/module";
import {
  NAV_LIVE_REFRESH_MS,
  NavLiveWindow
} from "../packages/nav2/modules/navigation/frontend/NavLiveWindow";
import type { SnapshotData } from "../packages/nav2/modules/navigation/service/impl/NavigationService";

function setVisibilityState(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

function createSnapshot(imageBase64: string): SnapshotData {
  return {
    mime: "image/png",
    imageBase64,
    stamp: Date.now(),
    width: 512,
    height: 512,
    frameId: "map",
    imageSizeBytes: 2048,
    layers: {
      local_costmap: true,
      global_costmap: false,
      keepout_mask: true,
      footprint: true,
      stop_zone: false,
      scan: true,
      plan: true,
      collision_polygons: false,
      global_inset: true
    }
  };
}

function createRuntime(requestSnapshot: ReturnType<typeof vi.fn>): AppRuntime {
  const connection = {
    getState: () => ({
      connected: true,
      connecting: false,
      preset: "real",
      host: "salus",
      port: "8766",
      lastError: "",
      txBytes: 0,
      rxBytes: 0
    }),
    subscribe: vi.fn(() => () => undefined),
    setPreset: vi.fn(),
    setHost: vi.fn(),
    setPort: vi.fn(),
    setClientProfile: vi.fn(),
    connect: vi.fn(() => Promise.resolve())
  };
  const navigation = {
    getState: () => ({ lastSnapshot: null }),
    requestSnapshot
  };
  return {
    env: {
      wsSimHost: "localhost",
      wsDefaultPort: "8766"
    },
    getPackageConfig: () => ({
      ws_sim_host: "localhost",
      ws_sim_port: 8766
    }),
    services: {
      getService: (id: string) => {
        if (id === "service.connection") return connection;
        if (id === "service.navigation") return navigation;
        throw new Error(`Unknown service ${id}`);
      }
    },
    getService: (id: string) => {
      if (id === "service.connection") return connection;
      if (id === "service.navigation") return navigation;
      throw new Error(`Unknown service ${id}`);
    }
  } as unknown as AppRuntime;
}

describe("NavLiveWindow", () => {
  beforeEach(() => {
    setVisibilityState("visible");
  });

  afterEach(() => {
    setVisibilityState("visible");
    vi.useRealTimers();
  });

  it("requests at 1 Hz while visible without overlapping requests", async () => {
    vi.useFakeTimers();
    const pending: Array<{
      resolve: (snapshot: SnapshotData) => void;
      reject: (error: Error) => void;
    }> = [];
    const requestSnapshot = vi.fn(
      () =>
        new Promise<SnapshotData>((resolve, reject) => {
          pending.push({ resolve, reject });
        })
    );

    render(<NavLiveWindow runtime={createRuntime(requestSnapshot)} />);

    expect(requestSnapshot).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(NAV_LIVE_REFRESH_MS);
    });
    expect(requestSnapshot).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending[0].resolve(createSnapshot("AAA"));
      await Promise.resolve();
    });
    expect(screen.getByAltText("Nav2 live snapshot")).toHaveAttribute("src", "data:image/png;base64,AAA");

    await act(async () => {
      vi.advanceTimersByTime(NAV_LIVE_REFRESH_MS);
    });
    expect(requestSnapshot).toHaveBeenCalledTimes(2);

    await act(async () => {
      pending[1].reject(new Error("snapshot unavailable"));
      await Promise.resolve();
    });
    expect(screen.getByText(/Trying simulation localhost:8766/)).toBeInTheDocument();
    expect(screen.getByAltText("Nav2 live snapshot")).toHaveAttribute("src", "data:image/png;base64,AAA");
  });

  it("stops requesting snapshots while hidden", async () => {
    vi.useFakeTimers();
    const requestSnapshot = vi.fn().mockResolvedValue(createSnapshot("AAA"));

    render(<NavLiveWindow runtime={createRuntime(requestSnapshot)} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(requestSnapshot).toHaveBeenCalledTimes(1);

    setVisibilityState("hidden");
    await act(async () => {
      vi.advanceTimersByTime(NAV_LIVE_REFRESH_MS * 3);
    });
    expect(requestSnapshot).toHaveBeenCalledTimes(1);
  });

  it("requests immediately when visible again and resumes at 1 Hz", async () => {
    vi.useFakeTimers();
    const requestSnapshot = vi.fn().mockResolvedValue(createSnapshot("AAA"));

    render(<NavLiveWindow runtime={createRuntime(requestSnapshot)} />);
    await act(async () => {
      await Promise.resolve();
    });
    setVisibilityState("hidden");
    await act(async () => {
      vi.advanceTimersByTime(NAV_LIVE_REFRESH_MS * 2);
    });

    setVisibilityState("visible");
    expect(requestSnapshot).toHaveBeenCalledTimes(2);
    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(NAV_LIVE_REFRESH_MS - 1);
    });
    expect(requestSnapshot).toHaveBeenCalledTimes(2);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(requestSnapshot).toHaveBeenCalledTimes(3);
  });

  it("does not duplicate timers or requests across repeated visibility changes", async () => {
    vi.useFakeTimers();
    const requestSnapshot = vi.fn().mockResolvedValue(createSnapshot("AAA"));

    render(<NavLiveWindow runtime={createRuntime(requestSnapshot)} />);
    await act(async () => {
      await Promise.resolve();
    });
    setVisibilityState("hidden");
    setVisibilityState("visible");
    setVisibilityState("visible");
    setVisibilityState("hidden");
    setVisibilityState("visible");
    expect(requestSnapshot).toHaveBeenCalledTimes(2);

    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(NAV_LIVE_REFRESH_MS);
    });
    expect(requestSnapshot).toHaveBeenCalledTimes(3);
  });

  it("removes visibility listeners and timers on unmount", async () => {
    vi.useFakeTimers();
    const requestSnapshot = vi.fn().mockResolvedValue(createSnapshot("AAA"));
    const { unmount } = render(<NavLiveWindow runtime={createRuntime(requestSnapshot)} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(vi.getTimerCount()).toBe(2);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
    setVisibilityState("hidden");
    setVisibilityState("visible");
    await act(async () => {
      vi.advanceTimersByTime(NAV_LIVE_REFRESH_MS);
    });
    expect(requestSnapshot).toHaveBeenCalledTimes(1);
  });

  it("marks its separate connection as nav-live without acquiring control", () => {
    const requestSnapshot = vi.fn().mockResolvedValue(createSnapshot("AAA"));
    const runtime = createRuntime(requestSnapshot);
    render(<NavLiveWindow runtime={runtime} />);

    const connection = runtime.getService<{ setClientProfile: ReturnType<typeof vi.fn> }>("service.connection");
    expect(connection.setClientProfile).toHaveBeenCalledWith("nav-live");
  });
});
