import { useState, useSyncExternalStore } from "react";
import type { CockpitModule, ModuleContext } from "../../../../../core/types/module";
import { ShellCommands } from "../../../../../app/shellCommands";
import type { ConnectionService } from "../../navigation/service/impl/ConnectionService";
import { PersonWatchService, type PersonAlert } from "../service/PersonWatchService";
import "./styles.css";

const labels: Record<string, string> = { watching: "Vigilando", starting: "Iniciando", unavailable: "Sin imagen reciente", resource_paused: "En pausa por recursos" };
function AlertSnapshot({ alert }: { alert: PersonAlert }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!alert.image_url) return <small>Este aviso no tiene captura.</small>;
  return <div className="pw-evidence">
    <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "Ocultar captura" : "Ver captura"}</button>
    {open && (failed ? <p role="status">La captura ya no está disponible.</p> :
      <a href={alert.image_url} target="_blank" rel="noreferrer"><img src={alert.image_url}
        alt={`Persona detectada en ${alert.label}, con recuadros y confianza`} onError={() => setFailed(true)} /></a>)}
  </div>;
}
export function PersonWatchPanel({ service }: { service: PersonWatchService }): JSX.Element {
  const state = useSyncExternalStore(service.subscribe, service.getSnapshot);
  return <section className="pw-panel">
    <h2>Detección de personas</h2>
    <p className="muted">Vigilancia local de las tres cámaras. Los avisos requieren detecciones consecutivas y se repiten como máximo cada 30 segundos por cámara.</p>
    {!state.available && <p role="status">{state.error}</p>}
    <div className="pw-cameras">{state.cameras.map(c => <article className="pw-camera" data-status={c.status} key={c.id}>
      <h3>{c.label}</h3><p>{labels[c.status] ?? "Estado desconocido"}</p>
      <strong>{c.status === "watching" ? `${c.detections.length} personas en la última muestra` : "Detección no disponible"}</strong>
    </article>)}</div>
    <h3>Avisos recientes</h3>
    <p className="muted">Hasta 50 avisos con captura. Se borran al reiniciar el detector.</p>
    {state.alerts.length === 0 ? <p className="muted">Todavía no hay avisos confirmados.</p> :
      <ul className="pw-history">{[...state.alerts].reverse().map(a => <li key={a.id}>
        <strong>Persona detectada · {a.label}</strong><span>{new Date(a.timestamp_ms).toLocaleString()} · {a.count} {a.count === 1 ? "persona" : "personas"}</span>
        <AlertSnapshot alert={a} />
      </li>)}</ul>}
    <p className="muted">Los avisos ayudan a supervisar; no ordenan frenar ni cambian la navegación. Pueden omitir personas pequeñas, lejanas u ocultas.</p>
  </section>;
}
function WatchFooter({ service, runtime }: { service: PersonWatchService; runtime: ModuleContext }): JSX.Element {
  const state = useSyncExternalStore(service.subscribe, service.getSnapshot);
  const latest = state.alerts.at(-1);
  const recent = state.available && latest && Date.now()-latest.timestamp_ms < 15000;
  const watching = state.cameras.filter(c => c.status === "watching").length;
  return <button type="button" className={`pw-footer${recent ? " pw-footer-alert" : ""}`}
    title="Abrir detección de personas" onClick={() => void runtime.commands.execute(ShellCommands.openWorkspace, "workspace.person-watch")}>
    <span role={recent ? "alert" : "status"}>{recent ? `Persona detectada · ${latest.label}` :
      state.available ? `Personas · ${watching}/3 cámaras vigilando` : "Personas · detector no disponible"}</span>
  </button>;
}
export function createPersonWatchModule(): CockpitModule {
  return { id: "person-watch", version: "1.0.0", enabledByDefault: true, register(ctx) {
    const connection = ctx.getService<ConnectionService>("service.connection");
    const service = new PersonWatchService(() => {
      const current = connection.getState();
      const values = ctx.getPackageConfig<Record<string, unknown>>("nav2");
      return current.preset === "real" && current.host === values.ws_real_host && typeof values.person_watch_url === "string" ? values.person_watch_url : "";
    });
    ctx.services.registerService({ id: "service.person-watch", service });
    ctx.contributions.register({ id: "footer.person-watch", slot: "footer", align: "right", render: () => <WatchFooter service={service} runtime={ctx} /> });
    ctx.contributions.register({ id: "workspace.person-watch", slot: "workspace", label: "Personas", render: () => <PersonWatchPanel service={service} /> });
    ctx.contributions.register({ id: "sidebar.person-watch", slot: "sidebar", label: "Personas", render: () => <div className="stack support-sidebar">
      <div className="panel-card"><h3>Detección de personas</h3><p className="muted">Avisos de las cámaras, sin intervenir en la navegación.</p></div>
      <button type="button" className="button-primary" onClick={() => void ctx.commands.execute(ShellCommands.openWorkspace, "workspace.person-watch")}>Ver vigilancia y avisos</button>
    </div> });
  } };
}
