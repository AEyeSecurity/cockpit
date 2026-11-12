import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoverAccessDialog, type RoverAccess } from "../packages/nav2/modules/navigation/frontend/RoverAccessDialog";

function fixture(overrides: Partial<NonNullable<RoverAccess["access"]>> = {}) {
  return {
    access: { id: "tab", mode: "waiting" as const, revision: 1, canTake: true, canKeepRoute: true, displaced: false, ...overrides },
    busy: false, error: "", connect: vi.fn(), disconnect: vi.fn(), choose: vi.fn()
  };
}

describe("Rover control dialogs", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value(this: HTMLDialogElement) { this.open = true; }
    });
  });
  afterEach(() => { Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal"); });

  it("offers both takeover options for an active autonomous mission", () => {
    const control = fixture();
    render(<RoverAccessDialog control={control} />);
    fireEvent.click(screen.getByRole("button", { name: "Tomar control y frenar" }));
    expect(control.choose).toHaveBeenCalledWith("take");
    fireEvent.click(screen.getByRole("button", { name: "Tomar control y mantener la ruta" }));
    expect(control.choose).toHaveBeenCalledWith("take", true);
  });

  it("lets a user cancel or watch when taking control is prohibited", () => {
    const control = fixture({ canTake: false });
    render(<RoverAccessDialog control={control} />);
    expect(screen.queryByRole("button", { name: /tomar control/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Espectar" }));
    expect(control.choose).toHaveBeenCalledWith("spectate");
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(control.disconnect).toHaveBeenCalledOnce();
  });

  it("lets the displaced controller continue watching or disconnect", () => {
    const control = fixture({ mode: "spectator", displaced: true });
    render(<RoverAccessDialog control={control} />);
    expect(screen.getByText("Otro usuario tomó el control del Rover")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Aceptar" }));
    expect(control.choose).toHaveBeenCalledWith("acknowledge");
    fireEvent.click(screen.getByRole("button", { name: "Desconectar" }));
    expect(control.disconnect).toHaveBeenCalledOnce();
  });
});
