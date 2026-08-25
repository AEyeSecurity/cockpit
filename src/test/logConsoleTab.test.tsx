import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { bootstrapApp } from "../core/bootstrap/bootstrapApp";

describe("log console", () => {
  it("keeps local command errors visible when telemetry is available", async () => {
    const runtime = await bootstrapApp();
    const contribution = runtime.contributions.get("core.console.log");
    if (!contribution || contribution.slot !== "console") {
      throw new Error("Log console contribution not registered");
    }

    render(<>{contribution.render()}</>);

    act(() => {
      runtime.eventBus.emit("console.event", {
        level: "error",
        text: "Patrol mission failed: command transport disconnected",
        timestamp: Date.now()
      });
    });

    expect(screen.getByText("Patrol mission failed: command transport disconnected")).toBeInTheDocument();
    expect(screen.queryByText("No events yet")).not.toBeInTheDocument();
  });
});
