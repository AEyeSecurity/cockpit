import { render, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModuleContext } from "../core/types/module";
import type { MapService, MapWorkspaceState } from "../packages/nav2/modules/map/service/impl/MapService";

const hoisted = vi.hoisted(() => ({
  loadGoogleMapsApiMock: vi.fn(),
  mapEngineCtorMock: vi.fn(),
  mapEngineInstances: [] as Array<Record<string, ReturnType<typeof vi.fn>>>
}));

vi.mock("../packages/nav2/modules/map/frontend/googleMapsLoader", () => ({
  GoogleMapsLoadError: class GoogleMapsLoadError extends Error {},
  loadGoogleMapsApi: hoisted.loadGoogleMapsApiMock
}));

vi.mock("../packages/nav2/modules/map/frontend/mapEngine", () => ({
  MapEngine: hoisted.mapEngineCtorMock
}));

import { GoogleMapCanvas } from "../packages/nav2/modules/map/frontend";

function createRuntime(): ModuleContext {
  return {
    env: {
      appName: "Cockpit Test",
      wsUrl: "",
      rosbridgeUrl: "",
      httpBaseUrl: "",
      googleMapsApiKey: "test-key",
      cameraIframeUrl: "",
      rosboardIframeUrlReal: "",
      rosboardIframeUrlSim: "",
      rosboardProbeTimeoutMs: 3000,
      rosboardLoadTimeoutMs: 7000
    },
    eventBus: {
      emit: vi.fn(),
      on: vi.fn(() => () => undefined)
    }
  } as unknown as ModuleContext;
}

function createState(input?: Partial<MapWorkspaceState>): MapWorkspaceState {
  return {
    map: {
      mapId: "map",
      title: "map",
      originLat: 1,
      originLon: 2
    },
    toolMode: "idle",
    toolInfo: "Map tools idle.",
    autoSync: true,
    zones: [],
    inspectCoords: "n/a",
    ...input
  };
}

function createEngineMock(): Record<string, ReturnType<typeof vi.fn>> {
  return {
    destroy: vi.fn(),
    setInteractive: vi.fn(),
    setMapType: vi.fn(),
    setToolMode: vi.fn(),
    setGoalMode: vi.fn(),
    setZoneEditMode: vi.fn(),
    setZones: vi.fn(),
    setWaypoints: vi.fn(),
    setRobotPose: vi.fn(),
    setDatumPose: vi.fn(),
    setMapOrigin: vi.fn(),
    centerOnRobot: vi.fn(),
    setInitialView: vi.fn(),
    invalidateSize: vi.fn()
  };
}

function renderCanvas(overrides?: Partial<ComponentProps<typeof GoogleMapCanvas>>) {
  const mapService = {
    setToolInfo: vi.fn(),
    setInspectCoords: vi.fn()
  };

  return render(
    <GoogleMapCanvas
      active
      state={createState()}
      mapService={mapService as unknown as MapService}
      runtime={createRuntime()}
      interactive
      goalMode={false}
      zoneEditMode="idle"
      mapType="hybrid"
      waypoints={[]}
      selectedWaypointIndexes={[]}
      robotPose={null}
      datumPose={null}
      centerRequestKey={0}
      onQueueWaypoint={vi.fn()}
      onToggleWaypointSelection={vi.fn()}
      onMoveWaypoint={vi.fn()}
      onZoneCreate={vi.fn()}
      onZonePolygonChange={vi.fn()}
      onZoneDelete={vi.fn()}
      onZoneToggle={vi.fn()}
      initialCenterLat={-31.4}
      initialCenterLon={-64.1}
      initialZoom={16}
      {...overrides}
    />
  );
}

