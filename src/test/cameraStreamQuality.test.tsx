import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CameraQualityButton } from "../packages/nav2/modules/camera/frontend/CameraQualityButton";
import { cameraStreamQuality, useCameraStreamConfig } from "../packages/nav2/shared/cameraStreamQuality";
import { readCameraStreamConfig, supportsNormalCameraQuality } from "../packages/nav2/shared/cameraStreamConfig";
import type { ModuleContext } from "../core/types/module";

const values: Record<string, unknown> = {
  camera_transport: "webrtc", camera_webrtc_url: "front-saving", camera_normal_webrtc_url: "front-normal",
  camera_mobile_webrtc_url: "mobile-saving", camera_mobile_normal_webrtc_url: "mobile-normal",
  camera_reverse_webrtc_url: "rear-saving", camera_reverse_normal_webrtc_url: "rear-normal"
};
function runtime(overrides: Record<string, unknown> = {}) {
  const config = { ...values, ...overrides };
  let updated: ((payload: { packageId: string }) => void) | undefined;
  return {
    ctx: { getPackageConfig: () => config, env: {}, eventBus: { on: (_: string, listener: typeof updated) => { updated = listener; return () => {}; } } } as unknown as ModuleContext,
    update: (key: string, value: unknown) => { config[key] = value; updated?.({ packageId: "nav2" }); }
  };
}
function Feed({ ctx, name }: { ctx: ModuleContext; name: string }) {
  const { config } = useCameraStreamConfig(ctx);
  return <output data-testid={name}>{[config.webrtcUrl, config.mobileWebrtcUrl, config.reverseWebrtcUrl].join(",")}</output>;
}
beforeEach(() => {
  const storage = new Map<string, string>();
  Object.defineProperty(window, "localStorage", { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); }
  } });
  cameraStreamQuality.set("saving");
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe("camera quality selection", () => {
  it("defaults to saving and switches all three URLs without changing audio or orientation", () => {
    const { ctx } = runtime({ camera_ptz_rotation_deg: 180 });
    expect(readCameraStreamConfig(ctx).webrtcUrl).toBe("front-saving");
    const normal = readCameraStreamConfig(ctx, "normal");
    expect([normal.webrtcUrl, normal.mobileWebrtcUrl, normal.reverseWebrtcUrl]).toEqual(["front-normal", "mobile-normal", "rear-normal"]);
    expect(normal.webrtcReceiveAudio).toBe(false);
    expect(normal.ptzRotationDeg).toBe(180);
  });
  it.each([{ camera_reverse_normal_webrtc_url: "" }, { camera_transport: "mjpeg" }])("disables incomplete or unsupported profiles: %j", overrides => {
    const { ctx } = runtime(overrides);
    expect(supportsNormalCameraQuality(ctx)).toBe(false);
    expect(readCameraStreamConfig(ctx, "normal").webrtcUrl).toBe("front-saving");
    render(<CameraQualityButton runtime={ctx} />);
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  });
  it("does not require normal URLs for unconfigured secondary cameras", () => {
    expect(supportsNormalCameraQuality(runtime({ camera_reverse_webrtc_url: "", camera_reverse_normal_webrtc_url: "" }).ctx)).toBe(true);
  });
  it("synchronizes mounted views, persists preference and restores it on remount", () => {
    const { ctx } = runtime();
    const view = render(<><CameraQualityButton runtime={ctx} /><Feed ctx={ctx} name="map" /><Feed ctx={ctx} name="workspace" /></>);
    fireEvent.click(screen.getByRole("button", { name: "Calidad de transmisión" }));
    expect(screen.getByTestId("map").textContent).toBe("front-normal,mobile-normal,rear-normal");
    expect(screen.getByTestId("workspace").textContent).toBe(screen.getByTestId("map").textContent);
    expect(window.localStorage.getItem("cockpit.camera.streamQuality")).toBe("normal");
    view.unmount();
    render(<CameraQualityButton runtime={ctx} />);
    expect(screen.getByRole("button").textContent).toBe("Calidad normal");
    fireEvent.click(screen.getByRole("button"));
    expect(window.localStorage.getItem("cockpit.camera.streamQuality")).toBe("saving");
  });
  it("reacts to package configuration changes", () => {
    const { ctx, update } = runtime();
    render(<Feed ctx={ctx} name="map" />);
    act(() => cameraStreamQuality.set("normal"));
    act(() => update("camera_normal_webrtc_url", "new-front"));
    expect(screen.getByTestId("map").textContent).toContain("new-front");
  });
  it("continues in memory when storage is blocked", () => {
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => { throw new Error("denied"); });
    expect(() => cameraStreamQuality.set("normal")).not.toThrow();
    expect(cameraStreamQuality.getSnapshot()).toBe("normal");
  });
});
