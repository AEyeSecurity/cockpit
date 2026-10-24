import { vi } from "vitest";
import type { RobotDispatcher } from "../packages/nav2/modules/navigation/dispatcher/impl/RobotDispatcher";
import type { Nav2IncomingMessage } from "../packages/nav2/protocol/messages";

export function robotRouteLibraryFixture() {
  const routes = new Map<string, { id: string; name: string; revision: number; document: unknown }>();
  let sequence = 0;
  const listeners = new Set<(message: Nav2IncomingMessage) => void>();
  const request = vi.fn(async (op: string, raw: unknown = {}): Promise<Nav2IncomingMessage> => {
    const payload = raw as { id?: string; name?: string; expected_revision?: number; document?: unknown };
    if (op === "list_routes") return { op: "ack", ok: true, routes: [...routes.values()].map(({ document: _, ...summary }) => summary).sort((a, b) => a.name.localeCompare(b.name)) };
    const route = payload.id ? routes.get(payload.id) : undefined;
    if (op === "get_route") return route ? { op: "ack", ok: true, route: structuredClone(route) } : { op: "ack", ok: false, error: "No existe" };
    if (payload.id && (!route || route.revision !== payload.expected_revision)) return { op: "ack", ok: false, error: "Otro operador modificó esta ruta", error_code: "ROUTE_CONFLICT" };
    if (op === "delete_route") {
      routes.delete(payload.id!);
      listeners.forEach((listener) => listener({ op: "routes_changed" }));
      return { op: "ack", ok: true };
    }
    if ([...routes.values()].some((item) => item.name === payload.name && item.id !== payload.id)) return { op: "ack", ok: false, error: "Ya existe una ruta con ese nombre" };
    const saved = { id: route?.id ?? String(++sequence), name: payload.name!, revision: (route?.revision ?? 0) + 1, document: structuredClone(payload.document) };
    routes.set(saved.id, saved);
    listeners.forEach((listener) => listener({ op: "routes_changed" }));
    return { op: "ack", ok: true, route: structuredClone(saved) };
  });
  const dispatcher = { requestRouteLibrary: request, subscribeRoutesChanged: (callback: (message: Nav2IncomingMessage) => void) => { listeners.add(callback); return () => { listeners.delete(callback); }; } };
  const attach = (target: RobotDispatcher) => {
    vi.spyOn(target, "requestRouteLibrary").mockImplementation(request);
    vi.spyOn(target, "subscribeRoutesChanged").mockImplementation(dispatcher.subscribeRoutesChanged);
  };
  return { routes, request, dispatcher, attach };
}
