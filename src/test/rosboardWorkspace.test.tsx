import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { AppShell } from "../app/AppShell";
import { createCommandRegistry } from "../core/commands/commandRegistry";
import { createContributionRegistry } from "../core/contributions/contributionRegistry";
import { createContainer } from "../core/di/container";
import { createEventBus } from "../core/events/eventBus";
import { createKeybindingRegistry } from "../core/keybindings/keybindingRegistry";
import { DispatcherRegistry } from "../core/registries/dispatcherRegistry";
import { ServiceRegistry } from "../core/registries/serviceRegistry";
import { TransportRegistry } from "../core/registries/transportRegistry";
import type { AppRuntime, ModuleContext } from "../core/types/module";
import { DispatchRouter } from "../packages/core/modules/runtime/dispatcher/DispatchRouter";
import { TransportManager } from "../packages/core/modules/runtime/transport/manager/TransportManager";
import {
  createVisualizationModule,
  RosboardWorkspaceView,
  resolveRosboardIframeUrl
} from "../packages/nav2/modules/visualization/frontend";

function createConnectionService(preset: "real" | "sim") {
  const state = { preset, connected: false, lastError: "", host: "", port: "", connecting: false, txBytes: 0, rxBytes: 0 };
  return {
    getState: () => ({ ...state }),
    subscribe: (listener: (next: typeof state) => void) => {
      listener({ ...state });
      return () => undefined;
    }
  };
}

function createModuleContext(input: {
  preset: "real" | "sim";
  realUrl: string;
  simUrl: string;
  probeTimeoutMs?: number;
  loadTimeoutMs?: number;
}): ModuleContext {
  const connectionService = createConnectionService(input.preset);
  return {
    env: {
      appName: "Cockpit Test",
      wsUrl: "",
      rosbridgeUrl: "",
      httpBaseUrl: "",
      googleMapsApiKey: "",
      cameraIframeUrl: "",
      rosboardIframeUrlReal: input.realUrl,
      rosboardIframeUrlSim: input.simUrl,
      rosboardProbeTimeoutMs: input.probeTimeoutMs ?? 3000,
      rosboardLoadTimeoutMs: input.loadTimeoutMs ?? 7000
    },
    services: {
      getService: () => connectionService
    }
  } as unknown as ModuleContext;
}

function createAppRuntime(): AppRuntime {
  const commands = createCommandRegistry();
  const contributions = createContributionRegistry();
  const transportManager = new TransportManager();
  const router = new DispatchRouter(transportManager);

  contributions.register({
    id: "sidebar.one",
    slot: "sidebar",
    label: "One",
    render: () => <div>Sidebar One</div>
  });
  contributions.register({
    id: "workspace.one",
    slot: "workspace",
    label: "Workspace One",
    render: () => <div>Workspace One</div>
  });
  contributions.register({
    id: "console.one",
    slot: "console",
    label: "Console One",
    render: () => <div>Console One</div>
  });

  return {
    packageId: "core",
    env: {
      appName: "Cockpit Test",
      wsUrl: "",
      rosbridgeUrl: "",
      httpBaseUrl: "",
      googleMapsApiKey: "",
      cameraIframeUrl: "",
      rosboardIframeUrlReal: "",
      rosboardIframeUrlSim: "",
      rosboardProbeTimeoutMs: 3000,
      rosboardLoadTimeoutMs: 7000
    },
    moduleConfig: { modules: {}, packages: {}, source: "default" },
    container: createContainer(),
    eventBus: createEventBus(),
    transportManager,
    router,
    commands,
    contributions,
    keybindings: createKeybindingRegistry(),
    services: new ServiceRegistry(),
    dispatchers: new DispatcherRegistry(),
    transports: new TransportRegistry(),
    packages: [],
    getService: () => undefined as never,
    getPackageConfig: <T extends Record<string, unknown>>() => ({}) as T,
    setPackageConfig: async () => undefined,
    resetPackageConfig: async () => undefined
  };
}

describe("rosboard workspace", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("resolves rosboard URL by preset with sim fallback to real", () => {
    expect(resolveRosboardIframeUrl({ preset: "real", realUrl: "http://real", simUrl: "http://sim" })).toBe("http://real");
    expect(resolveRosboardIframeUrl({ preset: "sim", realUrl: "http://real", simUrl: "http://sim" })).toBe("http://sim");
    expect(resolveRosboardIframeUrl({ preset: "sim", realUrl: "http://real", simUrl: "" })).toBe("http://real");
    expect(resolveRosboardIframeUrl({ preset: "sim", realUrl: "", simUrl: "" })).toBe("");
  });

  it("shows not-configured overlay when both URLs are empty", () => {
    const runtime = createModuleContext({ preset: "real", realUrl: "", simUrl: "" });
    render(<RosboardWorkspaceView runtime={runtime} />);

    expect(screen.getByText(/ROSBoard no configurado/i)).toBeInTheDocument();
  });

  it("shows connecting state while probe is pending", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>(() => {
            // Keep pending.
          })
      )
    );

    const runtime = createModuleContext({ preset: "real", realUrl: "http://localhost:8888", simUrl: "" });
    render(<RosboardWorkspaceView runtime={runtime} />);

    expect(screen.getByText("ROSBoard connecting")).toBeInTheDocument();
  });

  it("transitions to ready after iframe load", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));

    const runtime = createModuleContext({ preset: "real", realUrl: "http://localhost:8888", simUrl: "" });
    render(<RosboardWorkspaceView runtime={runtime} />);

    const frame = await screen.findByTitle("ROSBoard");
    fireEvent.load(frame);

    await waitFor(() => {
      expect(screen.queryByText(/ROSBoard connecting/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/ROSBoard .*error/i)).not.toBeInTheDocument();
    });
  });

  it("shows error when probe request fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("network down"))));

    const runtime = createModuleContext({ preset: "real", realUrl: "http://localhost:8888", simUrl: "" });
    render(<RosboardWorkspaceView runtime={runtime} />);

    await waitFor(() => {
      expect(screen.getByText(/ROSBoard probe failed/i)).toBeInTheDocument();
    });
  });

  it("shows blocked-by-policy timeout when iframe does not load", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));

    const runtime = createModuleContext({
      preset: "real",
      realUrl: "http://localhost:8888",
      simUrl: "",
      loadTimeoutMs: 30
    });
    render(<RosboardWorkspaceView runtime={runtime} />);

    await screen.findByTitle("ROSBoard");
    await waitFor(() => {
      expect(screen.getByText(/ROSBoard blocked by iframe policy or load timeout/i)).toBeInTheDocument();
    });
  });

  it("registers ROSBoard workspace tab in shell", () => {
    const runtime = createAppRuntime();
    createVisualizationModule().register(runtime as unknown as ModuleContext);

    render(<AppShell runtime={runtime} />);

    expect(screen.getByRole("button", { name: "ROSBoard" })).toBeInTheDocument();
  });
});
