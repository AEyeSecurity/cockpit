import { randomToken, digest, matchesPassword, passwordHash, newTotpSecret, acceptedTotpStep } from "./crypto.mjs";
import { audit, byId, byUsername, identity, provision, reset, transaction } from "./store.mjs";

const idle = 30 * 60 * 1000;
const lifetime = 12 * 60 * 60 * 1000;
const setupLifetime = 15 * 60 * 1000;
const cookieName = "__Host-cockpit";
const dummyHash = passwordHash(randomToken());

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const fail = (status, message) => { throw new HttpError(status, message); };
const denied = () => fail(401, "Credenciales incorrectas o vencidas.");
const publicAccount = ({ id, username, name, role, status }) => ({ id, username, name, role, status });
const stage = (account) => account.must_change ? "password" : account.role === "admin" && !account.totp ? "totp" : "ready";

function setCookie(res, value, age) {
  res.setHeader("Set-Cookie", cookieName + "=" + value + "; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=" + age);
}

function cookie(req) {
  const match = req.headers.cookie?.match(/(?:^|;\s*)__Host-cockpit=([\w-]{43})(?:;|$)/);
  return match ? digest(match[1]) : null;
}

function validatePassword(value, username) {
  if (typeof value !== "string" || value.length > 256) fail(400, "Clave inválida.");
  const password = value.normalize("NFC");
  if ([...password].length < 15 || [...password].length > 128 ||
      [username, "passwordpassword", "123456789012345", "contraseñacontraseña", "cockpitcockpitcockpit"].includes(password.toLowerCase())) {
    fail(400, "Elegí una clave de 15 a 128 caracteres que no sea común.");
  }
  return password;
}

async function readJson(req) {
  if (req.headers["content-type"]?.split(";")[0] !== "application/json") fail(415, "Se requiere JSON.");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) fail(413, "Solicitud demasiado grande.");
    chunks.push(chunk);
  }
  const data = Buffer.concat(chunks).toString("utf8");
  try {
    const value = JSON.parse(data);
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {
    // The response is identical for malformed JSON and a non-object payload.
  }
  return fail(400, "Solicitud inválida.");
}

