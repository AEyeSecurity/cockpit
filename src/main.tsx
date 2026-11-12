import React from "react";
import ReactDOM from "react-dom/client";
import { AppShell } from "./app/AppShell";
import { VscodeWebviewShell, type CockpitWebviewSlot } from "./app/VscodeWebviewShell";
import { bootstrapApp } from "./core/bootstrap/bootstrapApp";
import { isHostBridgeAvailable } from "./platform/host/bridge";
import { NavLiveWindow } from "./packages/nav2/modules/navigation/frontend/NavLiveWindow";
import { activateSession, loadSession, SessionGate } from "./packages/identity/SessionGate";
import { registerIdentity } from "./packages/identity/register";
import type { Session } from "./packages/identity/api";
import { RoverAccessProvider } from "./packages/nav2/modules/navigation/frontend/RoverAccessDialog";
import type { ConnectionService } from "./packages/nav2/modules/navigation/service/impl/ConnectionService";
import "./app/base.css";
import "./app/design.css";

declare global {
  interface Window {
    __COCKPIT_WEBVIEW_SLOT__?: CockpitWebviewSlot;
  }
}

async function start(): Promise<void> {
  const root = ReactDOM.createRoot(document.getElementById("root")!);
  const managed = import.meta.env.VITE_COCKPIT_AUTH === "required";
  const intro = document.getElementById("cockpit-intro");
  if (managed) intro?.remove();
  else if (intro) {
    window.setTimeout(() => {
      intro.classList.add("done");
      intro.addEventListener("animationend", () => intro.remove(), { once: true });
    }, 5400);
  }
  let session: Session | null = null;
  if (managed) {
    try {
      session = await loadSession();
    } catch {
      root.render(<SessionGate initial={null} unavailable />);
      return;
    }
    if (session?.stage !== "ready") {
      root.render(<SessionGate initial={session} />);
      return;
    }
    activateSession(session);
  }
  const runtime = await bootstrapApp({ roverControlCsrf: import.meta.env.VITE_COCKPIT_ROVER_CONTROL === "true" ? session?.csrf : undefined, operatorUser: session?.account.role === "user", managed: managed && import.meta.env.VITE_COCKPIT_KEEP_CONNECTIONS !== "true" });
  if (session) registerIdentity(runtime, session);
  const params = new URLSearchParams(window.location.search);
  const isNavLiveWindow = params.get("view") === "nav-live";
  const slot = window.__COCKPIT_WEBVIEW_SLOT__ ?? "full";
  const useVscodeFullLayout = slot === "full" && isHostBridgeAvailable();
  const content = isNavLiveWindow ? (
        <NavLiveWindow runtime={runtime} />
      ) : slot === "full" ? (
        <AppShell runtime={runtime} layoutMode={useVscodeFullLayout ? "vscode" : "default"} />
      ) : (
        <VscodeWebviewShell runtime={runtime} slot={slot} />
      );
  const csrf = runtime.env.roverControlCsrf;
  root.render(
    <React.StrictMode>
      {csrf ? <RoverAccessProvider csrf={csrf} service={runtime.getService<ConnectionService>("service.connection")}>
        {content}
      </RoverAccessProvider> : content}
    </React.StrictMode>
  );
}

void start();
