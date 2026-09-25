import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { bootstrapApp } from "../core/bootstrap/bootstrapApp";
import { NavigationService } from "../packages/nav2/modules/navigation/service/impl/NavigationService";

function installLocalStorageMock(): void {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, String(value)),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
      key: (index: number) => Array.from(values.keys())[index] ?? null,
      get length() { return values.size; }
    }
  });
}

describe("navigation sidebar and route editor", () => {
  it("keeps the sidebar focused on the current route and mission controls", async () => {
    const runtime = await bootstrapApp();
    const navigationSidebar = runtime.contributions.get("nav2.sidebar.navigation");
    const routeEditor = runtime.contributions.get("nav2.workspace.route-editor");
    expect(navigationSidebar?.slot).toBe("sidebar");
    if (!routeEditor || routeEditor.slot !== "workspace") throw new Error("Route editor workspace not registered");
    expect(routeEditor.label).toBe("Editor de rutas");
    if (!navigationSidebar || navigationSidebar.slot !== "sidebar") {
      throw new Error("Navigation sidebar contribution not registered");
    }

    render(<>{navigationSidebar.render()}</>);

    expect(screen.getByText("CONTROL MANUAL")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "PERFIL DE NAVEGACIÓN" })).toBeInTheDocument();
    expect(screen.getByText("RUTA ACTUAL")).toBeInTheDocument();
    expect(screen.getByText("RUTA AUTOMÁTICA")).toBeInTheDocument();
    expect(screen.getByText("Borrador nuevo")).toBeInTheDocument();
    expect(screen.getByText("EDITAR / AÑADIR PUNTOS")).toBeInTheDocument();
    expect(screen.getByText("Añade al menos 2 puntos desde el editor.")).toBeInTheDocument();
    expect(screen.getByText("INICIAR RUTA").closest("button")).toBeDisabled();
    expect(screen.getByText("INICIAR PATRULLA").closest("button")).toBeDisabled();
    expect(screen.queryByText("CANCELAR MISIÓN")).not.toBeInTheDocument();
    expect(screen.queryByText("WAYPOINTS")).not.toBeInTheDocument();
    expect(screen.queryByText("WAYPOINT TOOLS")).not.toBeInTheDocument();
    expect(screen.queryByText("ADD WAYPOINT")).not.toBeInTheDocument();
    expect(screen.queryByText("SELECT ALL")).not.toBeInTheDocument();

    const execute = vi.spyOn(runtime.commands, "execute").mockResolvedValue(undefined);
    fireEvent.click(screen.getByText("EDITAR / AÑADIR PUNTOS").closest("button") as HTMLButtonElement);
    expect(execute).toHaveBeenCalledWith("cockpit.shell.openWorkspace", "workspace.route-editor");

    fireEvent.change(screen.getByLabelText("Velocidad lineal"), { target: { value: "2.4" } });
    fireEvent.change(screen.getByLabelText("Ángulo de giro / radio de giro"), { target: { value: "24" } });
    const navigationService = runtime.services.getService<NavigationService>("nav2.service.navigation");
    expect(navigationService.getState().manualLinearSpeed).toBe(2.4);
    expect(navigationService.getState().manualSteeringAngleDeg).toBe(24);
  });

  it("shows the complete saved-route list above the waypoint editor", async () => {
    installLocalStorageMock();
    const runtime = await bootstrapApp();
    const editor = runtime.contributions.get("nav2.workspace.route-editor");
    if (!editor || editor.slot !== "workspace") throw new Error("Route editor workspace not registered");
    const navigationService = runtime.services.getService<NavigationService>("nav2.service.navigation");
    const routeNames = ["PatrullaSencillaPolo", "Ruta bien1", "test real polo", "test1", "test2", "test3", "test4"];
    act(() => {
      navigationService.queueWaypoint({ x: 10, y: 10 });
      for (const name of routeNames) navigationService.saveNamedRoute(name);
    });

    render(<>{editor.render()}</>);

    const savedRoutes = screen.getByText(`Rutas guardadas en Cockpit (${routeNames.length})`).closest("details");
    expect(savedRoutes).not.toHaveAttribute("open");
    fireEvent.click(screen.getByText(`Rutas guardadas en Cockpit (${routeNames.length})`));
    for (const name of routeNames) expect(savedRoutes).toHaveTextContent(name);
    const routePicker = screen.getByRole("combobox", { name: "Abrir ruta guardada" }) as HTMLSelectElement;
    expect(Array.from(routePicker.options).map((option) => option.value).filter(Boolean)).toEqual(routeNames);
  });

  it("restores the connected operator control-lock toggle", async () => {
    const runtime = await bootstrapApp();
    const navigationSidebar = runtime.contributions.get("nav2.sidebar.navigation");
    if (!navigationSidebar || navigationSidebar.slot !== "sidebar") throw new Error("Navigation sidebar contribution not registered");
    render(<>{navigationSidebar.render()}</>);

    const navigationService = runtime.services.getService<NavigationService>("nav2.service.navigation");
    const connectionService = runtime.services.getService<{
      applyTransportStatus: (status: { connected: boolean; intentional: boolean; reason: string }) => void;
    }>("nav2.service.connection");
    act(() => connectionService.applyTransportStatus({ connected: true, intentional: false, reason: "" }));

    const unlock = vi.spyOn(navigationService, "unlockControls").mockImplementation(async () => {
      navigationService.applyLocalControlLock(false, "unlocked");
    });
    const lock = vi.spyOn(navigationService, "lockControls").mockImplementation(async () => {
      navigationService.applyLocalControlLock(true, "locked");
    });
    fireEvent.click(screen.getByText("DESBLOQUEAR CONTROLES").closest("button") as HTMLButtonElement);
    await waitFor(() => expect(unlock).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByText("BLOQUEAR CONTROLES").closest("button") as HTMLButtonElement);
    await waitFor(() => expect(lock).toHaveBeenCalledOnce());
  });

  it("shows only the simple-route action when a regular route can run", async () => {
    const runtime = await bootstrapApp();
    const navigationSidebar = runtime.contributions.get("nav2.sidebar.navigation");
    if (!navigationSidebar || navigationSidebar.slot !== "sidebar") throw new Error("Navigation sidebar contribution not registered");
    const navigationService = runtime.services.getService<NavigationService>("nav2.service.navigation");
    act(() => {
      navigationService.applyLocalControlLock(false, "SIM_BACKEND");
      navigationService.queueWaypoint({ x: 10, y: 10 });
      navigationService.queueWaypoint({ x: 20, y: 20 });
    });

    render(<>{navigationSidebar.render()}</>);

    expect(screen.getByText("INICIAR RUTA").closest("button")).toBeEnabled();
    expect(screen.getByText("INICIAR PATRULLA").closest("button")).toBeDisabled();
    expect(screen.queryByText("CANCELAR MISIÓN")).not.toBeInTheDocument();
    expect(screen.queryByText("VOLVER A HOME")).not.toBeInTheDocument();
  });

  it("shows the empty state and opens the map to place the first point", async () => {
    const runtime = await bootstrapApp();
    const editor = runtime.contributions.get("nav2.workspace.route-editor");
    if (!editor || editor.slot !== "workspace") throw new Error("Route editor workspace not registered");
    const navigationService = runtime.services.getService<NavigationService>("nav2.service.navigation");
    act(() => navigationService.applyLocalControlLock(false, "SIM_BACKEND"));
    const execute = vi.spyOn(runtime.commands, "execute").mockResolvedValue(undefined);

    render(<>{editor.render()}</>);
    expect(screen.getByText("Todavía no hay puntos")).toBeInTheDocument();
    expect(screen.getByText("Para crear una ruta")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Añadir primer punto en el mapa" }));

    await waitFor(() => expect(navigationService.getState().routeEditor.insertionAfterIndex).toBe(-1));
    expect(execute).toHaveBeenCalledWith("cockpit.shell.openWorkspace", "workspace.map");
  });

  it("starts a new route draft without deleting or overwriting the saved route", async () => {
    installLocalStorageMock();
    const runtime = await bootstrapApp();
    const editor = runtime.contributions.get("nav2.workspace.route-editor");
    if (!editor || editor.slot !== "workspace") throw new Error("Route editor workspace not registered");
    const navigationService = runtime.services.getService<NavigationService>("nav2.service.navigation");
    act(() => {
      navigationService.queueWaypoint({ x: 10, y: 20 });
      navigationService.saveNamedRoute("Ruta original");
    });
    render(<>{editor.render()}</>);

    fireEvent.click(screen.getByRole("button", { name: "Nueva ruta" }));
    await waitFor(() => expect(screen.getByText("Todavía no hay puntos")).toBeInTheDocument());
    expect(navigationService.getState().routeEditor.activeRouteName).toBeNull();
    expect(navigationService.getState().savedRouteNames).toContain("Ruta original");
    expect(navigationService.getState().routeEditor.dirty).toBe(false);
    expect(screen.getByRole("combobox", { name: "Abrir ruta guardada" })).toHaveTextContent("Ruta original");
  });

  it("keeps point actions beside a compact list and inserts after the selection", async () => {
    const runtime = await bootstrapApp();
    const editor = runtime.contributions.get("nav2.workspace.route-editor");
    if (!editor || editor.slot !== "workspace") throw new Error("Route editor workspace not registered");
    const navigationService = runtime.services.getService<NavigationService>("nav2.service.navigation");
    act(() => {
      navigationService.applyLocalControlLock(false, "SIM_BACKEND");
      navigationService.queueWaypoint({ x: 10, y: 20 });
      navigationService.queueWaypoint({ x: 11, y: 21 });
    });
    const originalIds = navigationService.getState().waypoints.map((waypoint) => waypoint.localId);
    const execute = vi.spyOn(runtime.commands, "execute").mockResolvedValue(undefined);

    render(<>{editor.render()}</>);
    expect(screen.queryByText("Opciones del punto 1")).not.toBeInTheDocument();
    expect(document.querySelectorAll(".route-editor-insertion-slot")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: /Punto 1.*10\.000000/ }));
    const panel = screen.getByLabelText("Opciones del punto 1");
    expect(panel.parentElement).toHaveClass("route-editor-waypoint-layout");
    fireEvent.change(screen.getByRole("spinbutton", { name: "Ángulo de orientación fija en grados" }), { target: { value: "90" } });
    fireEvent.click(screen.getByRole("button", { name: "Aplicar orientación fija" }));
    expect(navigationService.getState().waypoints[0].yawDeg).toBe(90);
    fireEvent.click(screen.getByRole("button", { name: "Usar orientación automática" }));
    expect(navigationService.getState().waypoints[0].yawDeg).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Insertar entre 1 y 2 en el mapa" }));
    await waitFor(() => expect(navigationService.getState().routeEditor.insertionAfterIndex).toBe(0));
    expect(execute).toHaveBeenCalledWith("cockpit.shell.openWorkspace", "workspace.map");

    act(() => navigationService.insertWaypoint(1, { x: 10.5, y: 20.5 }));
    const state = navigationService.getState();
    expect(state.waypoints.map((waypoint) => waypoint.localId)).toEqual([
      originalIds[0], state.waypoints[1]?.localId, originalIds[1]
    ]);
    expect(state.selectedWaypointIndexes).toEqual([1]);
    expect(state.routeEditor.dirty).toBe(true);
  });

  it("restores area selection and actions for several selected points", async () => {
    const runtime = await bootstrapApp();
    const editor = runtime.contributions.get("nav2.workspace.route-editor");
    if (!editor || editor.slot !== "workspace") throw new Error("Route editor workspace not registered");
    const navigationService = runtime.services.getService<NavigationService>("nav2.service.navigation");
    act(() => {
      navigationService.applyLocalControlLock(false, "SIM_BACKEND");
      navigationService.queueWaypoint({ x: 10, y: 20 });
      navigationService.queueWaypoint({ x: 11, y: 21 });
      navigationService.queueWaypoint({ x: 12, y: 22 });
    });
    const execute = vi.spyOn(runtime.commands, "execute").mockResolvedValue(undefined);
    render(<>{editor.render()}</>);

    fireEvent.click(screen.getByRole("button", { name: "Seleccionar área en el mapa" }));
    await waitFor(() => expect(navigationService.getState().waypointSelectionMode).toBe(true));
    expect(execute).toHaveBeenCalledWith("cockpit.shell.openWorkspace", "workspace.map");

    act(() => navigationService.setWaypointSelection([0, 1], "replace"));
    const panel = screen.getByLabelText("Opciones de puntos");
    expect(panel).toHaveTextContent("2 puntos seleccionados");
    expect(screen.getByRole("button", { name: "Eliminar 2 puntos…" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Usar perfil rural" }));
    expect(navigationService.getState().waypoints[0].actions).toEqual(expect.arrayContaining([expect.objectContaining({ profile: "rural" })]));
    expect(navigationService.getState().waypoints[1].actions).toEqual(expect.arrayContaining([expect.objectContaining({ profile: "rural" })]));
    expect(navigationService.getState().waypoints[2].actions ?? []).toEqual([]);
  });

  it("keeps patrol segment insertion tied to that segment's order", async () => {
    const runtime = await bootstrapApp();
    const editor = runtime.contributions.get("nav2.workspace.route-editor");
    if (!editor || editor.slot !== "workspace") throw new Error("Route editor workspace not registered");
    const navigationService = runtime.services.getService<NavigationService>("nav2.service.navigation");
    act(() => {
      navigationService.applyLocalControlLock(false, "SIM_BACKEND");
      navigationService.queueWaypoint({ x: 10, y: 10 });
      navigationService.queueWaypoint({ x: 20, y: 20 });
      navigationService.queueWaypoint({ x: 30, y: 30 });
      navigationService.useQueuedWaypointsAsPatrolLoop();
      navigationService.reorderPatrolSegment("loop", 1, 0);
    });
    const originalIds = navigationService.getState().waypoints.map((waypoint) => waypoint.localId);
    const execute = vi.spyOn(runtime.commands, "execute").mockResolvedValue(undefined);

    render(<>{editor.render()}</>);
    fireEvent.click(screen.getByRole("list", { name: "Puntos de la ruta" }).querySelectorAll("button")[2]);
    fireEvent.click(screen.getByRole("button", { name: "Insertar entre 3 y 2 en Recorrido principal" }));

    await waitFor(() => expect(navigationService.getState().routeEditor.insertionSegmentIndex).toBe(3));
    expect(navigationService.getState().routeEditor.insertionSegment).toBe("loop");
    expect(navigationService.getState().selectedWaypointIndexes).toEqual([2, 1]);
    expect(execute).toHaveBeenCalledWith("cockpit.shell.openWorkspace", "workspace.map");

    act(() => navigationService.insertWaypoint(3, { x: 31, y: 31 }, { segment: "loop", segmentIndex: 3 }));
    const state = navigationService.getState();
    expect(state.waypoints.slice(0, 3).map((waypoint) => waypoint.localId)).toEqual(originalIds);
    expect(state.patrolMissionProfile.loopWaypoints.map((waypoint) => waypoint.localId)).toEqual([
      originalIds[1], originalIds[0], originalIds[2], state.waypoints[3]?.localId
    ]);
    expect(state.selectedWaypointIndexes).toEqual([3]);
  });

  it("moves patrol segment points without losing the selected re-entry waypoint", async () => {
    const runtime = await bootstrapApp();
    const navigationService = runtime.services.getService<NavigationService>("nav2.service.navigation");
    act(() => {
      navigationService.applyLocalControlLock(false, "SIM_BACKEND");
      navigationService.queueWaypoint({ x: 10, y: 10 });
      navigationService.queueWaypoint({ x: 20, y: 20 });
      navigationService.queueWaypoint({ x: 30, y: 30 });
      navigationService.useQueuedWaypointsAsPatrolLoop();
      navigationService.toggleWaypointSelection(1);
      navigationService.setPatrolDepartEntryFromSelected();
    });
    const before = navigationService.getState().patrolMissionProfile;
    const entryId = before.loopWaypoints[before.departEntryLoopIndex]?.localId;

    act(() => navigationService.reorderPatrolSegment("loop", 0, 2));
    const after = navigationService.getState().patrolMissionProfile;
    expect(after.loopWaypoints[after.departEntryLoopIndex]?.localId).toBe(entryId);
    expect(after.departEntryLoopIndex).toBe(0);
  });

  it("keeps simple route start unavailable when a structured patrol is configured", async () => {
    const runtime = await bootstrapApp();
    const navigationSidebar = runtime.contributions.get("nav2.sidebar.navigation");
    if (!navigationSidebar || navigationSidebar.slot !== "sidebar") throw new Error("Navigation sidebar contribution not registered");
    render(<>{navigationSidebar.render()}</>);
    const navigationService = runtime.services.getService<NavigationService>("nav2.service.navigation");
    act(() => {
      navigationService.applyLocalControlLock(false, "SIM_BACKEND");
      navigationService.queueWaypoint({ x: 10, y: 10 });
      navigationService.queueWaypoint({ x: 20, y: 20 });
      navigationService.queueWaypoint({ x: 30, y: 30 });
      navigationService.toggleWaypointSelection(2);
      navigationService.setPatrolHomeFromSelected();
      navigationService.clearWaypointSelection();
      navigationService.toggleWaypointSelection(0);
      navigationService.toggleWaypointSelection(1);
      navigationService.useQueuedWaypointsAsPatrolLoop();
      navigationService.clearWaypointSelection();
      navigationService.toggleWaypointSelection(1);
      navigationService.setPatrolDepartEntryFromSelected();
    });
    expect(screen.getByText("INICIAR RUTA").closest("button")).toBeDisabled();
    expect(screen.getByText("INICIAR PATRULLA").closest("button")).not.toBeDisabled();
  });

  it("shows missing patrol requirements and lets the selected point lose its re-entry role", async () => {
    const runtime = await bootstrapApp();
    const sidebar = runtime.contributions.get("nav2.sidebar.navigation");
    const editor = runtime.contributions.get("nav2.workspace.route-editor");
    if (!sidebar || sidebar.slot !== "sidebar" || !editor || editor.slot !== "workspace") throw new Error("Navigation UI not registered");
    const service = runtime.services.getService<NavigationService>("nav2.service.navigation");
    act(() => {
      service.applyLocalControlLock(false, "SIM_BACKEND");
      service.queueWaypoint({ x: 10, y: 10 });
      service.queueWaypoint({ x: 20, y: 20 });
      service.queueWaypoint({ x: 30, y: 30 });
      service.toggleWaypointSelection(2);
      service.setPatrolHomeFromSelected();
      service.clearWaypointSelection();
      service.useQueuedWaypointsAsPatrolLoop();
    });
    render(<>{sidebar.render()}{editor.render()}</>);
    const patrolOverview = screen.getByText("Patrulla", { selector: "strong" }).closest("details");
    expect(patrolOverview?.closest("section.route-editor-card")).toBe(screen.getByText("Puntos de la ruta").closest("section.route-editor-card"));
    expect(screen.getByText("INICIAR RUTA").closest("button")).toBeDisabled();
    expect(screen.getByText("INICIAR PATRULLA").closest("button")).toBeDisabled();
    expect(screen.getAllByText(/Falta: punto de reingreso/).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("list", { name: "Puntos de la ruta" }).querySelectorAll("button")[1]);
    fireEvent.click(screen.getByRole("button", { name: "Marcar como reingreso" }));
    expect(service.getState().patrolMissionProfile.departEntryLoopIndex).toBe(1);
    expect(screen.getByRole("button", { name: "Quitar reingreso" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Quitar reingreso" }));
    expect(service.getState().patrolMissionProfile.departEntryLoopIndex).toBe(-1);
    expect(screen.getByText("INICIAR PATRULLA").closest("button")).toBeDisabled();
  });
});