describe("map workspace consumption", () => {
  beforeEach(() => {
    hoisted.mapEngineInstances.length = 0;
    hoisted.loadGoogleMapsApiMock.mockReset();
    hoisted.mapEngineCtorMock.mockReset();

    hoisted.loadGoogleMapsApiMock.mockResolvedValue({} as typeof google.maps);
    hoisted.mapEngineCtorMock.mockImplementation(() => {
      const engine = createEngineMock();
      hoisted.mapEngineInstances.push(engine);
      return engine;
    });
  });

  it("lazy-loads google maps only when canvas is active", async () => {
    const view = renderCanvas({ active: false });

    expect(hoisted.loadGoogleMapsApiMock).not.toHaveBeenCalled();

    view.rerender(
      <GoogleMapCanvas
        active
        state={createState()}
        mapService={{ setToolInfo: vi.fn(), setInspectCoords: vi.fn() } as unknown as MapService}
        runtime={createRuntime()}
        interactive
        goalMode={false}
        zoneEditMode="idle"
        mapType="hybrid"
        waypoints={[]}
        selectedWaypointIndexes={[]}
        robotPose={null}
        datumPose={null}
        centerRequestKey={0}
        onQueueWaypoint={vi.fn()}
        onToggleWaypointSelection={vi.fn()}
        onMoveWaypoint={vi.fn()}
        onZoneCreate={vi.fn()}
        onZonePolygonChange={vi.fn()}
        onZoneDelete={vi.fn()}
        onZoneToggle={vi.fn()}
        initialCenterLat={-31.4}
        initialCenterLon={-64.1}
        initialZoom={16}
      />
    );

    await waitFor(() => {
      expect(hoisted.loadGoogleMapsApiMock).toHaveBeenCalledTimes(1);
      expect(hoisted.mapEngineCtorMock).toHaveBeenCalledTimes(1);
    });
  });

  it("pauses map sync while hidden and replays latest snapshot on return", async () => {
    const initialState = createState({
      zones: [
        {
          id: "z1",
          name: "Zone 1",
          vertices: 3,
          updatedAt: Date.now(),
          polygon: [
            { lat: 0, lon: 0 },
            { lat: 0, lon: 1 },
            { lat: 1, lon: 1 }
          ]
        }
      ]
    });

    const nextState = createState({
      map: {
        mapId: "map2",
        title: "map2",
        originLat: 5,
        originLon: 6
      },
      zones: [
        {
          id: "z2",
          name: "Zone 2",
          vertices: 3,
          updatedAt: Date.now(),
          polygon: [
            { lat: 2, lon: 2 },
            { lat: 2, lon: 3 },
            { lat: 3, lon: 3 }
          ]
        }
      ]
    });

    const view = renderCanvas({
      active: true,
      state: initialState,
      waypoints: [{ x: 1, y: 2, yawDeg: 30 }],
      selectedWaypointIndexes: [0],
      robotPose: { lat: 1, lon: 2, headingDeg: 90 },
      datumPose: { lat: 1, lon: 2 }
    });

    await waitFor(() => {
      expect(hoisted.mapEngineInstances).toHaveLength(1);
    });

    const engine = hoisted.mapEngineInstances[0];
    engine.setWaypoints.mockClear();
    engine.setRobotPose.mockClear();
    engine.setDatumPose.mockClear();
    engine.setZones.mockClear();
    engine.setMapOrigin.mockClear();
    engine.centerOnRobot.mockClear();
    engine.setInteractive.mockClear();

    view.rerender(
      <GoogleMapCanvas
        active={false}
        state={nextState}
        mapService={{ setToolInfo: vi.fn(), setInspectCoords: vi.fn() } as unknown as MapService}
        runtime={createRuntime()}
        interactive
        goalMode={false}
        zoneEditMode="idle"
        mapType="hybrid"
        waypoints={[{ x: 9, y: 8, yawDeg: 70 }]}
        selectedWaypointIndexes={[]}
        robotPose={{ lat: 9, lon: 8, headingDeg: 180 }}
        datumPose={{ lat: 9, lon: 8 }}
        centerRequestKey={3}
        onQueueWaypoint={vi.fn()}
        onToggleWaypointSelection={vi.fn()}
        onMoveWaypoint={vi.fn()}
        onZoneCreate={vi.fn()}
        onZonePolygonChange={vi.fn()}
        onZoneDelete={vi.fn()}
        onZoneToggle={vi.fn()}
        initialCenterLat={-31.4}
        initialCenterLon={-64.1}
        initialZoom={16}
      />
    );

    await waitFor(() => {
      expect(engine.setInteractive).toHaveBeenCalledWith(false);
    });
    expect(engine.setWaypoints).not.toHaveBeenCalled();
    expect(engine.setRobotPose).not.toHaveBeenCalled();
    expect(engine.setDatumPose).not.toHaveBeenCalled();
    expect(engine.setZones).not.toHaveBeenCalled();
    expect(engine.setMapOrigin).not.toHaveBeenCalled();
    expect(engine.centerOnRobot).not.toHaveBeenCalled();
    expect(hoisted.mapEngineCtorMock).toHaveBeenCalledTimes(1);

    view.rerender(
      <GoogleMapCanvas
        active
        state={nextState}
        mapService={{ setToolInfo: vi.fn(), setInspectCoords: vi.fn() } as unknown as MapService}
        runtime={createRuntime()}
        interactive
        goalMode={false}
        zoneEditMode="idle"
        mapType="hybrid"
        waypoints={[{ x: 9, y: 8, yawDeg: 70 }]}
        selectedWaypointIndexes={[]}
        robotPose={{ lat: 9, lon: 8, headingDeg: 180 }}
        datumPose={{ lat: 9, lon: 8 }}
        centerRequestKey={3}
        onQueueWaypoint={vi.fn()}
        onToggleWaypointSelection={vi.fn()}
        onMoveWaypoint={vi.fn()}
        onZoneCreate={vi.fn()}
        onZonePolygonChange={vi.fn()}
        onZoneDelete={vi.fn()}
        onZoneToggle={vi.fn()}
        initialCenterLat={-31.4}
        initialCenterLon={-64.1}
        initialZoom={16}
      />
    );

    await waitFor(() => {
      expect(engine.setInteractive).toHaveBeenCalledWith(true);
      expect(engine.setWaypoints).toHaveBeenCalledTimes(1);
      expect(engine.setRobotPose).toHaveBeenCalledTimes(1);
      expect(engine.setDatumPose).toHaveBeenCalledTimes(1);
      expect(engine.setZones).toHaveBeenCalledTimes(1);
      expect(engine.setMapOrigin).toHaveBeenCalledTimes(1);
      expect(engine.centerOnRobot).toHaveBeenCalledTimes(1);
    });
    expect(hoisted.mapEngineCtorMock).toHaveBeenCalledTimes(1);
  });
});
