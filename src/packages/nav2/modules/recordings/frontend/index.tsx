import { lazy } from "react";
import type { CockpitModule, ModuleContext } from "../../../../../core/types/module";
import { ShellCommands } from "../../../../../app/shellCommands";
import { Nav2DispatcherBase } from "../../../protocol/Nav2DispatcherBase";

import { DeferredView } from "../../../shared/DeferredView";

const RecordingsWorkspace = lazy(() => import("./RecordingsWorkspace"));

export class RecordingsDispatcher extends Nav2DispatcherBase {
  async execute(op: string, fields: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const result = await this.request(op, fields, { timeoutMs: 35000 });
    if (result.ok !== true) {
      const detail = String(result.error_code ?? result.error ?? "");
      if (detail.includes("LOCK") || detail.includes("LEASE")) throw new Error("Tomá el control desde Operación para iniciar o detener la grabación manual.");
      throw new Error(result.error === "recordings_not_configured" ? "El servicio de grabaciones no está configurado en el robot." : String(result.error ?? "No se pudo completar la solicitud"));
    }
    return result;
  }
}
export function createRecordingsModule(): CockpitModule {
  return { id: "recordings", version: "1.1.0", enabledByDefault: true, register(ctx: ModuleContext) {
    const dispatcher = new RecordingsDispatcher("dispatcher.recordings", "transport.ws.core");
    ctx.dispatchers.registerDispatcher({ id: dispatcher.id, dispatcher });
    ctx.contributions.register({ id: "sidebar.recordings", slot: "sidebar", label: "Grabaciones",
      render: () => <div className="stack support-sidebar"><div className="panel-card"><h3>Grabaciones</h3><p className="muted">Captura manual y automática durante misiones, con 30 segundos posteriores.</p></div><button type="button" className="button-secondary" onClick={() => void ctx.commands.execute(ShellCommands.openWorkspace, "workspace.recordings", { focused: true })}>Abrir biblioteca y grabación</button></div> });
    ctx.contributions.register({ id: "workspace.recordings", slot: "workspace", label: "Grabaciones", hiddenFromTabs: true, render: () => <DeferredView key="recordings"><RecordingsWorkspace dispatcher={dispatcher} managed={ctx.env.managed} /></DeferredView> });
  } };
}
