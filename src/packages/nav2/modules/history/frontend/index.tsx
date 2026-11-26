import { lazy } from "react";
import type { CockpitModule } from "../../../../../core/types/module";
import { ShellCommands } from "../../../../../app/shellCommands";
import { Nav2DispatcherBase } from "../../../protocol/Nav2DispatcherBase";
import { DeferredView } from "../../../shared/DeferredView";

const HistoryWorkspace = lazy(() => import("./HistoryWorkspace"));

export class HistoryDispatcher extends Nav2DispatcherBase {
  async read<T>(op: "history_list" | "history_patrol", fields: Record<string, unknown>): Promise<T> {
    const result = await this.request(op, fields, { timeoutMs: 6000 });
    if (result.ok !== true) {
      throw new Error(result.error_code === "unknown_op"
        ? "La versión del robot todavía no ofrece historial."
        : String(result.error ?? "Historial no disponible."));
    }
    return result as T;
  }
}

export function createHistoryModule(): CockpitModule {
  return {
    id: "history", version: "1.0.0", enabledByDefault: true,
    register(ctx) {
      const dispatcher = new HistoryDispatcher("dispatcher.history", "transport.ws.core");
      ctx.dispatchers.registerDispatcher({ id: dispatcher.id, dispatcher });
      ctx.contributions.register({
        id: "sidebar.history", slot: "sidebar", label: "Historial", placement: "secondary",
        render: () => <div className="stack support-sidebar">
          <button type="button" className="button-secondary"
            onClick={() => void ctx.commands.execute(ShellCommands.openWorkspace, "workspace.history", { focused: true })}>
            Abrir historial
          </button>
        </div>
      });
      ctx.contributions.register({
        id: "workspace.history", slot: "workspace", label: "Historial", hiddenFromTabs: true,
        render: () => <DeferredView key="history"><HistoryWorkspace dispatcher={dispatcher} /></DeferredView>
      });
    }
  };
}
