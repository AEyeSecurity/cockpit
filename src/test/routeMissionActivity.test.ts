import { describe, expect, it } from "vitest";
import {
  getRouteMissionActivityState,
  hasRouteMissionHistory,
  isRouteMissionIdleSnapshot,
  shouldPreserveRouteMissionSnapshot
} from "../packages/nav2/modules/navigation/routeMissionActivity";
import type { RouteMissionStateData } from "../packages/nav2/modules/navigation/service/impl/NavigationService";

function createRouteMission(overrides: Partial<RouteMissionStateData> = {}): RouteMissionStateData {
  return {
    active: false,
    paused: false,
    loop: false,
    lowBatteryActive: false,
    returnHomeRequested: false,
    returnHomeActive: false,
    returnHomeExitWaypointIndex: -1,
    returnHomePhase: "idle",
    homeAvailable: false,
    homeWaypoint: null,
    status: "idle",
    inputWaypointCount: 0,
    expandedWaypointCount: 0,
    currentStartIndex: 0,
    currentTargetIndex: 0,
    activeChunkSize: 0,
    legSpacingM: 0,
    chunkSpanM: 0,
    chunkMaxWaypoints: 0,
    blockedState: "",
    blockedReasonCode: "",
    blockedReasonText: "",
    blockedRetryAttempt: 0,
    blockedRetryMaxAttempts: 0,
    blockedWaitRemainingS: 0,
    actionActive: false,
    actionWaypointIndex: 0,
    actionType: "",
    actionRemainingS: 0,
    missionWaypoints: [],
    activeChunkWaypoints: [],
    ...overrides
  };
}

describe("routeMissionActivity", () => {
  it("detects transient idle snapshots and preserves active route history while goal remains active", () => {
    const previous = createRouteMission({
      active: true,
      loop: true,
      status: "route active (1->4)",
      inputWaypointCount: 3,
      expandedWaypointCount: 7,
      activeChunkSize: 4,
      missionWaypoints: [{ x: 1, y: 2, yawDeg: 0 }]
    });
    const incoming = createRouteMission();

    expect(hasRouteMissionHistory(previous)).toBe(true);
    expect(isRouteMissionIdleSnapshot(incoming)).toBe(true);
    expect(shouldPreserveRouteMissionSnapshot(previous, incoming, true)).toBe(true);
  });

  it("does not preserve transient idle snapshots once goal activity is explicitly false", () => {
    const previous = createRouteMission({
      active: true,
      status: "route active (1->4)",
      expandedWaypointCount: 7
    });
    const incoming = createRouteMission();

    expect(shouldPreserveRouteMissionSnapshot(previous, incoming, false)).toBe(false);
  });

  it("treats route history plus active goal telemetry as running", () => {
    const routeMission = createRouteMission({
      active: false,
      paused: false,
      status: "idle",
      inputWaypointCount: 3,
      expandedWaypointCount: 7,
      missionWaypoints: [{ x: 1, y: 2, yawDeg: 0 }]
    });

    expect(getRouteMissionActivityState(routeMission, true)).toMatchObject({
      running: true,
      activeVisual: true,
      hasHistory: true,
      isTerminal: false
    });
  });
});