export function createIdentity(db, vault, origin, now = Date.now) {
  const attempts = new Map();

  function throttle(key, limit) {
    const time = now();
    const entry = attempts.get(key);
    if (entry && entry.until > time) {
      if (entry.count >= limit) fail(429, "Demasiados intentos. Volvé a intentar más tarde.");
      entry.count++;
      return;
    }
    if (attempts.size >= 4096) {
      for (const [id, value] of attempts) {
        if (value.until <= time) attempts.delete(id);
      }
      if (attempts.size >= 4096) fail(429, "Demasiados intentos. Volvé a intentar más tarde.");
    }
    attempts.set(key, { count: 1, until: time + 5 * 60 * 1000 });
  }

  function getSession(req) {
    const id = cookie(req);
    if (!id) return null;
    const session = db.prepare("SELECT * FROM sessions WHERE id=? AND expires>? AND last_seen>?")
      .get(id, now(), now() - idle);
    if (!session) return null;
    const account = byId(db, session.account_id);
    if (account?.status !== "active") return null;
    return { ...session, account };
  }

  function describe(session) {
    return {
      account: publicAccount(session.account),
      stage: stage(session.account),
      csrf: session.csrf
    };
  }

  function issue(res, account) {
    const time = now();
    const age = stage(account) === "ready" ? lifetime : setupLifetime;
    const token = randomToken();
    const session = { id: digest(token), csrf: randomToken(), account };
    db.prepare("DELETE FROM sessions WHERE expires<=? OR last_seen<=?").run(time, time - idle);
    db.prepare("INSERT INTO sessions (id,account_id,csrf,last_seen,expires) VALUES (?,?,?,?,?)")
      .run(session.id, account.id, session.csrf, time, time + age);
    setCookie(res, token, age / 1000);
    return describe(session);
  }

  function useTotp(account, code) {
    if (!account.totp) denied();
    const secret = vault.unseal(account.totp, "totp:" + account.id);
    const step = acceptedTotpStep(secret, code, account.totp_step, now());
    if (step === null) denied();
    db.prepare("UPDATE accounts SET totp_step=? WHERE id=?").run(step, account.id);
  }

  function login(req, res, body) {
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase().slice(0, 64) : "";
    throttle("login:all", 180);
    const key = "login:" + username;
    throttle(key, 10);
    const account = byUsername(db, username);
    try {
      if (!matchesPassword(body.password, account?.hash ?? dummyHash) || account?.status !== "active" ||
          (account.must_change && !(account.setup_until > now()))) denied();
      const result = transaction(db, () => {
        if (account.totp) useTotp(account, body.code);
        const previous = cookie(req);
        if (previous) db.prepare("DELETE FROM sessions WHERE id=?").run(previous);
        if (account.must_change) db.prepare("UPDATE accounts SET setup_until=0 WHERE id=?").run(account.id);
        audit(db, account.id, account.id, "login");
        return issue(res, account);
      });
      attempts.delete(key);
      return result;
    } catch (error) {
      if (error instanceof HttpError) audit(db, account?.id ?? null, account?.id ?? null, "login", "denied");
      throw error;
    }
  }

  function changePassword(res, session, body) {
    const { account } = session;
    throttle("change:" + account.id, 10);
    if (!matchesPassword(body.currentPassword, account.hash)) denied();
    const password = validatePassword(body.password, account.username);
    if (matchesPassword(password, account.hash)) fail(400, "Elegí una clave diferente de la actual.");
    return transaction(db, () => {
      if (account.role === "admin" && account.totp && !account.must_change) useTotp(account, body.code);
      const copy = account.role === "user" ? vault.seal(password, "password:" + account.id) : null;
      db.prepare("UPDATE accounts SET hash=?,password_copy=?,must_change=0,setup_until=NULL WHERE id=?")
        .run(passwordHash(password), copy, account.id);
      db.prepare("DELETE FROM sessions WHERE account_id=?").run(account.id);
      audit(db, account.id, account.id, "password.change");
      return issue(res, byId(db, account.id));
    });
  }

  function enroll(res, session, body) {
    const { account } = session;
    if (stage(account) !== "totp") fail(409, "El enrolamiento no está disponible.");
    throttle("enroll:" + account.id, 12);
    if (body.code === undefined) {
      const secret = session.pending_totp
        ? vault.unseal(session.pending_totp, "enroll:" + account.id)
        : newTotpSecret();
      if (!session.pending_totp) {
        db.prepare("UPDATE sessions SET pending_totp=? WHERE id=?")
          .run(vault.seal(secret, "enroll:" + account.id), session.id);
      }
      return { secret };
    }
    if (!session.pending_totp) fail(409, "Iniciá el enrolamiento.");
    const secret = vault.unseal(session.pending_totp, "enroll:" + account.id);
    const step = acceptedTotpStep(secret, body.code, -1, now());
    if (step === null) fail(400, "Código incorrecto.");
    return transaction(db, () => {
      db.prepare("UPDATE accounts SET totp=?,totp_step=? WHERE id=?")
        .run(vault.seal(secret, "totp:" + account.id), step, account.id);
      db.prepare("DELETE FROM sessions WHERE account_id=?").run(account.id);
      audit(db, account.id, account.id, "totp.enroll");
      return issue(res, byId(db, account.id));
    });
  }

  function enforceLastAdmin(target) {
    if (target.role === "admin" && target.status === "active" &&
        db.prepare("SELECT COUNT(*) AS count FROM accounts WHERE role='admin' AND status='active' AND id<>?").get(target.id).count === 0) {
      fail(409, "Debe quedar al menos un administrador activo.");
    }
  }

  function manage(method, path, body, session) {
    const actor = session.account;
    if (stage(actor) !== "ready" || actor.role !== "admin") fail(403, "Permisos insuficientes.");
    if (path === "/api/users" && method === "GET") {
      return db.prepare("SELECT id,username,name,role,status FROM accounts ORDER BY username").all();
    }
    if (path === "/api/users" && method === "POST") {
      const profile = identity(body.username, body.name);
      if (!profile || !["admin", "user"].includes(body.role)) fail(400, "Perfil inválido.");
      return transaction(db, () => {
        if (byUsername(db, profile.username)) fail(409, "El nombre de usuario ya existe.");
        const initialPassword = body.initialPassword === undefined
          ? undefined : validatePassword(body.initialPassword, profile.username);
        const result = provision(db, vault, { ...profile, role: body.role, initialPassword }, now());
        audit(db, actor.id, result.id, "account.create");
        return { account: publicAccount(byId(db, result.id)), password: initialPassword ? undefined : result.password };
      });
    }
    const match = /^\/api\/users\/([a-f\d-]{36})(?:\/(reveal|reset))?$/.exec(path);
    if (!match) fail(404, "Ruta inexistente.");
    const [, id, action] = match;
    const target = byId(db, id);
    if (!target) fail(404, "Cuenta inexistente.");
    if (method === "POST" && action) {
      const auditAction = "password." + action;
      try {
        throttle("step-up:" + actor.id, 10);
        if (actor.id === id || (action === "reveal" && (target.role !== "user" || !target.password_copy))) {
          fail(403, "La operación no está disponible para esta cuenta.");
        }
        return transaction(db, () => {
          if (!matchesPassword(body.password, actor.hash)) fail(403, "Reautenticación incorrecta.");
          useTotp(actor, body.code);
          const password = action === "reveal"
            ? vault.unseal(target.password_copy, "password:" + target.id)
            : reset(db, vault, target, now());
          audit(db, actor.id, target.id, auditAction);
          return { password };
        });
      } catch (error) {
        audit(db, actor.id, target.id, auditAction, "denied");
        if (error instanceof HttpError && error.status === 401) fail(403, "Reautenticación incorrecta.");
        throw error;
      }
    }
    if (action) fail(404, "Ruta inexistente.");
    if (method === "DELETE") {
      return transaction(db, () => {
        enforceLastAdmin(target);
        if (actor.id === id) fail(409, "No podés eliminar tu propia cuenta.");
        db.prepare("DELETE FROM accounts WHERE id=?").run(id);
        audit(db, actor.id, id, "account.delete");
        return {};
      });
    }
    if (method === "PATCH") {
      const profile = identity(body.username ?? target.username, body.name ?? target.name);
      const role = body.role ?? target.role;
      const status = body.status ?? target.status;
      if (!profile || !["admin", "user"].includes(role) || !["active", "suspended"].includes(status)) {
        fail(400, "Perfil inválido.");
      }
      const roleChanged = role !== target.role;
      return transaction(db, () => {
        if (roleChanged || status === "suspended") {
          enforceLastAdmin(target);
          if (actor.id === id) fail(409, "No podés cambiar tu propio rol ni suspender tu cuenta.");
        }
        const existing = byUsername(db, profile.username);
        if (existing && existing.id !== id) fail(409, "El nombre de usuario ya existe.");
        db.prepare("UPDATE accounts SET username=?,name=?,role=?,status=? WHERE id=?")
          .run(profile.username, profile.name, role, status, id);
        let password;
        if (roleChanged) {
          db.prepare("UPDATE accounts SET totp=NULL,totp_step=-1 WHERE id=?").run(id);
          password = reset(db, vault, { ...target, role }, now());
        }
        if (status === "suspended") db.prepare("DELETE FROM sessions WHERE account_id=?").run(id);
        audit(db, actor.id, id, roleChanged ? "account.role" : status !== target.status ? "account." + status : "account.edit");
        return { account: publicAccount(byId(db, id)), password };
      });
    }
    return fail(404, "Ruta inexistente.");
  }

  return {
    operational(req) {
      const session = getSession(req);
      return session && stage(session.account) === "ready" ? session : null;
    },
    isLive(session) {
      const row = db.prepare("SELECT id FROM sessions WHERE id=? AND expires>? AND last_seen>?")
        .get(session.id, now(), now() - idle);
      return Boolean(row);
    },
    checkOrigin(req) {
      if (req.headers.origin !== origin) fail(403, "Origen no permitido.");
    },
    async api(req, res, path) {
      const method = req.method;
      const write = method !== "GET";
      let body;
      if (write) {
        this.checkOrigin(req);
        body = await readJson(req);
      }
      if (method === "POST" && path === "/api/session/login") return login(req, res, body);
      const session = getSession(req);
      if (!session) fail(401, "Iniciá sesión.");
      if (write && req.headers["x-cockpit-csrf"] !== session.csrf) fail(403, "Solicitud no autorizada.");
      if (method === "GET" && path === "/api/session") return describe(session);
      if (method === "POST" && path === "/api/session/keepalive" && stage(session.account) === "ready") {
        db.prepare("UPDATE sessions SET last_seen=? WHERE id=?").run(now(), session.id);
        return describe(session);
      }
      if (method === "POST" && path === "/api/session/logout") {
        db.prepare("DELETE FROM sessions WHERE id=?").run(session.id);
        setCookie(res, "", 0);
        return {};
      }
      if (method === "POST" && path === "/api/session/password") return changePassword(res, session, body);
      if (method === "POST" && path === "/api/session/totp") return enroll(res, session, body);
      if (path === "/api/users" || path.startsWith("/api/users/")) return manage(method, path, body, session);
      return fail(404, "Ruta inexistente.");
    }
  };
}
