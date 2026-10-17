import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeybindingHost } from "../app/layout/KeybindingHost";
import { createCommandRegistry } from "../core/commands/commandRegistry";
import { createKeybindingRegistry } from "../core/keybindings/keybindingRegistry";

function createHost() {
  const commands = createCommandRegistry();
  const keybindings = createKeybindingRegistry();
  const events: string[] = [];
  const down = vi.fn(() => { events.push("down"); });
  const up = vi.fn(() => { events.push("up"); });

  commands.register({ id: "manual.down", title: "Manual down" }, down);
  commands.register({ id: "manual.up", title: "Manual up" }, up);
  keybindings.register({ key: "w", commandId: "manual.down", source: "default" });
  keybindings.register({ key: "w:up", commandId: "manual.up", source: "default" });

  const runtime = { commands, keybindings } as never;
  const context = { modalOpen: false, editing: false };
  return { runtime, context, events, down, up };
}

function pressW(): void {
  fireEvent.keyDown(window, { code: "KeyW", key: "w" });
}

afterEach(() => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

describe("KeybindingHost hold safety", () => {
  it("releases an active hold on blur and does not duplicate it on keyup", async () => {
    const host = createHost();
    const { unmount } = render(<KeybindingHost runtime={host.runtime} context={host.context} />);

    pressW();
    fireEvent.blur(window);
    fireEvent.keyUp(window, { code: "KeyW", key: "w" });

    await waitFor(() => expect(host.events).toEqual(["down", "up"]));
    expect(host.down).toHaveBeenCalledTimes(1);
    expect(host.up).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("releases all active holds when the document becomes hidden", async () => {
    const host = createHost();
    const { unmount } = render(<KeybindingHost runtime={host.runtime} context={host.context} />);

    pressW();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    fireEvent(document, new Event("visibilitychange"));

    await waitFor(() => expect(host.events).toEqual(["down", "up"]));
    fireEvent(document, new Event("visibilitychange"));
    fireEvent.keyUp(window, { code: "KeyW", key: "w" });
    expect(host.up).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("releases active holds during cleanup", async () => {
    const host = createHost();
    const { unmount } = render(<KeybindingHost runtime={host.runtime} context={host.context} />);

    pressW();
    unmount();

    await waitFor(() => expect(host.events).toEqual(["down", "up"]));
  });
});
