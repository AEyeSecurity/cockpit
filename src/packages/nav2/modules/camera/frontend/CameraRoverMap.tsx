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
  const marker = useRef<L.Marker>();

  useEffect(() => {
    if (!element.current) return;
    const view = L.map(element.current, {
      zoomControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false,
      touchZoom: false, boxZoom: false, keyboard: false
    });
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxNativeZoom: 19, attribution: "Tiles © Esri"
    }).addTo(view);
    const icon = L.icon({ iconUrl: robotMarkerUrl, iconSize: [30, 30], iconAnchor: [15, 15] });
    marker.current = L.marker([0, 0], { icon, interactive: false, keyboard: false, alt: "Rover" }).addTo(view);
    map.current = view;
    const observer = typeof ResizeObserver === "undefined" ? undefined
      : new ResizeObserver(() => view.invalidateSize({ pan: false }));
    observer?.observe(element.current);
    return () => {
      observer?.disconnect();
      view.remove();
      map.current = undefined;
      marker.current = undefined;
    };
  }, []);

  useEffect(() => {
    const center: L.LatLngTuple = [pose.lat, pose.lon];
    marker.current?.setLatLng(center);
    map.current?.setView(center, 17, { animate: false });
    const icon = marker.current?.getElement();
    if (icon) icon.style.rotate = `${90 - (pose.headingDeg ?? 0)}deg`;
  }, [pose.lat, pose.lon, pose.headingDeg]);

  return <div ref={element} className="cv-rover-map-canvas" aria-label="Posición del rover en el mapa" />;
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
