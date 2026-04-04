import "./styles.css";
import type { CockpitModule, ModuleContext } from "../../../../core/types/module";
import type { LoadedPackage } from "../../../../core/types/module";

function PackageSettingsSection({
  runtime,
  cockpitPackage
}: {
  runtime: ModuleContext;
  cockpitPackage: LoadedPackage;
}): JSX.Element {
  const config = runtime.getPackageConfig<Record<string, unknown>>(cockpitPackage.id);
  if (!cockpitPackage.createSettingsSection) {
    return (
      <div className="panel-card">
        <h3>{cockpitPackage.id}</h3>
        <p className="muted">No package settings section registered.</p>
      </div>
    );
  }
  return (
    <>
      {cockpitPackage.createSettingsSection({
        runtime,
        packageId: cockpitPackage.id,
        config
      })}
    </>
  );
}

function SettingsModal(runtime: ModuleContext): JSX.Element {
  const source = runtime.moduleConfig.source;
  return (
    <div className="stack">
      <div className="panel-card">
        <h3>Settings</h3>
        <p className="muted">Module config source: {source}</p>
      </div>
      {runtime.packages.map((cockpitPackage) => (
        <PackageSettingsSection key={cockpitPackage.id} runtime={runtime} cockpitPackage={cockpitPackage} />
      ))}
    </div>
  );
}

export function createSettingsModule(): CockpitModule {
  return {
    id: "settings",
    version: "1.0.0",
    enabledByDefault: true,
    register(ctx: ModuleContext): void {
      ctx.registries.modalRegistry.registerModalDialog({
        id: "modal.settings",
        title: "Settings",
        order: 20,
        render: () => SettingsModal(ctx)
      });

      ctx.registries.toolbarMenuRegistry.registerToolbarMenu({
        id: "toolbar.settings",
        label: "Settings",
        order: 50,
        items: [
          {
            id: "settings.open-modal",
            label: "Open settings",
            onSelect: ({ openModal }) => openModal("modal.settings")
          }
        ]
      });
    }
  };
}
