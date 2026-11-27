import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

export const checkpointCode = "ROUTE_CHECKPOINT_REACHED";

interface Arrival {
  sequence: number;
  timestamp: string;
  details: Record<string, string>;
}

export function waypointNumber(details: Record<string, string>): number | undefined {
  const index = Number(details.input_index);
  return details.input_index?.trim() && Number.isSafeInteger(index) && index >= 0 ? index + 1 : undefined;
}

function position(details: Record<string, string>): L.LatLngTuple | undefined {
  if (!details.gps_lat?.trim() || !details.gps_lon?.trim()) return;
  const lat = Number(details.gps_lat);
  const lon = Number(details.gps_lon);
  if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return [lat, lon];
}

const formatArrival = new Intl.DateTimeFormat("es-AR", {
  dateStyle: "short", timeStyle: "medium", hourCycle: "h23"
});

export interface WaypointSummary extends Arrival {
  visit_count: number;
  last_at: string;
}

export function PatrolWaypoints({ points, readVisits }: {
  points: WaypointSummary[];
  readVisits: (point: WaypointSummary, after?: number) => Promise<{ items: Arrival[]; next: number | null }>;
}) {
  const [active, setActive] = useState<WaypointSummary>();
  const [visits, setVisits] = useState<Arrival[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const request = useRef(0);
  const container = useRef<HTMLDivElement>(null);
  const markers = useRef(new Map<number, L.Marker>());
  const groups = useMemo(() => points.flatMap(point => {
    const coordinates = position(point.details);
    const number = waypointNumber(point.details);
    return coordinates && number !== undefined ? [{ point, coordinates, number }] : [];
  }), [points]);

  async function load(point: WaypointSummary, after?: number) {
    const token = ++request.current;
    setActive(point);
    setError(false);
    setLoading(true);
    if (after === undefined) { setVisits([]); setCursor(null); }
    try {
      const page = await readVisits(point, after);
      if (token === request.current) {
        setVisits(previous => after === undefined ? page.items : [...previous, ...page.items]);
        setCursor(page.next);
      }
    } catch {
      if (token === request.current) setError(true);
    } finally {
      if (token === request.current) setLoading(false);
    }
  }

  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (!container.current || !groups.length) return;
    const map = L.map(container.current, { scrollWheelZoom: false });
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      attribution: "Tiles © Esri"
    }).addTo(map);
    for (const { point, coordinates, number } of groups) {
      const marker = L.marker(coordinates, {
        title: `Punto ${number}`,
        icon: L.divIcon({ className: "history-waypoint-pin", html: String(number), iconSize: [28, 28] })
      }).addTo(map);
      marker.on("click", () => void loadRef.current(point));
      markers.current.set(point.sequence, marker);
    }
    const bounds = L.latLngBounds(groups.map(point => point.coordinates));
    map.fitBounds(bounds, { padding: [24, 24], maxZoom: 18 });
    return () => {
      map.remove();
      markers.current.clear();
    };
  }, [groups]);

  useEffect(() => {
    for (const [key, marker] of markers.current) {
      const selected = key === active?.sequence;
      marker.getElement()?.classList.toggle("is-selected", selected);
      marker.setZIndexOffset(selected ? 500 : 0);
    }
  }, [active, groups]);

  if (!points.length) return null;
  return <section className="history-waypoints" aria-label="Puntos alcanzados">
    <h3>Puntos alcanzados <small>· {points.length} puntos</small></h3>
    {groups.length > 0 && <div ref={container} className="history-waypoint-map" aria-label="Mapa de puntos alcanzados" />}
    <ul className="history-waypoint-list">
      {points.map(point => <li key={point.sequence}>
        <button type="button" aria-pressed={active?.sequence === point.sequence}
          onClick={() => void load(point)}>
          <strong>Punto {waypointNumber(point.details)}</strong>
          <span>{point.visit_count} {point.visit_count === 1 ? "visita" : "visitas"}</span>
          <span className="muted">Última · {formatArrival.format(new Date(point.last_at))}</span>
          {!position(point.details) && <span className="muted">GPS no disponible</span>}
        </button>
      </li>)}
    </ul>
    {active && <div className="history-waypoint-visits" aria-live="polite">
      <div className="history-toolbar">
        <strong>Visitas al punto {waypointNumber(active.details)}</strong>
        <button type="button" className="button-secondary" onClick={() => {
          request.current++;
          setActive(undefined);
        }}>Ocultar visitas</button>
      </div>
      {loading && <p>Consultando visitas…</p>}
      {error && <button type="button" onClick={() => void load(active, cursor ?? undefined)}>Reintentar</button>}
      <ul>{visits.map(visit => {
        const coordinates = position(visit.details);
        return <li key={visit.sequence} title={coordinates?.join(", ")}>
          {formatArrival.format(new Date(visit.timestamp))} · Vuelta {Number(visit.details.loop_iteration) + 1}
          {!coordinates && <span className="muted"> · GPS no disponible</span>}
        </li>;
      })}</ul>
      {cursor !== null && !error && <button type="button" disabled={loading} onClick={() => void load(active, cursor)}>Cargar más visitas</button>}
    </div>}
  </section>;
}
