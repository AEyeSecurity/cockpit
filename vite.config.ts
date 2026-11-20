import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
import { createWeatherPreview } from "./server/weather/preview";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "WEATHERAPI_");
  const weather = createWeatherPreview(env.WEATHERAPI_KEY?.trim() ?? "");
  return {
    plugins: [react(), {
      name: "cockpit-weather-preview",
      configureServer(server) {
        server.middlewares.use("/api/weather", async (request, response) => {
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          response.setHeader("Cache-Control", "no-store");
          if (request.method !== "GET") {
            response.writeHead(405, { Allow: "GET" }).end(JSON.stringify({ error: "Método no permitido." }));
            return;
          }
          const query = new URL(request.url ?? "/", "http://localhost").searchParams;
          try {
            const report = await weather(query.get("lat"), query.get("lon"));
            response.end(JSON.stringify(report));
          } catch (error) {
            const invalid = error instanceof RangeError;
            response.writeHead(invalid ? 400 : 503).end(JSON.stringify({
              error: invalid ? "Ubicación inválida." : "Clima no disponible."
            }));
          }
        });
      }
    }],
    clearScreen: false,
    server: {
      port: 5173,
      strictPort: true,
      host: host || false,
      ...(host
        ? { hmr: { protocol: "ws", host, port: 5174 } }
        : undefined)
    },
    envPrefix: ["VITE_", "TAURI_ENV_"],
    build: {
      target:
        process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
      minify: process.env.TAURI_ENV_DEBUG ? false : "esbuild",
      sourcemap: !!process.env.TAURI_ENV_DEBUG
    },
    test: {
      environment: "jsdom",
      setupFiles: ["./src/test/setupTests.ts"],
      globals: true,
      css: true,
      exclude: ["server/test/**", "src/test-extension/**", "**/node_modules/**", "**/dist/**"]
    }
  };
});
