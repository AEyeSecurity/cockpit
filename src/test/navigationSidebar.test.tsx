import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { bootstrapApp } from "../core/bootstrap/bootstrapApp";
import { NavigationService } from "../packages/nav2/modules/navigation/service/impl/NavigationService";

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
    expect(screen.getByRole("group", { name: "Navigation profile" })).toBeInTheDocument();
    expect(screen.getByText("URBAN")).toBeInTheDocument();
    expect(screen.getByText("RURAL")).toBeInTheDocument();
    expect(screen.getByText("WAYPOINTS")).toBeInTheDocument();
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

    const linearSpeed = screen.getByLabelText("Linear speed");
    fireEvent.change(linearSpeed, { target: { value: "2.4" } });

    const steeringAngle = screen.getByLabelText("Steering angle / turn radius");
    fireEvent.change(steeringAngle, { target: { value: "24" } });

    const navigationService = runtime.services.getService<NavigationService>("nav2.service.navigation");
    expect(navigationService.getState().manualLinearSpeed).toBe(2.4);
    expect(navigationService.getState().manualSteeringAngleDeg).toBe(24);
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
