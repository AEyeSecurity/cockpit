import { useEffect, useMemo, useState } from "react";
import { ToolbarMenu, Panel, WorkspacePanel, ConsolePanel, Footer } from "../packages/core";
import type { KeybindingContext } from "../core/keybindings/types";
import { useSlot } from "../core/contributions/useSlot";
import { GlobalDialogHost } from "./layout/GlobalDialogHost";
import { KeybindingHost } from "./layout/KeybindingHost";
import { ModalHost } from "./layout/ModalHost";
import { ZoomHost } from "./layout/ZoomHost";
import { registerShellCommands } from "./shellCommands";
import type { AppRuntime } from "../core/types/module";
import { DIALOG_SERVICE_ID, type DialogService } from "../packages/core/modules/runtime/service/impl/DialogService";
import { SYSTEM_NOTIFICATION_SERVICE_ID, type SystemNotificationService } from "../packages/core/modules/runtime/service/impl/SystemNotificationService";
import { UiZoomController } from "./zoomController";

interface AppShellProps {
  runtime: AppRuntime;
}

interface ConnectionServiceLike {
  getState(): { connected: boolean; lastError: string };
  subscribe(listener: (state: { connected: boolean; lastError: string }) => void): () => void;
}

function isEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

const CONNECTION_SERVICE_ID = "service.connection";

