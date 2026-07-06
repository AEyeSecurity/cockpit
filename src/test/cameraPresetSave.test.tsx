import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createContributionRegistry } from "../core/contributions/contributionRegistry";
import { createEventBus } from "../core/events/eventBus";
import { ServiceRegistry } from "../core/registries/serviceRegistry";
import { createCameraModule } from "../packages/nav2/modules/camera/frontend";
import type { CameraPtzStateData, NavigationState } from "../packages/nav2/modules/navigation/service/impl/NavigationService";

function createPtzState(activePreset = "home"): CameraPtzStateData {
  return {
    ok: true,
    error: "",
    zoomIn: true,
    lastCommand: "save_preset:home",
    panDeg: 33,
    tiltDeg: 11,
    zoomLevel: 3.5,
    activePreset
  };
}

function createNavigationState(): NavigationState {
  return {
    waypoints: [],
    patrolMissionProfile: {
      loopWaypoints: [],
      homeWaypoint: null,
      returnWaypoints: [],
      departWaypoints: [],
      departEntryLoopIndex: -1
    },
    patrolMission: {
      active: false,
      phase: "idle",
      lowBatteryActive: false,
      returnHomeRequested: false,
      returnHomeActive: false,
      returnExitLoopIndex: -1,
      departEntryLoopIndex: -1,
      homeAvailable: false,
      missionId: "",
      status: "",
      homeWaypoint: null,
      loopWaypoints: [],
      returnWaypoints: [],
      departWaypoints: [],
      activeChunkWaypoints: []
    },
    selectedWaypointIndexes: [],
    loopRoute: false,
    routeMission: {
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
      status: "",
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
      actionWaypointIndex: -1,
      actionType: "",
      actionRemainingS: 0,
      missionWaypoints: [],
      activeChunkWaypoints: []
    },
    goalMode: false,
    manualMode: false,
    manualDisablePending: false,
    manualLinearSpeed: 1.2,
    manualWaypointDirection: true,
    manualSteeringAngleDeg: 18,
    manualLinearMin: 1,
    manualLinearMax: 4,
    manualSteeringAngleMinDeg: 1,
    manualSteeringAngleMaxDeg: 30,
    manualCommand: { linearX: 0, angularZ: 0 },
    manualKeys: { w: false, a: false, s: false, d: false },
    manualBrakeHeld: false,
    cameraStreamConnected: false,
    controlLocked: false,
    controlLockReason: "",
    unlockGraceUntilMs: 0,
    recording: { active: false, count: 0, lastMessage: "" },
    patrolLoop: { active: false, currentWaypoint: 0, totalWaypoints: 0, label: "" },
    lastStatus: "",
    lastSnapshot: null,
    savedRouteNames: []
  };
}

describe("camera preset save", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ camera: { width: 0, height: 0 }, ai: { detections: [] } })
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requires a second click before saving HOME", async () => {
    const contributions = createContributionRegistry();
    const services = new ServiceRegistry();
    const eventBus = createEventBus();
    const saveCameraPreset = vi.fn().mockResolvedValue(createPtzState("home"));
    const readCameraPtzState = vi.fn().mockResolvedValue(createPtzState("home"));
    const navigationService = {
      getState: () => createNavigationState(),
      subscribe: () => () => undefined,
      readCameraPtzState,
      saveCameraPreset,
      goCameraPreset: vi.fn(),
      moveCameraPtz: vi.fn(),
      toggleCameraZoom: vi.fn()
    };
    const connectionService = {
      getState: () => ({
        connected: true,
        connecting: false,
        preset: "real",
        host: "salus",
        port: "8766",
        lastError: "",
        txBytes: 0,
        rxBytes: 0
      }),
      subscribe: () => () => undefined
    };
    services.registerService({ id: "service.navigation", service: navigationService });
    services.registerService({ id: "service.connection", service: connectionService });

    const module = createCameraModule();
    module.register({
      packageId: "nav2",
      env: {
        cameraProbeTimeoutMs: 3000,
        cameraLoadTimeoutMs: 7000
      },
      moduleConfig: {},
      container: {} as never,
      eventBus,
      router: {} as never,
      transportManager: {} as never,
      commands: {} as never,
      contributions,
      keybindings: {} as never,
      services,
      dispatchers: { registerDispatcher: () => undefined } as never,
      transports: {} as never,
      packages: [],
      getService: (serviceId: string) => services.getService(serviceId),
      getPackageConfig: () => ({
        camera_transport: "webrtc",
        camera_webrtc_url: "http://robot.local:8889/cam3/whep"
      }),
      setPackageConfig: async () => undefined,
      resetPackageConfig: async () => undefined
    } as never);

    const contribution = contributions.get("workspace.camera");
    if (!contribution || contribution.slot !== "workspace") {
      throw new Error("camera workspace contribution not registered");
    }

    render(<>{contribution.render()}</>);

    await waitFor(() => expect(readCameraPtzState).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "Set Home" }));
    expect(saveCameraPreset).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Confirm Home" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Confirm Home" }));

    await waitFor(() => expect(saveCameraPreset).toHaveBeenCalledWith("home", true));
  });
});
