import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseWatchState, PersonWatchService } from "../packages/nav2/modules/person-watch/service/PersonWatchService";
import { detectionClipFinder } from "../packages/nav2/modules/person-watch/service/detectionClip";
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
  it("shows a recent event and its count", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => payload() });
    const service = new PersonWatchService(() => "http://private", fetchFn);
    await act(async () => { render(<PersonWatchPanel service={service} />); });
    expect(screen.getByText("Detección de personas")).toBeInTheDocument();
    expect(screen.getByText("1 evento")).toBeInTheDocument();
  });
  it("loads evidence only on request and rejects a server-provided image URL", async () => {
    const id = "a0292a23-4ccc-4c04-8b73-0123456789ab";
    const data = { ...payload(), alerts: [{ ...payload().alerts[0], id, image_available: true, image_url: "https://untrusted.test/photo" }] };
    const parsed = parseWatchState(data, 10000, "http://private:8791/v1/state");
    expect(parsed.alerts[0].image_url).toBe(`http://private:8791/v1/alerts/${id}.jpg`);
    const service = new PersonWatchService(() => "http://private:8791/v1/state", vi.fn().mockResolvedValue({ ok: true, json: async () => data }));
    await act(async () => { render(<PersonWatchPanel service={service} />); });
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Detección de personas/ }));
    expect(screen.getByRole("img")).toHaveAttribute("src", `http://private:8791/v1/alerts/${id}.jpg`);
    fireEvent.error(screen.getByRole("img"));
    expect(screen.getByRole("status")).toHaveTextContent("La captura ya no está disponible");
  });

});

it("keeps original frame time, validates GPS age and routes images through the managed gateway", () => {
  const id = "a0292a23-4ccc-4c04-8b73-0123456789ab";
  const alert = { ...payload().alerts[0], id, frame_ms: 8500, image_available: true };
  const position = { lat: -31.42, lon: -64.18, timestamp_ms: 8000 };
  const parse = (fix: typeof position) => parseWatchState({
    ...payload(), alerts: [{ ...alert, position: fix }]
  }, 80000, "/operation/person").alerts[0];
  expect(parse(position)).toMatchObject({ frame_ms: 8500, position, image_url: `/operation/person/alerts/${id}.jpg` });
  expect(parse({ ...position, timestamp_ms: 8501 }).position).toBeUndefined();
  expect(parse({ ...position, timestamp_ms: 3499 }).position).toBeUndefined();
});

it.each([["cam3", "main"], ["cam4", "mobile"], ["cam5", "rear"]])(
  "finds ten seconds only when the recording covers the entire alert window for %s", async (camera_id, camera) => {
    const start = new Date(5000).toISOString();
    const video = { start, camera, duration: 10, url: "http://private/download?sig=example" };
    const execute = vi.fn().mockResolvedValueOnce({ items: [{ ...video, duration: 9 }] })
      .mockResolvedValueOnce({ items: [video] });
    const findClip = detectionClipFinder({ execute } as never, true);
    const alert = { ...payload().alerts[0], camera_id, frame_ms: 10000 };
    await expect(findClip(alert)).resolves.toBeUndefined();
    await expect(findClip(alert)).resolves.toBe("/operation/recordings/download?sig=example&view=inline");
    expect(execute).toHaveBeenCalledWith("recordings_list", { camera, start, end: new Date(15000).toISOString() });
  }
);

it("opens one detection at a time and releases evidence when switched", async () => {
  const data = payload();
  data.alerts.push({ ...data.alerts[0], id: "two", camera_id: "cam5", label: "Trasera", timestamp_ms: 1000 });
  const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => data });
  const service = new PersonWatchService(() => "http://private/v1/state", fetchFn);
  await act(async () => { render(<PersonWatchPanel service={service} />); });

  const [front, rear] = screen.getAllByRole("button", { name: /Detección de personas/ });
  expect(front).toHaveAttribute("aria-expanded", "false");
  expect(rear).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(front);
  expect(front).toHaveAttribute("aria-expanded", "true");
  fireEvent.click(rear);
  expect(front).toHaveAttribute("aria-expanded", "false");
  expect(rear).toHaveAttribute("aria-expanded", "true");
  expect(screen.getAllByText("Ubicación no disponible")).toHaveLength(1);
  fireEvent.click(rear);
  expect(screen.queryByText("Ubicación no disponible")).not.toBeInTheDocument();
});

it("groups nearby confirmations and uses one common clip time across all three cameras", async () => {
  const base = payload();
  const data = { ...base, server_ms: 30000, alerts: [
    { ...base.alerts[0], timestamp_ms: 11000, frame_ms: 10000 },
    { ...base.alerts[0], id: "two", camera_id: "cam4", timestamp_ms: 14000, frame_ms: 13000 },
    { ...base.alerts[0], id: "three", camera_id: "cam5", timestamp_ms: 16000, frame_ms: 15000 }
  ] };
  const findClip = vi.fn(async () => undefined);
  const service = new PersonWatchService(() => "http://private/v1/state",
    vi.fn().mockResolvedValue({ ok: true, json: async () => data }));
  await act(async () => { render(<PersonWatchPanel service={service} findClip={findClip} />); });
  expect(screen.getAllByRole("button", { name: /Detección de personas/ })).toHaveLength(2);
  expect(findClip).not.toHaveBeenCalled();

  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /2 cámaras detectaron/ })); });
  expect(findClip).toHaveBeenLastCalledWith({ camera_id: "cam3", frame_ms: 10000 });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Móvil PTZ Detección/ })); });
  expect(findClip).toHaveBeenLastCalledWith({ camera_id: "cam4", frame_ms: 10000 });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Trasera Contexto/ })); });
  expect(findClip).toHaveBeenLastCalledWith({ camera_id: "cam5", frame_ms: 10000 });
});
