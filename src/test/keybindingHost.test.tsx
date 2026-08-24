import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { KeybindingHost } from "../app/layout/KeybindingHost";
import type { KeybindingDescriptor } from "../core/keybindings/types";
import type { AppRuntime } from "../core/types/module";

function createRuntime() {
  const execute = vi.fn().mockResolvedValue(undefined);
  const bindings: Record<string, KeybindingDescriptor> = {
    w: {
      key: "w",
      commandId: "nav.manual.w.down",
      source: "default"
    },
    "w:up": {
      key: "w:up",
      commandId: "nav.manual.w.up",
      source: "default"
    }
  };
  const runtime = {
    commands: { execute },
    keybindings: {
      getBindingForKey: (key: string) => bindings[key]
    }
  } as unknown as AppRuntime;
  return { runtime, execute };
}

describe("KeybindingHost", () => {
  it("keeps manual keydown and keyup active while a range slider has focus", () => {
    const { runtime, execute } = createRuntime();
    render(
      <>
        <KeybindingHost runtime={runtime} context={{ modalOpen: false, editing: false }} />
        <input aria-label="manual speed" type="range" />
      </>
    );

    const slider = screen.getByRole("slider", { name: "manual speed" });
    slider.focus();
    fireEvent.keyDown(slider, { code: "KeyW", key: "w" });
    fireEvent.keyUp(slider, { code: "KeyW", key: "w" });

    expect(execute).toHaveBeenNthCalledWith(1, "nav.manual.w.down");
    expect(execute).toHaveBeenNthCalledWith(2, "nav.manual.w.up");
  });

  it("continues blocking global shortcuts while typing in a text input", () => {
    const { runtime, execute } = createRuntime();
    render(
      <>
        <KeybindingHost runtime={runtime} context={{ modalOpen: false, editing: true }} />
        <input aria-label="name" type="text" />
      </>
    );

    const input = screen.getByRole("textbox", { name: "name" });
    input.focus();
    fireEvent.keyDown(input, { code: "KeyW", key: "w" });
    fireEvent.keyUp(input, { code: "KeyW", key: "w" });

    expect(execute).not.toHaveBeenCalled();
  });
});
