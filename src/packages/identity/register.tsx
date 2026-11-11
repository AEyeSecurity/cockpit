import { ShellCommands } from "../../app/shellCommands";
import type { AppRuntime } from "../../core/types/module";
import type { Session } from "./api";
import { SessionActions } from "./SessionGate";
import { UsersWorkspace } from "./UsersWorkspace";

export function registerIdentity(runtime: AppRuntime, session: Session): void {
  runtime.contributions.register({
    id: "modal.identity.account", slot: "modal", title: "Mi cuenta",
    render: () => <SessionActions session={session} />
  });
  runtime.contributions.register({
    id: "identity.account", slot: "footer", align: "right", order: 100,
    render: () => <button className="identity-account-button" type="button"
      onClick={() => void runtime.commands.execute(ShellCommands.openModal, "modal.identity.account")}>
      {session.account.name}
    </button>
  });
  if (session.account.role === "admin") {
    runtime.contributions.register({
      id: "identity.users", slot: "workspace", label: "Usuarios", order: 100,
      render: () => <UsersWorkspace session={session} />
    });
  }
}
