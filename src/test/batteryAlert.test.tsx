import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { bootstrapApp } from "../core/bootstrap/bootstrapApp";
import type { ConnectionService } from "../packages/nav2/modules/navigation/service/impl/ConnectionService";
import { BatteryAlert } from "../packages/nav2/modules/telemetry/frontend/BatteryAlert";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("shows low and critical charge without stealing input or repeating each reading", async () => {
  const runtime = await bootstrapApp();
  const connection = runtime.getService<ConnectionService>("service.connection");
  const dispatcher = runtime.dispatchers.get("nav2.dispatcher.robot")!.dispatcher;
  vi.spyOn(connection, "subscribe").mockImplementation((listener) => {
    listener({ ...connection.getState(), connected: true });
    return () => {};
  });
  vi.useFakeTimers();
  render(<><button type="button">Control manual</button><BatteryAlert runtime={runtime} /></>);
  const control = screen.getByRole("button", { name: "Control manual" });
  control.focus();

  function report(battery_pct: number, battery_state = "OK", manual = false) {
    act(() => {
      dispatcher.handleIncoming({ op: "nav_telemetry", connected: true, battery_present: true, battery_pct, battery_state, manual_control: { enabled: manual } },
        dispatcher.transportId);
    });
  }

  report(30, "STALE");
  expect(screen.queryByRole("alert")).toBeNull();
  report(30, "OK", true);
  expect(screen.getByRole("alert")).toHaveTextContent("empezar a regresar al puesto de carga");
  expect(screen.getByRole("button", { name: "OK" })).toBeDisabled();
  expect(control).toHaveFocus();

  const released = vi.fn();
  window.addEventListener("keyup", released, { once: true });
  fireEvent.keyUp(control, { code: "KeyW" });
  expect(released).toHaveBeenCalledOnce();

  act(() => vi.advanceTimersByTime(60_000));
  expect(screen.getByRole("alert")).toHaveTextContent("Batería baja");
  report(29);
  fireEvent.click(screen.getByRole("button", { name: "OK" }));
  report(28);
  expect(screen.queryByRole("alert")).toBeNull();

  report(10);
  expect(screen.getByRole("alert")).toHaveTextContent("Urgente: regresá al puesto de carga de inmediato.");
  expect(control).toHaveFocus();
  report(35);
  expect(screen.getByRole("alert")).toHaveTextContent("Batería crítica");
  fireEvent.click(screen.getByRole("button", { name: "OK" }));
  report(30);
  expect(screen.getByRole("alert")).toHaveTextContent("Batería baja");
});
