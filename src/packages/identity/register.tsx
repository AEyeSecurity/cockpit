import { ShellCommands } from "../../app/shellCommands";
import type { AppRuntime } from "../../core/types/module";
import { api, message, type Session } from "./api";
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
  runtime.commands.register({ id: "identity.logout", title: "Cerrar sesión" }, async () => {
    try {
      await api("session/logout", "POST", {}, session.csrf);
      window.location.reload();
    } catch (error) {
      window.alert(message(error));
    }
  });
  runtime.contributions.register({
    id: "sidebar.identity.logout", slot: "sidebar", label: "Cerrar sesión",
    placement: "secondary", order: 100, command: "identity.logout", render: () => null
  });
  if (session.account.role === "admin") {
    runtime.commands.register({ id: "identity.users.open", title: "Usuarios" },
      () => runtime.commands.execute(ShellCommands.openWorkspace, "identity.users", { focused: true }));
    runtime.contributions.register({
      id: "sidebar.identity.users", slot: "sidebar", label: "Usuarios", order: 100,
      command: "identity.users.open", render: () => null
    });
    runtime.contributions.register({
      id: "identity.users", slot: "workspace", label: "Usuarios", hiddenFromTabs: true, order: 100,
      render: () => <UsersWorkspace session={session} />
    });
  }
}
