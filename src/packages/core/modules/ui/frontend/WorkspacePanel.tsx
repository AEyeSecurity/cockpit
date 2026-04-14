import type { ReactNode } from "react";
import type { WorkspaceContribution } from "../../../../../core/contributions/types";

interface WorkspacePanelProps {
  views: WorkspaceContribution[];
  activeViewId: string;
  onSelectView: (id: string) => void;
  children?: ReactNode;
}

export function WorkspacePanel({ views, activeViewId, onSelectView, children }: WorkspacePanelProps): JSX.Element {
  return (
    <main className="workspace-column">
      <section className="workspace-selector">
        {views.map((view) => (
          <button
            key={view.id}
            type="button"
            className={view.id === activeViewId ? "active" : ""}
            onClick={() => onSelectView(view.id)}
          >
            {view.label}
          </button>
        ))}
      </section>
      <section className="workspace-view">
        <div className="workspace-view-stack">
          {views.map((view) => {
            const active = view.id === activeViewId;
            return (
              <div
                key={view.id}
                className={`workspace-view-pane ${active ? "is-active" : "is-inactive"}`}
                hidden={!active}
                aria-hidden={!active}
              >
                {view.render({ active })}
              </div>
            );
          })}
          {views.length === 0 ? "No workspace view registered." : null}
        </div>
      </section>
      {children}
    </main>
  );
}
