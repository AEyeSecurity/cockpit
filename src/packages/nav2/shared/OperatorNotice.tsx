import { useEffect, useState, type ReactNode } from "react";
import type { ModuleContext } from "../../../core/types/module";
import type { NavigationService } from "../modules/navigation/service/impl/NavigationService";
import "./operatorNotice.css";

export function useManualControl(runtime: ModuleContext): boolean {
  const [manualControl, setManualControl] = useState(true);

  useEffect(() => {
    if (!runtime.services.has("nav2.service.navigation")) {
      setManualControl(false);
      return;
    }
    return runtime.getService<NavigationService>("nav2.service.navigation").subscribe((state) => {
      setManualControl(state.manualMode || state.manualDisablePending);
    });
  }, [runtime]);

  return manualControl;
}

export function OperatorNotice({ title, tone, children, manualControl, onConfirm, busy = false }: {
  title: string;
  tone: "warn" | "critical";
  children: ReactNode;
  manualControl: boolean;
  onConfirm: () => void;
  busy?: boolean;
}): JSX.Element {
  return (
    <aside className={`nav-rover-access-dialog nav-operator-notice tone-${tone}`}>
      <div role="alert">
        <strong>{title}</strong>
        {children}
      </div>
      <div className="nav-rover-access-actions">
        <button type="button" className="bt prim-btn" disabled={manualControl || busy} onClick={onConfirm}>
          OK
        </button>
      </div>
      {manualControl && <p>Salí del modo manual para confirmar el aviso.</p>}
    </aside>
  );
}
