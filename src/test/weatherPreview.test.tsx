import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WeatherPreview } from "../packages/nav2/modules/map/frontend/WeatherPreview";
import { createWeatherPreview } from "../../server/weather/preview";

const report = {
  updatedAt: 1_790_000_000_000,
  condition: "Partly cloudy",
  raining: false,
  windKph: 18,
  gustKph: 25,
  hours: [{ at: "16:00", rainChance: 65 }, { at: "17:00", rainChance: 5 }]
};
const provider = {
  location: { localtime_epoch: 100 },
  current: {
    last_updated_epoch: 1_790_000_000, condition: { text: "Light rain" }, wind_kph: 18, gust_kph: 25
  },
  forecast: { forecastday: [{ hour: [
    { time_epoch: 90, time: "2026-11-20 15:00", chance_of_rain: 5 },
    { time_epoch: 110, time: "2026-11-20 16:00", chance_of_rain: 65 },
    { time_epoch: 120, time: "2026-11-20 17:00", chance_of_rain: 5 }
  ] }] }
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, "geolocation");
  Reflect.deleteProperty(navigator, "permissions");
});

it("validates locations, shares rounded requests, expires cache and retries upstream failures", async () => {
  let now = 0;
  const upstream = vi.fn<typeof fetch>()
    .mockImplementation(async () => new Response(JSON.stringify(provider)));
  const weather = createWeatherPreview("test-secret", upstream, () => now);
  await expect(weather(null, "-64")).rejects.toThrow("Ubicación inválida");
  await expect(weather("91", "-64")).rejects.toThrow("Ubicación inválida");
  expect(upstream).not.toHaveBeenCalled();

  const calls = await Promise.all([weather("-31.401", "-64.181"), weather("-31.402", "-64.182")]);
  expect(calls[0]).toEqual({ ...report, condition: "Light rain", raining: true });
  expect(calls[1]).toBe(calls[0]);
  expect(upstream).toHaveBeenCalledOnce();
  const url = upstream.mock.calls[0][0] as URL;
  expect(url.origin).toBe("https://api.weatherapi.com");
  expect(url.searchParams.get("q")).toBe("-31.40,-64.18");
  expect(calls[0]).not.toHaveProperty("key");

  now = 600_000;
  upstream.mockResolvedValueOnce(new Response("", { status: 503 }));
  await expect(weather("-31.4", "-64.18")).rejects.toThrow("no respondió");
  await expect(weather("-31.4", "-64.18")).resolves.toHaveProperty("raining", true);
  expect(upstream).toHaveBeenCalledTimes(3);
});

it("asks for the PC location, handles denial, and waits for a retry", () => {
  const geolocation = { getCurrentPosition: vi.fn((_success, failure) => failure({ code: 1 })) };
  Object.defineProperty(navigator, "geolocation", { configurable: true, value: geolocation });
  const query = vi.fn();
  vi.stubGlobal("fetch", query);

  render(<WeatherPreview connected={false} pose={null} />);
  expect(geolocation.getCurrentPosition).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Usar ubicación de esta PC" }));
  expect(screen.getByRole("status")).toHaveTextContent("Clima no disponible");
  expect(screen.getByText(/Permiso de ubicación denegado/)).toBeVisible();
  expect(query).not.toHaveBeenCalled();
});

it("prefers fresh Rover GPS, falls back when it expires, and keeps the recommendation in the toolbar", async () => {
  vi.useFakeTimers();
  Object.defineProperty(navigator, "geolocation", { configurable: true, value: {
    getCurrentPosition: (success: (value: unknown) => void) => success({ coords: { latitude: -31.4, longitude: -64.18 } })
  } });
  const query = vi.fn(async () => new Response(JSON.stringify(report)));
  vi.stubGlobal("fetch", query);

  const view = render(<WeatherPreview connected={false} pose={null} />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Usar ubicación de esta PC" })); });
  expect(screen.getByRole("img", { name: /Condiciones actuales.*Esta PC/ })).toBeInTheDocument();
  expect(query).toHaveBeenLastCalledWith("/api/weather?lat=-31.40&lon=-64.18", expect.anything());
  expect(screen.getByRole("status")).toHaveTextContent("Postergar navegación");
  expect(screen.getByRole("img", { name: /Probabilidad de lluvia/ })).toHaveAttribute("title",
    "Probabilidad de lluvia: 16:00: 65% · 17:00: 5%");

  await act(async () => {
    view.rerender(<WeatherPreview connected pose={{
      lat: -31.52, lon: -64.21, headingDeg: 0, receivedAtMs: Date.now()
    }} />);
  });
  expect(screen.getByRole("img", { name: /Condiciones actuales.*Rover/ })).toBeInTheDocument();
  expect(query).toHaveBeenLastCalledWith("/api/weather?lat=-31.52&lon=-64.21", expect.anything());
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(screen.getByRole("img", { name: /Condiciones actuales.*Esta PC/ })).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();

  query.mockResolvedValueOnce(new Response("", { status: 503 }));
  await act(async () => { await vi.advanceTimersByTimeAsync(600_000); });
  expect(screen.getByRole("status")).toHaveTextContent("Clima no disponible");
  expect(screen.getByRole("status")).toHaveAttribute("title", expect.stringContaining("Último dato"));
});

it.each([
  { raining: true, label: "Postergar navegación", level: "stop" },
  { raining: false, label: "Sin alerta de lluvia", level: "clear" }
])("loads the PC forecast automatically with permission and shows the $level state", async ({ raining, label, level }) => {
  Object.defineProperty(navigator, "permissions", { configurable: true, value: {
    query: vi.fn(async () => ({ state: "granted" }))
  } });
  Object.defineProperty(navigator, "geolocation", { configurable: true, value: {
    getCurrentPosition: (success: (value: unknown) => void) => success({ coords: { latitude: -31.4, longitude: -64.18 } })
  } });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    ...report, raining, hours: report.hours.map((hour) => ({ ...hour, rainChance: 5 }))
  }))));

  await act(async () => { render(<WeatherPreview connected={false} pose={null} />); });
  expect(screen.getByRole("status")).toHaveTextContent(label);
  expect(screen.getByRole("status")).toHaveClass(`weather-advice--${level}`);
  expect(screen.getByRole("img", { name: /Condiciones actuales.*Esta PC/ })).toBeVisible();
});
