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
    expect(screen.getByText("Route")).toBeInTheDocument();
    expect(screen.getByText("Waypoints")).toBeInTheDocument();
    expect(screen.getByText("START ROUTE")).toBeInTheDocument();
    expect(screen.getByText("CANCEL")).toBeInTheDocument();
    expect(screen.getByText("ADD WAYPOINT")).toBeInTheDocument();
    expect(screen.getByText("WAYPOINT TOOLS")).toBeInTheDocument();
    expect(screen.queryByText("MARK HOME")).not.toBeInTheDocument();
    expect(screen.queryByText("ACTION WAYPOINT")).not.toBeInTheDocument();
    expect(screen.queryByText("CONTROL MODE")).not.toBeInTheDocument();
    expect(screen.queryByText("NAVIGATION ACTIONS")).not.toBeInTheDocument();
    expect(screen.queryByText("WAYPOINTS")).not.toBeInTheDocument();
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

  it("shows HOME and action tools together with correct enablement", async () => {
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
    const brakeButton = screen.getByText("Brake").closest("button");

    expect(setHomeButton).not.toBeNull();
    expect(clearHomeButton).not.toBeNull();
    expect(brakeButton).not.toBeNull();
    expect(setHomeButton).not.toBeDisabled();
    expect(clearHomeButton).toBeDisabled();
    expect(brakeButton).not.toBeDisabled();

    fireEvent.click(setHomeButton as HTMLButtonElement);

    act(() => {
      navigationService.toggleWaypointSelection(0);
      navigationService.toggleWaypointSelection(0);
    });

    fireEvent.click(waypointToolsButton as HTMLButtonElement);

    const updatedSetHomeButton = screen.getByText("Set HOME").closest("button");
    const updatedClearHomeButton = screen.getByText("Clear HOME").closest("button");
    const updatedBrakeButton = screen.getByText("Brake").closest("button");

    expect(updatedSetHomeButton).not.toBeNull();
    expect(updatedClearHomeButton).not.toBeNull();
    expect(updatedBrakeButton).not.toBeNull();
    expect(updatedSetHomeButton?.className).toContain("active");
    expect(updatedClearHomeButton).not.toBeDisabled();
    expect(updatedBrakeButton).toBeDisabled();
  });
});
