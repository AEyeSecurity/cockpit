import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { ModuleContext } from "../../../../../core/types/module";
import type { TelemetryService, TelemetrySnapshot } from "../../telemetry/service/impl/TelemetryService";
import robotMarkerUrl from "../../map/frontend/robot-marker.png";

type RobotPose = NonNullable<TelemetrySnapshot["robotPose"]>;

function RoverPosition({ pose }: { pose: RobotPose }): JSX.Element {
  const element = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map>();

  useEffect(() => {
    if (!element.current) return;
    const view = L.map(element.current, {
      zoomControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false,
      touchZoom: false, boxZoom: false, keyboard: false
    });
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxNativeZoom: 19, attribution: "Tiles © Esri"
    }).addTo(view);
    map.current = view;
    const observer = typeof ResizeObserver === "undefined" ? undefined
      : new ResizeObserver(() => view.invalidateSize({ pan: false }));
    observer?.observe(element.current);
    return () => {
      observer?.disconnect();
      view.remove();
      map.current = undefined;
    };
  }, []);

  useEffect(() => {
    map.current?.setView([pose.lat, pose.lon], 17, { animate: false });
  }, [pose.lat, pose.lon]);

  // The non-interactive map follows the rover, so its center is the rover position.
  const rotation = Number.isFinite(pose.headingDeg) ? 90 - pose.headingDeg : 90;
  return <div className="cv-rover-map-position">
    <div ref={element} className="cv-rover-map-canvas" />
    <div className="cv-rover-map-marker">
      <img src={robotMarkerUrl} alt="Posición del rover en el mapa" draggable={false}
        style={{ transform: `rotate(${rotation}deg)` }} />
    </div>
  </div>;
}

export function CameraRoverMap({ runtime, connected }: { runtime: ModuleContext; connected: boolean }): JSX.Element {
  const [pose, setPose] = useState<RobotPose | null>(null);
  useEffect(() => {
    if (!connected || !runtime.services.has?.("service.telemetry")) return;
    const telemetry = runtime.services.getService<TelemetryService>("service.telemetry");
    return telemetry.subscribeTelemetry(({ robotPose }) => {
      const valid = robotPose && Math.abs(robotPose.lat) <= 90 && Math.abs(robotPose.lon) <= 180;
      setPose((previous) => valid
        ? previous?.lat === robotPose.lat && previous?.lon === robotPose.lon &&
          previous?.headingDeg === robotPose.headingDeg ? previous : robotPose
        : null);
    });
  }, [connected, runtime]);

  return <section className="cv-rover-map" aria-label="Minimapa del rover">
    <header className="cv-grid-heading"><strong>Posición del rover</strong></header>
    {connected && pose ? <RoverPosition pose={pose} /> :
      <div className="cv-rover-map-empty">{connected ? "Esperando posición del rover" : "Rover desconectado"}</div>}
  </section>;
}
