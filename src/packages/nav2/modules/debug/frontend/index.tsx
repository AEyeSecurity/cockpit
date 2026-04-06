import { useEffect, useState } from "react";
import "./styles.css";
import type { CockpitModule, ModuleContext } from "../../../../../core/types/module";
import { ShellCommands } from "../../../../../app/shellCommands";
import { MissionDispatcher } from "../dispatcher/impl/MissionDispatcher";
import { MissionService } from "../service/impl/MissionService";
import type { RosbagStatus } from "../dispatcher/impl/MissionDispatcher";
import { RosBridgeTransport } from "../transport/impl/RosBridgeTransport";

const TRANSPORT_ID = "transport.rosbridge";
const DISPATCHER_ID = "dispatcher.mission";
const SERVICE_ID = "service.mission";
const OPEN_RECORD_MODAL_COMMAND_ID = "nav2.debug.openRecordModal";

function RecordModal({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const missionService = runtime.services.getService<MissionService>(SERVICE_ID);
  const [profile, setProfile] = useState("core");
  const [status, setStatus] = useState<RosbagStatus>({
    active: false,
    profile: "core",
    outputPath: "n/a",
    logPath: "n/a"
  });
  const [error, setError] = useState("");

  useEffect(() => {
    void missionService
      .getRosbagStatus()
      .then((next) => {
        setStatus(next);
      })
      .catch(() => {
        // Optional backend capability.
      });
  }, [missionService]);

  return (
    <div className="stack">
      <div className="panel-card">
        <h3>Record</h3>
        <p className="muted">
          Rosbag manual para debugging de navegacion. El bag queda grabado dentro del workspace ROS del backend.
        </p>
        <div className={`status-pill ${status.active ? "ok" : ""}`}>
          Rosbag: {status.active ? `recording (${status.profile})` : "idle"}
        </div>
        <div className="key-value-grid">
          <span>Output path</span>
          <code>{status.outputPath}</code>
          <span>Log path</span>
          <code>{status.logPath}</code>
        </div>
        <div className="row">
          <label className="grow">
            Profile
            <select value={profile} onChange={(event) => setProfile(event.target.value)}>
              <option value="core">core</option>
              <option value="navigation">navigation</option>
              <option value="full">full</option>
            </select>
          </label>
        </div>
        <div className="action-grid">
          <button
            type="button"
            onClick={async () => {
              setError("");
              try {
                const next = await missionService.startRosbag(profile);
                setStatus(next);
                runtime.eventBus.emit("console.event", {
                  level: "info",
                  text: `Rosbag started (${profile})`,
                  timestamp: Date.now()
                });
              } catch (cause) {
                setError(String(cause));
              }
            }}
          >
            Start bag
          </button>
          <button
            type="button"
            className="danger-btn"
            onClick={async () => {
              setError("");
              try {
                const next = await missionService.stopRosbag();
                setStatus(next);
                runtime.eventBus.emit("console.event", {
                  level: "warn",
                  text: "Rosbag stopped",
                  timestamp: Date.now()
                });
              } catch (cause) {
                setError(String(cause));
              }
            }}
          >
            Stop bag
          </button>
        </div>
        {error ? <p className="muted">Error: {error}</p> : null}
      </div>
    </div>
  );
}

export function createDebugModule(): CockpitModule {
  return {
    id: "debug",
    version: "1.1.0",
    enabledByDefault: true,
    register(ctx: ModuleContext): void {
      const transport = new RosBridgeTransport(TRANSPORT_ID, ({ env }) => env.rosbridgeUrl);
      ctx.transports.registerTransport({
        id: transport.id,
        transport
      });

      const dispatcher = new MissionDispatcher(DISPATCHER_ID, TRANSPORT_ID);
      ctx.dispatchers.registerDispatcher({
        id: dispatcher.id,
        dispatcher
      });

      const service = new MissionService(dispatcher);
      ctx.services.registerService({
        id: SERVICE_ID,
        service
      });

      ctx.contributions.register({
        id: "modal.record",
        slot: "modal",
        title: "Record",
        render: () => <RecordModal runtime={ctx} />
      });

      ctx.commands.register(
        { id: OPEN_RECORD_MODAL_COMMAND_ID, title: "Open Record Modal", category: "Debug" },
        () => ctx.commands.execute(ShellCommands.openModal, "modal.record")
      );

      ctx.contributions.register({
        id: "toolbar.debug",
        slot: "toolbar",
        label: "Debug",
        items: [
          {
            id: "debug.open-record-modal",
            label: "Open record modal",
            commandId: OPEN_RECORD_MODAL_COMMAND_ID
          }
        ]
      });
    }
  };
}
