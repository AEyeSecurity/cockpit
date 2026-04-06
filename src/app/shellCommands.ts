import type { AppRuntime } from "../core/types/module";
import type { Disposable } from "../core/commands/types";

export const ShellCommands = {
  toggleSidebar: "core.shell.toggleSidebar",
  toggleConsole: "core.shell.toggleConsole",
  openModal:     "core.shell.openModal",
  closeModal:    "core.shell.closeModal",
  dismiss:       "core.shell.dismiss"
} as const;

export interface ShellCommandCallbacks {
  toggleSidebar: () => void;
  toggleConsole: () => void;
  openModal: (modalId: string) => void;
  closeModal: () => void;
  getActiveModalId: () => string | null;
}

export function registerShellCommands(
  runtime: AppRuntime,
  callbacks: ShellCommandCallbacks
): Disposable[] {
  const disposables: Disposable[] = [];

  disposables.push(
    runtime.commands.register(
      { id: ShellCommands.toggleSidebar, title: "Toggle Sidebar", category: "Shell" },
      () => callbacks.toggleSidebar()
    )
  );

  disposables.push(
    runtime.commands.register(
      { id: ShellCommands.toggleConsole, title: "Toggle Console", category: "Shell" },
      () => callbacks.toggleConsole()
    )
  );

  disposables.push(
    runtime.commands.register(
      { id: ShellCommands.openModal, title: "Open Modal", category: "Shell" },
      (modalId: unknown) => {
        if (typeof modalId === "string") callbacks.openModal(modalId);
      }
    )
  );

  disposables.push(
    runtime.commands.register(
      { id: ShellCommands.closeModal, title: "Close Modal", category: "Shell" },
      () => callbacks.closeModal()
    )
  );

  disposables.push(
    runtime.commands.register(
      { id: ShellCommands.dismiss, title: "Dismiss", category: "Shell" },
      () => {
        if (callbacks.getActiveModalId()) {
          callbacks.closeModal();
        }
      }
    )
  );

  disposables.push(
    runtime.keybindings.register({
      key: "ctrl+b",
      commandId: ShellCommands.toggleSidebar,
      source: "default"
    })
  );

  disposables.push(
    runtime.keybindings.register({
      key: "ctrl+j",
      commandId: ShellCommands.toggleConsole,
      source: "default"
    })
  );

  disposables.push(
    runtime.keybindings.register({
      key: "escape",
      commandId: ShellCommands.dismiss,
      source: "default",
      when: "modalOpen"
    })
  );

  return disposables;
}
