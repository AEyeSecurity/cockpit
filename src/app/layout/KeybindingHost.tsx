import { useEffect } from "react";
import type { AppRuntime } from "../../core/types/module";
import type { KeybindingContext, KeybindingDescriptor } from "../../core/keybindings/types";
import { normalizeKeyCombo } from "../../core/keybindings/normalizeKey";

interface KeybindingHostProps {
  runtime: AppRuntime;
  context: KeybindingContext;
}

function isEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  // if (target.closest(".terminal-xterm-host")) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function KeybindingHost({ runtime, context }: KeybindingHostProps): null {
  useEffect(() => {
    const activeHoldBindings = new Map<string, KeybindingDescriptor>();

    const execute = (binding: KeybindingDescriptor): void => {
      void runtime.commands.execute(binding.commandId, ...(binding.args ?? []));
    };

    const releaseHeldBindings = (): void => {
      const bindings = [...activeHoldBindings.values()];
      activeHoldBindings.clear();
      bindings.forEach(execute);
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (isEditingTarget(event.target)) return;

      const key = normalizeKeyCombo(event);
      const binding = runtime.keybindings.getBindingForKey(key, context);
      if (!binding) return;

      event.preventDefault();
      execute(binding);

      const releaseBinding = runtime.keybindings.getBindingForKey(`${key}:up`, context);
      if (releaseBinding) activeHoldBindings.set(key, releaseBinding);
    };

    const onKeyUp = (event: KeyboardEvent): void => {
      const key = normalizeKeyCombo(event) + ":up";
      const activeKey = key.slice(0, -3);
      const binding = activeHoldBindings.get(activeKey);
      if (!binding) return;

      activeHoldBindings.delete(activeKey);
      event.preventDefault();
      execute(binding);
    };

    const onWindowBlur = (): void => {
      releaseHeldBindings();
    };

    const onVisibilityChange = (): void => {
      if (document.visibilityState === "hidden") releaseHeldBindings();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onWindowBlur);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      releaseHeldBindings();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onWindowBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [runtime, context]);

  return null;
}
