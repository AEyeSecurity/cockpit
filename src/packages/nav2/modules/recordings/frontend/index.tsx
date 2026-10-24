import { useState } from "react";
import type { CockpitModule } from "../../../../../core/types/module";
import { ShellCommands } from "../../../../../app/shellCommands";

function RecordingsWorkspace(): JSX.Element {
  const [camera, setCamera] = useState("all");
  const [date, setDate] = useState("");
  return <div className="recordings-workspace stack">
    <div className="panel-card">
      <h2>Grabaciones</h2>
      <p className="muted">Consultar y descargar los videos guardados en la Jetson.</p>
      <div className="recordings-filters">
        <label>Cámara<select value={camera} onChange={event => setCamera(event.target.value)}>
          <option value="all">Todas las cámaras</option>
          <option value="main">Principal</option>
          <option value="mobile">Móvil</option>
          <option value="rear">Reversa</option>
        </select></label>
        <label>Fecha<input type="date" value={date} onChange={event => setDate(event.target.value)} /></label>
        <button type="button" className="button-secondary" onClick={() => { setCamera("all"); setDate(""); }}>Limpiar filtros</button>
      </div>
    </div>
    <section className="panel-card recordings-empty" role="status">
      <span className="status-pill">Acceso a archivos pendiente</span>
      <h3>La biblioteca de videos todavía no está conectada</h3>
      <p>Cuando esté disponible, aquí aparecerán los archivos con su cámara, fecha, duración y opción de descarga.</p>
      <p className="muted">Todavía no podemos consultar los archivos de la Jetson. Esto no indica que su carpeta esté vacía.</p>
    </section>
  </div>;
}

export function createRecordingsModule(): CockpitModule {
  return {
    id: "recordings", version: "1.0.0", enabledByDefault: true,
    register(ctx) {
      ctx.contributions.register({
        id: "sidebar.recordings", slot: "sidebar", label: "Grabaciones",
        render: () => <div className="stack support-sidebar">
          <div className="panel-card"><h3>Grabaciones</h3><p className="muted">Videos guardados en la Jetson.</p></div>
          <button type="button" className="button-secondary" onClick={() => void ctx.commands.execute(ShellCommands.openWorkspace, "workspace.recordings", { focused: true })}>Abrir biblioteca de videos</button>
          <p className="muted">Acceso a archivos pendiente de conexión.</p>
        </div>
      });
      ctx.contributions.register({
        id: "workspace.recordings", slot: "workspace", label: "Grabaciones", hiddenFromTabs: true,
        render: () => <RecordingsWorkspace />
      });
    }
  };
}
