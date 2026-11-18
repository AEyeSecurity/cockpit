import {
  argon2Sync, createCipheriv, createDecipheriv, createHash, createHmac,
  randomBytes, timingSafeEqual
} from "node:crypto";
import { readFileSync } from "node:fs";

const argon = { memory: 19456, passes: 2, parallelism: 1, tagLength: 32 };
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export const randomToken = () => randomBytes(32).toString("base64url");
export const digest = (token) => createHash("sha256").update(token).digest("base64url");

function derive(password, nonce) {
  return argon2Sync("argon2id", { ...argon, message: Buffer.from(password), nonce });
}

export function passwordHash(password) {
  const salt = randomBytes(16);
  return [1, salt.toString("base64url"), derive(password, salt).toString("base64url")].join(".");
}

export function matchesPassword(password, encoded) {
  if (typeof password !== "string" || password.length > 256) return false;
  const [version, salt, hash] = encoded.split(".");
  if (version !== "1") throw new Error("Unknown password hash version");
  return timingSafeEqual(derive(password.normalize("NFC"), Buffer.from(salt, "base64url")), Buffer.from(hash, "base64url"));
}

export function openVault(file) {
  const { active, keys } = JSON.parse(readFileSync(file, "utf8"));
  const keyring = new Map(Object.entries(keys).map(([id, value]) => {
    const key = Buffer.from(value, "base64");
    if (!/^[\w-]+$/.test(id) || key.length !== 32) throw new Error("Invalid vault key");
    return [id, key];
  }));
  if (!keyring.has(active)) throw new Error("Missing active vault key");
  return {
    seal(value, context) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", keyring.get(active), nonce);
      cipher.setAAD(Buffer.from(context));
      const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return [active, nonce, cipher.getAuthTag(), data].map((part) =>
        typeof part === "string" ? part : part.toString("base64url")).join(".");
    },
    unseal(encoded, context) {
      const [id, nonce, tag, data] = encoded.split(".");
      if (!keyring.has(id)) throw new Error("Unknown vault key");
      const decipher = createDecipheriv("aes-256-gcm", keyring.get(id), Buffer.from(nonce, "base64url"), { authTagLength: 16 });
      decipher.setAAD(Buffer.from(context));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
    }
  };
}

export function newTotpSecret() {
  const bytes = randomBytes(20);
  let secret = "";
  for (let i = 0; i < bytes.length; i += 5) {
    let block = bytes.readUIntBE(i, 5);
    let encoded = "";
    for (let digit = 0; digit < 8; digit++) {
      encoded = alphabet[block % 32] + encoded;
      block = Math.floor(block / 32);
    }
    secret += encoded;
  }
  return secret;
}

export function totpCode(secret, step) {
  const key = Buffer.alloc(secret.length * 5 / 8);
  for (let i = 0; i < secret.length; i += 8) {
    let block = 0;
    for (const char of secret.slice(i, i + 8)) block = block * 32 + alphabet.indexOf(char);
    key.writeUIntBE(block, i / 8 * 5, 5);
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hash = createHmac("sha1", key).update(counter).digest();
  const offset = hash[hash.length - 1] & 15;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, "0");
}

export function acceptedTotpStep(secret, code, lastStep, now) {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return null;
  const step = Math.floor(now / 30000);
  for (const candidate of [step, step - 1, step + 1]) {
    if (candidate > lastStep && timingSafeEqual(Buffer.from(totpCode(secret, candidate)), Buffer.from(code))) {
      return candidate;
    }
  }
  return null;
}
