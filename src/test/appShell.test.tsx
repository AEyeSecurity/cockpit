import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppShell } from "../app/AppShell";
import { createCommandRegistry } from "../core/commands/commandRegistry";
import { createContributionRegistry } from "../core/contributions/contributionRegistry";
import { createContainer } from "../core/di/container";
import { createEventBus } from "../core/events/eventBus";
import { createKeybindingRegistry } from "../core/keybindings/keybindingRegistry";
import { DispatcherRegistry } from "../core/registries/dispatcherRegistry";
import { ServiceRegistry } from "../core/registries/serviceRegistry";
import { TransportRegistry } from "../core/registries/transportRegistry";
import type { AppRuntime } from "../core/types/module";
import { DispatchRouter } from "../packages/core/modules/runtime/dispatcher/DispatchRouter";
import { TransportManager } from "../packages/core/modules/runtime/transport/manager/TransportManager";

function createRuntime(): AppRuntime {
  const commands = createCommandRegistry();
  const contributions = createContributionRegistry();
  const transportManager = new TransportManager();
  const router = new DispatchRouter(transportManager);
  const services = new ServiceRegistry();
  const dispatchers = new DispatcherRegistry();
  const transports = new TransportRegistry();

  commands.register({ id: "test.shell.openModal", title: "Open Test Modal", category: "Test" }, () =>
    commands.execute("core.shell.openModal", "modal.test")
  );

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
  contributions.register({
    id: "modal.test",
    slot: "modal",
    title: "Test Modal",
    render: () => <div>Modal Body</div>
  });
  contributions.register({
    id: "toolbar.test",
    slot: "toolbar",
    label: "Tools",
    items: [
      {
        id: "open-modal",
        label: "Open modal",
        commandId: "test.shell.openModal"
      }
    ]
  });

  return {
    packageId: "core",
    env: {
      appName: "Cockpit Test",
      wsUrl: "",
      rosbridgeUrl: "",
      httpBaseUrl: "",
      googleMapsApiKey: "",
      cameraIframeUrl: ""
    },
    moduleConfig: { modules: {}, packages: {}, source: "default" },
    container: createContainer(),
    eventBus: createEventBus(),
    transportManager,
    router,
    commands,
    contributions,
    keybindings: createKeybindingRegistry(),
    services,
    dispatchers,
    transports,
    packages: [],
    getService: () => undefined as never,
    getPackageConfig: <T extends Record<string, unknown>>() => ({}) as T,
    setPackageConfig: async () => undefined,
    resetPackageConfig: async () => undefined
  };
}

describe("AppShell", () => {
  it("renders registered hosts and opens modal from toolbar menu", async () => {
    const runtime = createRuntime();
    render(<AppShell runtime={runtime} />);

    expect(screen.getByText("Sidebar One")).toBeInTheDocument();
    expect(screen.getAllByText("Workspace One").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Console One").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByText("Tools"));
    fireEvent.click(screen.getByText("Open modal"));

    expect(await screen.findByText("Test Modal")).toBeInTheDocument();
    expect(screen.getByText("Modal Body")).toBeInTheDocument();
  });

  it("opens modal directly from toolbar button without dropdown", async () => {
    const runtime = createRuntime();
    runtime.commands.register({ id: "test.settings.openModal", title: "Open Settings Modal", category: "Test" }, () =>
      runtime.commands.execute("core.shell.openModal", "modal.test")
    );
    runtime.contributions.register({
      id: "toolbar.settings",
      slot: "toolbar",
      label: "Settings",
      commandId: "test.settings.openModal"
    });

    render(<AppShell runtime={runtime} />);

    fireEvent.click(screen.getByText("Settings"));
    expect(await screen.findByText("Test Modal")).toBeInTheDocument();
  });
});
