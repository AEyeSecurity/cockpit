import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { bootstrapApp } from "../core/bootstrap/bootstrapApp";
import { NavigationService } from "../packages/nav2/modules/navigation/service/impl/NavigationService";

const reason = "Navegación bloqueada: el planner propuso un giro en U. Cancelá y revisá el recorrido.";

describe("operator maneuver block", () => {
  it.each(["nav2.sidebar.navigation", "nav2.workspace.map"])(
    "shows the terminal block and its cause in %s", async (id) => {
      const runtime = await bootstrapApp();
      const service = runtime.services.getService<NavigationService>("nav2.service.navigation");
      const state = service.getState();
      vi.spyOn(service, "getState").mockReturnValue({ ...state,
        routeMission: { ...state.routeMission, active: true, status: "ACTIVE",
          inputWaypointCount: 5, expandedWaypointCount: 5,
          blockedState: "NEEDS_OPERATOR", blockedReasonCode: "PLANNER_U_TURN",
          blockedReasonText: reason, currentStartIndex: 4,
          blockedRetryAttempt: 0, blockedRetryMaxAttempts: 3 } });
      const contribution = runtime.contributions.get(id);
      if (!contribution || (contribution.slot !== "sidebar" && contribution.slot !== "workspace")) {
        throw new Error("view not registered");
      }
      render(<>{contribution.render()}</>);
      expect(screen.getByText("Se necesita intervención")).toBeInTheDocument();
      expect(screen.getByText(reason)).toBeInTheDocument();
      expect(screen.queryByText(/retry 1\/3/)).not.toBeInTheDocument();
      service.stopControlHeartbeat();
    }
  );
});
