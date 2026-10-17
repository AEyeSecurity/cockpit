import { describe, expect, it, vi } from "vitest";
import { describeRouteBlock } from "../packages/nav2/modules/navigation/blockedRouteStatus";
import { NavigationService } from "../packages/nav2/modules/navigation/service/impl/NavigationService";

const pending = {
  blockedState: "WAITING_DATA", blockedReasonCode: "PLANNER_LOOP",
  blockedReasonText: "Robot detenido: esperando un replan sin rulo.",
  blockedRetryAttempt: 0, blockedRetryMaxAttempts: 3, blockedWaitRemainingS: 7.2
};

describe("planner maneuver block presentation", () => {
  it("shows the backend's total wait without inventing a retry budget", () => {
    expect(describeRouteBlock(pending)).toEqual({
      title: "Esperando camino alternativo", tone: "paused",
      detail: `${pending.blockedReasonText} · 8s`
    });
  });

  it("keeps the final cause and operator instructions prominent", () => {
    const reason = "Giro en U: cancelá y volvé a iniciar después de revisar.";
    expect(describeRouteBlock({ ...pending, blockedState: "NEEDS_OPERATOR",
      blockedReasonCode: "PLANNER_U_TURN", blockedReasonText: reason })).toEqual({
      title: "Se necesita intervención", tone: "error", detail: reason
    });
    expect(describeRouteBlock({ ...pending, blockedState: "CLEAR" })).toBeNull();
  });

  it("retains the existing obstacle retry presentation", () => {
    expect(describeRouteBlock({ ...pending, blockedReasonCode: "NO_VALID_PATH",
      blockedState: "WAITING_RETRY", blockedReasonText: "Sin camino seguro" })?.detail)
      .toBe("Sin camino seguro · retry 1/3 · 8s");
  });

  it("projects current ROS state names and clears the block on actual recovery", () => {
    let receive: ((message: Record<string, unknown>) => void) | undefined;
    const service = new NavigationService({
      requestControlHeartbeat: vi.fn().mockResolvedValue({}),
      subscribeState: (callback: typeof receive) => { receive = callback; return () => {}; }
    } as never);
    receive?.({ op: "state", route_mission: { active: true, status: "ACTIVE",
      blocked_state: "NEEDS_OPERATOR", blocked_reason_code: "PLANNER_LOOP",
      blocked_reason_text: "Rulo rechazado. Cancelá y revisá la misión.", current_start_index: 4 } });
    expect(service.getState().routeMission.currentStartIndex).toBe(4);
    expect(describeRouteBlock(service.getState().routeMission)?.tone).toBe("error");
    receive?.({ op: "state", route_mission: { active: true, status: "ACTIVE", blocked_state: "CLEAR" } });
    expect(service.getState().routeMission.blockedState).toBe("");
    service.stopControlHeartbeat();
  });

  it("refreshes get_state on the existing heartbeat and prevents overlapping refreshes", async () => {
    vi.useFakeTimers();
    try {
      let resolve: (() => void) | undefined;
      const dispatcher = {
        requestControlHeartbeat: vi.fn().mockResolvedValue({}),
        requestState: vi.fn(() => new Promise<void>((done) => { resolve = done; }))
      };
      const service = new NavigationService(dispatcher as never);
      vi.advanceTimersByTime(6100);
      expect(dispatcher.requestState).toHaveBeenCalledTimes(1);
      resolve?.();
      await Promise.resolve();
      await Promise.resolve();
      vi.advanceTimersByTime(3000);
      expect(dispatcher.requestState).toHaveBeenCalledTimes(2);
      service.stopControlHeartbeat();
      vi.advanceTimersByTime(6000);
      expect(dispatcher.requestState).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
});
