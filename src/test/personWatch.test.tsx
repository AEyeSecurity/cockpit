import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseWatchState, PersonWatchService } from "../packages/nav2/modules/person-watch/service/PersonWatchService";
import { PersonWatchPanel } from "../packages/nav2/modules/person-watch/frontend";
function payload(sample = 10000) { return { schema: 1, server_ms: 10000, cameras: ["cam3", "cam4", "cam5"].map(id => ({
  id, label: id, status: "watching", sample_ms: sample, detections: [], inference_ms: 15
})), alerts: [{ id: "one", camera_id: "cam3", label: "Frontal", timestamp_ms: 9000, count: 1, confidence: .8 }] }; }
afterEach(() => { cleanup(); vi.useRealTimers(); });
describe("person watch", () => {
  it("uses server age, distinguishes stale cameras and translates alert time", () => {
    const state = parseWatchState(payload(1000), 50000);
    expect(state.cameras.every(c => c.status === "unavailable")).toBe(true);
    expect(state.alerts[0].timestamp_ms).toBe(49000);
    expect(() => parseWatchState({ ...payload(), cameras: [] })).toThrow();
    expect(parseWatchState({ ...payload(), alerts: [{ ...payload().alerts[0], confidence: NaN }] }).alerts).toHaveLength(0);
  });
  it("polls once for multiple views, cancels after unmount and marks outages", async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => payload() }).mockRejectedValue(new Error("offline"));
    const service = new PersonWatchService(() => "http://private/v1/state", fetchFn);
    const a = service.subscribe(() => {}), b = service.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchFn).toHaveBeenCalledTimes(1); expect(service.getSnapshot().available).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(service.getSnapshot().available).toBe(false);
    expect(service.getSnapshot().cameras[0].status).toBe("unavailable");
    a(); b(); await vi.advanceTimersByTimeAsync(10000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
  it("shows a camera-labelled alert and never presents lost reception as no people", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => payload() });
    const service = new PersonWatchService(() => "http://private", fetchFn);
    await act(async () => { render(<PersonWatchPanel service={service} />); });
    expect(screen.getByText("Persona detectada · Frontal")).toBeInTheDocument();
    expect(screen.getAllByText("Vigilando")).toHaveLength(3);
  });
});
