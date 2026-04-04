import { useEffect, useState } from "react";
import type { CockpitPackage, PackageSettingsSectionContext } from "../../core/types/module";
import { createDebugModule } from "./frontend/debug";
import { createMapModule } from "./frontend/map";
import { createNavigationModule } from "./frontend/navigation";
import { createSettingsModule } from "./frontend/settings";
import { createTelemetryModule } from "./frontend/telemetry";

function prettyJson(value: Record<string, unknown>): string {
  return JSON.stringify(value, null, 2);
}

function Nav2SettingsSection({ config }: PackageSettingsSectionContext): JSX.Element {
  const [draft, setDraft] = useState(() => prettyJson(config));

  useEffect(() => {
    setDraft(prettyJson(config));
  }, [config]);

  return (
    <div className="panel-card">
      <h3>Package nav2</h3>
      <p className="muted">
        Configuración gestionada por <code>config.json</code> del paquete.
      </p>
      <textarea
        className="settings-json-editor"
        value={draft}
        readOnly
        spellCheck={false}
        rows={12}
      />
    </div>
  );
}

export function createPackage(): CockpitPackage {
  return {
    id: "nav2",
    version: "1.0.0",
    enabledByDefault: true,
    modules: [
      createNavigationModule(),
      createTelemetryModule(),
      createMapModule(),
      createDebugModule(),
      createSettingsModule()
    ],
    createSettingsSection: (ctx) => <Nav2SettingsSection {...ctx} />
  };
}
