import { beforeEach, describe, expect, it, vi } from "vitest";

const coreMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn()
}));

const eventMocks = vi.hoisted(() => ({
  listen: vi.fn()
}));

vi.mock("@tauri-apps/api/core", () => coreMocks);
vi.mock("@tauri-apps/api/event", () => eventMocks);

import {
  TerminalRuntimeError,
  isTerminalRuntimeAvailable,
  listenTerminalOutput,
  terminalListSshHosts,
  terminalStartSession,
  terminalWrite
} from "../platform/tauri/terminal";

describe("terminal bridge", () => {
  beforeEach(() => {
    coreMocks.invoke.mockReset();
    coreMocks.isTauri.mockReset();
    eventMocks.listen.mockReset();
    coreMocks.isTauri.mockReturnValue(true);
  });

  it("invokes terminal_start_session using camelCase payload fields", async () => {
    coreMocks.invoke.mockResolvedValue({
      session_id: "terminal-1",
      host: "Localhost",
      local: true
    });

    const result = await terminalStartSession({
      host: "Localhost",
      sshConfigPath: "~/.ssh/config",
      shellOverride: "/bin/bash"
    });

    expect(coreMocks.invoke).toHaveBeenCalledWith("terminal_start_session", {
      host: "Localhost",
      sshConfigPath: "~/.ssh/config",
      shellOverride: "/bin/bash"
    });
    expect(result).toEqual({
      sessionId: "terminal-1",
      host: "Localhost",
      local: true
    });
  });

  it("invokes terminal_write using camelCase payload fields", async () => {
    coreMocks.invoke.mockResolvedValue(undefined);

    await terminalWrite("terminal-4", "echo ok\n");
    expect(coreMocks.invoke).toHaveBeenCalledWith("terminal_write", {
      sessionId: "terminal-4",
      data: "echo ok\n"
    });
  });

  it("propagates invoke errors with detail", async () => {
    coreMocks.invoke.mockRejectedValue(new Error("missing required key sessionId"));

    const writePromise = terminalWrite("terminal-4", "pwd\n");
    await expect(writePromise).rejects.toBeInstanceOf(TerminalRuntimeError);
    await expect(writePromise).rejects.toThrow("missing required key sessionId");
  });

  it("respects Tauri runtime detection via isTauri()", async () => {
    coreMocks.isTauri.mockReturnValue(false);
    await expect(isTerminalRuntimeAvailable()).resolves.toBe(false);
    coreMocks.isTauri.mockReturnValue(true);
    await expect(isTerminalRuntimeAvailable()).resolves.toBe(true);
  });

  it("throws when SSH hosts payload is invalid", async () => {
    coreMocks.invoke.mockResolvedValue({ hosts: ["robot-a"] });
    await expect(terminalListSshHosts("~/.ssh/config")).rejects.toThrow("lista de hosts SSH invalida");
  });

  it("propagates listen errors with detail", async () => {
    eventMocks.listen.mockRejectedValue(new Error("event listen denied"));
    const listenPromise = listenTerminalOutput(() => undefined);
    await expect(listenPromise).rejects.toBeInstanceOf(TerminalRuntimeError);
    await expect(listenPromise).rejects.toThrow("event listen denied");
  });
});
