import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CameraAuxControls } from "../packages/nav2/modules/camera/frontend/CameraAuxControls";

function fixture() {
  const state = { supported: true, sweepRunning: false, sweepPhase: "idle",
    fixedLight: -1, mobileLight: -1, error: "" };
  return {
    readCameraFeatures: vi.fn().mockResolvedValue(state),
    sweepCamera: vi.fn().mockImplementation(async (enabled) => ({ ...state, sweepRunning: enabled, sweepPhase: "moving_left" })),
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
    fireEvent.click(start);
    await waitFor(() => expect(service.sweepCamera).toHaveBeenCalledWith(true));
    expect(await screen.findByText("Buscando extremo izquierdo…")).toBeInTheDocument();
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

  it("blocks starts without control but leaves stop and off accessible", async () => {
    const service = fixture();
    render(<CameraAuxControls service={service as never} connected controlLocked />);
    fireEvent.click(screen.getByText("Luces"));
    await waitFor(() => expect(service.readCameraFeatures).toHaveBeenCalled());
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
