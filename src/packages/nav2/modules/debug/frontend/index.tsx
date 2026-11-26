import { lazy } from "react";
import type { CockpitModule, ModuleContext } from "../../../../../core/types/module";
import { ShellCommands } from "../../../../../app/shellCommands";
import { MissionDispatcher } from "../dispatcher/impl/MissionDispatcher";
import { MissionService } from "../service/impl/MissionService";
import { DeferredView } from "../../../shared/DeferredView";

const TRANSPORT_ID = "transport.ws.core";
const DISPATCHER_ID = "dispatcher.mission";
const SERVICE_ID = "service.mission";
const OPEN_RECORD_MODAL_COMMAND_ID = "nav2.debug.openRecordModal";
const OPEN_SESSIONS_WORKSPACE_COMMAND_ID = "nav2.debug.openSessionsWorkspace";

const RecordModal = lazy(() => import("./DebugViews").then(({ RecordModal }) => ({ default: RecordModal })));
const DebugSidebarPanel = lazy(() => import("./DebugViews").then(({ DebugSidebarPanel }) => ({ default: DebugSidebarPanel })));
export function createDebugModule(): CockpitModule {
  return {
    id: "debug",
    version: "1.1.0",
    enabledByDefault: true,
    register(ctx: ModuleContext): void {
      const dispatcher = new MissionDispatcher(DISPATCHER_ID, TRANSPORT_ID);
      ctx.dispatchers.registerDispatcher({
        id: dispatcher.id,
        dispatcher
      });

      const service = new MissionService(dispatcher);
      ctx.services.registerService({
        id: SERVICE_ID,
        service
      });

      ctx.contributions.register({
        id: "modal.record",
        slot: "modal",
        title: "Record",
        render: () => <DeferredView key="record"><RecordModal runtime={ctx} /></DeferredView>
      });

      ctx.commands.register(
        { id: OPEN_RECORD_MODAL_COMMAND_ID, title: "Open Record Modal", category: "Debug" },
        () => ctx.commands.execute(ShellCommands.openModal, "modal.record")
      );

      ctx.commands.register(
        { id: OPEN_SESSIONS_WORKSPACE_COMMAND_ID, title: "Abrir historial operativo", category: "Debug" },
        () => ctx.commands.execute(ShellCommands.openWorkspace, "workspace.history", { focused: true, toggleFocused: true })
      );

      ctx.contributions.register({
        id: "sidebar.debug",
        slot: "sidebar",
        label: "Diagnóstico",
        placement: "secondary",
        icon: "🛠️",
        order: 100,
        render: () => <DeferredView key="debug"><DebugSidebarPanel runtime={ctx} /></DeferredView>
      });

    }
  };
}
