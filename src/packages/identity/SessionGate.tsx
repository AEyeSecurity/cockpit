import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, message, localPasswordOnly, minimumPasswordLength, type Session } from "./api";
import { setStorageAccount } from "../../core/config/accountStorage";
import "./identity.css";

export async function loadSession(): Promise<Session | null> {
  try {
    return await api<Session>("session");
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export function SessionGate({ initial, unavailable }: { initial: Session | null; unavailable?: boolean }) {
  const [session, setSession] = useState(initial);
  const [secret, setSecret] = useState("");
  const [error, setError] = useState(unavailable ? "El servicio de identidad no está disponible." : "");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const input = Object.fromEntries(new FormData(form));
    setBusy(true);
    setError("");
    try {
      const path = !session ? "login" : session.stage === "password" ? "password" : "totp";
      const next = await api<Session>("session/" + path, "POST", input, session?.csrf);
      form.reset();
      if (next.stage === "ready") window.location.reload();
      else setSession(next);
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
    }
  }

  async function enroll() {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ secret: string }>("session/totp", "POST", {}, session?.csrf);
      setSecret(result.secret);
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    try {
      await api("session/logout", "POST", {}, session?.csrf);
      window.location.reload();
    } catch (failure) {
      setError(message(failure));
    }
  }

  const title = !session ? "Iniciar sesión" : session.stage === "password" ? "Cambiar clave" : "Configurar segundo factor";
  return <main className="identity-gate">
    <section className="identity-card">
      <p className="identity-brand">Cockpit</p>
      <h1>{title}</h1>
      <form key={title} onSubmit={submit}>
        {!session && <>
          <label>Usuario<input name="username" autoComplete="username" required /></label>
          <label>Clave<input name="password" type="password" autoComplete="current-password" required /></label>
          {!localPasswordOnly && <label>Código de administrador <span>(si ya configuraste el segundo factor)</span>
            <input name="code" inputMode="numeric" pattern="[0-9]{6}" autoComplete="one-time-code" />
          </label>}
        </>}
        {session?.stage === "password" && <>
          <label>Clave actual<input name="currentPassword" type="password" autoComplete="current-password" required /></label>
          <label>Nueva clave<input name="password" type="password" autoComplete="new-password" minLength={minimumPasswordLength} maxLength={256} required /></label>
        </>}
        {session?.stage === "totp" && <>
          <p>Agregá una cuenta en tu app autenticadora. Elegí código basado en tiempo y usá esta clave de configuración.</p>
          {!secret ? <button type="button" disabled={busy} onClick={() => void enroll()}>Mostrar clave de configuración</button> : <>
            <output className="identity-secret">{secret}</output>
            <label>Código de seis dígitos<input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required /></label>
          </>}
        </>}
        {error && <p role="alert" className="identity-error">{error}</p>}
        {(session?.stage !== "totp" || secret) && <button disabled={busy}>{!session ? "Entrar" : "Continuar"}</button>}
        {session && <button className="identity-secondary" type="button" onClick={() => void logout()}>Cerrar sesión</button>}
      </form>
    </section>
  </main>;
}

export function SessionActions({ session }: { session: Session }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function update(path: string, payload: unknown) {
    setBusy(true);
    setError("");
    try {
      await api("session/" + path, "POST", payload, session.csrf);
      window.location.reload();
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
    }
  }

  return <section className="identity-card" aria-label="Mi cuenta">
      <form onSubmit={(event) => {
        event.preventDefault();
        void update("password", Object.fromEntries(new FormData(event.currentTarget)));
      }}>
        <label>Clave actual<input name="currentPassword" type="password" autoComplete="current-password" required /></label>
        <label>Nueva clave<input name="password" type="password" autoComplete="new-password" minLength={minimumPasswordLength} maxLength={256} required /></label>
        {!localPasswordOnly && session.account.role === "admin" && <label>Código de seis dígitos<input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required /></label>}
        <button disabled={busy}>Cambiar clave</button>
        <button className="identity-secondary" type="button" disabled={busy} onClick={() => void update("logout", {})}>Cerrar sesión</button>
        {error && <p role="alert" className="identity-error">{error}</p>}
      </form>
  </section>;
}

export function activateSession(session: Session): void {
  setStorageAccount(session.account.id);
  let lastActivity = Date.now();
  for (const event of ["pointerdown", "keydown"]) {
    window.addEventListener(event, () => { lastActivity = Date.now(); }, { passive: true });
  }
  let pending = false;
  window.setInterval(async () => {
    if (pending) return;
    pending = true;
    try {
      const active = Date.now() - lastActivity < 20000;
      const current = active
        ? await api<Session>("session/keepalive", "POST", {}, session.csrf)
        : await loadSession();
      if (current?.csrf !== session.csrf || current.stage !== "ready") window.location.reload();
    } catch (error) {
      if (error instanceof ApiError && [401, 403].includes(error.status)) window.location.reload();
    } finally {
      pending = false;
    }
  }, 15000);
}
