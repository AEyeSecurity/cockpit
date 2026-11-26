import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import HistoryWorkspace from "../packages/nav2/modules/history/frontend/HistoryWorkspace";
import type { HistoryDispatcher } from "../packages/nav2/modules/history/frontend";

const patrol = {
  id: "test-patrol", robot: "SALUS", status: "interrupted", started_at: "2026-11-26T14:00:00Z",
  ended_at: null, duration_s: 242, circuit_s: 195, incomplete: true
};
const stop = {
  sequence: 2, robot: "SALUS", timestamp: "2026-11-26T14:03:15Z", patrol_id: patrol.id,
  category: "stop", severity: 0, component: "controller", code: "VEHICLE_STOP_OBSERVED", details: {}
};

it("shows measured stops without implying a cause and opens a patrol with its independent timings", async () => {
  const read = vi.fn(async (op, fields) => {
    if (op === "history_patrol") return { patrol, schema_version: 1, items: [stop], through: 2, next: null };
    return { robot: "SALUS", degraded: false, next: null, items: fields.view === "patrols" ? [patrol] : [stop] };
  });
  render(<HistoryWorkspace dispatcher={{ read } as unknown as HistoryDispatcher} />);
  expect(await screen.findByText("Detención medida")).toBeInTheDocument();
  expect(screen.getByText("Motivo no disponible")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Patrullas" }));
  fireEvent.click(await screen.findByRole("button", { name: /Ver detalle/ }));
  expect(await screen.findByText("4 min 2 s")).toBeInTheDocument();
  expect(screen.getByText("3 min 15 s")).toBeInTheDocument();
  expect(screen.getByText("Sin cierre registrado")).toBeInTheDocument();
});

it("exports a versioned JSONL file in query order across event pages", async () => {
  const start = { ...stop, sequence: 1, code: "PATROL_MISSION_STARTED" };
  const read = vi.fn(async (op, fields) => {
    if (op === "history_list") return { robot: "SALUS", degraded: false, next: null, items: [patrol] };
    return {
      patrol, schema_version: 1, through: 2, next: fields.after ? null : 1,
      items: fields.after ? [stop] : [start]
    };
  });
  const create = vi.fn(() => "blob:history");
  vi.stubGlobal("URL", Object.assign(class extends URL {}, { createObjectURL: create, revokeObjectURL: vi.fn() }));
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  try {
    render(<HistoryWorkspace dispatcher={{ read } as unknown as HistoryDispatcher} />);
    fireEvent.click(screen.getByRole("button", { name: "Patrullas" }));
    fireEvent.click(await screen.findByRole("button", { name: /Ver detalle/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Descargar registro/ }));
    await waitFor(() => expect(click).toHaveBeenCalledOnce());
    const [blob] = create.mock.calls[0] as unknown as [Blob];
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = reject;
      reader.readAsText(blob);
    });
    const lines = text.trim().split("\n").map(line => JSON.parse(line));
    expect(lines[0]).toMatchObject({ type: "patrol", schema_version: 1, incomplete: true });
    expect(lines.slice(1).map(line => line.sequence)).toEqual([1, 2]);
  } finally {
    click.mockRestore();
    vi.unstubAllGlobals();
  }
});

it("explains navigation waits and separates controller stop signals from braking", async () => {
  const items = [
    { ...stop, sequence: 5, code: "PATH_HEALTH_RECOVERED", details: { reason_code: "costmap_stale" } },
    { ...stop, sequence: 4, code: "PATH_STOP_AND_WAIT", details: { reason_code: "costmap_stale" } },
    { ...stop, sequence: 3, code: "BRAKE_APPLIED", details: { brake_pct: "100", stop_signal: "True" } },
    { ...stop, sequence: 2, code: "SAFETY_STOP_SIGNAL_ACTIVE", details: { brake_pct: "0", stop_signal: "True" } }
  ];
  const read = vi.fn(async () => ({ robot: "SALUS", degraded: false, next: null, items }));
  render(<HistoryWorkspace dispatcher={{ read } as unknown as HistoryDispatcher} />);
  expect(await screen.findByText("Navegación en espera")).toBeInTheDocument();
  expect(screen.getByText("Datos del mapa de obstáculos vencidos")).toBeInTheDocument();
  expect(screen.getByText("Camino válido recuperado")).toBeInTheDocument();
  expect(screen.getByText("Freno aplicado según el controlador")).toBeInTheDocument();
  expect(screen.getByText("Señal de parada reportada sin freno aplicado")).toBeInTheDocument();
  expect(screen.queryByText("Parada de emergencia activa")).not.toBeInTheDocument();
});
