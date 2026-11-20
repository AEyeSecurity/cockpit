import { useEffect, useId, useState, useSyncExternalStore } from "react";
import type { CockpitModule, ModuleContext } from "../../../../../core/types/module";
import { ShellCommands } from "../../../../../app/shellCommands";
import type { ConnectionService } from "../../navigation/service/impl/ConnectionService";
import { PersonWatchService, type PersonAlert } from "../service/PersonWatchService";
import type { RecordingsDispatcher } from "../../recordings/frontend";
import { detectionClipFinder, type FindDetectionClip } from "../service/detectionClip";
import { detectionTime, groupDetectionEvents } from "../service/detectionEvents";
import { DetectionMap } from "./DetectionMap";
import "./styles.css";

function DetectionClip({ cameraId, frameMs, findClip }: {
  cameraId: string; frameMs?: number; findClip?: FindDetectionClip
}): JSX.Element {
  const [clip, setClip] = useState<string>();
  const [checking, setChecking] = useState(Boolean(findClip && frameMs));
  const [playing, setPlaying] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!findClip || frameMs === undefined) return;
    let active = true;
    setChecking(true);
    void findClip({ camera_id: cameraId, frame_ms: frameMs }).then((url) => {
      if (active) setClip(url);
    }).catch(() => {
      if (active) setClip(undefined);
    }).finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, [cameraId, frameMs, findClip, revision]);

  if (checking) return <small role="status">Consultando clip…</small>;
  if (!clip) return <div className="pw-clip"><small>Clip no disponible</small>
    {findClip && frameMs && <button type="button" onClick={() => setRevision((count) => count + 1)}>Volver a consultar</button>}
  </div>;
  return playing
    ? <video controls playsInline preload="none" aria-label="Clip de la detección" src={clip}
        onError={() => { setPlaying(false); setClip(undefined); }} />
    : <button type="button" onClick={() => setPlaying(true)}>Ver clip</button>;
}

const evidenceCameras = [
  { id: "cam3", label: "Frontal panorámica" },
  { id: "cam4", label: "Móvil PTZ" },
  { id: "cam5", label: "Trasera" }
];

function CameraSnapshot({ alert }: { alert: PersonAlert }): JSX.Element {
  const [failed, setFailed] = useState(false);
  if (!alert.image_url || failed) {
    return <small role="status">{failed ? "La captura ya no está disponible." : "Este aviso no tiene captura."}</small>;
  }
  return <a href={alert.image_url} target="_blank" rel="noreferrer"><img src={alert.image_url}
    alt={`Persona detectada en ${alert.label}, con recuadros y confianza`} onError={() => setFailed(true)} /></a>;
}

