import type { ReactNode } from "react";
import type { WorkspaceContribution } from "../../../../../core/contributions/types";

interface WorkspacePanelProps {
  views: WorkspaceContribution[];
  activeViewId: string;
  onSelectView: (id: string) => void;
  children?: ReactNode;
}

export function WorkspacePanel({ views, activeViewId, onSelectView, children }: WorkspacePanelProps): JSX.Element {
  const activeView = views.find((v) => v.id === activeViewId) ?? null;

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
        {activeView ? activeView.render() : "No workspace view registered."}
      </section>
      {children}
    </main>
  );
}
