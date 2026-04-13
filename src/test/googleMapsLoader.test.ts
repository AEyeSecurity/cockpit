import { describe, expect, it } from "vitest";
import { loadGoogleMapsApi } from "../packages/nav2/modules/map/frontend/googleMapsLoader";

describe("googleMapsLoader", () => {
  it("rejects when API key is missing", async () => {
    await expect(loadGoogleMapsApi("   ")).rejects.toThrow("Missing Google Maps API key");
  });

  it("resolves immediately when google.maps already exists", async () => {
    const mapsRef = {} as unknown as typeof google.maps;
    Object.defineProperty(window, "google", {
      configurable: true,
      value: {
        maps: mapsRef
      }
    });

    await expect(loadGoogleMapsApi("dummy-key")).resolves.toBe(mapsRef);
  });
});
