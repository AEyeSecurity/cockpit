import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { readCameraStreamConfig } from "../packages/nav2/shared/cameraStreamConfig";

describe("frontal video-only WHEP negotiation", () => {
  it.each([false, true, undefined])("negotiates audio only when requested: %s", async (receiveAudio) => {
    const connections: Array<{ kinds: string[] }> = [];
    class Peer {
      kinds: string[] = [];
      constructor() { connections.push(this); }
      addTransceiver(kind: string) { this.kinds.push(kind); }
      createDataChannel() {}
      createOffer() { return Promise.reject(new Error("end mock negotiation")); }
      close() {}
    }
    const context = {
      window: { setTimeout: vi.fn(), clearTimeout: vi.fn() }, RTCPeerConnection: Peer,
      fetch: vi.fn().mockResolvedValue({ headers: { get: () => null } }),
      setTimeout: vi.fn(), clearTimeout: vi.fn(), console
    };
    const source = readFileSync("public/vendor/mediamtx/reader.js", "utf8");
    runInNewContext(source + "; window.ReaderForTest = MediaMTXWebRTCReader;", context);
    const Reader = (context.window as unknown as { ReaderForTest: new (config: object) => { close(): void } }).ReaderForTest;
    const reader = new Reader({ url: "http://camera/whep", receiveAudio });
    await waitFor(() => expect(connections.length).toBe(4));
    expect(connections[3].kinds).toEqual(receiveAudio === false ? ["video"] : ["video", "audio"]);
    reader.close();
  });

  it("defaults frontal audio off and supports explicit opt-in", () => {
    const runtime = (value?: boolean) => ({
      getPackageConfig: () => ({ camera_transport: "webrtc", camera_webrtc_receive_audio: value }),
      env: {}
    });
    expect(readCameraStreamConfig(runtime() as never).webrtcReceiveAudio).toBe(false);
    expect(readCameraStreamConfig(runtime(true) as never).webrtcReceiveAudio).toBe(true);
  });
});
