import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { bootstrapApp } from "../core/bootstrap/bootstrapApp";
import { NavigationService } from "../packages/nav2/modules/navigation/service/impl/NavigationService";

describe("map workspace HUD", () => {
  it("shows Patrol card above Battery and reflects local patrol readiness", async () => {
    const runtime = await bootstrapApp();
    const workspace = runtime.contributions.get("nav2.workspace.map");
    if (!workspace || workspace.slot !== "workspace") {
      throw new Error("Map workspace contribution not registered");
    }

    const navigationService = runtime.services.getService<NavigationService>("nav2.service.navigation");
    act(() => {
      navigationService.queueWaypoint({ x: 10, y: 10 });
      navigationService.queueWaypoint({ x: 20, y: 20 });
      navigationService.queueWaypoint({ x: 30, y: 30 });
      navigationService.useQueuedWaypointsAsPatrolLoop();
      navigationService.toggleWaypointSelection(2);
      navigationService.setPatrolHomeFromSelected();
      navigationService.clearWaypointSelection();
      navigationService.toggleWaypointSelection(1);
      navigationService.setPatrolDepartEntryFromSelected();
    });

    render(<>{workspace.render()}</>);

    const patrolTitle = screen.getByText("Patrol");
    const batteryTitle = screen.getByText("Battery");
    const readyText = screen.getByText("Ready to start");
    const detailText = screen.getByText("2 loop · home · entry #2");

    expect(patrolTitle).toBeInTheDocument();
    expect(readyText).toBeInTheDocument();
    expect(detailText).toBeInTheDocument();
    expect(
      patrolTitle.compareDocumentPosition(batteryTitle) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });
});
