import L, { type Map as LeafletMap } from 'leaflet';
import { useEffect, useMemo, useState } from 'react';
import { MapContainer, Marker, Polyline, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import { Layers, LocateFixed, Map, Maximize2, Minus, MousePointerClick, Plus, Search, SlidersHorizontal } from 'lucide-react';
import type { LatLng, RobotState } from '../types';

type MapMode = 'idle' | 'addWaypoint' | 'goal';

type MapViewProps = {
  robot: RobotState;
  mapMode: MapMode;
  onMapClick: (point: LatLng) => void;
  variant?: 'full' | 'mini';
  onSwap?: () => void;
};

const DEFAULT_CENTER: [number, number] = [-31.4201, -64.1888];
const DEFAULT_ZOOM = 15;

const FLAG_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V4"/><path d="M5 4.5h11l-2 3.5 2 3.5H5"/></svg>';

function toLatLng(point: LatLng): [number, number] {
  return [point.lat, point.lng];
}

function normalizeHeading(deg: number): number {
  let yaw = Number(deg) || 0;
  while (yaw <= -180) yaw += 360;
  while (yaw > 180) yaw -= 360;
  return yaw;
}

function robotIcon(headingDeg: number) {
  // Misma flecha de navegación del cockpit: la aguja rota con el rumbo, la etiqueta queda derecha.
  const rotation = normalizeHeading(90 - headingDeg);
  return L.divIcon({
    className: '',
    html:
      '<div class="map-pin map-pin-robot">' +
      `<div class="nav-marker" style="transform: rotate(${rotation}deg)"><div class="nav-arrow"></div></div>` +
      '</div>',
    iconAnchor: [29, 29],
    iconSize: [58, 58],
  });
}

function destinationIcon() {
  return L.divIcon({
    className: '',
    html: `<div class="map-pin map-pin-dest"><div class="map-pin-dot">${FLAG_SVG}</div><div class="map-pin-label">DESTINO</div></div>`,
    iconAnchor: [23, 23],
    iconSize: [46, 46],
  });
}

function waypointIcon(label: number) {
  return L.divIcon({
    className: '',
    html: `<div class="wp-pin">${label}</div>`,
    iconAnchor: [14, 14],
    iconSize: [28, 28],
  });
}

function MapBinder({
  enabled,
  onMapClick,
  onMapReady,
}: {
  enabled: boolean;
  onMapClick: (point: LatLng) => void;
  onMapReady: (map: LeafletMap) => void;
}) {
  const map = useMap();
  onMapReady(map);
  useMapEvents({
    click(event) {
      if (!enabled) {
        return;
      }
      onMapClick({ lat: event.latlng.lat, lng: event.latlng.lng });
    },
  });
  return null;
}

function SatelliteFallback() {
  return (
    <div aria-hidden="true" className="satellite-fallback">
      <svg className="satellite-fallback-svg" preserveAspectRatio="none" viewBox="0 0 1000 620">
        <rect className="sat-field field-a" height="620" width="1000" x="0" y="0" />
        <path className="sat-road sat-road-wide" d="M-40 190 C 120 205 240 202 382 182 C 530 162 720 178 1040 122" />
        <path className="sat-road sat-road-wide" d="M-40 450 C 130 410 270 390 420 420 C 560 448 690 438 830 378 C 940 332 1000 320 1050 330" />
        <path className="sat-road" d="M185 -30 C 205 120 250 245 345 360 C 420 452 455 530 470 650" />
        <path className="sat-road" d="M825 -30 C 785 120 782 260 838 384 C 884 486 935 552 1040 620" />
        <path className="sat-dirt" d="M20 310 C 150 285 270 280 405 320 C 545 362 670 362 815 315 C 920 282 990 276 1040 288" />
        <polygon className="sat-park" points="405,210 590,190 660,280 595,372 410,360 350,278" />
        <polygon className="sat-park dark" points="410,432 575,392 678,466 620,575 430,565" />
        <polygon className="sat-campus" points="38,215 255,205 268,342 50,360" />
        <polygon className="sat-campus" points="60,384 248,365 270,512 70,535" />
        <g className="sat-buildings">
          {Array.from({ length: 36 }, (_, index) => {
            const col = index % 6;
            const row = Math.floor(index / 6);
            return <rect height="18" key={index} rx="2" width="42" x={40 + col * 58} y={224 + row * 34} />;
          })}
          {Array.from({ length: 44 }, (_, index) => {
            const col = index % 4;
            const row = Math.floor(index / 4);
            return <rect height="16" key={`r-${index}`} rx="2" width="36" x={850 + col * 42} y={54 + row * 42} />;
          })}
        </g>
        <g className="sat-tree-clusters">
          {Array.from({ length: 42 }, (_, index) => {
            const x = 300 + ((index * 83) % 430);
            const y = 70 + ((index * 47) % 470);
            const r = 11 + (index % 5) * 2;
            return <circle cx={x} cy={y} key={index} r={r} />;
          })}
        </g>
      </svg>
    </div>
  );
}

export function MapView({ robot, mapMode, onMapClick, variant = 'full', onSwap }: MapViewProps) {
  const [map, setMap] = useState<LeafletMap | null>(null);
  const robotMarker = useMemo(() => robotIcon(robot.headingDeg), [Math.round(robot.headingDeg)]); // eslint-disable-line react-hooks/exhaustive-deps
  const destMarker = useMemo(destinationIcon, []);
  const mini = variant === 'mini';

  // Leaflet necesita recalcular su tamaño cuando el contenedor cambia (p.ej. al hacer swap con la cámara).
  useEffect(() => {
    if (!map) {
      return;
    }
    const refreshMap = () => {
      map.invalidateSize({ pan: false });
      map.eachLayer((layer) => {
        if (layer instanceof L.TileLayer) {
          layer.redraw();
        }
      });
    };
    const container = map.getContainer();
    const observer = new ResizeObserver(refreshMap);
    observer.observe(container);
    window.requestAnimationFrame(refreshMap);
    const timers = [
      window.setTimeout(refreshMap, 120),
      window.setTimeout(refreshMap, 360),
      window.setTimeout(refreshMap, 900),
    ];
    return () => {
      observer.disconnect();
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [map, mini]);

  // Línea sólida = ruta del backend; si todavía no hay, traza la planeada con los waypoints del operador.
  const backendRoute = robot.route.map(toLatLng);
  const plannedRoute = robot.position
    ? [toLatLng(robot.position), ...robot.waypoints.map(toLatLng)]
    : robot.waypoints.map(toLatLng);
  const showDestinationMarker = robot.goalActive && robot.waypoints.length === 1;

  const mapSurface = (
    <div className={`overflow-hidden ${mini ? 'relative aspect-video rounded-md border border-edge bg-black/80' : 'absolute inset-0'}`}>
      <SatelliteFallback />
      <MapContainer key={mini ? 'map-mini' : 'map-full'} center={DEFAULT_CENTER} zoom={DEFAULT_ZOOM} maxZoom={20} zoomControl={false} scrollWheelZoom className="map-leaflet relative z-10">
        <TileLayer
          attribution="Tiles © Esri"
          maxNativeZoom={19}
          maxZoom={20}
          url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
        />

        {backendRoute.length >= 2 ? (
          <>
            <Polyline pathOptions={{ color: '#05070a', opacity: 0.82, weight: 11 }} positions={backendRoute} />
            <Polyline pathOptions={{ color: '#ffdd00', opacity: 1, weight: 6 }} positions={backendRoute} />
          </>
        ) : plannedRoute.length >= 2 ? (
          <Polyline pathOptions={{ color: '#ffdd00', opacity: 0.95, weight: 4, dashArray: '8 8' }} positions={plannedRoute} />
        ) : null}

        {robot.waypoints.map((point, index) => (
          <Marker
            key={`${point.lat}-${point.lng}-${index}`}
            icon={showDestinationMarker ? destMarker : waypointIcon(index + 1)}
            position={toLatLng(point)}
          />
        ))}

        {robot.position ? <Marker icon={robotMarker} position={toLatLng(robot.position)} zIndexOffset={1000} /> : null}

        <MapBinder enabled={mapMode !== 'idle'} onMapClick={onMapClick} onMapReady={setMap} />
      </MapContainer>

      <div className="pointer-events-none absolute inset-0 z-[400] bg-[radial-gradient(circle_at_center,rgba(7,13,22,0.02)_0%,rgba(7,13,22,0.12)_62%,rgba(7,13,22,0.34)_100%)] mix-blend-multiply" />

      {/* Búsqueda + ayuda de modo */}
      {!mini ? (
      <div className="absolute left-4 right-4 top-3 z-[500] flex items-center gap-2">
        <label className="flex min-h-9 max-w-[280px] flex-1 items-center gap-2 rounded-md border border-edge bg-surface-panel px-3 shadow-card">
          <Search className="text-ink-faint" size={14} />
          <input className="min-w-0 flex-1 bg-transparent text-[11px] font-medium text-ink outline-none placeholder:text-ink-faint" placeholder="Buscar ubicación..." type="search" />
          <button type="button" className="grid h-6 w-6 shrink-0 place-items-center rounded text-ink-faint hover:bg-white/5 hover:text-ink" aria-label="Filtros del mapa">
            <SlidersHorizontal size={13} />
          </button>
        </label>
        {mapMode !== 'idle' ? (
          <div className="flex items-center gap-1.5 rounded-md border border-brand-ring bg-brand-soft px-2.5 py-2 text-[10px] font-bold uppercase tracking-wide text-brand shadow-card backdrop-blur">
            <MousePointerClick size={12} />
            {mapMode === 'goal' ? 'Toca el mapa para fijar destino' : 'Toca el mapa para agregar punto'}
          </div>
        ) : null}
      </div>
      ) : null}

      {/* Zoom + centrar */}
      {!mini ? (
      <div className="absolute left-4 top-[58px] z-[500] flex flex-col gap-2">
        <div className="overflow-hidden rounded-md border border-edge bg-black/70 shadow-card backdrop-blur">
          <button className="grid h-9 w-9 place-items-center text-ink-soft hover:bg-surface-sunken" onClick={() => map?.zoomIn()} type="button"><Plus size={15} /></button>
          <div className="mx-2 h-px bg-edge" />
          <button className="grid h-9 w-9 place-items-center text-ink-soft hover:bg-surface-sunken" onClick={() => map?.zoomOut()} type="button"><Minus size={15} /></button>
        </div>
        <button
          className="ctl grid h-9 w-9 place-items-center bg-black/70 text-ink-soft shadow-card backdrop-blur disabled:opacity-40"
          disabled={!robot.position}
          onClick={() => robot.position && map?.setView(toLatLng(robot.position), Math.max(map.getZoom(), 16))}
          type="button"
        >
          <LocateFixed size={14} />
          <span className="sr-only">Centrar en el robot</span>
        </button>
      </div>
      ) : null}

      {!mini ? (
        <>
          <div className="absolute bottom-4 left-4 z-[500] rounded-md border border-edge bg-black/70 px-3 py-1.5 text-[11px] font-bold text-ink-soft shadow-card backdrop-blur">
            <span className="mr-2 inline-block h-1.5 w-10 border-x border-b border-ink-soft align-middle" />
            200 m
          </div>

          <button className="ctl absolute bottom-4 right-4 z-[500] grid h-9 w-9 place-items-center bg-black/70 text-ink-soft shadow-card backdrop-blur" type="button">
            <Layers size={15} />
            <span className="sr-only">Capas</span>
          </button>
        </>
      ) : (
        null
      )}
    </div>
  );

  if (mini) {
    return (
      <section className="panel map-panel w-full shrink-0 overflow-hidden p-3.5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[11px] font-extrabold uppercase text-ink">Mapa</h2>
          <span className="flex items-center gap-1.5 text-[10px] font-extrabold uppercase tracking-wider text-ink-faint">
            <span className="h-1.5 w-1.5 rounded-full bg-ink-faint" />
            Local
          </span>
        </div>

        {mapSurface}

        <button
          type="button"
          onClick={onSwap}
          className="ctl mt-3 flex h-8 w-full items-center justify-center gap-2 text-[10px] font-bold uppercase tracking-wide text-ink-soft disabled:opacity-40"
          disabled={!onSwap}
        >
          <Map size={14} />
          Ver en el mapa
          <Maximize2 size={13} className="ml-0.5" />
        </button>
      </section>
    );
  }

  return (
    <section
      className={`panel map-panel relative min-h-[420px] flex-1 overflow-hidden lg:min-h-0 ${mapMode !== 'idle' ? 'cursor-crosshair' : ''}`}
    >
      {mapSurface}
    </section>
  );
}
