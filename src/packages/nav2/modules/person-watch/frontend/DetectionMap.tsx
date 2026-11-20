import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { DetectionPosition } from "../service/PersonWatchService";

export function DetectionMap({ position: { lat, lon } }: { position: DetectionPosition }): JSX.Element {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!container.current) return;
    const map = L.map(container.current, {
      dragging: false, keyboard: false, scrollWheelZoom: false, doubleClickZoom: false,
      touchZoom: false, boxZoom: false, zoomControl: false
    }).setView([lat, lon], 17);
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      attribution: "Tiles © Esri"
    }).addTo(map);
    L.circleMarker([lat, lon], { radius: 7, color: "#fff", weight: 2, fillColor: "#e11d48", fillOpacity: 1 }).addTo(map);
    return () => { map.remove(); };
  }, [lat, lon]);
  const fullMap = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=18/${lat}/${lon}`;
  return <figure className="pw-map">
    <div ref={container} className="pw-map-tile" aria-label="Mapa de la ubicación de la detección" />
    <figcaption><a href={fullMap} target="_blank" rel="noreferrer">Ver en el mapa</a></figcaption>
  </figure>;
}
