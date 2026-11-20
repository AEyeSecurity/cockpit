import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ModuleContext } from "../../../../../core/types/module";
import type { WeatherReport } from "../../../../../../server/weather/preview";
import type { ConnectionService } from "../../navigation/service/impl/ConnectionService";
import type { TelemetryService, TelemetrySnapshot } from "../../telemetry/service/impl/TelemetryService";
import "./weatherPreview.css";

const POSE_MAX_AGE_MS = 30_000;
const REFRESH_MS = 10 * 60_000;
const RAIN_CHANCE = 60;

interface Coordinates {
  lat: number;
  lon: number;
}

function WeatherMetric({ icon, detail, children }: { icon: string; detail: string; children?: ReactNode }): JSX.Element {
  const [anchor, setAnchor] = useState<{ top: number; right: number }>();
  return (
    <span className="weather-metric" title={detail} aria-label={detail} role="img" tabIndex={0}
      onFocus={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        setAnchor({ top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) });
      }}
      onBlur={() => setAnchor(undefined)}>
      <span className="weather-icon" aria-hidden="true">{icon}</span>
      {children && <span aria-hidden="true">{children}</span>}
      {anchor && createPortal(
        <span className="weather-tooltip" style={anchor} aria-hidden="true">{detail}</span>,
        document.body
      )}
    </span>
  );
}

export function WeatherToolbar({ runtime }: { runtime: ModuleContext }): JSX.Element | null {
  const [connected, setConnected] = useState(false);
  const [pose, setPose] = useState<TelemetrySnapshot["robotPose"]>(null);
  const available = runtime.services.has("nav2.service.connection") && runtime.services.has("nav2.service.telemetry");

  useEffect(() => {
    if (!available) return;
    const connection = runtime.getService<ConnectionService>("nav2.service.connection");
    const telemetry = runtime.getService<TelemetryService>("nav2.service.telemetry");
    const stopConnection = connection.subscribe((state) => setConnected(state.connected));
    const stopTelemetry = telemetry.subscribeTelemetry(({ robotPose }) => {
      setPose((previous) => previous?.receivedAtMs === robotPose?.receivedAtMs &&
        previous?.lat === robotPose?.lat && previous?.lon === robotPose?.lon ? previous : robotPose);
    });
    return () => { stopConnection(); stopTelemetry(); };
  }, [available, runtime]);

  return available ? <WeatherPreview connected={connected} pose={pose} /> : null;
}

