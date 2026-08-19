import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { bootstrapApp } from "../core/bootstrap/bootstrapApp";
import { NavigationService } from "../packages/nav2/modules/navigation/service/impl/NavigationService";
import { CoverageService } from "../packages/nav2/modules/navigation/service/impl/CoverageService";
import { ConnectionService } from "../packages/nav2/modules/navigation/service/impl/ConnectionService";

describe("navigation sidebar", () => {
  it("groups manual controls and automatic route actions in the sidebar", async () => {
    const runtime = await bootstrapApp();
    const navigationSidebar = runtime.contributions.get("nav2.sidebar.navigation");
    expect(navigationSidebar?.slot).toBe("sidebar");
    if (!navigationSidebar || navigationSidebar.slot !== "sidebar") {
      throw new Error("Navigation sidebar contribution not registered");
    }

    render(<>{navigationSidebar.render()}</>);

    expect(screen.getByText("MANUAL CONTROL")).toBeInTheDocument();
    expect(screen.getByText("AUTOMATIC ROUTE")).toBeInTheDocument();
    expect(screen.getByText("WAYPOINTS")).toBeInTheDocument();
    expect(screen.getByText("CAMPO")).toBeInTheDocument();
    expect(screen.getByText("GESTIÓN DE RUTAS")).toBeInTheDocument();
    expect(screen.getByText("Route")).toBeInTheDocument();
    expect(screen.getByText("Waypoints")).toBeInTheDocument();
    expect(screen.getByText("START ROUTE")).toBeInTheDocument();
    expect(screen.getByText("CANCEL")).toBeInTheDocument();
    expect(screen.getByText("ADD WAYPOINT")).toBeInTheDocument();
    expect(screen.getByText("WAYPOINT TOOLS")).toBeInTheDocument();
    expect(screen.getByText("Patrol Mission")).toBeInTheDocument();
    expect(screen.getByText("USE LOOP")).toBeInTheDocument();
    expect(screen.getByText("SET HOME")).toBeInTheDocument();
    expect(screen.queryByText("SET RETURN")).not.toBeInTheDocument();
    expect(screen.queryByText("SET DEPART")).not.toBeInTheDocument();
    expect(screen.queryByText("SET ENTRY")).not.toBeInTheDocument();
    expect(screen.queryByText("MARK HOME")).not.toBeInTheDocument();
    expect(screen.queryByText("ACTION WAYPOINT")).not.toBeInTheDocument();
    expect(screen.queryByText("CONTROL MODE")).not.toBeInTheDocument();
    expect(screen.queryByText("NAVIGATION ACTIONS")).not.toBeInTheDocument();
    expect(screen.queryByText("PATROL")).not.toBeInTheDocument();

    const routeHeading = screen.getByText("Route");
    const waypointsHeading = screen.getByText("Waypoints");
    expect(routeHeading.compareDocumentPosition(waypointsHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const waypointsSectionHeading = screen.getByText("WAYPOINTS");
    const fieldSectionHeading = screen.getByText("CAMPO");
    const routesSectionHeading = screen.getByText("GESTIÓN DE RUTAS");
    expect(
      waypointsSectionHeading.compareDocumentPosition(fieldSectionHeading) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      fieldSectionHeading.compareDocumentPosition(routesSectionHeading) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    const linearSpeed = screen.getByLabelText("Linear speed");
    fireEvent.change(linearSpeed, { target: { value: "2.4" } });

    const steeringAngle = screen.getByLabelText("Steering angle / turn radius");
    fireEvent.change(steeringAngle, { target: { value: "24" } });

    const navigationService = runtime.services.getService<NavigationService>("nav2.service.navigation");
    expect(navigationService.getState().manualLinearSpeed).toBe(2.4);
    expect(navigationService.getState().manualSteeringAngleDeg).toBe(24);
  });

  it("offers the square field workflow without unlocking movement", async () => {
    const runtime = await bootstrapApp();
    const navigationSidebar = runtime.contributions.get("nav2.sidebar.navigation");
    if (!navigationSidebar || navigationSidebar.slot !== "sidebar") {
      throw new Error("Navigation sidebar contribution not registered");
    }

    render(<>{navigationSidebar.render()}</>);
    fireEvent.click(screen.getByText("CAMPO").closest("button") as HTMLButtonElement);

    const coverageService = runtime.services.getService<CoverageService>("nav2.service.coverage");
    // El lote es siempre un cuadrado armado desde el vehiculo: no hay dibujo,
    // ni interruptor de forma, ni campo de ancho.
    expect(screen.queryByRole("checkbox", { name: /campo cuadrado/i })).toBeNull();
    expect(screen.queryByText("DIBUJAR CAMPO")).toBeNull();

    act(() => {
      coverageService.squareFromVehiclePose(
        { lat: -31.4859, lon: -64.2425, yawDeg: 0 },
        { sideM: 20 }
      );
    });

    const state = coverageService.getState();
    expect(state.fieldPolygon).toHaveLength(4);
    expect(state.field?.fieldWidthM).toBeCloseTo(state.field?.fieldLengthM ?? 0, 6);
    expect(screen.getByLabelText(/lado exacto del campo/i)).toBeInTheDocument();
    expect(screen.getByText("INVERTIR INICIO")).toBeInTheDocument();

    const previewButton = screen.getByText("GENERAR PREVIEW").closest("button");
    const startButton = screen.getByText("INICIAR COBERTURA").closest("button");
    expect(previewButton).not.toBeDisabled();
    expect(startButton).toBeDisabled();

    expect(screen.queryByLabelText(/ancho exacto del campo/i)).toBeNull();
    // Escribir el lado mueve los dos lados a la vez.
    fireEvent.change(screen.getByLabelText(/lado exacto del campo/i), { target: { value: "26" } });
    expect(coverageService.getState().field?.fieldLengthM).toBeCloseTo(26, 6);
    expect(coverageService.getState().field?.fieldWidthM).toBeCloseTo(26, 6);
  });

  it("adelanta el trazado antes de pedir el preview", async () => {
    const runtime = await bootstrapApp();
    const navigationSidebar = runtime.contributions.get("nav2.sidebar.navigation");
    if (!navigationSidebar || navigationSidebar.slot !== "sidebar") {
      throw new Error("Navigation sidebar contribution not registered");
    }

    render(<>{navigationSidebar.render()}</>);
    fireEvent.click(screen.getByText("CAMPO").closest("button") as HTMLButtonElement);

    const coverageService = runtime.services.getService<CoverageService>("nav2.service.coverage");

    // El lote se arma por el modo legacy, que es el que trae la estimacion
    // analitica del zigzag. Desde el cockpit el lote se dibuja como poligono y
    // ya no hay atajo que deje un cuadrado en el mapa.
    act(() => {
      coverageService.squareFromVehiclePose(
        { lat: -31.4859, lon: -64.2425, yawDeg: 0 },
        { sideM: 20 }
      );
      coverageService.setParameters({ cutterWidthM: 5, overlapRatio: 0, minTurningRadiusM: 4 });
    });

    const state = coverageService.getState();
    expect(state.field?.fieldLengthM).toBeCloseTo(20, 3);
    expect(state.preview).toBeNull();

    // La estimacion aparece sin haber pedido el preview.
    const estimate = screen.getByLabelText(/estimación del trazado/i);
    expect(estimate).toBeInTheDocument();
    expect(within(estimate).getByText("Pasadas").nextSibling).toHaveTextContent("4");
    expect(within(estimate).getByText("Giros omega").nextSibling).toHaveTextContent("3");
    expect(screen.getByText(/necesitan .* libres más allá de cada extremo/i)).toBeInTheDocument();

    // Y sigue siendo el preview el que habilita el inicio.
    expect(screen.getByText("INICIAR COBERTURA").closest("button")).toBeDisabled();
  });

  it("invalidates coverage preview state when the connection endpoint changes", async () => {
    const runtime = await bootstrapApp();
    const coverageService = runtime.services.getService<CoverageService>("nav2.service.coverage");
    const connectionService = runtime.services.getService<ConnectionService>("nav2.service.connection");
    const invalidatePreview = vi.spyOn(coverageService, "invalidatePreview");

    connectionService.setHost("coverage-endpoint.example");

    expect(invalidatePreview).toHaveBeenCalledWith(expect.stringMatching(/conexión|endpoint/i));
  });

  it("shows HOME, patrol, and action tools together with correct enablement", async () => {
    const runtime = await bootstrapApp();
    const navigationSidebar = runtime.contributions.get("nav2.sidebar.navigation");
    if (!navigationSidebar || navigationSidebar.slot !== "sidebar") {
      throw new Error("Navigation sidebar contribution not registered");
    }

    render(<>{navigationSidebar.render()}</>);

    const navigationService = runtime.services.getService<NavigationService>("nav2.service.navigation");
    act(() => {
      navigationService.applyLocalControlLock(false, "SIM_BACKEND");
      navigationService.queueWaypoint({ x: 10, y: 10 });
      navigationService.queueWaypoint({ x: 20, y: 20 });
    });

    const waypointToolsButton = screen.getByText("WAYPOINT TOOLS").closest("button");
    expect(waypointToolsButton).not.toBeNull();
    expect(waypointToolsButton).toBeDisabled();

    act(() => {
      navigationService.toggleWaypointSelection(0);
    });

    expect(waypointToolsButton).not.toBeDisabled();
    fireEvent.click(waypointToolsButton as HTMLButtonElement);

    const setHomeButton = screen.getByText("Set HOME").closest("button");
    const clearHomeButton = screen.getByText("Clear HOME").closest("button");
    const setReturnButton = screen.getByText("Set RETURN").closest("button");
    const clearReturnButton = screen.getByText("Clear RETURN").closest("button");
    const setDepartButton = screen.getByText("Set DEPART").closest("button");
    const clearDepartButton = screen.getByText("Clear DEPART").closest("button");
    const setEntryButton = screen.getByText("Set ENTRY").closest("button");
    const brakeButton = screen.getByText("Brake").closest("button");

    expect(setHomeButton).not.toBeNull();
    expect(clearHomeButton).not.toBeNull();
    expect(setReturnButton).not.toBeNull();
    expect(clearReturnButton).not.toBeNull();
    expect(setDepartButton).not.toBeNull();
    expect(clearDepartButton).not.toBeNull();
    expect(setEntryButton).not.toBeNull();
    expect(brakeButton).not.toBeNull();
    expect(setHomeButton).not.toBeDisabled();
    expect(clearHomeButton).toBeDisabled();
    expect(setReturnButton).not.toBeDisabled();
    expect(clearReturnButton).toBeDisabled();
    expect(setDepartButton).not.toBeDisabled();
    expect(clearDepartButton).toBeDisabled();
    expect(setEntryButton).toBeDisabled();
    expect(brakeButton).not.toBeDisabled();

    fireEvent.click(setHomeButton as HTMLButtonElement);
    act(() => {
      navigationService.clearWaypointSelection();
      navigationService.toggleWaypointSelection(1);
    });

    fireEvent.click(waypointToolsButton as HTMLButtonElement);
    const reopenedSetReturnButton = screen.getByText("Set RETURN").closest("button");
    expect(reopenedSetReturnButton).not.toBeNull();
    fireEvent.click(reopenedSetReturnButton as HTMLButtonElement);
    fireEvent.click(waypointToolsButton as HTMLButtonElement);

    const updatedSetHomeButton = screen.getByText("Set HOME").closest("button");
    const updatedClearHomeButton = screen.getByText("Clear HOME").closest("button");
    const updatedSetReturnButton = screen.getByText("Set RETURN").closest("button");
    const updatedClearReturnButton = screen.getByText("Clear RETURN").closest("button");
    const updatedBrakeButton = screen.getByText("Brake").closest("button");

    expect(updatedSetHomeButton).not.toBeNull();
    expect(updatedClearHomeButton).not.toBeNull();
    expect(updatedSetReturnButton).not.toBeNull();
    expect(updatedClearReturnButton).not.toBeNull();
    expect(updatedBrakeButton).not.toBeNull();
    expect(updatedSetHomeButton?.className).not.toContain("active");
    expect(updatedClearHomeButton).toBeDisabled();
    expect(updatedClearReturnButton).not.toBeDisabled();
    expect(updatedBrakeButton).not.toBeDisabled();
  });

  it("provides select all, clear selection, and map area selection controls", async () => {
    const runtime = await bootstrapApp();
    const navigationSidebar = runtime.contributions.get("nav2.sidebar.navigation");
    if (!navigationSidebar || navigationSidebar.slot !== "sidebar") {
      throw new Error("Navigation sidebar contribution not registered");
    }

    render(<>{navigationSidebar.render()}</>);
    const navigationService = runtime.services.getService<NavigationService>("nav2.service.navigation");
    act(() => {
      navigationService.applyLocalControlLock(false, "SIM_BACKEND");
      navigationService.queueWaypoint({ x: 10, y: 10 });
      navigationService.queueWaypoint({ x: 20, y: 20 });
    });

    fireEvent.click(screen.getByText("SELECT ALL").closest("button") as HTMLButtonElement);
    expect(navigationService.getState().selectedWaypointIndexes).toEqual([0, 1]);

    fireEvent.click(screen.getByText("SELECT AREA").closest("button") as HTMLButtonElement);
    expect(navigationService.getState().waypointSelectionMode).toBe(true);

    fireEvent.click(screen.getByText("CLEAR SEL.").closest("button") as HTMLButtonElement);
    expect(navigationService.getState().selectedWaypointIndexes).toEqual([]);
  });

  it("blocks simple route start when a structured patrol profile is configured", async () => {
    const runtime = await bootstrapApp();
    const navigationSidebar = runtime.contributions.get("nav2.sidebar.navigation");
    if (!navigationSidebar || navigationSidebar.slot !== "sidebar") {
      throw new Error("Navigation sidebar contribution not registered");
    }

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

    const startRouteButton = screen.getByText("START ROUTE").closest("button");
    const startPatrolButton = screen.getByText("START PATROL").closest("button");

    expect(startRouteButton).not.toBeNull();
    expect(startPatrolButton).not.toBeNull();
    expect(startRouteButton).toBeDisabled();
    expect(startPatrolButton).not.toBeDisabled();
    expect(screen.getByText("Structured patrol loaded: use START PATROL")).toBeInTheDocument();
  });

  it("shows exactly which patrol requirements are missing", async () => {
    const runtime = await bootstrapApp();
    const navigationSidebar = runtime.contributions.get("nav2.sidebar.navigation");
    if (!navigationSidebar || navigationSidebar.slot !== "sidebar") {
      throw new Error("Navigation sidebar contribution not registered");
    }

    render(<>{navigationSidebar.render()}</>);

    const navigationService = runtime.services.getService<NavigationService>("nav2.service.navigation");
    act(() => {
      navigationService.applyLocalControlLock(false, "SIM_BACKEND");
    });

    expect(screen.getByText("Missing: LOOP, HOME, ENTRY")).toBeInTheDocument();

    act(() => {
      navigationService.queueWaypoint({ x: 10, y: 10 });
      navigationService.queueWaypoint({ x: 20, y: 20 });
      navigationService.queueWaypoint({ x: 30, y: 30 });
      navigationService.useQueuedWaypointsAsPatrolLoop();
    });

    expect(screen.getByText("Missing: HOME, ENTRY")).toBeInTheDocument();

    act(() => {
      navigationService.toggleWaypointSelection(2);
      navigationService.setPatrolHomeFromSelected();
      navigationService.clearWaypointSelection();
    });

    expect(screen.getByText("Missing: ENTRY")).toBeInTheDocument();

    act(() => {
      navigationService.toggleWaypointSelection(1);
      navigationService.setPatrolDepartEntryFromSelected();
    });

    expect(screen.getByText("2 loop · home · entry #2")).toBeInTheDocument();
  });
});
