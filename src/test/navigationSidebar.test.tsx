import { fireEvent, render, screen } from "@testing-library/react";
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
    expect(screen.queryByText("CONTROL MODE")).not.toBeInTheDocument();
    expect(screen.queryByText("NAVIGATION ACTIONS")).not.toBeInTheDocument();
    expect(screen.queryByText("WAYPOINTS")).not.toBeInTheDocument();

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
});