export function AppShell({ runtime }: AppShellProps): JSX.Element {
  const toolbarMenus = useSlot(runtime.contributions, "toolbar");
  const sidebarPanels = useSlot(runtime.contributions, "sidebar");
  const workspaceViews = useSlot(runtime.contributions, "workspace");
  const consoleTabs = useSlot(runtime.contributions, "console");
  const modalDialogs = useSlot(runtime.contributions, "modal");
  const footerItems = useSlot(runtime.contributions, "footer");

  const [activeSidebarId, setActiveSidebarId] = useState<string>(sidebarPanels[0]?.id ?? "");
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>(workspaceViews[0]?.id ?? "");
  const [activeConsoleId, setActiveConsoleId] = useState<string>(consoleTabs[0]?.id ?? "");
  const [activeModalId, setActiveModalId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [consoleCollapsed, setConsoleCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(320);
  const [consoleHeight, setConsoleHeight] = useState(220);
  const [zoomController] = useState(() => new UiZoomController());

  const resolveModalId = (modalId: string): string => {
    if (modalDialogs.some((dialog) => dialog.id === modalId)) return modalId;
    const suffix = `.${modalId}`;
    const namespaced = modalDialogs.find((dialog) => dialog.id.endsWith(suffix));
    return namespaced?.id ?? modalId;
  };

  useEffect(() => {
    const disposables = registerShellCommands(runtime, {
      toggleSidebar: () => setSidebarCollapsed((prev) => !prev),
      toggleConsole: () => setConsoleCollapsed((prev) => !prev),
      openModal: (modalId: string) => setActiveModalId(resolveModalId(modalId)),
      closeModal: () => setActiveModalId(null),
      getActiveModalId: () => activeModalId,
      zoomIn: async () => {
        await zoomController.zoomIn();
      },
      zoomOut: async () => {
        await zoomController.zoomOut();
      },
      zoomReset: async () => {
        await zoomController.zoomReset();
      }
    });
    return () => disposables.forEach((d) => d.dispose());
  }, [runtime, activeModalId, modalDialogs, zoomController]);

  const keybindingContext = useMemo<KeybindingContext>(
    () => ({
      modalOpen: activeModalId !== null,
      editing: false
    }),
    [activeModalId]
  );

  useEffect(() => {
    if (activeSidebarId && sidebarPanels.some((panel) => panel.id === activeSidebarId)) return;
    setActiveSidebarId(sidebarPanels[0]?.id ?? "");
  }, [activeSidebarId, sidebarPanels]);

  useEffect(() => {
    if (activeWorkspaceId && workspaceViews.some((view) => view.id === activeWorkspaceId)) return;
    setActiveWorkspaceId(workspaceViews[0]?.id ?? "");
  }, [activeWorkspaceId, workspaceViews]);

  useEffect(() => {
    if (activeConsoleId && consoleTabs.some((tab) => tab.id === activeConsoleId)) return;
    setActiveConsoleId(consoleTabs[0]?.id ?? "");
  }, [activeConsoleId, consoleTabs]);

  useEffect(() => {
    let notificationService: SystemNotificationService | null = null;
    try {
      notificationService = runtime.getService<SystemNotificationService>(SYSTEM_NOTIFICATION_SERVICE_ID);
    } catch {
      notificationService = null;
    }
    if (!notificationService) return;
    const stop = notificationService.start({ runtime });
    return () => {
      stop();
    };
  }, [runtime]);

  useEffect(() => {
    let connectionService: ConnectionServiceLike | null = null;
    let dialogService: DialogService | null = null;
    try {
      connectionService = runtime.getService<ConnectionServiceLike>(CONNECTION_SERVICE_ID);
      dialogService = runtime.getService<DialogService>(DIALOG_SERVICE_ID);
    } catch {
      connectionService = null;
      dialogService = null;
    }
    if (!connectionService || !dialogService) return;

    let connected = connectionService.getState().connected;
    let notifiedLoss = false;

    const notifyLostConnection = (reason: string): void => {
      if (notifiedLoss) return;
      notifiedLoss = true;
      const detail = reason.trim() ? `\n\nDetalle: ${reason.trim()}` : "";
      void dialogService.alert({
        title: "Conexión perdida",
        message: `Se perdió la conexión con el backend remoto.${detail}`,
        confirmLabel: "Entendido",
        danger: true
      });
    };

    const unsubscribeConnection = connectionService.subscribe((next) => {
      const lostByTransition = connected && !next.connected && next.lastError.trim().length > 0;
      connected = next.connected;
      if (next.connected) {
        notifiedLoss = false;
      } else if (lostByTransition) {
        notifyLostConnection(next.lastError);
      }
    });

    return () => {
      unsubscribeConnection();
    };
  }, [runtime]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isEditingTarget(event.target)) return;

      let dialogService: DialogService | null = null;
      try {
        dialogService = runtime.getService<DialogService>(DIALOG_SERVICE_ID);
      } catch {
        dialogService = null;
      }
      if (dialogService?.getActiveDialog()) {
        if (event.key === "Escape") {
          dialogService.dismiss();
          event.preventDefault();
        }
        return;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [runtime]);

  const startSidebarResize = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (sidebarCollapsed) return;
    event.preventDefault();
    const startX = event.clientX;
    const initial = sidebarWidth;
    const shellBody = event.currentTarget.closest(".shell-body") as HTMLElement | null;
    const onMove = (moveEvent: MouseEvent): void => {
      const maxWidthByViewport = shellBody
        ? Math.max(260, Math.floor(shellBody.getBoundingClientRect().width) - 52 - 4)
        : Number.POSITIVE_INFINITY;
      const next = Math.max(260, Math.min(maxWidthByViewport, initial + (moveEvent.clientX - startX)));
      setSidebarWidth(next);
    };
    const onUp = (): void => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const startConsoleResize = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (consoleCollapsed) return;
    event.preventDefault();
    const startY = event.clientY;
    const initial = consoleHeight;
    const workspaceColumn = event.currentTarget.closest(".workspace-column") as HTMLElement | null;
    const onMove = (moveEvent: MouseEvent): void => {
      const maxHeightByWorkspace = workspaceColumn
        ? Math.max(120, Math.floor(workspaceColumn.getBoundingClientRect().height) - 32 - 4)
        : Number.POSITIVE_INFINITY;
      const next = Math.max(120, Math.min(maxHeightByWorkspace, initial - (moveEvent.clientY - startY)));
      setConsoleHeight(next);
    };
    const onUp = (): void => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const shellBodyColumns = sidebarCollapsed
    ? "52px minmax(0, 1fr)"
    : `52px ${sidebarWidth}px 4px minmax(0, 1fr)`;

  return (
    <div className="shell">
      <ZoomHost controller={zoomController} />
      <KeybindingHost runtime={runtime} context={keybindingContext} />
      <ToolbarMenu runtime={runtime} menus={toolbarMenus} />
      <div
        className="shell-body"
        style={{
          gridTemplateColumns: shellBodyColumns
        }}
      >
        <Panel
          panels={sidebarPanels}
          activePanelId={activeSidebarId}
          onSelectPanel={(id) => {
            if (id === activeSidebarId) {
              setSidebarCollapsed((prev) => !prev);
              return;
            }
            setActiveSidebarId(id);
            setSidebarCollapsed(false);
          }}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed((prev) => !prev)}
          width={sidebarWidth}
          onResizeStart={startSidebarResize}
        />
        <WorkspacePanel views={workspaceViews} activeViewId={activeWorkspaceId} onSelectView={setActiveWorkspaceId}>
          <div
            className={`splitter-horizontal ${consoleCollapsed ? "collapsed" : ""}`}
            onMouseDown={startConsoleResize}
            role="separator"
            aria-orientation="horizontal"
          />
          <ConsolePanel
            tabs={consoleTabs}
            activeTabId={activeConsoleId}
            onSelectTab={setActiveConsoleId}
            collapsed={consoleCollapsed}
            height={consoleCollapsed ? 36 : consoleHeight}
          />
        </WorkspacePanel>
      </div>
      <ModalHost dialogs={modalDialogs} modalId={activeModalId} closeModal={() => setActiveModalId(null)} />
      <GlobalDialogHost runtime={runtime} />
      <Footer
        items={footerItems}
        consoleCollapsed={consoleCollapsed}
        onToggleConsoleCollapse={() => setConsoleCollapsed((prev) => !prev)}
      />
    </div>
  );
}
