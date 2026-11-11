import { backup } from "node:sqlite";
import { existsSync } from "node:fs";
import { openVault } from "./crypto.mjs";
import { audit, byUsername, identity, openStore, provision, reset, transaction } from "./store.mjs";

process.umask(0o077);
const [command, username, name] = process.argv.slice(2);
const db = openStore(process.env.COCKPIT_DB ?? "/data/cockpit.sqlite");
const vault = openVault(process.env.COCKPIT_KEYS_FILE);

try {
  if (command === "backup" && username) {
    if (existsSync(username)) throw new Error("El archivo de copia ya existe.");
    await backup(db, username);
  } else if (command === "init-admin" && identity(username, name)) {
    const result = transaction(db, () => {
      if (db.prepare("SELECT 1 FROM accounts LIMIT 1").get()) throw new Error("La base ya fue inicializada.");
      const result = provision(db, vault, { username, name: name.trim(), role: "admin" });
      audit(db, null, result.id, "admin.bootstrap");
      return result;
    });
    console.log(result.password);
  } else if (command === "recover-admin" && username) {
    const password = transaction(db, () => {
      const account = byUsername(db, username);
      if (account?.role !== "admin") throw new Error("Administrador inexistente.");
      db.prepare("UPDATE accounts SET status='active',totp=NULL,totp_step=-1 WHERE id=?").run(account.id);
      const value = reset(db, vault, account);
      audit(db, null, account.id, "admin.recover");
      return value;
    });
    console.log(password);
  } else if (command === "revoke-sessions") {
    transaction(db, () => {
      db.exec("DELETE FROM sessions");
      audit(db, null, null, "sessions.revoke");
    });
  } else if (command === "rotate") {
    transaction(db, () => {
      for (const account of db.prepare("SELECT id,password_copy,totp FROM accounts").all()) {
        const rewrap = (value, purpose) => {
          const context = purpose + ":" + account.id;
          return value ? vault.seal(vault.unseal(value, context), context) : null;
        };
        db.prepare("UPDATE accounts SET password_copy=?,totp=? WHERE id=?")
          .run(rewrap(account.password_copy, "password"), rewrap(account.totp, "totp"), account.id);
      }
      db.exec("DELETE FROM sessions");
      audit(db, null, null, "vault.rotate");
    });
  } else {
    throw new Error("Uso: init-admin <usuario> <nombre> | recover-admin <usuario> | backup <archivo> | revoke-sessions | rotate");
  }
} finally {
  db.close();
}
