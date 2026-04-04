import { beforeEach, describe, expect, it, vi } from "vitest";

const terminalMocks = vi.hoisted(() => ({
  isTerminalRuntimeAvailable: vi.fn(),
  listenTerminalOutput: vi.fn(),
  terminalCloseSession: vi.fn(),
  terminalListSshHosts: vi.fn(),
  terminalResize: vi.fn(),
  terminalStartSession: vi.fn(),
  terminalWrite: vi.fn()
}));

vi.mock("../platform/tauri/terminal", () => terminalMocks);

import { TerminalService } from "../packages/core/modules/terminal/service/impl/TerminalService";

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("terminal service", () => {
  beforeEach(() => {
    terminalMocks.isTerminalRuntimeAvailable.mockReset();
    terminalMocks.listenTerminalOutput.mockReset();
    terminalMocks.terminalCloseSession.mockReset();
    terminalMocks.terminalListSshHosts.mockReset();
    terminalMocks.terminalResize.mockReset();
    terminalMocks.terminalStartSession.mockReset();
    terminalMocks.terminalWrite.mockReset();

    terminalMocks.isTerminalRuntimeAvailable.mockResolvedValue(true);
    terminalMocks.listenTerminalOutput.mockResolvedValue(() => undefined);
    terminalMocks.terminalListSshHosts.mockResolvedValue(["robot-a", "robot-b"]);
    terminalMocks.terminalStartSession.mockImplementation(async ({ host }: { host: string }) => {
      const next = terminalMocks.terminalStartSession.mock.calls.length;
      return {
        sessionId: `session-${next}`,
        host,
        local: host.toLowerCase() === "localhost"
      };
    });
    terminalMocks.terminalCloseSession.mockResolvedValue(true);
    terminalMocks.terminalResize.mockResolvedValue(true);
    terminalMocks.terminalWrite.mockResolvedValue(true);
  });

  it("numbers duplicate host sessions with host (N)", async () => {
    const service = new TerminalService({
      sshConfigPath: "~/.ssh/config",
      defaultHost: "Localhost",
      shellOverride: "",
      scrollback: 5000
    });
    await flush();

    await service.openSession("robot-a");
    await service.openSession("robot-a");

    const labels = service.getState().sessions.map((session) => session.label);
    expect(labels).toEqual(["robot-a (1)", "robot-a (2)"]);
  });

  it("uses default host when opening a session without explicit host", async () => {
    const service = new TerminalService({
      sshConfigPath: "~/.ssh/config",
      defaultHost: "jump-host",
      shellOverride: "",
      scrollback: 5000
    });
    await flush();

    await service.openSession();
    expect(terminalMocks.terminalStartSession).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "jump-host"
      })
    );
  });

  it("falls back safely when terminal runtime is unavailable", async () => {
    terminalMocks.isTerminalRuntimeAvailable.mockResolvedValue(false);
    const service = new TerminalService({
      sshConfigPath: "~/.ssh/config",
      defaultHost: "Localhost",
      shellOverride: "",
      scrollback: 5000
    });
    await flush();

    await service.openSession("Localhost");
    const state = service.getState();
    expect(state.supported).toBe(false);
    expect(state.lastError).toContain("solo en desktop");
    expect(terminalMocks.terminalStartSession).not.toHaveBeenCalled();
  });

  it("shows detailed error when opening a terminal session fails", async () => {
    terminalMocks.terminalStartSession.mockRejectedValue(new Error("spawn failed"));
    const service = new TerminalService({
      sshConfigPath: "~/.ssh/config",
      defaultHost: "Localhost",
      shellOverride: "",
      scrollback: 5000
    });
    await flush();

    await service.openSession("Localhost");
    const state = service.getState();
    expect(state.lastError).toContain("No fue posible iniciar la sesion de terminal");
    expect(state.lastError).toContain("spawn failed");
  });

  it("shows detailed error when writing to active session fails", async () => {
    const service = new TerminalService({
      sshConfigPath: "~/.ssh/config",
      defaultHost: "Localhost",
      shellOverride: "",
      scrollback: 5000
    });
    await flush();
    await service.openSession("Localhost");
    terminalMocks.terminalWrite.mockRejectedValue(new Error("writer not found"));

    await service.writeToActive("echo hola");
    const state = service.getState();
    expect(state.lastError).toContain("No fue posible escribir en la sesion de terminal");
    expect(state.lastError).toContain("writer not found");
  });

  it("shows detailed error when output listener cannot be initialized", async () => {
    terminalMocks.listenTerminalOutput.mockRejectedValue(new Error("listen unavailable"));
    const service = new TerminalService({
      sshConfigPath: "~/.ssh/config",
      defaultHost: "Localhost",
      shellOverride: "",
      scrollback: 5000
    });
    await flush();

    const state = service.getState();
    expect(state.lastError).toContain("No fue posible iniciar el stream de salida de terminal");
    expect(state.lastError).toContain("listen unavailable");
  });
});
