import type { ReactNode } from "react";
import type { WorkspaceContribution } from "../../../../../core/contributions/types";

interface WorkspacePanelProps {
  views: WorkspaceContribution[];
  activeViewId: string;
  onSelectView: (id: string) => void;
  hideTabs?: boolean;
  children?: ReactNode;
}

function workspaceTabIcon(id: string, label: string): JSX.Element | null {
  const normalized = `${id} ${label}`.toLowerCase();
  const baseProps = {
    viewBox: "0 0 24 24",
    width: 14,
    height: 14,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.9,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const
  };

  if (normalized.includes("map")) {
    return (
      <svg {...baseProps}>
        <path d="M4 6.5 9 4l6 2.5 5-2.5v13.5L15 20l-6-2.5L4 20V6.5Z" />
        <path d="M9 4v13.5" />
        <path d="M15 6.5V20" />
      </svg>
    );
  }

  if (normalized.includes("camera")) {
    return (
      <svg {...baseProps}>
        <rect x="4" y="7" width="11" height="9.5" rx="2" />
        <path d="m15 10 5-2.5v9L15 14" />
      </svg>
    );
  }

  if (normalized.includes("session") || normalized.includes("record")) {
    return (
      <svg {...baseProps}>
        <path d="M8 6h11" />
        <path d="M8 12h11" />
        <path d="M8 18h11" />
        <path d="M4 6h.01" />
        <path d="M4 12h.01" />
        <path d="M4 18h.01" />
      </svg>
    );
  }

  return null;
}

export function WorkspacePanel({ views, activeViewId, onSelectView, hideTabs = false, children }: WorkspacePanelProps): JSX.Element {
  const activeView = views.find((v) => v.id === activeViewId) ?? null;
  const visibleViews = views.filter((view) => view.hiddenFromTabs !== true);

  return (
    <main className="workspace-column ws-col">
      {!hideTabs ? (
        <section className="workspace-selector ws-tabs" aria-label="Workspace tabs">
          {visibleViews.map((view) => (
            <button
              key={view.id}
              type="button"
              className={`ws-tab ${view.id === activeViewId ? "active" : ""}`}
              onClick={() => onSelectView(view.id)}
            >
              <span className="ws-tab-icon" aria-hidden="true">{workspaceTabIcon(view.id, view.label)}</span>
              <span className="ws-tab-label">{view.label}</span>
            </button>
          ))}
        </section>
      ) : null}
      <section className="workspace-view ws-view">
        {activeView ? activeView.render() : "No workspace view registered."}
      </section>
      {children}
    </main>
  );
}
