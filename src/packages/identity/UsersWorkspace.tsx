import { SessionActions } from "./SessionGate";
import { useEffect, useState, type FormEvent } from "react";
import { api, message, localPasswordOnly, minimumPasswordLength, type Account, type Session } from "./api";

type Action = { kind: "create" } | { kind: "edit" | "reveal" | "reset"; account: Account };

export function UsersWorkspace({ session }: { session: Session }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [action, setAction] = useState<Action | null>(null);
  const [credential, setCredential] = useState<{ username: string; password: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setAccounts(await api<Account[]>("users"));
  }

  useEffect(() => { void refresh().catch((failure) => setError(message(failure))); }, []);

  function choose(next: Action | null) {
    setCredential(null);
    setError("");
    setAction(next);
  }

  async function mutate(path: string, method: string, payload: unknown, username: string) {
    setBusy(true);
    setError("");
    setCredential(null);
    try {
      const result = await api<{ password?: string }>(path, method, payload, session.csrf);
      setAction(null);
      if (result.password) setCredential({ username, password: result.password });
      await refresh();
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!action) return;
    const body = Object.fromEntries(new FormData(event.currentTarget));
    if (action.kind === "create") {
      void mutate("users", "POST", body, String(body.username));
    } else if (action.kind === "edit") {
      void mutate("users/" + action.account.id, "PATCH", body, String(body.username));
    } else {
      void mutate("users/" + action.account.id + "/" + action.kind, "POST", body, action.account.username);
    }
  }

  return <section className="identity-users">
    <h2>Usuarios</h2>
    <button type="button" disabled={busy} onClick={() => choose({ kind: "create" })}>Crear usuario</button>
    <table>
      <thead><tr><th>Usuario</th><th>Nombre</th><th>Rol</th><th>Estado</th><th>Acciones</th></tr></thead>
      <tbody>{accounts.map((account) => {
        const own = account.id === session.account.id;
        return <tr key={account.id}>
          <td>{account.username}</td><td>{account.name}</td>
          <td>{account.role === "admin" ? "Administrador" : "Usuario"}</td>
          <td>{account.status === "active" ? "Activo" : "Suspendido"}</td>
          <td>
            <button type="button" disabled={busy} onClick={() => choose({ kind: "edit", account })}>Modificar</button>
            {account.role === "user" && <button type="button" disabled={busy} onClick={() => choose({ kind: "reveal", account })}>Consultar clave</button>}
            {!own && <>
              <button type="button" disabled={busy} onClick={() => choose({ kind: "reset", account })}>Restablecer clave</button>
              <button type="button" disabled={busy} onClick={() => {
                choose(null);
                void mutate("users/" + account.id, "PATCH", { status: account.status === "active" ? "suspended" : "active" }, account.username);
              }}>{account.status === "active" ? "Suspender" : "Reactivar"}</button>
              <button type="button" disabled={busy} onClick={() => {
                if (!window.confirm("¿Eliminar la cuenta " + account.username + "?")) return;
                choose(null);
                void mutate("users/" + account.id, "DELETE", {}, account.username);
              }}>Eliminar</button>
            </>}
          </td>
        </tr>;
      })}</tbody>
    </table>
    {action && <form key={action.kind + ("account" in action ? action.account.id : "")} onSubmit={submit}>
      {(action.kind === "create" || action.kind === "edit") ? <>
        <h3>{action.kind === "create" ? "Crear cuenta" : "Modificar cuenta"}</h3>
        <label>Usuario<input name="username" pattern="[a-z0-9][a-z0-9._\-]{2,63}" defaultValue={action.kind === "edit" ? action.account.username : ""} required /></label>
        <label>Nombre<input name="name" maxLength={100} defaultValue={action.kind === "edit" ? action.account.name : ""} required /></label>
        {action.kind === "create" && <label>Clave inicial<input name="initialPassword" type="password" autoComplete="new-password" minLength={minimumPasswordLength} maxLength={256} required /></label>}
        <label>Rol<select name="role" disabled={action.kind === "edit" && action.account.id === session.account.id} defaultValue={action.kind === "edit" ? action.account.role : "user"}>
          <option value="user">Usuario</option><option value="admin">Administrador</option>
        </select></label>
        {action.kind === "edit" && action.account.id !== session.account.id && <p>Al cambiar el rol se genera una nueva clave temporal y se cierran las sesiones de la cuenta.</p>}
      </> : <>
        <h3>{action.kind === "reveal" ? "Consultar clave" : "Restablecer clave"} de {action.account.username}</h3>
        <label>Tu clave de administrador<input name="password" type="password" autoComplete="current-password" required /></label>
        {!localPasswordOnly && <><p>Usá un código nuevo de tu autenticador.</p>
        <label>Código de seis dígitos<input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required /></label></>}
      </>}
      <div><button disabled={busy}>Confirmar</button>{" "}<button type="button" disabled={busy} onClick={() => choose(null)}>Cancelar</button></div>
    </form>}
    {action?.kind === "edit" && action.account.id === session.account.id && (
      <details>
        <summary>Cambiar mi clave</summary>
        <SessionActions session={session} />
      </details>
    )}
    {credential && <section aria-label="Credencial de la cuenta">
      <p>Clave de {credential.username}</p>
      <output className="identity-secret">{credential.password}</output>{" "}
      <button type="button" onClick={() => setCredential(null)}>Ocultar clave</button>
    </section>}
    {error && <p role="alert" className="identity-error">{error}</p>}
  </section>;
}
