export const WEATHER_REFRESH_MS = 10 * 60 * 1000;

export interface WeatherReport {
  updatedAt: number;
  condition: string;
  raining: boolean;
  rainNearby: boolean;
  windKph: number;
  gustKph: number;
  hours: { at: string; rainChance: number }[];
}

interface ProviderWeather {
  location: { localtime_epoch: number };
  current: {
    last_updated_epoch: number;
    condition: { text: string };
    precip_mm?: number;
    wind_kph: number;
    gust_kph: number;
  };
  forecast: { forecastday: { hour: { time_epoch: number; time: string; chance_of_rain: number }[] }[] };
}

export function createWeatherPreview(key: string, request = fetch, now = Date.now) {
  const cache = new Map<string, { expiresAt: number; result: Promise<WeatherReport> }>();
  return async (latitude: string | null, longitude: string | null): Promise<WeatherReport> => {
    const lat = latitude?.trim() ? Number(latitude) : NaN;
    const lon = longitude?.trim() ? Number(longitude) : NaN;
    if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180) {
      throw new RangeError("Ubicación inválida.");
    }
    if (!key) throw new Error("WeatherAPI sin configurar.");
    const coordinates = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    const cached = cache.get(coordinates);
    if (cached && cached.expiresAt > now()) return cached.result;

    const url = new URL("https://api.weatherapi.com/v1/forecast.json");
    url.search = new URLSearchParams({ key, q: coordinates, days: "2", lang: "es", aqi: "no", alerts: "no" }).toString();
    const result = (async () => {
      const response = await request(url, { signal: AbortSignal.timeout(6000), redirect: "error" });
      if (!response.ok) throw new Error("WeatherAPI no respondió correctamente.");
      const data = await response.json() as ProviderWeather;
      const current = data.current;
      if (typeof current?.condition?.text !== "string" ||
          ![current.last_updated_epoch, current.wind_kph, current.gust_kph, data.location?.localtime_epoch].every(Number.isFinite)) {
        throw new Error("Respuesta meteorológica incompleta.");
      }
      const hours = data.forecast.forecastday.flatMap((day) => day.hour)
        .filter((hour) => hour.time_epoch > data.location.localtime_epoch &&
          typeof hour.time === "string" && Number.isFinite(hour.chance_of_rain))
        .sort((a, b) => a.time_epoch - b.time_epoch)
        .slice(0, 2)
        .map((hour) => ({ at: hour.time.slice(-5), rainChance: hour.chance_of_rain }));
      if (hours.length < 2) throw new Error("Pronóstico horario incompleto.");
      const rainCondition = /\b(rain|drizzle|lluvias?|llovizna|chubascos?)\b/i.test(current.condition.text);
      const rainNearby = rainCondition && /nearby|cerca|alrededores|proximidades/i.test(current.condition.text);
      return {
        updatedAt: current.last_updated_epoch * 1000,
        condition: current.condition.text,
        raining: !rainNearby && (rainCondition || (current.precip_mm ?? 0) > 0),
        rainNearby,
        windKph: current.wind_kph,
        gustKph: current.gust_kph,
        hours
      };
    })();
    if (cache.size >= 128) cache.delete(cache.keys().next().value!);
    cache.set(coordinates, { expiresAt: now() + WEATHER_REFRESH_MS, result });
    try {
      return await result;
    } catch (error) {
      if (cache.get(coordinates)?.result === result) cache.delete(coordinates);
      throw error;
    }
  };
}
