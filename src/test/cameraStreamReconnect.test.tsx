import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CameraStreamSurface } from "../packages/nav2/shared/CameraStreamSurface";

const config = { transport: "webrtc" as const, webrtcUrl: "saving", mjpegUrl: "", ptzRotationDeg: 0 as const, probeTimeoutMs: 3000, loadTimeoutMs: 7000 };
afterEach(() => { cleanup(); delete window.MediaMTXWebRTCReader; vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("quality reconnect lifecycle", () => {
  it("closes the previous reader on mode change and releases the final reader on stop", async () => {
    const opened: string[] = [];
    const closed: string[] = [];
    vi.stubGlobal("MediaStream", class {});
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    window.MediaMTXWebRTCReader = class {
      url: string;
      constructor(options: { url: string }) { this.url = options.url; opened.push(this.url); }
      close() { closed.push(this.url); }
    };
    const view = render(<CameraStreamSurface isActive config={config} className="" alt="test" />);
    await waitFor(() => expect(opened).toEqual(["saving"]));
    view.rerender(<CameraStreamSurface isActive config={{ ...config, webrtcUrl: "normal" }} className="" alt="test" />);
    await waitFor(() => expect(opened).toEqual(["saving", "normal"]));
    expect(closed).toEqual(["saving"]);
    view.rerender(<CameraStreamSurface isActive={false} config={{ ...config, webrtcUrl: "normal" }} className="" alt="test" />);
    expect(closed).toEqual(["saving", "normal"]);
    view.rerender(<CameraStreamSurface isActive={false} config={config} className="" alt="test" />);
    expect(opened).toHaveLength(2);
  });

  it("reports the first frame immediately, limits frame updates, and resets after an error", async () => {
    const status = vi.fn();
    const callbacks = vi.fn();
    const cancelFrame = vi.fn();
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    vi.stubGlobal("MediaStream", class {});
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    let options: { onTrack?: (event: RTCTrackEvent) => void; onError?: (error: string) => void };
    window.MediaMTXWebRTCReader = class {
      constructor(config: typeof options) { options = config; }
      close() {}
    };

    const view = render(<CameraStreamSurface isActive config={config} className="" alt="test" onStatusChange={status} />);
    const video = view.container.querySelector("video")!;
    video.requestVideoFrameCallback = callbacks.mockReturnValue(1);
    video.cancelVideoFrameCallback = cancelFrame;
    await waitFor(() => expect(options).toBeDefined());

    const track = () => options.onTrack?.({ streams: [new MediaStream()] } as unknown as RTCTrackEvent);
    const frame = (at: number) => act(() => {
      now.mockReturnValue(at);
      callbacks.mock.lastCall?.[0](at, {});
    });

    act(track);
    status.mockClear();
    frame(0);
    frame(66);
    frame(499);
    expect(status).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenLastCalledWith(expect.objectContaining({ connected: true }));
    frame(500);
    expect(status).toHaveBeenCalledTimes(2);

    act(() => options.onError?.("stream unavailable"));
    expect(cancelFrame).toHaveBeenCalled();
    expect(status).toHaveBeenLastCalledWith(expect.objectContaining({ connected: false, error: "stream unavailable" }));
    act(track);
    frame(550);
    expect(status).toHaveBeenLastCalledWith(expect.objectContaining({ connected: true, error: "" }));
  });

  it("reports failure without claiming the new feed is connected", async () => {
    const status = vi.fn();
    vi.stubGlobal("MediaStream", class {});
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    window.MediaMTXWebRTCReader = class {
      constructor(options: { onError?: (message: string) => void }) {
        options.onError?.("stream unavailable");
      }
      close() {}
    };
    render(<CameraStreamSurface isActive config={config} className="" alt="test" onStatusChange={status} />);
    await waitFor(() => expect(status).toHaveBeenLastCalledWith(expect.objectContaining({ error: "stream unavailable", connected: false })));
  });
});
