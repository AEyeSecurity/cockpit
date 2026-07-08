import { describe, expect, it } from "vitest";
import { getPatrolPresentation } from "../packages/nav2/modules/map/frontend/patrolPresentation";

describe("patrolPresentation", () => {
  it("shows all missing requirements when patrol is empty", () => {
    const presentation = getPatrolPresentation(
      {
        loopWaypoints: [],
        homeWaypoint: null,
        returnWaypoints: [],
        departWaypoints: [],
        departEntryLoopIndex: -1
      },
      null
    );

    expect(presentation.badgeLabel).toBe("Setup");
    expect(presentation.detail).toBe("Missing: LOOP, HOME, ENTRY");
    expect(presentation.tone).toBe("idle");
  });

  it("shows partial missing requirements from local profile", () => {
    const presentation = getPatrolPresentation(
      {
        loopWaypoints: [{ x: 1, y: 1 }, { x: 2, y: 2 }],
        homeWaypoint: null,
        returnWaypoints: [],
        departWaypoints: [],
        departEntryLoopIndex: -1
      },
      null
    );

    expect(presentation.detail).toBe("Missing: HOME, ENTRY");
  });

  it("shows only missing entry when loop and home are ready", () => {
    const presentation = getPatrolPresentation(
      {
        loopWaypoints: [{ x: 1, y: 1 }, { x: 2, y: 2 }],
        homeWaypoint: { x: 3, y: 3, role: "home" },
        returnWaypoints: [],
        departWaypoints: [],
        departEntryLoopIndex: -1
      },
      null
    );

    expect(presentation.detail).toBe("Missing: ENTRY");
  });

  it("shows ready state from local profile when backend is idle", () => {
    const presentation = getPatrolPresentation(
      {
        loopWaypoints: [{ x: 1, y: 1 }, { x: 2, y: 2 }],
        homeWaypoint: { x: 3, y: 3, role: "home" },
        returnWaypoints: [],
        departWaypoints: [],
        departEntryLoopIndex: 1
      },
      {
        active: false,
        phase: "idle",
        lowBatteryActive: false,
        returnHomeRequested: false,
        returnHomeActive: false,
        returnExitLoopIndex: -1,
        departEntryLoopIndex: -1,
        homeAvailable: false,
        missionId: "",
        status: "idle",
        homeWaypoint: null,
        loopWaypoints: [],
        returnWaypoints: [],
        departWaypoints: [],
        activeChunkWaypoints: []
      }
    );

    expect(presentation.badgeLabel).toBe("Ready");
    expect(presentation.detail).toBe("Ready to start");
    expect(presentation.secondaryDetail).toBe("2 loop · home · entry #2");
    expect(presentation.tone).toBe("ready");
  });

  it("prioritizes backend patrol phase when patrol is active", () => {
    const presentation = getPatrolPresentation(
      {
        loopWaypoints: [{ x: 1, y: 1 }, { x: 2, y: 2 }],
        homeWaypoint: { x: 3, y: 3, role: "home" },
        returnWaypoints: [],
        departWaypoints: [],
        departEntryLoopIndex: 1
      },
      {
        active: true,
        phase: "loop_main",
        lowBatteryActive: false,
        returnHomeRequested: false,
        returnHomeActive: false,
        returnExitLoopIndex: -1,
        departEntryLoopIndex: 1,
        homeAvailable: true,
        missionId: "mission-1",
        status: "loop running",
        homeWaypoint: { x: 3, y: 3, role: "home" },
        loopWaypoints: [{ x: 1, y: 1 }, { x: 2, y: 2 }],
        returnWaypoints: [{ x: 4, y: 4 }],
        departWaypoints: [{ x: 5, y: 5 }],
        activeChunkWaypoints: []
      }
    );

    expect(presentation.badgeLabel).toBe("loop_main");
    expect(presentation.detail).toBe("2 loop · 1 return · 1 depart");
    expect(presentation.secondaryDetail).toBe("loop running");
    expect(presentation.tone).toBe("active");
  });
});
