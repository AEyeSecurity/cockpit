export interface Account {
  id: string;
  username: string;
  name: string;
  role: "admin" | "user";
  status: "active" | "suspended";
}

export interface Session {
  account: Account;
  stage: "password" | "totp" | "ready";
  csrf: string;
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, method = "GET", body?: unknown, csrf?: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== "GET") headers["Content-Type"] = "application/json";
  if (csrf) headers["X-Cockpit-CSRF"] = csrf;
  const response = await fetch("/api/" + path, {
    method, headers, cache: "no-store",
    body: method === "GET" ? undefined : JSON.stringify(body ?? {})
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new ApiError(response.status, payload.error ?? "No se pudo completar la solicitud.");
  }
  return await response.json() as T;
}

export const message = (error: unknown) => error instanceof ApiError
  ? error.message : "No se pudo conectar al servicio de identidad.";
