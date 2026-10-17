import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecondaryCameraTile } from "../packages/nav2/modules/camera/frontend/SecondaryCameraTile";
vi.mock("../packages/nav2/shared/CameraStreamSurface", () => ({ CameraStreamSurface: ({ config }: { config: { webrtcUrl: string } }) => <div data-testid="feed">{config.webrtcUrl}</div> }));
afterEach(cleanup);
const config = { transport: "webrtc" as const, mjpegUrl: "", webrtcUrl: "primary", ptzRotationDeg: 0 as const, probeTimeoutMs: 3000, loadTimeoutMs: 7000 };
describe("secondary camera feeds", () => {
  it("does not open a missing reverse camera", () => {
    render(<SecondaryCameraTile autoStart title="Reversa" description="Trasera" config={config} url="" />);
    expect(screen.queryByTestId("feed")).toBeNull();
    expect(screen.getByText("Cámara pendiente de conectar")).toBeTruthy();
  });
  it("opens only the mobile URL when requested and releases it on stop", () => {
    render(<SecondaryCameraTile title="Móvil" description="Secundaria" config={config} url="mobile" />);
    expect(screen.queryByTestId("feed")).toBeNull();
    fireEvent.click(screen.getByText("Ver video"));
    expect(screen.getByTestId("feed").textContent).toBe("mobile");
    fireEvent.click(screen.getByText("Detener"));
    expect(screen.queryByTestId("feed")).toBeNull();
  });
  it("opens a configured reverse feed automatically", () => {
    render(<SecondaryCameraTile autoStart title="Reversa" description="Trasera" config={config} url="rear" />);
    expect(screen.getByTestId("feed").textContent).toBe("rear");
  });
});
