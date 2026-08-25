import { describe, expect, it, vi } from "vitest";
import { MapService } from "../packages/nav2/modules/map/service/impl/MapService";
import { MissionService } from "../packages/nav2/modules/debug/service/impl/MissionService";
import { NavigationService } from "../packages/nav2/modules/navigation/service/impl/NavigationService";
import { ConnectionService } from "../packages/nav2/modules/navigation/service/impl/ConnectionService";
import type { Nav2IncomingMessage } from "../packages/nav2/protocol/messages";

function installStorageMock(seed: Record<string, string> = {}): void {
  if (typeof window === "undefined") return;
  const state = new Map<string, string>(Object.entries(seed));
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => (state.has(key) ? state.get(key)! : null),
      setItem: (key: string, value: string) => {
        state.set(key, value);
      },
      removeItem: (key: string) => {
        state.delete(key);
      },
      clear: () => {
        state.clear();
      }
    }
  });
}

describe("services", () => {
  it("uses config defaults for ConnectionService when localStorage is empty", () => {
    installStorageMock();
    const transportManager = {
      getTrafficStats: vi.fn(() => ({ txBytes: 0, rxBytes: 0 })),
      subscribeTraffic: vi.fn(),
      subscribeStatus: vi.fn(() => () => undefined),
      connectTransport: vi.fn(),
      disconnectTransport: vi.fn()
    };
    const env = {
      appName: "test",
      wsUrl: "ws://env-host:9999",
      wsRealHost: "env-real",
      wsSimHost: "env-sim",
      wsDefaultPort: "9999",
      rosbridgeUrl: "",
      httpBaseUrl: "",
      googleMapsApiKey: "",
      cameraIframeUrl: ""
    };
    const eventBus = { emit: vi.fn() };
    const service = new ConnectionService(transportManager as never, env as never, "transport.ws.core", eventBus as never, {
      real: { host: "cfg-real", port: "8766" },
      sim: { host: "cfg-sim", port: "17777" }
    });
    const state = service.getState();
    expect(state.preset).toBe("real");
    expect(state.host).toBe("cfg-real");
    expect(state.port).toBe("8766");
  });

  it("prioritizes localStorage over config defaults for ConnectionService", () => {
    installStorageMock({
      "map_tools.connection_presets.v4": JSON.stringify({
        preset: "sim",
        presets: {
          real: { host: "ls-real", port: "1111" },
          sim: { host: "ls-sim", port: "2222" }
        }
      })
    });
    const transportManager = {
      getTrafficStats: vi.fn(() => ({ txBytes: 0, rxBytes: 0 })),
      subscribeTraffic: vi.fn(),
      subscribeStatus: vi.fn(() => () => undefined),
      connectTransport: vi.fn(),
      disconnectTransport: vi.fn()
    };
    const env = {
      appName: "test",
      wsUrl: "ws://env-host:9999",
      wsRealHost: "env-real",
      wsSimHost: "env-sim",
      wsDefaultPort: "9999",
      rosbridgeUrl: "",
      httpBaseUrl: "",
      googleMapsApiKey: "",
      cameraIframeUrl: ""
    };
    const eventBus = { emit: vi.fn() };
    const service = new ConnectionService(transportManager as never, env as never, "transport.ws.core", eventBus as never, {
      real: { host: "cfg-real", port: "8766" },
      sim: { host: "cfg-sim", port: "17777" }
    });
    const state = service.getState();
    expect(state.preset).toBe("sim");
    expect(state.host).toBe("ls-sim");
    expect(state.port).toBe("2222");
  });

  it("validates goal input in NavigationService", async () => {
    const dispatcher = {
      requestGoal: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "navigation.goal.result",
        ok: true
      }),
      requestControlLock: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "ack",
        ok: true
      })
    };
    const service = new NavigationService(dispatcher as never);
    await service.unlockControls();
    await expect(service.sendGoal({ x: 1, y: 2, yawDeg: 3 })).resolves.toBeUndefined();
    await expect(service.sendGoal({ x: Number.NaN, y: 2, yawDeg: 3 })).rejects.toThrow("Invalid");
  });

  it("maps response payload in MapService", async () => {
    const dispatcher = {
      subscribe: vi.fn(() => () => undefined),
      requestMap: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "map.loaded",
        ok: true,
        payload: {
          mapId: "map-x",
          title: "Main map",
          originLat: -31.4,
          originLon: -64.1
        } as never
      })
    };
    const service = new MapService(dispatcher as never);
    const map = await service.loadMap("map-x");
    expect(map.mapId).toBe("map-x");
    expect(map.title).toBe("Main map");
  });

  it("maps saved camera preset payload in NavigationService", async () => {
    const dispatcher = {
      requestCameraPtzSetPreset: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "ack",
        ok: true,
        payload: {
          ok: true,
          error: "",
          last_command: "save_preset:home",
          zoom_in: true,
          pan_deg: 33,
          tilt_deg: 11,
          zoom_level: 3.5,
          active_preset: "home"
        } as never
      })
    };
    const service = new NavigationService(dispatcher as never);
    const state = await service.saveCameraPreset("home", true);
    expect(dispatcher.requestCameraPtzSetPreset).toHaveBeenCalledWith("home", true);
    expect(state).toMatchObject({
      ok: true,
      lastCommand: "save_preset:home",
      panDeg: 33,
      tiltDeg: 11,
      zoomLevel: 3.5,
      activePreset: "home"
    });
  });

  it("marks connection as lost on unexpected transport disconnect", async () => {
    let subscribed = false;
    let onStatus: (status: { connected: boolean; intentional: boolean; reason: string }) => void = () => undefined;
    const transportManager = {
      getTrafficStats: vi.fn(() => ({ txBytes: 0, rxBytes: 0 })),
      subscribeTraffic: vi.fn(() => () => undefined),
      subscribeStatus: vi.fn((_transportId: string, listener: (status: { connected: boolean; intentional: boolean; reason: string }) => void) => {
        subscribed = true;
        onStatus = listener;
        return () => undefined;
      }),
      connectTransport: vi.fn().mockResolvedValue(undefined),
      disconnectTransport: vi.fn().mockResolvedValue(undefined)
    };
    const env = {
      appName: "test",
      wsUrl: "ws://env-host:9999",
      wsRealHost: "env-real",
      wsSimHost: "env-sim",
      wsDefaultPort: "9999",
      rosbridgeUrl: "",
      httpBaseUrl: "",
      googleMapsApiKey: "",
      cameraIframeUrl: ""
    };
    const eventBus = { emit: vi.fn() };
    const service = new ConnectionService(transportManager as never, env as never, "transport.ws.core", eventBus as never);

    await service.connect();
    if (!subscribed) {
      throw new Error("status listener not registered");
    }
    onStatus({
      connected: false,
      intentional: false,
      reason: "backend dropped"
    });

    expect(service.getState()).toMatchObject({
      connected: false,
      lastError: "backend dropped"
    });
    expect(eventBus.emit).toHaveBeenCalledWith(
      "console.event",
      expect.objectContaining({
        level: "error",
        text: "backend dropped"
      })
    );
  });

  it("keeps waypoint state in NavigationService and persists to localStorage", () => {
    const dispatcher = {
      requestGoal: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "navigation.goal.result",
        ok: true
      }),
      requestCancelGoal: vi.fn(),
      requestManualMode: vi.fn(),
      requestManualCommand: vi.fn(),
      requestSnapshot: vi.fn(),
      requestCameraPan: vi.fn(),
      requestCameraZoomToggle: vi.fn(),
      requestCameraStatus: vi.fn()
    };
    const service = new NavigationService(dispatcher as never);

    service.queueWaypoint({ x: 1, y: 2, yawDeg: 90 });
    service.queueWaypoint({ x: 3, y: 4 });
    expect(service.getState().waypoints).toHaveLength(2);
    const count = service.saveWaypoints();
    expect(count).toBe(2);

    service.clearWaypoints();
    expect(service.getState().waypoints).toHaveLength(0);
    const loaded = service.loadWaypoints();
    expect(loaded).toBe(2);
    expect(service.getState().waypoints).toHaveLength(2);
    expect(service.getState().waypoints[0]).toMatchObject({ x: 1, y: 2, yawDeg: 90 });
    expect(service.getState().waypoints[1]).toMatchObject({ x: 3, y: 4 });
  });

  it("saves, lists, loads and deletes named routes via localStorage", () => {
    installStorageMock();
    const dispatcher = {
      requestGoal: vi.fn(),
      requestCancelGoal: vi.fn(),
      requestManualMode: vi.fn(),
      requestManualCommand: vi.fn(),
      requestSnapshot: vi.fn(),
      requestCameraPan: vi.fn(),
      requestCameraZoomToggle: vi.fn(),
      requestCameraStatus: vi.fn()
    };
    const service = new NavigationService(dispatcher as never);

    // Cannot save with empty name or with no waypoints.
    expect(() => service.saveNamedRoute("ruta")).toThrowError(/waypoints/i);
    service.queueWaypoint({ x: 1, y: 2, yawDeg: 90 });
    service.queueWaypoint({ x: 3, y: 4 });
    service.toggleWaypointSelection(0);
    service.toggleWaypointSelection(1);
    service.useQueuedWaypointsAsPatrolLoop();
    service.clearWaypointSelection();
    service.toggleWaypointSelection(1);
    service.setPatrolDepartEntryFromSelected();
    expect(() => service.saveNamedRoute("   ")).toThrowError(/vacío/i);

    const saved = service.saveNamedRoute("Ronda noche");
    expect(saved).toBe(2);
    expect(service.getState().savedRouteNames).toEqual(["Ronda noche"]);
    expect(service.listSavedRouteNames()).toEqual(["Ronda noche"]);

    // A second service instance reads the persisted routes on construction.
    const reopened = new NavigationService(dispatcher as never);
    expect(reopened.listSavedRouteNames()).toEqual(["Ronda noche"]);
    reopened.clearWaypoints();
    expect(reopened.getState().waypoints).toHaveLength(0);
    const loaded = reopened.loadNamedRoute("Ronda noche");
    expect(loaded).toBe(2);
    expect(reopened.getState().waypoints[0]).toMatchObject({ x: 1, y: 2, yawDeg: 90 });
    expect(reopened.getState().waypoints[1]).toMatchObject({ x: 3, y: 4 });
    expect(reopened.getState().patrolMissionProfile.loopWaypoints).toHaveLength(2);
    expect(reopened.getState().patrolMissionProfile.departEntryLoopIndex).toBe(1);

    expect(() => reopened.loadNamedRoute("inexistente")).toThrowError(/No existe/i);

    reopened.deleteNamedRoute("Ronda noche");
    expect(reopened.getState().savedRouteNames).toEqual([]);
    expect(() => reopened.loadNamedRoute("Ronda noche")).toThrowError(/No existe/i);
  });

  it("supports waypoint selection and selective removal", () => {
    const dispatcher = {
      requestGoal: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "navigation.goal.result",
        ok: true
      }),
      requestCancelGoal: vi.fn(),
      requestManualMode: vi.fn(),
      requestManualCommand: vi.fn(),
      requestSnapshot: vi.fn(),
      requestCameraPan: vi.fn(),
      requestCameraZoomToggle: vi.fn(),
      requestCameraStatus: vi.fn()
    };
    const service = new NavigationService(dispatcher as never);

    service.queueWaypoint({ x: 1, y: 1, yawDeg: 0 });
    service.queueWaypoint({ x: 2, y: 2, yawDeg: 0 });
    service.queueWaypoint({ x: 3, y: 3, yawDeg: 0 });
    service.toggleWaypointSelection(0);
    service.toggleWaypointSelection(2);
    expect(service.getState().selectedWaypointIndexes).toEqual([0, 2]);

    const removed = service.removeSelectedWaypoints();
    expect(removed).toBe(2);
    expect(service.getState().waypoints).toHaveLength(1);
    expect(service.getState().waypoints[0]).toMatchObject({ x: 2, y: 2, yawDeg: 0 });
    expect(service.getState().selectedWaypointIndexes).toEqual([]);
  });

  it("replaces or adds waypoint selections for map area selection", () => {
    const service = new NavigationService({} as never);
    service.queueWaypoint({ x: 1, y: 1 });
    service.queueWaypoint({ x: 2, y: 2 });
    service.queueWaypoint({ x: 3, y: 3 });

    service.setWaypointSelection([1, 2], "replace");
    expect(service.getState().selectedWaypointIndexes).toEqual([1, 2]);

    service.setWaypointSelection([0, 2, 99], "add");
    expect(service.getState().selectedWaypointIndexes).toEqual([0, 1, 2]);

    service.setWaypointSelectionMode(true);
    expect(service.getState().waypointSelectionMode).toBe(true);
    service.setWaypointSelectionMode(false);
    expect(service.getState().waypointSelectionMode).toBe(false);
  });

  it("applies the selected initial navigation profile before a route mission", async () => {
    const dispatcher = {
      requestNavigationProfile: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "ack",
        ok: true,
        active_profile: "rural"
      }),
      requestRouteMission: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "ack",
        ok: true,
        input_waypoint_count: 1,
        expanded_waypoint_count: 1
      }),
      requestControlLock: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({ op: "ack", ok: true })
    };
    const service = new NavigationService(dispatcher as never);
    await service.unlockControls();
    await service.setNavigationStartProfile("rural");
    service.queueWaypoint({ x: 3, y: 4 });

    await service.sendRouteMission();

    expect(dispatcher.requestNavigationProfile).toHaveBeenCalledTimes(2);
    expect(dispatcher.requestNavigationProfile).toHaveBeenLastCalledWith("rural");
    expect(dispatcher.requestRouteMission).toHaveBeenCalledTimes(1);
    expect(dispatcher.requestNavigationProfile.mock.invocationCallOrder[1]).toBeLessThan(
      dispatcher.requestRouteMission.mock.invocationCallOrder[0]
    );
    expect(service.getState().navigationStartProfile).toBe("rural");
  });

  it("keeps the previous initial navigation profile when Nav2 rejects it", async () => {
    const dispatcher = {
      requestNavigationProfile: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "ack",
        ok: false,
        error: "profile unavailable"
      }),
      requestControlLock: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({ op: "ack", ok: true })
    };
    const service = new NavigationService(dispatcher as never);
    await service.unlockControls();

    await expect(service.setNavigationStartProfile("rural")).rejects.toThrow("profile unavailable");

    expect(service.getState().navigationStartProfile).toBe("urban");
  });

  it("restores the urban selector when a patrol is cancelled", async () => {
    const dispatcher = {
      requestNavigationProfile: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "ack",
        ok: true,
        active_profile: "rural"
      }),
      requestCancelPatrolMission: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "ack",
        ok: true
      }),
      requestControlLock: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({ op: "ack", ok: true })
    };
    const service = new NavigationService(dispatcher as never);
    await service.unlockControls();
    await service.setNavigationStartProfile("rural");

    await service.cancelPatrolMission();

    expect(dispatcher.requestCancelPatrolMission).toHaveBeenCalledTimes(1);
    expect(service.getState().navigationStartProfile).toBe("urban");
  });

  it("sends queued goals through NavigationService", async () => {
    const dispatcher = {
      requestGoal: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "navigation.goal.result",
        ok: true
      }),
      requestRouteMission: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "ack",
        ok: true
      }),
      requestCancelGoal: vi.fn(),
      requestCancelRouteMission: vi.fn(),
      requestManualMode: vi.fn(),
      requestManualCommand: vi.fn(),
      requestSnapshot: vi.fn(),
      requestCameraPan: vi.fn(),
      requestCameraZoomToggle: vi.fn(),
      requestCameraStatus: vi.fn(),
      requestControlLock: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "ack",
        ok: true
      })
    };
    const service = new NavigationService(dispatcher as never);
    await service.unlockControls();
    service.queueWaypoint({ x: 3, y: 4, yawDeg: 0 });
    const sent = await service.sendQueuedGoal({ x: 0, y: 0, yawDeg: 0 });
    expect(sent.sentCount).toBe(1);
    expect(dispatcher.requestGoal).toHaveBeenCalledTimes(1);
  });

  it("omits yaw_deg for automatic queued waypoints", async () => {
    const dispatcher = {
      requestGoal: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "navigation.goal.result",
        ok: true
      }),
      requestRouteMission: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "ack",
        ok: true
      }),
      requestCancelGoal: vi.fn(),
      requestCancelRouteMission: vi.fn(),
      requestManualMode: vi.fn(),
      requestManualCommand: vi.fn(),
      requestSnapshot: vi.fn(),
      requestCameraPan: vi.fn(),
      requestCameraZoomToggle: vi.fn(),
      requestCameraStatus: vi.fn(),
      requestControlLock: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "ack",
        ok: true
      })
    };
    const service = new NavigationService(dispatcher as never);
    await service.unlockControls();
    service.queueWaypoint({ x: 3, y: 4, actions: [{ type: "brake_hold", duration_s: 5, brake_pct: 100 }] });
    service.queueWaypoint({ x: 5, y: 6, yawDeg: 45 });

    await service.sendQueuedGoal();

    expect(dispatcher.requestGoal).toHaveBeenCalledWith(
      expect.objectContaining({
        waypoints: [
          { lat: 3, lon: 4 },
          { lat: 5, lon: 6, yaw_deg: 45 }
        ]
      })
    );
  });

  it("sends route missions through NavigationService", async () => {
    const dispatcher = {
      requestGoal: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "navigation.goal.result",
        ok: true
      }),
      requestRouteMission: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "ack",
        ok: true,
        input_waypoint_count: 2,
        expanded_waypoint_count: 5
      }),
      requestNavigationProfile: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "ack",
        ok: true,
        active_profile: "urban"
      }),
      requestCancelGoal: vi.fn(),
      requestCancelRouteMission: vi.fn(),
      requestManualMode: vi.fn(),
      requestManualCommand: vi.fn(),
      requestSnapshot: vi.fn(),
      requestCameraPan: vi.fn(),
      requestCameraZoomToggle: vi.fn(),
      requestCameraStatus: vi.fn(),
      requestControlLock: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "ack",
        ok: true
      })
    };
    const service = new NavigationService(dispatcher as never);
    await service.unlockControls();
    service.queueWaypoint({ x: 3, y: 4, yawDeg: 0 });
    service.queueWaypoint({ x: 5, y: 6, yawDeg: 5 });
    service.toggleWaypointSelection(1);
    service.setBrakeHoldActionForSelected(true, 5, 100);

    const started = await service.sendRouteMission();

    expect(started.inputCount).toBe(2);
    expect(started.expandedCount).toBe(5);
    expect(dispatcher.requestRouteMission).toHaveBeenCalledWith(
      expect.objectContaining({
        waypoints: [
          { lat: 3, lon: 4, yaw_deg: 0 },
          {
            lat: 5,
            lon: 6,
            yaw_deg: 5,
            actions: [{ type: "brake_hold", duration_s: 5, brake_pct: 100 }]
          }
        ]
      })
    );
  });

  it("serializes rural and urban navigation profile waypoint actions", async () => {
    const dispatcher = {
      requestRouteMission: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "ack",
        ok: true,
        input_waypoint_count: 2,
        expanded_waypoint_count: 2
      }),
      requestNavigationProfile: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "ack",
        ok: true,
        active_profile: "urban"
      }),
      requestControlLock: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({ op: "ack", ok: true })
    };
    const service = new NavigationService(dispatcher as never);
    await service.unlockControls();
    service.queueWaypoint({ x: 3, y: 4 });
    service.queueWaypoint({ x: 5, y: 6 });
    service.toggleWaypointSelection(0);
    service.setNavigationProfileActionForSelected("rural");
    service.clearWaypointSelection();
    service.toggleWaypointSelection(1);
    service.setNavigationProfileActionForSelected("urban");

    await service.sendRouteMission();

    expect(dispatcher.requestRouteMission).toHaveBeenCalledWith(
      expect.objectContaining({
        waypoints: [
          { lat: 3, lon: 4, actions: [{ type: "set_navigation_profile", profile: "rural" }] },
          { lat: 5, lon: 6, actions: [{ type: "set_navigation_profile", profile: "urban" }] }
        ]
      })
    );
  });

  it("marks a single waypoint as HOME and strips route actions", () => {
    const dispatcher = {
      requestGoal: vi.fn(),
      requestRouteMission: vi.fn(),
      requestCancelGoal: vi.fn(),
      requestCancelRouteMission: vi.fn(),
      requestManualMode: vi.fn(),
      requestManualCommand: vi.fn(),
      requestSnapshot: vi.fn(),
      requestCameraPan: vi.fn(),
      requestCameraZoomToggle: vi.fn(),
      requestCameraStatus: vi.fn()
    };
    const service = new NavigationService(dispatcher as never);
    service.queueWaypoint({ x: 1, y: 1, actions: [{ type: "brake_hold", duration_s: 5, brake_pct: 100 }] });
    service.queueWaypoint({ x: 2, y: 2 });
    service.toggleWaypointSelection(0);

    const homeIndex = service.setHomeForSelected();

    expect(homeIndex).toBe(0);
    expect(service.getState().waypoints[0]).toMatchObject({ x: 1, y: 1, role: "home" });
    expect(service.getState().waypoints[0].actions).toBeUndefined();
  });

  it("keeps patrol loop exclusive from return and depart connectors", () => {
    const dispatcher = {
      requestGoal: vi.fn(),
      requestRouteMission: vi.fn(),
      requestCancelGoal: vi.fn(),
      requestCancelRouteMission: vi.fn(),
      requestManualMode: vi.fn(),
      requestManualCommand: vi.fn(),
      requestSnapshot: vi.fn(),
      requestCameraPan: vi.fn(),
      requestCameraZoomToggle: vi.fn(),
      requestCameraStatus: vi.fn()
    };
    const service = new NavigationService(dispatcher as never);

    service.queueWaypoint({ x: 1, y: 1 });
    service.queueWaypoint({ x: 2, y: 2 });
    service.queueWaypoint({ x: 3, y: 3 });
    service.queueWaypoint({ x: 4, y: 4 });
    service.toggleWaypointSelection(2);
    service.useSelectedWaypointsAsPatrolSegment("return");
    service.clearWaypointSelection();
    service.toggleWaypointSelection(3);
    service.useSelectedWaypointsAsPatrolSegment("depart");
    const count = service.useQueuedWaypointsAsPatrolLoop();
    const profile = service.getState().patrolMissionProfile;

    expect(count).toBe(2);
    expect(profile.loopWaypoints.map((waypoint) => [waypoint.x, waypoint.y])).toEqual([
      [1, 1],
      [2, 2]
    ]);
    expect(profile.returnWaypoints.map((waypoint) => [waypoint.x, waypoint.y])).toEqual([[3, 3]]);
    expect(profile.departWaypoints.map((waypoint) => [waypoint.x, waypoint.y])).toEqual([[4, 4]]);
  });

  it("tracks patrol HOME from waypoint tools state", () => {
    const service = new NavigationService({} as never);

    service.queueWaypoint({ x: 1, y: 1 });
    service.queueWaypoint({ x: 2, y: 2 });
    service.toggleWaypointSelection(1);

    service.setHomeForSelected();

    let profile = service.getState().patrolMissionProfile;
    expect(profile.homeWaypoint).toMatchObject({ x: 2, y: 2, role: "home" });

    const changed = service.clearHomeForSelected();

    expect(changed).toBe(1);
    profile = service.getState().patrolMissionProfile;
    expect(profile.homeWaypoint).toBeNull();
  });

  it("rejects selecting HOME or connector waypoints as patrol entry", () => {
    const service = new NavigationService({} as never);

    service.queueWaypoint({ x: 1, y: 1 });
    service.queueWaypoint({ x: 2, y: 2 });
    service.queueWaypoint({ x: 3, y: 3 });
    service.queueWaypoint({ x: 4, y: 4 });
    service.toggleWaypointSelection(0);
    service.toggleWaypointSelection(1);
    service.useQueuedWaypointsAsPatrolLoop();
    service.clearWaypointSelection();
    service.toggleWaypointSelection(2);
    service.setPatrolHomeFromSelected();

    expect(() => service.setPatrolDepartEntryFromSelected()).toThrowError(/HOME waypoint/i);

    service.clearWaypointSelection();
    service.toggleWaypointSelection(3);
    service.useSelectedWaypointsAsPatrolSegment("return");

    expect(() => service.setPatrolDepartEntryFromSelected()).toThrowError(/Connector waypoint/i);
  });

  it("reconciles patrol segments after moving and deleting queued waypoints", () => {
    const dispatcher = {
      requestGoal: vi.fn(),
      requestRouteMission: vi.fn(),
      requestCancelGoal: vi.fn(),
      requestCancelRouteMission: vi.fn(),
      requestManualMode: vi.fn(),
      requestManualCommand: vi.fn(),
      requestSnapshot: vi.fn(),
      requestCameraPan: vi.fn(),
      requestCameraZoomToggle: vi.fn(),
      requestCameraStatus: vi.fn()
    };
    const service = new NavigationService(dispatcher as never);

    service.queueWaypoint({ x: 1, y: 1 });
    service.queueWaypoint({ x: 2, y: 2 });
    service.queueWaypoint({ x: 3, y: 3 });
    service.toggleWaypointSelection(0);
    service.useQueuedWaypointsAsPatrolLoop();
    service.clearWaypointSelection();
    service.toggleWaypointSelection(2);
    service.useSelectedWaypointsAsPatrolSegment("depart");
    service.clearWaypointSelection();
    service.toggleWaypointSelection(1);
    service.setPatrolDepartEntryFromSelected();
    service.moveWaypoint(2, 30, 30);

    let profile = service.getState().patrolMissionProfile;
    expect(profile.departWaypoints[0]).toMatchObject({ x: 30, y: 30 });
    expect(profile.departEntryLoopIndex).toBe(1);

    service.clearWaypointSelection();
    service.toggleWaypointSelection(1);
    service.removeSelectedWaypoints();
    profile = service.getState().patrolMissionProfile;
    expect(profile.loopWaypoints.map((waypoint) => [waypoint.x, waypoint.y])).toEqual([[1, 1]]);
    expect(profile.departEntryLoopIndex).toBe(-1);
  });

  it("resolves auto yaw before dispatching a structured patrol", async () => {
    const dispatcher = {
      requestControlLock: vi.fn().mockResolvedValue({ op: "ack", ok: true }),
      requestNavigationProfile: vi.fn().mockResolvedValue({
        op: "ack", ok: true, active_profile: "urban"
      }),
      requestPatrolMission: vi.fn().mockResolvedValue({
        op: "ack", ok: true,
        loop_input_waypoint_count: 3,
        loop_expanded_waypoint_count: 3
      })
    };
    const service = new NavigationService(dispatcher as never);
    await service.unlockControls();
    service.queueWaypoint({ x: -31.0, y: -64.0 });
    service.queueWaypoint({ x: -31.0, y: -63.9999 });
    service.queueWaypoint({ x: -30.9999, y: -63.9999 });
    service.queueWaypoint({ x: -31.0001, y: -64.0001 });
    service.toggleWaypointSelection(0);
    service.toggleWaypointSelection(1);
    service.toggleWaypointSelection(2);
    service.useQueuedWaypointsAsPatrolLoop();
    service.clearWaypointSelection();
    service.toggleWaypointSelection(3);
    service.setPatrolHomeFromSelected();
    service.clearWaypointSelection();
    service.toggleWaypointSelection(0);
    service.setPatrolDepartEntryFromSelected();

    await service.sendPatrolMission();

    const payload = dispatcher.requestPatrolMission.mock.calls[0][0] as {
      patrol_mission: {
        loop_waypoints: Array<{ yaw_deg?: number }>;
        home_waypoint: { yaw_deg?: number };
      };
    };
    expect(payload.patrol_mission.loop_waypoints).toHaveLength(3);
    expect(payload.patrol_mission.loop_waypoints.every((waypoint) => Number.isFinite(waypoint.yaw_deg))).toBe(true);
    expect(Number.isFinite(payload.patrol_mission.home_waypoint.yaw_deg)).toBe(true);
  });

  it("saves and loads file waypoints without yaw for auto mode", async () => {
    const dispatcher = {
      requestGoal: vi.fn(),
      requestRouteMission: vi.fn(),
      requestSaveWaypointsFile: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "ack",
        ok: true,
        waypoint_count: 2
      }),
      requestLoadWaypointsFile: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "ack",
        ok: true,
        patrol_profile: {
          home_waypoint_index: 0,
          loop_waypoint_indices: [1],
          return_waypoint_indices: [],
          depart_waypoint_indices: [],
          depart_entry_waypoint_index: 1
        },
        waypoints: [
          { lat: 1, lon: 2, role: "home" },
          {
            lat: 3,
            lon: 4,
            yaw_deg: 30,
            actions: [{ type: "brake_hold", duration_s: 5, brake_pct: 100 }]
          },
          { lat: 5, lon: 6 }
        ]
      }),
      requestCancelGoal: vi.fn(),
      requestCancelRouteMission: vi.fn(),
      requestManualMode: vi.fn(),
      requestManualCommand: vi.fn(),
      requestSnapshot: vi.fn(),
      requestCameraPan: vi.fn(),
      requestCameraZoomToggle: vi.fn(),
      requestCameraStatus: vi.fn()
    };
    const service = new NavigationService(dispatcher as never);
    service.queueWaypoint({ x: 1, y: 2, role: "home" });
    service.queueWaypoint({
      x: 3,
      y: 4,
      yawDeg: 30,
      actions: [{ type: "brake_hold", duration_s: 5, brake_pct: 100 }]
    });
    service.queueWaypoint({ x: 5, y: 6 });
    service.toggleWaypointSelection(1);
    service.useQueuedWaypointsAsPatrolLoop();
    service.setPatrolDepartEntryFromSelected();

    await service.saveWaypointsFile();
    await service.loadWaypointsFile();

    expect(dispatcher.requestSaveWaypointsFile).toHaveBeenCalledWith({
      waypoints: [
        { lat: 1, lon: 2, role: "home" },
        {
          lat: 3,
          lon: 4,
          yaw_deg: 30,
          actions: [{ type: "brake_hold", duration_s: 5, brake_pct: 100 }]
        },
        { lat: 5, lon: 6 }
      ],
      patrol_profile: {
        home_waypoint_index: 0,
        loop_waypoint_indices: [1, 2],
        return_waypoint_indices: [],
        depart_waypoint_indices: [],
        depart_entry_waypoint_index: 1
      }
    });
    expect(service.getState().waypoints[0]).toMatchObject({ x: 1, y: 2, role: "home" });
    expect(service.getState().waypoints[1]).toMatchObject({
      x: 3,
      y: 4,
      yawDeg: 30,
      actions: [{ type: "brake_hold", duration_s: 5, brake_pct: 100 }]
    });
    expect(service.getState().waypoints[2]).toMatchObject({ x: 5, y: 6 });
    expect(service.getState().patrolMissionProfile.homeWaypoint).toMatchObject({ x: 1, y: 2, role: "home" });
    expect(service.getState().patrolMissionProfile.departEntryLoopIndex).toBe(0);
  });

  it("applies route mission state from backend messages", () => {
    let onState: ((message: Record<string, unknown>) => void) | undefined;
    const dispatcher = {
      requestGoal: vi.fn(),
      requestRouteMission: vi.fn(),
      requestCancelGoal: vi.fn(),
      requestCancelRouteMission: vi.fn(),
      requestManualMode: vi.fn(),
      requestManualCommand: vi.fn(),
      requestSnapshot: vi.fn(),
      requestCameraPan: vi.fn(),
      requestCameraZoomToggle: vi.fn(),
      requestCameraStatus: vi.fn(),
      subscribeState: vi.fn((callback: (message: Record<string, unknown>) => void) => {
        onState = callback;
        return () => undefined;
      })
    };
    const service = new NavigationService(dispatcher as never);
    onState?.({
      op: "state",
      route_mission: {
        active: true,
        paused: false,
        loop: true,
        low_battery_active: true,
        return_home_requested: true,
        return_home_active: false,
        return_home_exit_waypoint_index: 2,
        return_home_phase: "waiting_exit",
        home_available: true,
        home_waypoint: { lat: 9, lon: 10, yaw_deg: 180, role: "home" },
        status: "route active (1->4)",
        input_waypoint_count: 3,
        expanded_waypoint_count: 7,
        active_chunk_size: 4,
        blocked_state: "WAITING_RETRY",
        blocked_reason_code: "NO_VALID_PATH",
        blocked_reason_text: "no valid path found",
        blocked_retry_attempt: 1,
        blocked_retry_max_attempts: 3,
        blocked_wait_remaining_s: 8.5,
        action_active: true,
        action_waypoint_index: 2,
        action_type: "brake_hold",
        action_remaining_s: 4.2,
        mission_waypoints: [
          {
            lat: 1,
            lon: 2,
            yaw_deg: 3,
            actions: [{ type: "brake_hold", duration_s: 5, brake_pct: 100 }]
          }
        ],
        active_chunk_waypoints: [{ lat: 4, lon: 5, yaw_deg: 6 }]
      }
    });

    expect(service.getState().routeMission).toMatchObject({
      active: true,
      loop: true,
      lowBatteryActive: true,
      returnHomeRequested: true,
      returnHomeExitWaypointIndex: 2,
      returnHomePhase: "waiting_exit",
      homeAvailable: true,
      expandedWaypointCount: 7,
      activeChunkSize: 4,
      blockedState: "WAITING_RETRY",
      blockedReasonCode: "NO_VALID_PATH",
      blockedReasonText: "no valid path found",
      blockedRetryAttempt: 1,
      blockedRetryMaxAttempts: 3,
      blockedWaitRemainingS: 8.5,
      actionActive: true,
      actionWaypointIndex: 2,
      actionType: "brake_hold",
      actionRemainingS: 4.2
    });
    expect(service.getState().routeMission.missionWaypoints[0]).toMatchObject({
      x: 1,
      y: 2,
      yawDeg: 3,
      actions: [{ type: "brake_hold", duration_s: 5, brake_pct: 100 }]
    });
    expect(service.getState().routeMission.homeWaypoint).toMatchObject({
      x: 9,
      y: 10,
      yawDeg: 180,
      role: "home"
    });
  });

  it("preserves active route mission state across transient idle telemetry snapshots", () => {
    let onNavTelemetry: ((message: Record<string, unknown>) => void) | undefined;
    const dispatcher = {
      requestGoal: vi.fn(),
      requestRouteMission: vi.fn(),
      requestCancelGoal: vi.fn(),
      requestCancelRouteMission: vi.fn(),
      requestManualMode: vi.fn(),
      requestManualCommand: vi.fn(),
      requestSnapshot: vi.fn(),
      requestCameraPan: vi.fn(),
      requestCameraZoomToggle: vi.fn(),
      requestCameraStatus: vi.fn(),
      subscribeNavTelemetry: vi.fn((callback: (message: Record<string, unknown>) => void) => {
        onNavTelemetry = callback;
        return () => undefined;
      })
    };
    const service = new NavigationService(dispatcher as never);

    onNavTelemetry?.({
      op: "nav_telemetry",
      goal_active: true,
      route_mission: {
        active: true,
        paused: false,
        loop: true,
        status: "route active (1->4)",
        input_waypoint_count: 3,
        expanded_waypoint_count: 7,
        active_chunk_size: 4,
        mission_waypoints: [{ lat: 1, lon: 2, yaw_deg: 0 }]
      }
    });

    onNavTelemetry?.({
      op: "nav_telemetry",
      goal_active: true,
      route_mission: {
        active: false,
        paused: false,
        loop: false,
        status: "idle",
        input_waypoint_count: 0,
        expanded_waypoint_count: 0,
        active_chunk_size: 0,
        mission_waypoints: [],
        active_chunk_waypoints: []
      }
    });

    expect(service.getState().routeMission).toMatchObject({
      active: true,
      loop: true,
      status: "route active (1->4)",
      expandedWaypointCount: 7,
      activeChunkSize: 4
    });
  });

  it("infers return-home phase from legacy route status payloads", () => {
    let onState: ((message: Record<string, unknown>) => void) | undefined;
    const dispatcher = {
      subscribeState: vi.fn<(cb: (message: Record<string, unknown>) => void) => () => void>((cb) => {
        onState = cb;
        return () => undefined;
      }),
      subscribeNavTelemetry: vi.fn(() => () => undefined),
      subscribeAck: vi.fn(() => () => undefined),
      subscribeRobotStatus: vi.fn(() => () => undefined),
      subscribeRobotPose: vi.fn(() => () => undefined),
      subscribeNavEvent: vi.fn(() => () => undefined),
      subscribeRecordingCount: vi.fn(() => () => undefined),
      subscribePatrolStatus: vi.fn(() => () => undefined)
    };
    const service = new NavigationService(dispatcher as never);

    onState?.({
      op: "state",
      route_mission: {
        active: false,
        paused: false,
        loop: true,
        low_battery_active: true,
        return_home_requested: false,
        return_home_active: false,
        status: "return home completed",
        home_available: true
      }
    });

    expect(service.getState().routeMission).toMatchObject({
      lowBatteryActive: true,
      loop: true,
      returnHomeRequested: false,
      returnHomeActive: false,
      returnHomePhase: "completed",
      returnHomeExitWaypointIndex: -1
    });
  });

  it("toggles goal mode in NavigationService state", () => {
    const dispatcher = {
      requestGoal: vi.fn(),
      requestCancelGoal: vi.fn(),
      requestManualMode: vi.fn(),
      requestManualCommand: vi.fn(),
      requestSnapshot: vi.fn(),
      requestCameraPan: vi.fn(),
      requestCameraZoomToggle: vi.fn(),
      requestCameraStatus: vi.fn()
    };
    const service = new NavigationService(dispatcher as never);
    expect(service.getState().goalMode).toBe(false);
    const next = service.toggleGoalMode();
    expect(next).toBe(true);
    expect(service.getState().goalMode).toBe(true);
  });

  it("applies runtime manual defaults in NavigationService", () => {
    const dispatcher = {
      requestGoal: vi.fn(),
      requestCancelGoal: vi.fn(),
      requestManualMode: vi.fn(),
      requestManualCommand: vi.fn(),
      requestSnapshot: vi.fn(),
      requestCameraPan: vi.fn(),
      requestCameraZoomToggle: vi.fn(),
      requestCameraStatus: vi.fn()
    };
    const service = new NavigationService(dispatcher as never, {
      linearSpeed: 1.2,
      steeringAngleDeg: 18,
      loopIntervalMs: 50
    });
    service.applyRuntimeDefaults({
      linearSpeed: 2.4,
      steeringAngleDeg: 30,
      loopIntervalMs: 90
    });
    const state = service.getState();
    expect(state.manualLinearSpeed).toBe(2.4);
    expect(state.manualSteeringAngleDeg).toBe(30);
  });

  it("persists zone state in MapService local storage adapter", () => {
    const service = new MapService({ requestMap: vi.fn(), subscribe: vi.fn(() => () => undefined) } as never);
    service.addZone("A");
    const savedCount = service.persistZonesToStorage();
    expect(savedCount).toBe(1);
    service.clearZones();
    expect(service.getState().zones).toHaveLength(0);
    const loadedCount = service.loadZonesFromStorage();
    expect(loadedCount).toBe(1);
    expect(service.getState().zones).toHaveLength(1);
  });

  it("validates mission input in MissionService", async () => {
    const dispatcher = {
      startMission: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "mission.start.result",
        ok: true
      }),
      subscribeMissionStatus: vi.fn(() => () => undefined)
    };
    const service = new MissionService(dispatcher as never);
    await expect(service.startMission({ missionId: "m1", robotId: "r1" })).resolves.toBeUndefined();
    await expect(service.startMission({ missionId: "", robotId: "r1" })).rejects.toThrow("required");
  });

  it("starts rosbag recording in MissionService", async () => {
    const dispatcher = {
      startMission: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "mission.start.result",
        ok: true
      }),
      subscribeMissionStatus: vi.fn(() => () => undefined),
      startRosbag: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "rosbag.status.update",
        ok: true,
        payload: { active: true, profile: "core", outputPath: "/tmp/bag", logPath: "/tmp/log" } as never
      }),
      stopRosbag: vi.fn(),
      requestRosbagStatus: vi.fn(),
      subscribeRosbagStatus: vi.fn(() => () => undefined)
    };
    const service = new MissionService(dispatcher as never);
    await expect(service.startRosbag()).resolves.toMatchObject({ active: true, profile: "core" });
  });

  it("runs manual command loop when keys are pressed", async () => {
    const dispatcher = {
      requestGoal: vi.fn(),
      requestCancelGoal: vi.fn(),
      requestManualMode: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "ack",
        ok: true
      }),
      requestManualCommand: vi
        .fn<(linearX: number, angularZ: number, brake: boolean) => Promise<Nav2IncomingMessage>>()
        .mockResolvedValue({
          op: "ack",
          ok: true
        }),
      requestSnapshot: vi.fn(),
      requestCameraPan: vi.fn(),
      requestCameraZoomToggle: vi.fn(),
      requestCameraStatus: vi.fn(),
      requestControlLock: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "ack",
        ok: true
      })
    };
    const service = new NavigationService(dispatcher as never);
    await service.unlockControls();
    await service.setManualMode(true);
    service.setManualKeyState("w", true);
    service.setManualKeyState("a", true);
    await Promise.resolve();
    expect(dispatcher.requestManualCommand).toHaveBeenCalled();
    const calls = dispatcher.requestManualCommand.mock.calls;
    const [linearX, angularZ, brake] = calls[calls.length - 1] ?? [];
    expect(Number(linearX)).toBeGreaterThan(0);
    expect(Number(angularZ)).toBeCloseTo(0.415, 3);
    expect(brake).toBe(false);
    await service.setManualMode(false);
  });

  it("initializes manual defaults in NavigationService constructor", () => {
    const dispatcher = {
      requestGoal: vi.fn(),
      requestCancelGoal: vi.fn(),
      requestManualMode: vi.fn(),
      requestManualCommand: vi.fn(),
      requestSnapshot: vi.fn(),
      requestCameraPan: vi.fn(),
      requestCameraZoomToggle: vi.fn(),
      requestCameraStatus: vi.fn()
    };
    const service = new NavigationService(dispatcher as never, {
      linearSpeed: 2.4,
      steeringAngleDeg: 30,
      loopIntervalMs: 70
    });
    const state = service.getState();
    expect(state.manualLinearSpeed).toBe(2.4);
    expect(state.manualSteeringAngleDeg).toBe(30);
  });

  it("keeps control heartbeat active while locked", async () => {
    vi.useFakeTimers();
    try {
      const dispatcher = {
        requestGoal: vi.fn(),
        requestCancelGoal: vi.fn(),
        requestManualMode: vi.fn(),
        requestManualCommand: vi.fn(),
        requestSnapshot: vi.fn(),
        requestCameraPan: vi.fn(),
        requestCameraZoomToggle: vi.fn(),
        requestCameraStatus: vi.fn(),
        requestControlHeartbeat: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
          op: "ack",
          ok: true
        })
      };
      const service = new NavigationService(dispatcher as never);

      expect(service.getState().controlLocked).toBe(true);
      vi.advanceTimersByTime(1100);
      await Promise.resolve();

      expect(dispatcher.requestControlHeartbeat).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("updates lock state from ack payloads", () => {
    const subscribers: {
      ack?: (message: Record<string, unknown>) => void;
    } = {};
    const dispatcher = {
      requestGoal: vi.fn(),
      requestCancelGoal: vi.fn(),
      requestManualMode: vi.fn(),
      requestManualCommand: vi.fn(),
      requestSnapshot: vi.fn(),
      requestCameraPan: vi.fn(),
      requestCameraZoomToggle: vi.fn(),
      requestCameraStatus: vi.fn(),
      subscribeAck: vi.fn((callback: (message: Record<string, unknown>) => void) => {
        subscribers.ack = callback;
        return () => undefined;
      })
    };
    const service = new NavigationService(dispatcher as never);

    subscribers.ack?.({
      op: "ack",
      payload: {
        control_locked: false,
        control_lock_reason: "REMOTE_UNLOCK"
      }
    });

    const state = service.getState();
    expect(state.controlLocked).toBe(false);
    expect(state.controlLockReason).toBe("REMOTE_UNLOCK");
  });

  it("updates lock state from legacy locked alias in ack payloads", () => {
    const subscribers: {
      ack?: (message: Record<string, unknown>) => void;
    } = {};
    const dispatcher = {
      requestGoal: vi.fn(),
      requestCancelGoal: vi.fn(),
      requestManualMode: vi.fn(),
      requestManualCommand: vi.fn(),
      requestSnapshot: vi.fn(),
      requestCameraPan: vi.fn(),
      requestCameraZoomToggle: vi.fn(),
      requestCameraStatus: vi.fn(),
      subscribeAck: vi.fn((callback: (message: Record<string, unknown>) => void) => {
        subscribers.ack = callback;
        return () => undefined;
      })
    };
    const service = new NavigationService(dispatcher as never);

    subscribers.ack?.({
      op: "ack",
      request: "set_control_lock",
      payload: {
        locked: false,
        lock_reason: "REMOTE_UNLOCK"
      }
    });

    const state = service.getState();
    expect(state.controlLocked).toBe(false);
    expect(state.controlLockReason).toBe("REMOTE_UNLOCK");
  });

  it("ignores legacy locked alias on unrelated ack requests", () => {
    const subscribers: {
      ack?: (message: Record<string, unknown>) => void;
    } = {};
    const dispatcher = {
      requestGoal: vi.fn(),
      requestCancelGoal: vi.fn(),
      requestManualMode: vi.fn(),
      requestManualCommand: vi.fn(),
      requestSnapshot: vi.fn(),
      requestCameraPan: vi.fn(),
      requestCameraZoomToggle: vi.fn(),
      requestCameraStatus: vi.fn(),
      subscribeAck: vi.fn((callback: (message: Record<string, unknown>) => void) => {
        subscribers.ack = callback;
        return () => undefined;
      })
    };
    const service = new NavigationService(dispatcher as never);

    subscribers.ack?.({
      op: "ack",
      request: "set_manual_mode",
      payload: {
        locked: false,
        lock_reason: "SHOULD_BE_IGNORED"
      }
    });

    const state = service.getState();
    expect(state.controlLocked).toBe(true);
    expect(state.controlLockReason).toBe("locked");
  });

  it("updates lock state from nav_event control lock codes", () => {
    const subscribers: {
      navEvent?: (message: Record<string, unknown>) => void;
    } = {};
    const dispatcher = {
      requestGoal: vi.fn(),
      requestCancelGoal: vi.fn(),
      requestManualMode: vi.fn(),
      requestManualCommand: vi.fn(),
      requestSnapshot: vi.fn(),
      requestCameraPan: vi.fn(),
      requestCameraZoomToggle: vi.fn(),
      requestCameraStatus: vi.fn(),
      subscribeNavEvent: vi.fn((callback: (message: Record<string, unknown>) => void) => {
        subscribers.navEvent = callback;
        return () => undefined;
      })
    };
    const service = new NavigationService(dispatcher as never);

    subscribers.navEvent?.({
      op: "nav_event",
      event: {
        code: "CONTROL_LOCK_RELEASED",
        details: {
          reason: "REMOTE_UNLOCK"
        }
      }
    });

    const state = service.getState();
    expect(state.controlLocked).toBe(false);
    expect(state.controlLockReason).toBe("REMOTE_UNLOCK");
  });
});
