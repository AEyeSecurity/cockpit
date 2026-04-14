import { afterEach, describe, expect, it, vi } from "vitest";
import { loadGoogleMapsApi } from "../packages/nav2/modules/map/frontend/googleMapsLoader";

afterEach(() => {
  vi.restoreAllMocks();
  document.getElementById("cockpit-google-maps-script")?.remove();
  if ("google" in window) {
    delete (window as unknown as Record<string, unknown>).google;
  }
  if ("__cockpitGoogleMapsInit" in window) {
    delete (window as unknown as Record<string, unknown>).__cockpitGoogleMapsInit;
  }
});

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

  it("loads script without optional libraries query", async () => {
    const appendSpy = vi.spyOn(document.head, "appendChild");
    const pending = loadGoogleMapsApi("dummy-key");
    const script = appendSpy.mock.calls[0]?.[0] as HTMLScriptElement | undefined;
    expect(script).toBeDefined();
    expect(script?.src).toContain("maps.googleapis.com/maps/api/js");
    expect(script?.src).not.toContain("libraries=");

    const mapsRef = {} as unknown as typeof google.maps;
    Object.defineProperty(window, "google", {
      configurable: true,
      value: {
        maps: mapsRef
      }
    });
    window.__cockpitGoogleMapsInit?.();
    await expect(pending).resolves.toBe(mapsRef);
  });
});
