import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CameraAuxControls } from "../packages/nav2/modules/camera/frontend/CameraAuxControls";

function fixture() {
  const state = { supported: true, sweepRunning: false, sweepPhase: "idle",
    fixedLight: -1, mobileLight: -1, error: "" };
  return {
    readCameraFeatures: vi.fn().mockResolvedValue(state),
    sweepCamera: vi.fn().mockImplementation(async (enabled) => ({ ...state, sweepRunning: enabled, sweepPhase: "centering" })),
    setCameraLight: vi.fn().mockImplementation(async (lens, enabled) => ({ ...state,
      [lens === "mobile" ? "mobileLight" : "fixedLight"]: enabled ? 1 : 0 }))
  };
}

describe("camera sweep and light controls", () => {
  it("starts and stops one sweep and sends independent light targets", async () => {
    const service = fixture();
    render(<CameraAuxControls service={service as never} connected controlLocked={false} />);
    fireEvent.click(screen.getByText("Luces"));
    const start = screen.getByRole("button", { name: "Iniciar paneo" });
    await waitFor(() => expect(start).toBeEnabled());
    const minimum = screen.getByRole("slider", { name: "Ángulo mínimo" });
    const maximum = screen.getByRole("slider", { name: "Ángulo máximo" });
    fireEvent.change(maximum, { target: { value: "30" } });
    fireEvent.change(minimum, { target: { value: "40" } });
    expect(minimum).toHaveValue("28");
    expect(maximum).toHaveValue("30");
    expect(service.sweepCamera).not.toHaveBeenCalled();
    fireEvent.click(start);
    await waitFor(() => expect(service.sweepCamera).toHaveBeenCalledWith(true));
    expect(await screen.findByText("Buscando la posición inicial…")).toBeInTheDocument();
    expect(start).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Detener paneo" }));
    await waitFor(() => expect(service.sweepCamera).toHaveBeenCalledWith(false));
    const mobile = screen.getByRole("button", { name: "Encender luz móvil" });
    await waitFor(() => expect(mobile).toBeEnabled());
    fireEvent.click(mobile);
    await waitFor(() => expect(service.setCameraLight).toHaveBeenCalledWith("mobile", true));
    await waitFor(() => expect(screen.getByRole("button", { name: "Apagar luz fija" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Apagar luz fija" }));
    await waitFor(() => expect(service.setCameraLight).toHaveBeenCalledWith("fixed", false));
  });

  it("uses the camera's available range and sends the selected limits", async () => {
    const service = fixture();
    service.readCameraFeatures.mockResolvedValue({
      ...await service.readCameraFeatures(),
      sweepBounds: { minimum: -35, maximum: 315 }
    });
    render(<CameraAuxControls service={service as never} connected controlLocked={false} />);
    await screen.findByRole("group", { name: "Rango de paneo" });
    const minimum = screen.getByRole("slider", { name: "Ángulo mínimo" });
    const maximum = screen.getByRole("slider", { name: "Ángulo máximo" });
    expect(minimum).toHaveValue("-35");
    fireEvent.change(minimum, { target: { value: "-20" } });
    fireEvent.change(maximum, { target: { value: "250" } });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar paneo" }));
    expect(service.sweepCamera).toHaveBeenCalledWith(true, { minimum: -20, maximum: 250 });
    await screen.findByText("Buscando la posición inicial…");
  });

  it("blocks starts without control but leaves stop and off accessible", async () => {
    const service = fixture();
    render(<CameraAuxControls service={service as never} connected controlLocked />);
    fireEvent.click(screen.getByText("Luces"));
    expect(screen.getByText("Consultando el estado del paneo…")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Consultando el estado del paneo…")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Iniciar paneo" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Encender luz fija" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Detener paneo" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Apagar luz móvil" })).toBeEnabled();
  });

  it("does not display an unknown light as off and surfaces a rejected command", async () => {
    const service = fixture();
    service.setCameraLight.mockRejectedValue(new Error("mobile light unsupported"));
    render(<CameraAuxControls service={service as never} connected controlLocked={false} />);
    fireEvent.click(screen.getByText("Luces"));
    const on = screen.getByRole("button", { name: "Encender luz móvil" });
    await waitFor(() => expect(on).toBeEnabled());
    expect(screen.getAllByText("Sin confirmar")).toHaveLength(2);
    fireEvent.click(on);
    expect(await screen.findByRole("alert")).toHaveTextContent("mobile light unsupported");
  });
});
