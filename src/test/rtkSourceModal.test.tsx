import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { bootstrapApp } from "../core/bootstrap/bootstrapApp";
import type { TelemetryService } from "../packages/nav2/modules/telemetry/service/impl/TelemetryService";

describe("RTK source modal", () => {
  it("shows save failures in the form and disables credential autofill hints", async () => {
    const runtime = await bootstrapApp();
    const contribution = runtime.contributions.get("nav2.modal.rtk");
    if (!contribution || contribution.slot !== "modal") {
      throw new Error("RTK modal contribution not registered");
    }

    const telemetryService = runtime.services.getService<TelemetryService>("nav2.service.telemetry");
    vi.spyOn(telemetryService, "upsertRtkSource").mockRejectedValue(
      new Error("backend does not support RTK source management")
    );

    render(<>{contribution.render({ close: vi.fn() })}</>);

    fireEvent.click(screen.getByRole("button", { name: "Agregar antena" }));
    fireEvent.change(screen.getByLabelText("Identificador RTK"), { target: { value: "base_sur" } });
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "rtk.example.com" } });
    fireEvent.change(screen.getByLabelText("Mountpoint"), { target: { value: "BASESUR" } });

    const userInput = screen.getByLabelText("Usuario");
    const passwordInput = screen.getByLabelText("Password");
    expect(userInput).toHaveAttribute("autocomplete", "off");
    expect(passwordInput).toHaveAttribute("autocomplete", "off");
    expect(userInput).toHaveAttribute("data-form-type", "other");
    expect(passwordInput).toHaveAttribute("data-form-type", "other");

    fireEvent.click(screen.getByRole("button", { name: "Guardar antena" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "No se pudo guardar la antena RTK: backend does not support RTK source management"
      );
    });
    expect(screen.getByRole("button", { name: "Guardar antena" })).toBeEnabled();
  });
});
