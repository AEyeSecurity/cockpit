import { describe, expect, it, vi } from "vitest";
import { NavigationService } from "../packages/nav2/modules/navigation/service/impl/NavigationService";
import { robotRouteLibraryFixture } from "./robotRouteLibraryFixture";

async function operator(library = robotRouteLibraryFixture()) {
  const service = new NavigationService(library.dispatcher as never);
  service.setRouteLibraryConnection(true, "ws://robot:8766");
  await service.refreshSavedRoutes();
  return { service, library };
}

describe("shared robot route library", () => {
  it("refreshes another operator's catalog and refuses stale edits while preserving the draft", async () => {
    const { service: first, library } = await operator();
    const { service: second } = await operator(library);
    first.queueWaypoint({ x: -31, y: -64 });
    await first.saveNamedRoute("Patrulla");
    await vi.waitFor(() => expect(second.listSavedRouteNames()).toEqual(["Patrulla"]));
    await second.loadNamedRoute("Patrulla");
    second.queueWaypoint({ x: -31.1, y: -64.1 });
    first.queueWaypoint({ x: -31.2, y: -64.2 });
    await first.saveCurrentNamedRoute();
    await vi.waitFor(() => expect(second.getState().routeLibrary.conflict).toBe(true));
    const draft = second.getState().waypoints;
    await expect(second.saveCurrentNamedRoute()).rejects.toThrow(/Otro operador/);
    expect(second.getState().waypoints).toEqual(draft);
    expect(second.getState().routeEditor.dirty).toBe(true);
    await second.saveNamedRoute("Copia del borrador");
    expect(library.routes.size).toBe(2);
    expect(second.getState().routeLibrary.conflict).toBe(false);
  });

  it("never marks a failed save as saved and keeps offline drafts editable", async () => {
    const { service, library } = await operator();
    service.queueWaypoint({ x: -31, y: -64 });
    library.request.mockRejectedValueOnce(new Error("Sin espacio en disco"));
    await expect(service.saveNamedRoute("Fallida")).rejects.toThrow(/disco/);
    expect(service.getState().routeEditor).toMatchObject({ dirty: true, activeRouteName: null });
    expect(service.getState().routeLibrary).toMatchObject({ busy: false, error: "Sin espacio en disco" });
    service.setRouteLibraryConnection(false, "ws://robot:8766");
    service.queueWaypoint({ x: -31.1, y: -64.1 });
    await expect(service.saveNamedRoute("Offline")).rejects.toThrow(/Conectate/);
    expect(service.getState().waypoints).toHaveLength(2);
  });

  it("discards replies from the old robot after changing connection", async () => {
    const { service, library } = await operator();
    service.queueWaypoint({ x: -31, y: -64 });
    let finish!: (response: { op: string; ok: boolean; route: unknown }) => void;
    library.request.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = service.saveNamedRoute("Anterior");
    expect(service.getState().routeLibrary.busy).toBe(true);
    service.setRouteLibraryConnection(false, "ws://robot-two:8766");
    finish({ op: "ack", ok: true, route: { id: "old", revision: 1, name: "Anterior" } });
    await expect(pending).rejects.toThrow(/conexión cambió/);
    expect(service.listSavedRouteNames()).toEqual([]);
    expect(service.getState().routeEditor.activeRouteName).toBeNull();
    expect(service.getState().waypoints).toHaveLength(1);
  });

  it("retains edits made while a save is pending", async () => {
    const { service, library } = await operator();
    service.queueWaypoint({ x: -31, y: -64 });
    const dispatch = library.request.getMockImplementation()!;
    let finish!: () => void;
    library.request.mockImplementationOnce((op, payload) => new Promise((resolve) => {
      finish = () => { void dispatch(op, payload).then(resolve); };
    }));
    const pending = service.saveNamedRoute("Primera versión");
    service.queueWaypoint({ x: -31.1, y: -64.1 });
    finish();
    await pending;
    expect(service.getState().waypoints).toHaveLength(2);
    expect(service.getState().routeEditor.dirty).toBe(true);
    expect((Array.from(library.routes.values())[0].document as { waypoints: unknown[] }).waypoints).toHaveLength(1);
  });

  it("imports selected local routes without replacing duplicates or deleting local data", async () => {
    const source = JSON.stringify({ Local: { waypoints: [{ x: -31, y: -64 }], loopRoute: false } });
    Object.defineProperty(window, "localStorage", { configurable: true, value: {
      getItem: (key: string) => key === "cockpit.navigation.routes.v1" ? source : null,
      setItem: vi.fn()
    } });
    const { service, library } = await operator();
    expect(service.listSavedRouteNames()).toEqual([]);
    expect(service.listLocalRouteNames()).toEqual(["Local"]);
    await service.importLocalRoute("Local", "Compartida");
    await expect(service.importLocalRoute("Local", "Compartida")).rejects.toThrow(/Ya existe/);
    expect(library.routes.size).toBe(1);
    expect(window.localStorage.setItem).not.toHaveBeenCalled();
    const session = service.getRouteLibrarySession();
    service.setRouteLibraryConnection(false, "ws://otro:8766");
    await expect(service.importLocalRoute("Local", "Otra", session)).rejects.toThrow(/conexión cambió/);
  });

  it("allows offline draft placement while preserving the robot control lock", async () => {
    const library = robotRouteLibraryFixture();
    const service = new NavigationService(library.dispatcher as never);
    await expect(service.setGoalMode(true)).rejects.toThrow(/locked/);
    await service.setGoalMode(true, true);
    service.beginWaypointInsertion(-1, undefined, true);
    service.insertWaypoint(0, { x: -31, y: -64 });
    expect(service.getState().controlLocked).toBe(true);
    expect(service.getState().waypoints).toHaveLength(1);
    expect(library.request).not.toHaveBeenCalled();
    await expect(service.saveNamedRoute("Borrador")).rejects.toThrow(/Conectate/);
    service.setRouteLibraryConnection(true, "ws://robot:8766");
    await expect(service.setGoalMode(true, true)).rejects.toThrow(/locked/);
  });

  it("does not replace a new draft when an earlier save completes", async () => {
    const { service, library } = await operator();
    service.queueWaypoint({ x: -31, y: -64 });
    const dispatch = library.request.getMockImplementation()!;
    let finish!: () => void;
    library.request.mockImplementationOnce((op, payload) => new Promise((resolve) => {
      finish = () => { void dispatch(op, payload).then(resolve); };
    }));
    const pending = service.saveNamedRoute("Anterior");
    service.createNewRouteDraft();
    finish();
    await pending;
    expect(service.getState().waypoints).toEqual([]);
    expect(service.getState().routeEditor.activeRouteName).toBeNull();
    expect(service.listSavedRouteNames()).toEqual(["Anterior"]);
  });

  it("round trips route backups without starting any mission", async () => {
    const { service, library } = await operator();
    service.queueWaypoint({ x: -31, y: -64, yawDeg: 20, role: "home" });
    service.queueWaypoint({ x: -31.1, y: -64.1, actions: [{ type: "brake_hold", duration_s: 4 }] });
    const text = service.exportRouteDocument();
    service.clearWaypoints();
    service.importRouteDocument(text);
    expect(JSON.parse(service.exportRouteDocument())).toEqual(JSON.parse(text));
    expect(service.getState().routeEditor.dirty).toBe(true);
    expect(library.request.mock.calls.every(([op]) => op === "list_routes")).toBe(true);
  });
});
