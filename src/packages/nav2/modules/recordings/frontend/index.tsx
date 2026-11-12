import { useEffect, useRef, useState } from "react";
import type { CockpitModule, ModuleContext } from "../../../../../core/types/module";
import { ShellCommands } from "../../../../../app/shellCommands";
import { Nav2DispatcherBase } from "../../../protocol/Nav2DispatcherBase";

interface RecordingStatus {
  manual: boolean; mission: boolean; tail_seconds: number; mission_stale: boolean;
  requested: boolean; disk_ok: boolean;
  cameras: { camera: string; recording: boolean; error: string }[];
}
interface Video { camera: string; start: string; duration: number; url: string }
const errorLabels: Record<string, string> = {
  camera_unavailable: "Sin señal de cámara",
  media_service_unavailable: "Servicio de video no disponible",
  recording_storage_error: "Problema de almacenamiento"
};
const names: Record<string, string> = { main: "Principal", mobile: "Móvil", rear: "Reversa" };
export class RecordingsDispatcher extends Nav2DispatcherBase {
  async execute(op: string, fields: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const result = await this.request(op, fields, { timeoutMs: 35000 });
    if (result.ok !== true) {
      const detail = String(result.error_code ?? result.error ?? "");
      if (detail.includes("LOCK") || detail.includes("LEASE")) throw new Error("Tomá el control desde Operación para iniciar o detener la grabación manual.");
      throw new Error(result.error === "recordings_not_configured" ? "El servicio de grabaciones no está configurado en el robot." : String(result.error ?? "No se pudo completar la solicitud"));
    }
    return result;
  }
}
function localDay(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
function RecordingsWorkspace({ dispatcher }: { dispatcher: RecordingsDispatcher }): JSX.Element {
  const [camera, setCamera] = useState("all");
  const [date, setDate] = useState(localDay);
  const [status, setStatus] = useState<RecordingStatus | null>(null);
  const [items, setItems] = useState<Video[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const sequence = useRef(0);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await dispatcher.execute("recordings_status");
        if (!disposed) setStatus(next as unknown as RecordingStatus);
      } catch {
        if (!disposed) setStatus(null);
      } finally {
        if (!disposed) timer = setTimeout(poll, 3000);
      }
    }
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [dispatcher]);
  async function refresh() {
    const id = ++sequence.current;
    if (!date) { setError("Elegí una fecha."); return; }
    setLoading(true); setLoaded(false); setError(""); setItems([]);
    const start = new Date(`${date}T00:00:00`);
    const end = new Date(start); end.setDate(end.getDate() + 1);
    try {
      const result = await dispatcher.execute("recordings_list", { camera, start: start.toISOString(), end: end.toISOString() });
      if (id === sequence.current) { setItems(result.items as Video[]); setLoaded(true); }
    } catch (e) { if (id === sequence.current) setError(String(e)); }
    finally { if (id === sequence.current) setLoading(false); }
  }
  useEffect(() => { void refresh(); return () => { sequence.current++; }; }, [camera, date]);
  async function manual() {
    setBusy(true); setError("");
    try { setStatus(await dispatcher.execute(status?.manual ? "recordings_stop" : "recordings_start") as unknown as RecordingStatus); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  async function download(item: Video) {
    // Refresh signed URLs at click time: old catalog links deliberately expire.
    setBusy(true); setError("");
    try {
      const start = new Date(item.start);
      const result = await dispatcher.execute("recordings_list", { camera: item.camera,
        start: start.toISOString(), end: new Date(start.getTime() + item.duration * 1000).toISOString() });
      const fresh = (result.items as Video[])[0];
      if (!fresh) throw new Error("El video ya no está disponible.");
      const url = new URL(fresh.url);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("Dirección de descarga inválida.");
      const link = document.createElement("a"); link.href = url.href; link.rel = "noreferrer";
      link.download = ""; link.click();
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  return <div className="recordings-workspace stack">
    <section className="panel-card">
      <h2>Grabaciones</h2><p className="muted">Videos guardados en la Jetson · hasta 7 días según espacio disponible.</p>
      {!status ? <p role="status">Servicio de grabaciones no disponible. Conectá el robot y verificá el servicio.</p> : <>
        <button type="button" className="button-secondary" disabled={busy} onClick={() => void manual()}>{status.manual ? "Detener grabación manual" : "Iniciar grabación manual"}</button>
        <p role="status">{status.mission ? "Grabación solicitada por misión" : status.tail_seconds > 0 ? `Grabando contexto posterior · ${status.tail_seconds} s` : status.manual ? "Grabación manual solicitada" : "Sin captura solicitada"}</p>
        {status.mission_stale ? <p className="status-pill">Estado de misión no disponible; se conserva la captura que ya estaba activa.</p> : null}
        {!status.disk_ok ? <p role="alert">Almacenamiento no disponible o espacio insuficiente. Captura suspendida.</p> : null}
        <div className="recordings-filters">{status.cameras.map(entry => <span key={entry.camera}>{names[entry.camera]}: {entry.recording ? "Grabando" : entry.error ? "No disponible" : "En espera"}{entry.error ? ` · ${errorLabels[entry.error] ?? "Revisar servicio de grabación"}` : ""}</span>)}</div>
        {status.manual && status.mission ? <p className="muted">Detener la grabación manual no interrumpe la grabación de la misión.</p> : null}
      </>}
      <div className="recordings-filters">
        <label>Cámara<select value={camera} onChange={e => setCamera(e.target.value)}><option value="all">Todas las cámaras</option>{Object.entries(names).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
        <label>Fecha<input type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
        <button type="button" className="button-secondary" disabled={loading} onClick={() => void refresh()}>Actualizar</button>
      </div>
    </section>
    {error ? <section className="panel-card" role="alert">No se pudo completar la operación: {error}</section> : null}
    <section className="panel-card">
      {loading ? <p role="status">Consultando videos…</p> : loaded && !items.length ? <p>No hay grabaciones para esta cámara y fecha.</p> : null}
      {items.map(item => <div className="recording-row" key={`${item.camera}-${item.start}`}>
        <div><strong>{names[item.camera]}</strong><p>{new Date(item.start).toLocaleString()} · {Math.ceil(item.duration)} s</p></div>
        <button type="button" className="button-secondary" disabled={busy} onClick={() => void download(item)}>Descargar MP4</button>
      </div>)}
    </section>
  </div>;
}
export function createRecordingsModule(): CockpitModule {
  return { id: "recordings", version: "1.1.0", enabledByDefault: true, register(ctx: ModuleContext) {
    const dispatcher = new RecordingsDispatcher("dispatcher.recordings", "transport.ws.core");
    ctx.dispatchers.registerDispatcher({ id: dispatcher.id, dispatcher });
    ctx.contributions.register({ id: "sidebar.recordings", slot: "sidebar", label: "Grabaciones",
      render: () => <div className="stack support-sidebar"><div className="panel-card"><h3>Grabaciones</h3><p className="muted">Captura manual y automática durante misiones, con 30 segundos posteriores.</p></div><button type="button" className="button-secondary" onClick={() => void ctx.commands.execute(ShellCommands.openWorkspace, "workspace.recordings", { focused: true })}>Abrir biblioteca y grabación</button></div> });
    ctx.contributions.register({ id: "workspace.recordings", slot: "workspace", label: "Grabaciones", hiddenFromTabs: true, render: () => <RecordingsWorkspace dispatcher={dispatcher} /> });
  } };
}
