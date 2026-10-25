import { act, cleanup, render } from "@testing-library/react";
import L from "leaflet";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapApp } from "../core/bootstrap/bootstrapApp";

const originalRetina = Object.getOwnPropertyDescriptor(L.Browser, "retina")!;
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(L.Browser, "retina", originalRetina);
});

describe.each([false, true])("satellite zoom with retina=%s", (retina) => {
  it("allows visual zoom to 26 while requesting imagery no higher than level 19", async () => {
    Object.defineProperty(L.Browser, "retina", { ...originalRetina, value: retina });
    const runtime = await bootstrapApp();
    const workspace = runtime.contributions.get("nav2.workspace.map");
    if (!workspace || workspace.slot !== "workspace") throw new Error("Map workspace not registered");
    const setView = vi.spyOn(L.Map.prototype, "setView");
    render(<>{workspace.render()}</>);
    const map = (setView.mock.contexts as L.Map[]).find((item) => item.getContainer().isConnected)!;
    act(() => { map.setZoom(26, { animate: false }); });
    expect(map.getZoom()).toBe(26);
    const imagery = Array.from(document.querySelectorAll<HTMLImageElement>("img.leaflet-tile"))
      .map((tile) => tile.src.match(/World_Imagery\/MapServer\/tile\/(\d+)\//))
      .filter((match): match is RegExpMatchArray => match !== null)
      .map((match) => Number(match[1]));
    expect(imagery.length).toBeGreaterThan(0);
    expect(Math.max(...imagery)).toBe(19);
  });
});