export function WeatherPreview({ connected, pose }: {
  connected: boolean;
  pose: TelemetrySnapshot["robotPose"];
}): JSX.Element {
  const [pc, setPc] = useState<Coordinates>();
  const [locationError, setLocationError] = useState("");
  const [locating, setLocating] = useState(false);
  const [, setPoseClock] = useState(0);
  const [reading, setReading] = useState<{ key: string; report?: WeatherReport; failed: boolean }>();

  const receivedAt = pose?.receivedAtMs;
  useEffect(() => {
    if (!connected || receivedAt === undefined) return;
    const remaining = receivedAt + POSE_MAX_AGE_MS - Date.now();
    if (remaining <= 0) return;
    const timer = setTimeout(() => setPoseClock(Date.now()), remaining);
    return () => clearTimeout(timer);
  }, [connected, receivedAt]);

  const freshRover = connected && pose && receivedAt !== undefined && Date.now() - receivedAt < POSE_MAX_AGE_MS
    && Math.abs(pose.lat) <= 90 && Math.abs(pose.lon) <= 180;
  const coordinates = freshRover ? pose : pc;
  const source = freshRover ? "Rover" : pc ? "Esta PC" : undefined;
  const lat = coordinates?.lat.toFixed(2);
  const lon = coordinates?.lon.toFixed(2);
  const key = source ? `${source}:${lat},${lon}` : "";
  const current = reading?.key === key ? reading : undefined;

  useEffect(() => {
    if (!key || lat === undefined || lon === undefined) return;
    const controller = new AbortController();
    async function refresh() {
      try {
        const response = await fetch(`/api/weather?lat=${lat}&lon=${lon}`, { signal: controller.signal });
        if (!response.ok) throw new Error("Weather unavailable");
        const report = await response.json() as WeatherReport;
        if (controller.signal.aborted) return;
        setReading({ key, report, failed: false });
      } catch {
        if (controller.signal.aborted) return;
        setReading((previous) => ({ key, failed: true, report: previous?.key === key ? previous.report : undefined }));
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [key, lat, lon]);

  const locatePC = useCallback(() => {
    if (!navigator.geolocation) {
      setLocationError("Este navegador no puede obtener la ubicación.");
      return;
    }
    setLocationError("");
    setLocating(true);
    navigator.geolocation.getCurrentPosition(({ coords }) => {
      setPc({ lat: coords.latitude, lon: coords.longitude });
      setLocating(false);
    }, ({ code }) => {
      const message = code === 1 ? "Permiso de ubicación denegado. Habilitalo en el navegador."
        : code === 3 ? "Se agotó el tiempo para obtener la ubicación. Intentá nuevamente."
        : "El navegador no pudo determinar la ubicación. Intentá nuevamente.";
      setLocationError(message);
      setLocating(false);
    }, { timeout: 10_000, maximumAge: 60_000 });
  }, []);

  useEffect(() => {
    if (key || locating || locationError || !navigator.permissions || !navigator.geolocation) return;
    let cancelled = false;
    void navigator.permissions.query({ name: "geolocation" }).then((permission) => {
      if (!cancelled && permission.state === "granted") locatePC();
      if (!cancelled && permission.state === "denied") {
        setLocationError("Permiso de ubicación denegado. Habilitalo en el navegador.");
      }
    }).catch(() => { /* The location button is available if the browser cannot query permissions. */ });
    return () => { cancelled = true; };
  }, [key, locating, locationError, locatePC]);

  const report = current?.report;
  const upToDate = report && !current.failed;
  const rainChance = report ? Math.max(...report.hours.map((hour) => hour.rainChance)) : 0;
  const level = !upToDate ? "unknown" : report.raining ? "stop" : rainChance >= RAIN_CHANCE ? "caution" : "clear";
  const advice = level === "stop" || level === "caution" ? "Postergar navegación"
    : level === "clear" ? "Sin alerta de lluvia"
    : locating ? "Buscando ubicación…"
    : current?.failed || locationError ? "Clima no disponible"
    : source ? "Consultando clima…" : "Clima sin ubicación";
  const freshness = report
    ? `${current.failed ? "Último dato" : "Actualizado"} ${new Date(report.updatedAt).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}`
    : "";
  const detail = level === "stop" ? "Está lloviendo en la ubicación consultada."
    : level === "caution" ? `Hasta ${rainChance}% de probabilidad de lluvia en las próximas dos horas.`
    : level === "clear" ? "Sin lluvia actual ni alta probabilidad de lluvia en las próximas dos horas."
    : locationError || freshness || advice;
  const condition = report?.condition ?? "";
  const weatherIcon = report?.raining ? "🌧️"
    : /parcial|partly/i.test(condition) ? "🌤️"
    : /soleado|sunny/i.test(condition) ? "☀️"
    : /despejado|clear/i.test(condition) ? "🌙" : "☁️";

  return <section className="weather-toolbar" aria-label="Clima">
    {upToDate && <div className="weather-details">
      <WeatherMetric icon={weatherIcon}
        detail={`Condiciones actuales: ${condition} · ${source} · WeatherAPI · ${freshness}`} />
      <WeatherMetric icon="☂" detail={`Probabilidad de lluvia: ${report.hours.map(({ at, rainChance }) => `${at}: ${rainChance}%`).join(" · ")}`}>
        {rainChance}%
      </WeatherMetric>
      <WeatherMetric icon="💨" detail={`Viento: ${Math.round(report.windKph)} km/h · Ráfagas: ${Math.round(report.gustKph)} km/h`}>
        {Math.round(report.gustKph)} km/h
      </WeatherMetric>
    </div>}
    <span className={`weather-advice weather-advice--${level}`} role="status" title={detail}>
      <span className="weather-light" aria-hidden="true" />
      <span>{advice}</span>
    </span>
    {!source && !locating && <button type="button" className="weather-location" onClick={locatePC}>
      Usar ubicación de esta PC
    </button>}
    {locationError && !source && <span className="weather-location-error">{locationError}</span>}
  </section>;
}
