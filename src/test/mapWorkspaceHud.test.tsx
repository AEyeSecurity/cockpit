import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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

  it("clears waypoint selection and exits area selection mode with Escape", async () => {
    const runtime = await bootstrapApp();
    const workspace = runtime.contributions.get("nav2.workspace.map");
    if (!workspace || workspace.slot !== "workspace") {
      throw new Error("Map workspace contribution not registered");
    }

    const navigationService = runtime.services.getService<NavigationService>("nav2.service.navigation");
    act(() => {
      navigationService.queueWaypoint({ x: 10, y: 10 });
      navigationService.queueWaypoint({ x: 20, y: 20 });
      navigationService.setWaypointSelection([0, 1]);
      navigationService.setWaypointSelectionMode(true);
    });

    render(<>{workspace.render()}</>);
    fireEvent.keyDown(window, { key: "Escape" });

    expect(navigationService.getState().selectedWaypointIndexes).toEqual([]);
    expect(navigationService.getState().waypointSelectionMode).toBe(false);
  });

  it("explains the insertion gap and returns to the editor when placement is cancelled", async () => {
    const runtime = await bootstrapApp();
    const workspace = runtime.contributions.get("nav2.workspace.map");
    if (!workspace || workspace.slot !== "workspace") throw new Error("Map workspace contribution not registered");
    const navigationService = runtime.services.getService<NavigationService>("nav2.service.navigation");
    act(() => {
      navigationService.applyLocalControlLock(false, "SIM_BACKEND");
      navigationService.queueWaypoint({ x: 10, y: 10 });
      navigationService.queueWaypoint({ x: 20, y: 20 });
      navigationService.beginWaypointInsertion(0);
    });
    const execute = vi.spyOn(runtime.commands, "execute").mockResolvedValue(undefined);

    render(<>{workspace.render()}</>);
    expect(screen.getByText("Insertando entre los puntos 1 y 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar y volver al editor" }));

    await waitFor(() => expect(navigationService.getState().routeEditor.insertionAfterIndex).toBeNull());
    expect(execute).toHaveBeenCalledWith("cockpit.shell.openWorkspace", "workspace.route-editor");
  });
});
