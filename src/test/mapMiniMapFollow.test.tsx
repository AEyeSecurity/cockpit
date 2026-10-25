import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import L from "leaflet";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapApp } from "../core/bootstrap/bootstrapApp";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function mapWorkspace() {
  const runtime = await bootstrapApp();
  const workspace = runtime.contributions.get("nav2.workspace.map");
  if (!workspace || workspace.slot !== "workspace") throw new Error("Map workspace not registered");
  const dispatcher = runtime.dispatchers.get("nav2.dispatcher.robot")!.dispatcher;
  const setView = vi.spyOn(L.Map.prototype, "setView");
  const pose = (lat: number, lon: number) => act(() => {
    dispatcher.handleIncoming({ op: "robot_pose", robot_pose: { lat, lon, heading_deg: 0 } }, dispatcher.transportId);
  });
  const miniMap = () => {
    const maps = setView.mock.contexts as L.Map[];
    const map = maps.filter((item) => item.getContainer().isConnected && item.getContainer().closest(".map-mini-frame")).pop();
    if (!map) throw new Error("Live minimap not found");
    return map;
  };
  return { workspace, pose, miniMap };
}

function expectCenter(map: L.Map, lat: number, lon: number) {
  expect(map.getCenter().lat).toBeCloseTo(lat, 6);
  expect(map.getCenter().lng).toBeCloseTo(lon, 6);
}

describe("camera minimap robot tracking", () => {
  it("centers on the existing robot pose immediately and follows new poses without changing the main map preference", async () => {
    const { workspace, pose, miniMap } = await mapWorkspace();
    pose(-31.48, -64.24);
    render(<>{workspace.render()}</>);
    expect(screen.getByRole("button", { name: "Seguir al robot" })).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(screen.getByTitle("Abrir cámara"));
    expectCenter(miniMap(), -31.48, -64.24);
    pose(-31.4805, -64.2408);
    expectCenter(miniMap(), -31.4805, -64.2408);

    fireEvent.click(screen.getByRole("button", { name: "Volver al mapa" }));
    expect(screen.getByRole("button", { name: "Seguir al robot" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByTitle("Abrir cámara"));
    expectCenter(miniMap(), -31.4805, -64.2408);
  });

  it("waits for telemetry when expanded before the first robot pose", async () => {
    const { workspace, pose, miniMap } = await mapWorkspace();
    render(<>{workspace.render()}</>);
    fireEvent.click(screen.getByTitle("Abrir cámara"));
    expect(document.querySelector(".map-mini-frame .robot-icon")).toBeNull();
    pose(-31.49, -64.25);
    expectCenter(miniMap(), -31.49, -64.25);
    expect(document.querySelector(".map-mini-frame .robot-icon")).not.toBeNull();
  });
});
