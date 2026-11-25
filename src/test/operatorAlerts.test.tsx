import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { bootstrapApp } from "../core/bootstrap/bootstrapApp";
import { OperatorAlerts } from "../packages/nav2/modules/navigation/frontend/OperatorAlerts";
import type { RobotDispatcher } from "../packages/nav2/modules/navigation/dispatcher/impl/RobotDispatcher";
import type { ConnectionService } from "../packages/nav2/modules/navigation/service/impl/ConnectionService";
import type { NavigationService } from "../packages/nav2/modules/navigation/service/impl/NavigationService";

it("warns once for a matching loop rejection and once per blocked incident", async () => {
  const runtime = await bootstrapApp();
  const navigation = runtime.getService<NavigationService>("service.navigation");
  const connection = runtime.getService<ConnectionService>("service.connection");
  const dispatcher = runtime.dispatchers.get("nav2.dispatcher.robot")!.dispatcher as RobotDispatcher;
  vi.spyOn(connection, "subscribe").mockImplementation((listener) => {
    listener({ ...connection.getState(), connected: true });
    return () => {};
  });
  vi.spyOn(dispatcher, "requestNavigationProfile").mockResolvedValue({ op: "ack", ok: true });
  vi.spyOn(dispatcher, "requestRouteMission").mockResolvedValue({ op: "ack", ok: true, preparation_id: 7 });
  navigation.applyLocalControlLock(false, "SIM_BACKEND");
  navigation.queueWaypoint({ x: 10, y: 10 });
  navigation.queueWaypoint({ x: 20, y: 20 });
  render(<OperatorAlerts runtime={runtime} />);

  const reject = (id: number) => act(() => {
    dispatcher.handleIncoming({
      op: "nav_event", component: "route_executor", code: "ROUTE_ANCHOR_REJECTED",
      details: [{ key: "preparation_id", value: String(id) }, { key: "reason", value: "no_near_segment" }]
    }, dispatcher.transportId);
  });
  await act(async () => { await navigation.sendRouteMission(); });
  reject(6);
  expect(screen.queryByRole("alert")).toBeNull();
  reject(7);
  expect(screen.getByRole("alert")).toHaveTextContent("Repetir la ruta al terminar");
  fireEvent.click(screen.getByRole("button", { name: "OK" }));
  reject(7);
  expect(screen.queryByRole("alert")).toBeNull();

  const block = (blocked_state: string) => act(() => {
    dispatcher.handleIncoming({
      op: "state",
      manual_control: { enabled: true },
      route_mission: { active: true, blocked_state, blocked_reason_text: "Camino bloqueado" }
    }, dispatcher.transportId);
  });
  block("RECOVERING");
  expect(screen.queryByRole("alert")).toBeNull();
  block("NEEDS_OPERATOR");
  const card = screen.getByRole("alert").closest("aside")!;
  expect(card).toHaveTextContent("La ruta no pudo continuar");
  const notices = card.closest(".nav-operator-notices");
  expect(notices?.parentElement).toBe(document.body);
  expect(notices).toHaveAttribute("data-manual-control", "true");
  expect(within(card).getByRole("button", { name: "OK" })).toBeDisabled();

  act(() => {
    dispatcher.handleIncoming({ op: "nav_telemetry", manual_control: { enabled: false } }, dispatcher.transportId);
  });
  expect(notices).toHaveAttribute("data-manual-control", "false");
  fireEvent.click(within(card).getByRole("button", { name: "OK" }));
  block("NEEDS_OPERATOR");
  expect(screen.queryByRole("alert")).toBeNull();
  block("CLEAR");
  block("NEEDS_OPERATOR");
  expect(screen.getByRole("alert")).toHaveTextContent("La ruta no pudo continuar");
  navigation.stopControlHeartbeat();
  vi.restoreAllMocks();
});
