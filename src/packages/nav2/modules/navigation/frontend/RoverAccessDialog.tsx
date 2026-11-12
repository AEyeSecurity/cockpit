import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, message } from "../../../../identity/api";
import type { ConnectionService } from "../service/impl/ConnectionService";

interface Access {
  id: string;
  mode: "waiting" | "spectator" | "controller";
  revision: number;
  canTake: boolean;
  canKeepRoute: boolean;
  displaced: boolean;
}

function useRoverAccess(service: ConnectionService, csrf?: string) {
  const [access, setAccess] = useState<Access | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const current = useRef<Access | null>(null);
  const actionPending = useRef(false);

  function update(value: Access | null) {
    current.current = value;
    setAccess(value);
  }

  function request<T>(action: string, body: Record<string, unknown> = {}) {
    return api<T>("rover/control/" + action, "POST", body, csrf);
  }

  useEffect(() => {
    if (!csrf || !access?.id) return;
    const id = access.id;
    let active = true;
    let polling = false;
    const timer = window.setInterval(async () => {
      if (polling || actionPending.current) return;
      polling = true;
      try {
        const next = await api<Access>("rover/control/heartbeat", "POST", { instanceId: id }, csrf);
        if (active && !actionPending.current && current.current?.id === id &&
            next.revision >= current.current.revision) update(next);
      } catch (failure) {
        if (!active || actionPending.current || current.current?.id !== id) return;
        update(null);
        setError(message(failure));
        void service.disconnect();
      } finally {
        polling = false;
      }
    }, 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [access?.id, csrf, service]);

  async function perform(task: () => Promise<void>) {
    if (actionPending.current) return;
    actionPending.current = true;
    setBusy(true);
    setError("");
    try {
      await task();
    } catch (failure) {
      setError(message(failure));
    } finally {
      actionPending.current = false;
      setBusy(false);
    }
  }

  async function join(next: Access) {
    update(next);
    if (next.mode === "waiting" || service.getState().connected) return;
    service.setPreset("real");
    await service.connect(next.id);
    if (!service.getState().connected) {
      update(null);
      await request("close", { instanceId: next.id });
    }
  }

  function connect() {
    return perform(async () => {
      if (!csrf) return service.connect();
      await join(await request<Access>("open"));
    });
  }

  function disconnect() {
    return perform(async () => {
      const previous = current.current;
      update(null);
      try {
        if (previous && csrf) await request("close", { instanceId: previous.id });
      } finally {
        await service.disconnect();
      }
    });
  }

  function choose(action: "spectate" | "take" | "acknowledge", keepRoute = false) {
    return perform(async () => {
      const previous = current.current;
      if (!previous) return;
      const next = await request<Access>(action, { instanceId: previous.id, revision: previous.revision, keepRoute });
      if (action === "acknowledge") update(next);
      else await join(next);
    });
  }

  return { access, error, busy, connect, disconnect, choose };
}

export type RoverAccess = ReturnType<typeof useRoverAccess>;
const RoverAccessContext = createContext<RoverAccess | null>(null);

export const useRoverAccessContext = () => useContext(RoverAccessContext);

export function RoverAccessProvider({ service, csrf, children }: {
  service: ConnectionService;
  csrf: string;
  children: ReactNode;
}) {
  const control = useRoverAccess(service, csrf);
  return <RoverAccessContext.Provider value={control}>
    {children}
    <RoverAccessDialog control={control} />
  </RoverAccessContext.Provider>;
}

export function RoverAccessDialog({ control }: { control: RoverAccess }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { access, busy, error, disconnect, choose } = control;
  const waiting = access?.mode === "waiting";
  const displaced = access?.displaced === true;
  const visible = waiting || displaced;
  useEffect(() => {
    const element = dialog.current;
    if (visible && element && !element.open) element.showModal();
  }, [visible]);
  if (!visible) return null;

  return <dialog ref={dialog} className="nav-rover-access-dialog" aria-labelledby="rover-access-title"
    onCancel={(event) => { event.preventDefault(); }}>
    <h2 id="rover-access-title">{displaced ? "Otro usuario tomó el control del Rover" : "Ya hay un usuario conectado al Rover"}</h2>
    {waiting && access.canTake && <p>¿Querés tomar el control?</p>}
    {error && <p role="alert">{error}</p>}
    <div className="nav-rover-access-actions">
      <button type="button" className="bt sec-btn" disabled={busy} onClick={() => void disconnect()}>
        {displaced ? "Desconectar" : "Cancelar"}
      </button>
      {displaced
        ? <button type="button" className="bt prim-btn" disabled={busy} onClick={() => void choose("acknowledge")}>Aceptar</button>
        : <>
            <button type="button" className="bt sec-btn" disabled={busy} onClick={() => void choose("spectate")}>Espectar</button>
            {access.canTake && <button type="button" className="bt prim-btn" disabled={busy} onClick={() => void choose("take")}>Tomar control y frenar</button>}
            {access.canTake && access.canKeepRoute && <button type="button" className="bt sec-btn" disabled={busy}
              onClick={() => void choose("take", true)}>Tomar control y mantener la ruta</button>}
          </>}
    </div>
  </dialog>;
}
