import { useEffect, useState } from "react";
import { ConsoleHost } from "./layout/ConsoleHost";
import { ModalHost } from "./layout/ModalHost";
import { SidebarHost } from "./layout/SidebarHost";
import { TopToolbar } from "./layout/TopToolbar";
import { WorkspaceHost } from "./layout/WorkspaceHost";
import type { AppRuntime } from "../core/types/module";
import { NAV_EVENTS } from "../core/events/topics";
import type { NavigationService } from "../services/impl/NavigationService";

interface AppShellProps {
  runtime: AppRuntime;
}

function isEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function AppShell({ runtime }: AppShellProps): JSX.Element {
  const toolbarMenus = runtime.registries.toolbarMenuRegistry.list();
  const sidebarPanels = runtime.registries.sidebarPanelRegistry.list();
  const workspaceViews = runtime.registries.workspaceViewRegistry.list();
  const consoleTabs = runtime.registries.consoleTabRegistry.list();
  const modalDialogs = runtime.registries.modalRegistry.list();

  const [activeSidebarId, setActiveSidebarId] = useState<string>(sidebarPanels[0]?.id ?? "");
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>(workspaceViews[0]?.id ?? "");
  const [activeConsoleId, setActiveConsoleId] = useState<string>(consoleTabs[0]?.id ?? "");
  const [activeModalId, setActiveModalId] = useState<string | null>(null);

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
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isEditingTarget(event.target)) return;

      let navigationService: NavigationService | null = null;
      try {
        navigationService = runtime.registries.serviceRegistry.getService<NavigationService>("service.navigation");
      } catch {
        navigationService = null;
      }

      if (event.key === "Escape") {
        if (!activeModalId) return;
        if (event.shiftKey && activeModalId === "modal.snapshot") {
          runtime.eventBus.emit(NAV_EVENTS.snapshotDownloadRequest, {});
        }
        setActiveModalId(null);
        event.preventDefault();
        return;
      }

      if (event.code === "KeyQ") {
        setActiveModalId("modal.snapshot");
        runtime.eventBus.emit(NAV_EVENTS.snapshotCaptureRequest, {});
        event.preventDefault();
        return;
      }

      if (event.code === "KeyE") {
        runtime.eventBus.emit(NAV_EVENTS.swapWorkspaceRequest, {});
        event.preventDefault();
        return;
      }

      if (event.code === "KeyF" && navigationService) {
        const enabled = navigationService.toggleGoalMode();
        runtime.eventBus.emit("console.event", {
          level: "info",
          text: enabled ? "Goal mode enabled (hotkey)" : "Goal mode disabled (hotkey)",
          timestamp: Date.now()
        });
        event.preventDefault();
        return;
      }

      if (event.code === "KeyM" && navigationService) {
        const current = navigationService.getState().manualMode;
        void navigationService
          .setManualMode(!current)
          .then(() => {
            runtime.eventBus.emit("console.event", {
              level: "info",
              text: !current ? "Manual mode enabled (hotkey)" : "Manual mode disabled (hotkey)",
              timestamp: Date.now()
            });
          })
          .catch((error) => {
            runtime.eventBus.emit("console.event", {
              level: "error",
              text: `Manual mode hotkey failed: ${String(error)}`,
              timestamp: Date.now()
            });
          });
        event.preventDefault();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [activeModalId, runtime]);

  const activeSidebarPanel = sidebarPanels.find((panel) => panel.id === activeSidebarId) ?? null;
  const activeWorkspace = workspaceViews.find((view) => view.id === activeWorkspaceId) ?? null;

  return (
    <div className="shell">
      <TopToolbar runtime={runtime} menus={toolbarMenus} openModal={setActiveModalId} />
      <div className="shell-body">
        <div className="sidebar-selector">
          {sidebarPanels.map((panel) => (
            <button
              key={panel.id}
              type="button"
              className={panel.id === activeSidebarId ? "active" : ""}
              onClick={() => setActiveSidebarId(panel.id)}
            >
              {panel.label}
            </button>
          ))}
        </div>
        <SidebarHost runtime={runtime} panel={activeSidebarPanel} />
        <main className="workspace-column">
          <section className="workspace-selector">
            {workspaceViews.map((view) => (
              <button
                key={view.id}
                type="button"
                className={view.id === activeWorkspaceId ? "active" : ""}
                onClick={() => setActiveWorkspaceId(view.id)}
              >
                {view.label}
              </button>
            ))}
          </section>
          <WorkspaceHost runtime={runtime} view={activeWorkspace} />
          <ConsoleHost
            runtime={runtime}
            tabs={consoleTabs}
            activeTabId={activeConsoleId}
            onSelectTab={setActiveConsoleId}
          />
        </main>
      </div>
      <ModalHost runtime={runtime} dialogs={modalDialogs} modalId={activeModalId} closeModal={() => setActiveModalId(null)} />
    </div>
  );
}