function EventEvidence({ first, alerts, findClip }: {
  first: PersonAlert; alerts: PersonAlert[]; findClip?: FindDetectionClip
}): JSX.Element {
  const [cameraId, setCameraId] = useState(first.camera_id);
  const cameraAlerts = alerts.filter((alert) => alert.camera_id === cameraId);
  const position = alerts.find((alert) => alert.position)?.position;
  const frameMs = first.frame_ms ?? alerts.find((alert) => alert.frame_ms !== undefined)?.frame_ms;

  return <div className="pw-evidence">
    <div className="pw-camera-picker" role="group" aria-label="Cámaras del evento">
      {evidenceCameras.map((camera) => {
        const detected = alerts.some((alert) => alert.camera_id === camera.id);
        return <button type="button" key={camera.id} aria-pressed={cameraId === camera.id}
          onClick={() => setCameraId(camera.id)}>
          <strong>{camera.label}</strong><small>{detected ? "Detección" : "Contexto"}</small>
        </button>;
      })}
    </div>
    <div className="pw-evidence-grid">
      <div className="pw-camera-evidence">
        {cameraAlerts.length > 0
          ? cameraAlerts.map((alert) => <CameraSnapshot key={alert.id} alert={alert} />)
          : <small>Video de contexto de esta cámara, si estaba grabando.</small>}
        <DetectionClip key={cameraId} cameraId={cameraId} frameMs={frameMs} findClip={findClip} />
      </div>
      {position ? <DetectionMap position={position} /> : <small>Ubicación no disponible</small>}
    </div>
  </div>;
}
export function PersonWatchPanel({ service, findClip }: {
  service: PersonWatchService; findClip?: FindDetectionClip
}): JSX.Element {
  const [openEventId, setOpenEventId] = useState<string>();
  const historyId = useId();
  const state = useSyncExternalStore(service.subscribe, service.getSnapshot);
  const events = groupDetectionEvents(state.alerts);
  return <section className="pw-panel">
    <h2>Detecciones</h2>
    {!state.available && <p role="status">{state.error}</p>}
    <div className="pw-history-heading">
      <h3>Avisos recientes</h3>
      <span>{events.length} {events.length === 1 ? "evento" : "eventos"}</span>
    </div>
    {state.alerts.length === 0 ? <p className="muted">Todavía no hay avisos confirmados.</p> :
      <ul className="pw-history">{events.map(({ first, alerts }, index) => {
        const expanded = openEventId === first.id;
        const cameraCount = new Set(alerts.map((alert) => alert.camera_id)).size;
        const evidenceId = `${historyId}-${index}`;
        const detectedAt = new Date(detectionTime(first));
        return <li key={first.id}>
          <button type="button" className="pw-alert-summary" aria-expanded={expanded} aria-controls={evidenceId}
            onClick={() => setOpenEventId(expanded ? undefined : first.id)}>
            <strong>Detección de personas</strong>
            <span className="pw-alert-meta">
              <time>{detectedAt.toLocaleString()}</time>
              <span>{cameraCount} {cameraCount === 1 ? "cámara detectó" : "cámaras detectaron"}</span>
            </span>
            <span className="pw-chevron" aria-hidden="true" />
          </button>
          <div id={evidenceId} hidden={!expanded}>
            {expanded && <EventEvidence first={first} alerts={alerts} findClip={findClip} />}
          </div>
        </li>;
      })}</ul>}
    <p className="muted">Los avisos ayudan a supervisar; no ordenan frenar ni cambian la navegación. Pueden omitir personas pequeñas, lejanas u ocultas.</p>
  </section>;
}
function WatchFooter({ service, runtime }: { service: PersonWatchService; runtime: ModuleContext }): JSX.Element {
  const state = useSyncExternalStore(service.subscribe, service.getSnapshot);
  const latest = state.alerts.at(-1);
  const recent = state.available && latest && Date.now()-latest.timestamp_ms < 15000;
  const watching = state.cameras.filter(c => c.status === "watching").length;
  return <button type="button" className={`pw-footer${recent ? " pw-footer-alert" : ""}`}
    title="Abrir detecciones" onClick={() => void runtime.commands.execute(ShellCommands.openWorkspace, "workspace.person-watch")}>
    <span role={recent ? "alert" : "status"}>{recent ? "Detecciones · actividad reciente" :
      state.available ? `Detecciones · ${watching}/3 cámaras vigilando` : "Detecciones · detector no disponible"}</span>
  </button>;
}
export function createPersonWatchModule(): CockpitModule {
  return { id: "person-watch", version: "1.0.0", enabledByDefault: true, register(ctx) {
    const connection = ctx.getService<ConnectionService>("service.connection");
    const service = new PersonWatchService(() => {
      const current = connection.getState();
      if (ctx.env.managed) return current.preset === "real" ? "/operation/person" : "";
      const values = ctx.getPackageConfig<Record<string, unknown>>("nav2");
      return current.preset === "real" && current.host === values.ws_real_host && typeof values.person_watch_url === "string" ? values.person_watch_url : "";
    });
    const recordings = ctx.dispatchers.get("dispatcher.recordings")?.dispatcher as RecordingsDispatcher | undefined;
    const findClip = recordings ? detectionClipFinder(recordings, Boolean(ctx.env.managed)) : undefined;
    ctx.services.registerService({ id: "service.person-watch", service });
    ctx.contributions.register({ id: "footer.person-watch", slot: "footer", align: "right", render: () => <WatchFooter service={service} runtime={ctx} /> });
    ctx.contributions.register({ id: "workspace.person-watch", slot: "workspace", label: "Detecciones", render: () => <PersonWatchPanel service={service} findClip={findClip} /> });
    ctx.contributions.register({ id: "sidebar.person-watch", slot: "sidebar", label: "Detecciones", render: () => <div className="stack support-sidebar">
      <div className="panel-card"><h3>Detecciones</h3><p className="muted">Avisos de las cámaras, sin intervenir en la navegación.</p></div>
      <button type="button" className="button-primary" onClick={() => void ctx.commands.execute(ShellCommands.openWorkspace, "workspace.person-watch")}>Ver detecciones</button>
    </div> });
  } };
}
