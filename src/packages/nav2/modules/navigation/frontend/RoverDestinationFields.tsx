import { useEffect, useState } from "react";
import { api, message } from "../../../../identity/api";

interface Address {
  host: string;
  port: string;
}

interface Destination extends Address {
  options: Address[];
}

export function RoverDestinationFields({ csrf, connected }: { csrf: string; connected: boolean }): JSX.Element {
  const [destination, setDestination] = useState<Destination>();
  const [draft, setDraft] = useState<Address>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function load(): Promise<void> {
    setError("");
    try {
      setDestination(await api<Destination>("rover/destination"));
    } catch (failure) {
      setError(message(failure));
    }
  }

  useEffect(() => { void load(); }, []);

  async function save(): Promise<void> {
    if (!draft) return;
    setSaving(true);
    setError("");
    try {
      const result = await api<Destination>("rover/destination", "PUT", {
        host: draft.host.trim(), port: draft.port.trim()
      }, csrf);
      setDestination(result);
      setDraft(undefined);
    } catch (failure) {
      setError(message(failure));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="input-grid">
        <input aria-label="Dirección del robot" placeholder="Dirección del robot" value={draft?.host ?? destination?.host ?? ""}
          list="rover-destination-hosts" readOnly={!draft || saving || connected}
          onChange={event => draft && setDraft({ ...draft, host: event.target.value })} />
        <input aria-label="Puerto del robot" placeholder="Puerto" value={draft?.port ?? destination?.port ?? ""}
          list="rover-destination-ports" inputMode="numeric" readOnly={!draft || saving || connected}
          onChange={event => draft && setDraft({ ...draft, port: event.target.value })} />
        <datalist id="rover-destination-hosts">
          {[...new Set(destination?.options.map(option => option.host))].map(host => <option key={host} value={host} />)}
        </datalist>
        <datalist id="rover-destination-ports">
          {[...new Set(destination?.options.filter(option => option.host === draft?.host).map(option => option.port))].map(port => <option key={port} value={port} />)}
        </datalist>
      </div>
      {draft ? <>
        <button type="submit" className="bt prim-btn" disabled={saving || connected}>Guardar</button>
        <button type="button" className="bt sec-btn" disabled={saving} onClick={() => { setDraft(undefined); setError(""); }}>Cancelar</button>
      </> : destination
        ? <button type="button" className="bt sec-btn" disabled={connected} onClick={() => setDraft(destination)}>Editar</button>
        : error && <button type="button" className="bt sec-btn" onClick={() => void load()}>Reintentar</button>}
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
