import { RoverDisplacedNotice } from "../packages/nav2/modules/navigation/frontend/OperatorAlerts";
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

  it("shows a passive notice explaining spectator mode to the displaced operator", () => {
    const control = fixture({ mode: "spectator", displaced: true });
    const { rerender } = render(<RoverDisplacedNotice control={control} manualControl />);
    expect(screen.getByRole("alert")).toHaveTextContent("Pasaste a modo espectador");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "OK" })).toBeDisabled();
    rerender(<RoverDisplacedNotice control={control} manualControl={false} />);
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(control.choose).toHaveBeenCalledWith("acknowledge");
  });

  it("shows a pending safety confirmation after a SALUS outage", () => {
    const control = fixture({ phase: "fault", canKeepRoute: false });
    const { rerender } = render(<RoverAccessDialog control={control} />);
    expect(screen.getByRole("heading", { name: "Control del Rover en pausa" })).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: "Verificar SALUS y tomar control" });
    fireEvent.click(retry);
    expect(control.choose).toHaveBeenCalledWith("take");
    rerender(<RoverAccessDialog control={{ ...control, busy: true }} />);
    expect(retry).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Verificando");
    expect(screen.queryByText("Ya hay un usuario conectado al Rover")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /mantener la ruta/i })).not.toBeInTheDocument();
  });
});
