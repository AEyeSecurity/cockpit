import type { ModuleContext } from "../../../../../core/types/module";
import { DIALOG_SERVICE_ID, type DialogService } from "../../../../core/modules/runtime/service/impl/DialogService";
import type { NavigationService, NavigationState } from "../service/impl/NavigationService";
import "./routeEditor.css";

export async function openSavedRoute(runtime: ModuleContext, navigation: NavigationService, name: string): Promise<string | undefined> {
  if (!name) return;
  if (navigation.getState().routeEditor.dirty) {
    const dialogs = runtime.services.getService<DialogService>(DIALOG_SERVICE_ID);
    if (!(await dialogs.confirm({
      title: "Cambios sin guardar",
      message: `La ruta tiene cambios sin guardar. Si abrís «${name}», se perderán esos cambios.`,
      confirmLabel: "Abrir ruta",
      cancelLabel: "Cancelar",
      danger: true
    }))) return;
  }
  const count = await navigation.loadNamedRoute(name);
  return `Ruta «${name}» abierta (${count} puntos).`;
}

export function SavedRoutePicker({ state, importing = false, onOpen }: {
  state: NavigationState;
  importing?: boolean;
  onOpen: (name: string) => Promise<void>;
}): JSX.Element {
  const disabled = !state.routeLibrary.connected || state.routeLibrary.busy || importing ||
    state.routeMission.active || state.routeMission.paused || state.patrolMission.active;
  return <label className="route-editor-load-label">
    <select disabled={disabled} aria-label="Abrir ruta guardada" value="" onChange={(event) => void onOpen(event.target.value)}>
      <option value="">Abrir ruta guardada…</option>
      {state.savedRouteNames.map((name) => <option key={name} value={name}>{name}</option>)}
    </select>
  </label>;
}
