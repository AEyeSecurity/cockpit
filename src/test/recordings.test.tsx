import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createRecordingsModule, RecordingsDispatcher } from "../packages/nav2/modules/recordings/frontend";

const status = { manual: false, mission: true, tail_seconds: 0, mission_stale: false,
  requested: true, disk_ok: true, cameras: [{ camera: "main", recording: true, error: "" }] };
function mount(execute: typeof RecordingsDispatcher.prototype.execute) {
  const contributions: any[] = [];
  createRecordingsModule().register({ dispatchers: { registerDispatcher: vi.fn() },
    contributions: { register: (value: unknown) => contributions.push(value) } } as never);
  vi.spyOn(RecordingsDispatcher.prototype, "execute").mockImplementation(execute);
  render(contributions.find(c => c.id === "workspace.recordings").render());
}
describe("recording library", () => {
  it("keeps mission capture visible after stopping manual capture", async () => {
    const execute = vi.fn(async (op: string) => op === "recordings_list" ? { items: [] } :
      op === "recordings_status" ? { ...status, manual: true } : status);
    mount(execute);
    fireEvent.click(await screen.findByRole("button", { name: "Detener grabación manual" }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith("recordings_stop"));
    expect(screen.getByText("Grabación solicitada por misión")).toBeInTheDocument();
  });
  it("distinguishes service error from an empty library", async () => {
    mount(async () => { throw new Error("recordings_not_configured"); });
    expect(await screen.findByRole("alert")).toHaveTextContent("recordings_not_configured");
    expect(screen.queryByText("No hay grabaciones para esta cámara y fecha.")).not.toBeInTheDocument();
  });
});
