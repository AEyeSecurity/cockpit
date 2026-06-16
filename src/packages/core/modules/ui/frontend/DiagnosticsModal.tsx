import { useEffect, useState } from "react";
import type { ModuleContext } from "../../../../../core/types/module";
import { useSlot } from "../../../../../core/contributions/useSlot";
import { ConsolePanel } from "./ConsolePanel";

export function DiagnosticsModal({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const consoleTabs = useSlot(runtime.contributions, "console");
  const [activeTabId, setActiveTabId] = useState<string>(consoleTabs[0]?.id ?? "");

  useEffect(() => {
    if (activeTabId && consoleTabs.some((tab) => tab.id === activeTabId)) return;
    setActiveTabId(consoleTabs[0]?.id ?? "");
  }, [activeTabId, consoleTabs]);

  return (
    <div className="diagnostics-modal-root">
      <ConsolePanel
        tabs={consoleTabs}
        activeTabId={activeTabId}
        onSelectTab={setActiveTabId}
        collapsed={false}
        height="100%"
        className="diagnostics-console"
      />
    </div>
  );
}
