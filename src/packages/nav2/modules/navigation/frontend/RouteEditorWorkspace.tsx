import { useEffect, useState } from "react";
import type { ModuleContext } from "../../../../../core/types/module";
import { ShellCommands } from "../../../../../app/shellCommands";
import { DIALOG_SERVICE_ID, type DialogService } from "../../../../core/modules/runtime/service/impl/DialogService";
import { NavigationService, type GoalInput, type NavigationState, type PatrolRouteSegment } from "../service/impl/NavigationService";
import { getPatrolProfileReadiness } from "../patrolProfileReadiness";
import "./routeEditor.css";

const NAVIGATION_SERVICE_ID = "service.navigation";
const EDITOR_WORKSPACE_ID = "workspace.route-editor";
const MAP_WORKSPACE_ID = "workspace.map";

function waypointTags(waypoint: GoalInput, state: NavigationState): string[] {
  const id = waypoint.localId;
  const tags: string[] = [];
  if (waypoint.role === "home" || state.patrolMissionProfile.homeWaypoint?.localId === id) tags.push("HOME");
  if (state.patrolMissionProfile.loopWaypoints.some((item) => item.localId === id)) tags.push("Recorrido");
  if (state.patrolMissionProfile.departWaypoints.some((item) => item.localId === id)) tags.push("Salida");
  if (state.patrolMissionProfile.returnWaypoints.some((item) => item.localId === id)) tags.push("Regreso");
  return tags;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function missingRequirementsText(missing: string[]): string {
  const labels: Record<string, string> = {
    LOOP: "recorrido principal",
    HOME: "punto HOME",
    ENTRY: "punto de reingreso"
  };
  return missing.map((item) => labels[item] ?? item.toLowerCase()).join(", ");
}

export function RouteEditorWorkspace({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const navigation = runtime.services.getService<NavigationService>(NAVIGATION_SERVICE_ID);
  const dialogs = runtime.services.getService<DialogService>(DIALOG_SERVICE_ID);
  const [state, setState] = useState<NavigationState>(navigation.getState());
  const [message, setMessage] = useState("");

  useEffect(() => navigation.subscribe(setState), [navigation]);

  const emitInfo = (text: string): void => {
    runtime.eventBus.emit("console.event", { level: "info", text, timestamp: Date.now() });
  };
  const reportError = (error: unknown): void => {
    setMessage(errorText(error));
    runtime.eventBus.emit("console.event", { level: "error", text: errorText(error), timestamp: Date.now() });
  };
  const openMap = async (
    afterIndex: number | null,
    segment?: { segment: PatrolRouteSegment; segmentIndex: number }
  ): Promise<void> => {
    setMessage("");
    if (state.controlLocked) {
      setMessage(`No se puede editar: ${state.controlLockReason || "los controles están bloqueados"}.`);
      return;
    }
    try {
      if (!state.goalMode) await navigation.setGoalMode(true);
      navigation.setWaypointSelectionMode(false);
      navigation.beginWaypointInsertion(afterIndex ?? state.waypoints.length - 1, segment);
      runtime.commands.execute(ShellCommands.openWorkspace, MAP_WORKSPACE_ID);
    } catch (error) {
      reportError(error);
    }
  };
  const confirmDiscard = async (action: string): Promise<boolean> => {
    if (!state.routeEditor.dirty) return true;
    return dialogs.confirm({
      title: "Cambios sin guardar",
      message: `La ruta tiene cambios sin guardar. ¿Descartarlos para ${action}?`,
      confirmLabel: "Descartar",
      danger: true
    });
  };
  const saveAs = async (): Promise<void> => {
    const name = await dialogs.prompt({
      title: "Guardar ruta en Cockpit",
      message: "Elige un nombre para esta ruta:",
      placeholder: "Por ejemplo, Ronda noche",
      confirmLabel: "Guardar"
    });
    if (name === null) return;
    const trimmed = name.trim();
    if (state.savedRouteNames.includes(trimmed) && trimmed !== state.routeEditor.activeRouteName) {
      const overwrite = await dialogs.confirm({
        title: "Sobrescribir ruta",
        message: `Ya existe «${trimmed}». ¿Quieres reemplazarla?`,
        confirmLabel: "Sobrescribir",
        danger: true
      });
      if (!overwrite) return;
    }
    try {
      const count = navigation.saveNamedRoute(trimmed);
      setMessage(`Ruta «${trimmed}» guardada en Cockpit (${count} puntos).`);
    } catch (error) {
      reportError(error);
    }
  };
  const loadRoute = async (name: string): Promise<void> => {
    if (!name || name === state.routeEditor.activeRouteName) return;
    if (!(await confirmDiscard(`abrir «${name}»`))) return;
    try {
      const count = navigation.loadNamedRoute(name);
      setMessage(`Ruta «${name}» abierta (${count} puntos).`);
    } catch (error) {
      reportError(error);
    }
  };
  const selectWaypoint = (index: number, additive = false): void => {
    if (additive) {
      navigation.toggleWaypointSelection(index);
      return;
    }
    navigation.clearWaypointSelection();
    navigation.toggleWaypointSelection(index);
  };
  const withError = (action: () => void, success?: string): void => {
    setMessage("");
    try {
      action();
      if (success) setMessage(success);
    } catch (error) {
      reportError(error);
    }
  };

  const count = state.waypoints.length;
  const selectedIndex = state.selectedWaypointIndexes.length === 1 ? state.selectedWaypointIndexes[0] : null;
  const selectedWaypoint = selectedIndex === null ? null : state.waypoints[selectedIndex] ?? null;
  const selectionIncludesHome = state.selectedWaypointIndexes.some((index) => state.waypoints[index]?.role === "home");
  const patrolReadiness = getPatrolProfileReadiness(state.patrolMissionProfile);
  const structuredPatrol = patrolReadiness.profileConfigured;
  const editingDisabled = state.controlLocked || state.routeMission.active || state.patrolMission.active;
  const missionReadOnlyMessage = state.controlLocked
    ? `Edición bloqueada: ${state.controlLockReason || "desbloquea el control para modificar la ruta"}.`
    : state.routeMission.active || state.patrolMission.active
      ? "Hay una misión activa. La ruta se muestra en modo consulta hasta que termine o se cancele."
      : "";
  const segmentRows: Array<{ key: PatrolRouteSegment; label: string; points: GoalInput[] }> = [
    { key: "loop", label: "Recorrido principal", points: state.patrolMissionProfile.loopWaypoints },
    { key: "depart", label: "Salida desde HOME", points: state.patrolMissionProfile.departWaypoints },
    { key: "return", label: "Regreso a HOME", points: state.patrolMissionProfile.returnWaypoints }
  ];
  const indexForId = (id: string | undefined): number =>
    state.waypoints.findIndex((waypoint) => waypoint.localId === id);
  const selectedSegmentInsertions = selectedWaypoint ? segmentRows.flatMap((segment) => {
    const segmentIndex = segment.points.findIndex((point) => point.localId === selectedWaypoint.localId);
    if (segmentIndex < 0) return [];
    const nextPoint = segment.points[segmentIndex + 1] ?? (segment.key === "loop" ? segment.points[0] : null);
    const nextIndex = nextPoint ? indexForId(nextPoint.localId) : -1;
    return [{
      segment: segment.key,
      segmentIndex: segmentIndex + 1,
      label: nextIndex >= 0
        ? `Insertar entre ${selectedIndex! + 1} y ${nextIndex + 1} en ${segment.label}`
        : `Añadir después del punto ${selectedIndex! + 1} en ${segment.label}`
    }];
  }) : [];

  return (
    <main className="route-editor" aria-label="Editor de rutas">
      <header className="route-editor-header">
        <div>
          <p className="route-editor-eyebrow">NAVEGACIÓN · PLANIFICACIÓN</p>
          <h1>Editor de rutas</h1>
          <p className="route-editor-subtitle">Organiza los puntos, ajusta la patrulla y guarda la ruta para volver a usarla.</p>
        </div>
        <div className={`route-editor-save-state ${state.routeEditor.dirty ? "is-dirty" : state.routeEditor.activeRouteName ? "is-saved" : "is-new"}`} role="status">
          <span className="route-editor-state-dot" />
          {state.routeEditor.activeRouteName
            ? state.routeEditor.dirty ? "Cambios sin guardar" : "Guardada en Cockpit"
            : state.routeEditor.dirty ? "Borrador con cambios" : "Borrador nuevo"}
        </div>
      </header>

      {missionReadOnlyMessage ? <div className="route-editor-notice" role="status">{missionReadOnlyMessage}</div> : null}
      {message ? <div className="route-editor-message" role="status">{message}</div> : null}

      <section className="route-editor-card route-editor-route-card" aria-labelledby="route-document-title">
        <div className="route-editor-card-heading">
          <div>
            <h2 id="route-document-title">Ruta actual</h2>
            <p>{state.routeEditor.activeRouteName ? `Editando «${state.routeEditor.activeRouteName}»` : "Este borrador todavía no tiene nombre."}</p>
          </div>
          <div className="route-editor-document-actions">
            <button
              type="button"
              className="route-editor-button primary"
              disabled={!state.routeEditor.dirty || !state.routeEditor.activeRouteName}
              onClick={() => withError(() => navigation.saveCurrentNamedRoute(), "Cambios guardados en la ruta actual.")}
            >Guardar cambios</button>
            <button type="button" className="route-editor-button" disabled={count === 0} onClick={() => void saveAs()}>
              Guardar como…
            </button>
            <label className="route-editor-load-label">
              <select aria-label="Abrir ruta guardada" value="" onChange={(event) => void loadRoute(event.target.value)}>
                <option value="">Abrir ruta guardada…</option>
                {state.savedRouteNames.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
            {count > 0 ? <button type="button" className="route-editor-button danger" disabled={editingDisabled} onClick={async () => {
              if (!(await dialogs.confirm({ title: "Borrar puntos de la ruta", message: `Se quitarán los ${count} puntos del borrador actual. ¿Continuar?`, confirmLabel: "Borrar puntos", danger: true }))) return;
              withError(() => navigation.clearWaypoints(), "Se quitaron los puntos del borrador.");
            }}>Borrar puntos…</button> : null}
          </div>
        </div>
        <div className="route-editor-summary">
          <span><strong>{count}</strong> {count === 1 ? "punto" : "puntos"}</span>
          <span><strong>{state.waypoints.filter((waypoint) => waypoint.role === "home").length}</strong> puntos HOME</span>
          <span className={patrolReadiness.isReady ? "ready" : "incomplete"}>
            Patrulla: {patrolReadiness.isReady ? "lista" : `faltan ${missingRequirementsText(patrolReadiness.missingRequirements)}`}
          </span>
        </div>
      </section>

      {state.savedRouteNames.length ? (
        <details className="route-editor-card route-editor-saved-routes">
          <summary>Rutas guardadas en Cockpit ({state.savedRouteNames.length})</summary>
          <ul>
            {state.savedRouteNames.map((name) => <li key={name}>
              <span>{name}{name === state.routeEditor.activeRouteName ? " · abierta" : ""}</span>
              <button type="button" className="route-editor-button" onClick={() => void loadRoute(name)}>Abrir</button>
              <button type="button" className="route-editor-button danger" onClick={async () => {
                if (!(await dialogs.confirm({ title: "Eliminar ruta guardada", message: `¿Eliminar «${name}» de Cockpit?`, confirmLabel: "Eliminar", danger: true }))) return;
                navigation.deleteNamedRoute(name);
                setMessage(`Ruta «${name}» eliminada de Cockpit.`);
              }}>Eliminar</button>
            </li>)}
          </ul>
        </details>
      ) : null}

      <section className="route-editor-card" aria-labelledby="route-waypoints-title">
        <div className="route-editor-card-heading route-editor-waypoints-heading">
          <div>
            <h2 id="route-waypoints-title">Puntos de la ruta</h2>
            <p>Selecciona un punto para ver sus opciones e insertar otro entre tramos en el mapa.</p>
          </div>
          <div className="route-editor-history-actions">
            <button type="button" className="route-editor-button" disabled={!count || editingDisabled} onClick={() => navigation.selectAllWaypoints()}>Seleccionar todos</button>
            <button type="button" className="route-editor-button" disabled={!state.selectedWaypointIndexes.length} onClick={() => navigation.clearWaypointSelection()}>Quitar selección</button>
            <button type="button" className="route-editor-button" disabled={!state.routeEditor.canUndo || editingDisabled} onClick={() => navigation.undoRouteEdit()}>Deshacer</button>
            <button type="button" className="route-editor-button" disabled={!state.routeEditor.canRedo || editingDisabled} onClick={() => navigation.redoRouteEdit()}>Rehacer</button>
            {count > 0 ? <button type="button" className="route-editor-button primary" disabled={editingDisabled} onClick={() => void openMap(null)}>
              Añadir punto al final
            </button> : null}
          </div>
        </div>

        {count === 0 ? (
          <div className="route-editor-empty">
            <div className="route-editor-empty-mark" aria-hidden="true">＋</div>
            <h3>Todavía no hay puntos</h3>
            <p>Añade un punto desde el mapa o abre una ruta guardada para empezar.</p>
            <div className="route-editor-empty-actions">
              <button type="button" className="route-editor-button primary" disabled={editingDisabled} onClick={() => void openMap(null)}>Añadir primer punto en el mapa</button>
              {state.savedRouteNames.length ? <span>También puedes elegir una ruta guardada arriba.</span> : null}
            </div>
          </div>
        ) : (
          <div className="route-editor-waypoint-layout">
            <ol className="route-editor-list" aria-label="Puntos de la ruta">
              {state.waypoints.map((waypoint, index) => {
                const selected = state.selectedWaypointIndexes.includes(index);
                const yaw = waypoint.yawDeg;
                const tags = waypointTags(waypoint, state);
                return (
                  <li key={waypoint.localId ?? `${waypoint.x}-${waypoint.y}-${index}`} className="route-editor-list-item">
                    <div className={`route-editor-waypoint ${selected ? "selected" : ""}`}>
                      <button type="button" className="route-editor-waypoint-select" aria-pressed={selected}
                        onClick={(event) => selectWaypoint(index, event.shiftKey)}>
                        <span className="route-editor-waypoint-number">{index + 1}</span>
                        <span className="route-editor-waypoint-main">
                          <strong>{waypoint.role === "home" ? `Punto ${index + 1} · HOME` : `Punto ${index + 1}`}</strong>
                          <small>{Number(waypoint.x).toFixed(6)}, {Number(waypoint.y).toFixed(6)} · {yaw === undefined ? "Orientación automática" : `Orientación ${Number(yaw).toFixed(1)}°`}</small>
                        </span>
                        <span className="route-editor-waypoint-tags">
                          {tags.map((tag) => <span key={tag} className="route-editor-tag">{tag}</span>)}
                          {(waypoint.actions ?? []).map((action, actionIndex) => (
                            <span key={`${action.type}-${actionIndex}`} className="route-editor-tag action">
                              {action.type === "brake_hold" ? `Pausa ${action.duration_s}s` : action.profile === "rural" ? "Perfil rural" : "Perfil urbano"}
                            </span>
                          ))}
                        </span>
                      </button>
                    </div>
                  </li>
                );
              })}
            </ol>
            <aside className="route-editor-selected-tools" aria-label={selectedWaypoint ? `Opciones del punto ${selectedIndex! + 1}` : "Opciones del punto"}>
              {selectedWaypoint ? (
              <>
                <div>
                  <h3>Opciones del punto {selectedIndex! + 1}</h3>
                  <p>Las opciones se aplican al punto seleccionado.</p>
                </div>
                {!structuredPatrol ? (
                  <button type="button" className="route-editor-button primary route-editor-insert-action" disabled={editingDisabled}
                    onClick={() => void openMap(selectedIndex!)}>
                    {selectedIndex! < count - 1
                      ? `Insertar entre ${selectedIndex! + 1} y ${selectedIndex! + 2} en el mapa`
                      : `Añadir después del punto ${selectedIndex! + 1} en el mapa`}
                  </button>
                ) : selectedSegmentInsertions.length ? (
                  <div className="route-editor-insert-choices">
                    {selectedSegmentInsertions.map((choice) => (
                      <button key={choice.segment} type="button" className="route-editor-button primary"
                        disabled={editingDisabled}
                        onClick={() => void openMap(selectedIndex!, { segment: choice.segment, segmentIndex: choice.segmentIndex })}>
                        {choice.label}
                      </button>
                    ))}
                  </div>
                ) : <p className="route-editor-hint">Este punto no pertenece a un tramo de patrulla.</p>}
                <div className="route-editor-tool-buttons">
                  <button type="button" className="route-editor-button" disabled={editingDisabled || structuredPatrol || selectedIndex === 0}
                    aria-describedby={structuredPatrol ? "route-editor-segment-order-hint" : undefined}
                    onClick={() => navigation.reorderWaypoint(selectedIndex!, selectedIndex! - 1)}>Mover arriba en la lista</button>
                  <button type="button" className="route-editor-button" disabled={editingDisabled || structuredPatrol || selectedIndex === count - 1}
                    aria-describedby={structuredPatrol ? "route-editor-segment-order-hint" : undefined}
                    onClick={() => navigation.reorderWaypoint(selectedIndex!, selectedIndex! + 1)}>Mover abajo en la lista</button>
                  <button type="button" className="route-editor-button" disabled={editingDisabled}
                    onClick={() => withError(() => navigation.setHomeForSelected(), "Punto marcado como HOME.")}>Marcar como HOME</button>
                  <button type="button" className="route-editor-button" disabled={editingDisabled || selectedWaypoint.role !== "home"}
                    onClick={() => withError(() => navigation.clearHomeForSelected(), "Marca HOME quitada.")}>Quitar marca HOME</button>
                  <button type="button" className="route-editor-button danger" disabled={editingDisabled}
                    onClick={async () => {
                      const ok = await dialogs.confirm({ title: "Eliminar punto", message: `¿Eliminar el punto ${selectedIndex! + 1}?`, confirmLabel: "Eliminar", danger: true });
                      if (ok) withError(() => navigation.removeWaypoint(selectedIndex!), "Punto eliminado.");
                    }}>Eliminar punto</button>
                </div>
                {structuredPatrol ? (
                  <p id="route-editor-segment-order-hint" className="route-editor-hint">Para cambiar el orden de ejecución de la patrulla, usa Subir y Bajar en los segmentos. El orden de la lista general se conserva por separado.</p>
                ) : null}
                <div className="route-editor-tool-buttons route-editor-action-buttons">
                  <button type="button" className="route-editor-button" disabled={editingDisabled || selectedWaypoint.role === "home"}
                    onClick={() => withError(() => navigation.setNavigationProfileActionForSelected("urban"), "Perfil urbano asignado.")}>Usar perfil urbano</button>
                  <button type="button" className="route-editor-button" disabled={editingDisabled || selectedWaypoint.role === "home"}
                    onClick={() => withError(() => navigation.setNavigationProfileActionForSelected("rural"), "Perfil rural asignado.")}>Usar perfil rural</button>
                  <button type="button" className="route-editor-button" disabled={editingDisabled || selectedWaypoint.role === "home"}
                    onClick={async () => {
                      const value = await dialogs.prompt({ title: "Pausa en el punto", message: "Segundos que debe esperar el robot:", defaultValue: "5", confirmLabel: "Aplicar" });
                      if (value === null) return;
                      const seconds = Number(value);
                      if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 600) { setMessage("Escribe una duración entre 0 y 600 segundos."); return; }
                      withError(() => navigation.setBrakeHoldActionForSelected(true, seconds), `Pausa de ${seconds} segundos asignada.`);
                    }}>Añadir pausa…</button>
                  <button type="button" className="route-editor-button" disabled={editingDisabled || !(selectedWaypoint.actions?.length)}
                    onClick={() => withError(() => navigation.clearWaypointActionsForSelected(), "Acciones quitadas del punto.")}>Quitar acciones</button>
                </div>
                <p className="route-editor-hint">Mantén Shift para seleccionar varios puntos y asignarlos juntos a un segmento.</p>
              </>
              ) : (
                <div className="route-editor-select-prompt">
                  <h3>Selecciona un punto</h3>
                  <p>Elige un punto de la lista para ver aquí sus opciones y añadir puntos entre tramos.</p>
                </div>
              )}
            </aside>
          </div>
        )}
      </section>

      <section className="route-editor-card" aria-labelledby="patrol-setup-title">
        <div className="route-editor-card-heading">
          <div>
            <h2 id="patrol-setup-title">Configuración de patrulla</h2>
            <p>Define el recorrido, el punto de salida y cómo volver a HOME.</p>
          </div>
          <span className={`route-editor-readiness ${patrolReadiness.isReady ? "ready" : "incomplete"}`}>
            {patrolReadiness.isReady ? "Lista para iniciar" : `Falta: ${missingRequirementsText(patrolReadiness.missingRequirements)}`}
          </span>
        </div>
        <div className="route-editor-patrol-actions">
          <button type="button" className="route-editor-button" disabled={editingDisabled || count < 2}
            onClick={() => withError(() => navigation.useQueuedWaypointsAsPatrolLoop(), "Recorrido principal actualizado con los puntos de la ruta.")}>Usar los puntos de la ruta como recorrido</button>
          <button type="button" className="route-editor-button danger" disabled={editingDisabled || !patrolReadiness.profileConfigured}
            onClick={async () => {
              if (!(await dialogs.confirm({ title: "Borrar configuración de patrulla", message: "Se quitarán HOME y los segmentos de patrulla de esta ruta. ¿Continuar?", confirmLabel: "Borrar configuración", danger: true }))) return;
              withError(() => navigation.clearPatrolMissionProfile(), "Configuración de patrulla borrada.");
            }}>Borrar configuración de patrulla</button>
        </div>
        {state.patrolMissionProfile.homeWaypoint ? (
          <p className="route-editor-home-summary">HOME: punto {indexForId(state.patrolMissionProfile.homeWaypoint.localId) + 1}</p>
        ) : <p className="route-editor-hint">Selecciona un punto de la lista y usa «Marcar como HOME» para definir el inicio y final de la patrulla.</p>}
        <div className="route-editor-segments">
          {segmentRows.map((segment) => (
            <section key={segment.key} className="route-editor-segment" aria-label={segment.label}>
              <div className="route-editor-segment-heading">
                <h3>{segment.label}</h3><span>{segment.points.length} {segment.points.length === 1 ? "punto" : "puntos"}</span>
              </div>
              {segment.points.length ? (
                <ol>
                  {segment.points.map((waypoint, segmentIndex) => {
                    const routeIndex = indexForId(waypoint.localId);
                    const isEntry = segment.key === "loop" && state.patrolMissionProfile.departEntryLoopIndex === segmentIndex;
                    return <li key={waypoint.localId ?? `${segment.key}-${segmentIndex}`}>
                      <button type="button" className="route-editor-segment-point" onClick={() => routeIndex >= 0 && selectWaypoint(routeIndex)}>
                        <span>{segmentIndex + 1}</span><span>Punto {routeIndex + 1}{isEntry ? " · Reingreso" : ""}</span>
                      </button>
                      <div className="route-editor-segment-actions">
                        <button type="button" disabled={editingDisabled || segmentIndex === 0}
                          aria-label={`Mover punto ${segmentIndex + 1} arriba en ${segment.label}`}
                          onClick={() => withError(() => navigation.reorderPatrolSegment(segment.key, segmentIndex, segmentIndex - 1), "Orden de patrulla actualizado.")}>Subir</button>
                        <button type="button" disabled={editingDisabled || segmentIndex === segment.points.length - 1}
                          aria-label={`Mover punto ${segmentIndex + 1} abajo en ${segment.label}`}
                          onClick={() => withError(() => navigation.reorderPatrolSegment(segment.key, segmentIndex, segmentIndex + 1), "Orden de patrulla actualizado.")}>Bajar</button>
                        {routeIndex >= 0 ? <button type="button" disabled={editingDisabled} onClick={() => void openMap(routeIndex, { segment: segment.key, segmentIndex: segmentIndex + 1 })}>
                          {(() => {
                            const nextPoint = segment.points[segmentIndex + 1] ?? (segment.key === "loop" ? segment.points[0] : null);
                            const nextIndex = nextPoint ? indexForId(nextPoint.localId) : -1;
                            return nextIndex >= 0
                              ? `Insertar entre ${routeIndex + 1} y ${nextIndex + 1}`
                              : `Añadir después del punto ${routeIndex + 1}`;
                          })()}
                        </button> : null}
                      </div>
                    </li>;
                  })}
                </ol>
              ) : <p className="route-editor-hint">Todavía no hay puntos en este segmento.</p>}
              {segment.key === "loop" && segment.points.length >= 2 ? (
                <p className="route-editor-hint">{state.patrolMissionProfile.departEntryLoopIndex >= 0 ? `Punto de reingreso: ${state.patrolMissionProfile.departEntryLoopIndex + 1}.` : "Elige el punto de reingreso desde la selección de la lista."}</p>
              ) : null}
            </section>
          ))}
        </div>
        <div className="route-editor-segment-assignments">
          <p>Seleccionados: {state.selectedWaypointIndexes.length || "ninguno"}. Mantén Shift para sumar o quitar puntos.</p>
          <button type="button" className="route-editor-button" disabled={editingDisabled || state.selectedWaypointIndexes.length === 0 || selectionIncludesHome}
            onClick={() => withError(() => navigation.useSelectedWaypointsAsPatrolSegment("depart"), "Salida desde HOME actualizada.")}>Asignar selección a salida</button>
          <button type="button" className="route-editor-button" disabled={editingDisabled || state.selectedWaypointIndexes.length === 0 || selectionIncludesHome}
            onClick={() => withError(() => navigation.useSelectedWaypointsAsPatrolSegment("return"), "Regreso a HOME actualizado.")}>Asignar selección a regreso</button>
          <button type="button" className="route-editor-button" disabled={editingDisabled || state.selectedWaypointIndexes.length !== 1}
            onClick={() => withError(() => navigation.setPatrolDepartEntryFromSelected(), "Punto de reingreso actualizado.")}>Usar selección como reingreso</button>
          <button type="button" className="route-editor-button" disabled={state.selectedWaypointIndexes.length === 0}
            onClick={() => navigation.clearWaypointSelection()}>Quitar selección</button>
        </div>
        <label className="route-editor-loop-toggle">
          <input type="checkbox" checked={state.loopRoute} onChange={(event) => navigation.setLoopRoute(event.target.checked)} />
          Repetir la ruta al terminar
        </label>
      </section>

    </main>
  );
}
