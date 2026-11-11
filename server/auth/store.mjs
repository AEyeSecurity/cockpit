import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { passwordHash, randomToken } from "./crypto.mjs";

const migrations = new URL("./migrations/", import.meta.url);
const setupWindow = 24 * 60 * 60 * 1000;

export function transaction(db, run) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = run();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function openStore(filename) {
  mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON; PRAGMA busy_timeout=3000;");
  const files = readdirSync(migrations).filter((file) => /^\d+\.sql$/.test(file)).sort();
  const currentVersion = db.prepare("PRAGMA user_version").get().user_version;
  const latestVersion = Number(files.at(-1).split(".")[0]);
  if (currentVersion > latestVersion) {
    db.close();
    throw new Error("Database schema is newer than this Cockpit release");
  }
  for (const file of files) {
    const version = Number(file.split(".")[0]);
    transaction(db, () => {
      if (db.prepare("PRAGMA user_version").get().user_version >= version) return;
      db.exec(readFileSync(new URL(file, migrations), "utf8"));
      db.exec("PRAGMA user_version=" + version);
    });
  }
  return db;
}

export const byId = (db, id) => db.prepare("SELECT * FROM accounts WHERE id=?").get(id);
export const byUsername = (db, username) => db.prepare("SELECT * FROM accounts WHERE username=?").get(username);

export function audit(db, actor, target, action, outcome = "ok", now = Date.now()) {
  db.prepare("INSERT INTO audit (time,actor,target,action,outcome) VALUES (?,?,?,?,?)").run(now, actor, target, action, outcome);
}

export function identity(username, name) {
  if (typeof username !== "string" || !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(username)) return null;
  if (typeof name !== "string" || !name.trim() || name.trim().length > 100) return null;
  return { username, name: name.trim() };
}

export function provision(db, vault, { username, name, role, initialPassword }, now = Date.now()) {
  const id = randomUUID();
  const password = initialPassword ?? randomToken();
  const copy = role === "user" ? vault.seal(password, "password:" + id) : null;
  db.prepare("INSERT INTO accounts (id,username,name,role,hash,password_copy,setup_until,must_change) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, username, name, role, passwordHash(password), copy, initialPassword ? null : now + setupWindow, initialPassword ? 0 : 1);
  return { id, password };
}

export function reset(db, vault, account, now = Date.now()) {
  const password = randomToken();
  const copy = account.role === "user" ? vault.seal(password, "password:" + account.id) : null;
  db.prepare("UPDATE accounts SET hash=?,password_copy=?,must_change=1,setup_until=? WHERE id=?")
    .run(passwordHash(password), copy, now + setupWindow, account.id);
  db.prepare("DELETE FROM sessions WHERE account_id=?").run(account.id);
  return password;
}
