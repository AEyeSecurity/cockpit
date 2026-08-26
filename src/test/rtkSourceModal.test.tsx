import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapApp } from "../core/bootstrap/bootstrapApp";
import { TelemetryService, type TelemetrySnapshot } from "../packages/nav2/modules/telemetry/service/impl/TelemetryService";

afterEach(() => vi.useRealTimers());

describe("RTK source modal", () => {
  it("distinguishes handshake, valid corrections and a frozen heartbeat", async () => {
    const runtime = await bootstrapApp();
    const service = runtime.services.getService<TelemetryService>("nav2.service.telemetry");
    let next: ((value: TelemetrySnapshot) => void) | undefined;
    let snapshot: TelemetrySnapshot = {
      ...service.getSnapshot(),
      robotStatus: { ...service.getSnapshot().robotStatus, connected: true },
      rtkSources: [{ id: "ign_ucor", label: "IGN UCOR" }],
      rtkSourceState: {
        active_source_id: "ign_ucor", active_source_label: "IGN UCOR", connected: true,
        receiving_rtcm: false, rtcm_age_s: null, rtcm_stale_timeout_s: 10, status_sequence: 1
      }
    };
    vi.spyOn(service, "getSnapshot").mockImplementation(() => snapshot);
    vi.spyOn(service, "subscribeTelemetry").mockImplementation((callback) => {
      next = callback;
      return () => undefined;
    });
    const modal = runtime.contributions.get("nav2.modal.rtk");
    if (!modal || modal.slot !== "modal") throw new Error("Missing RTK modal");
    vi.useFakeTimers();
    const view = render(<>{modal.render({ close: () => undefined })}</>);
    expect(screen.getByText("NTRIP conectado · esperando RTCM válido")).toBeInTheDocument();
    expect(view.container.querySelector(".rtk-status-dot.connected")).toBeNull();
    snapshot = { ...snapshot, rtkSourceState: {
      ...snapshot.rtkSourceState, receiving_rtcm: true, rtcm_age_s: 0.2, status_sequence: 2
    } };
    act(() => next?.(snapshot));
    expect(screen.getByText("Recibiendo correcciones RTCM")).toBeInTheDocument();
    expect(view.container.querySelector(".rtk-status-dot.connected")).not.toBeNull();
    act(() => vi.advanceTimersByTime(6000));
    expect(screen.getByText("Sin telemetría RTK reciente")).toBeInTheDocument();
    expect(view.container.querySelector(".rtk-status-dot.connected")).toBeNull();
    view.unmount();
  });
});
