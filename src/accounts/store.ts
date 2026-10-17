// Per-environment login accounts, kept in a local SQLite file that is git-ignored by its own folder.
// Plaintext on purpose: it is a local test fixture store, not a vault.
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { ENV_NONE, isEnvName } from "../environment.ts";
import { parseSecret } from "../totp.ts";
import { openDatabase } from "./sqlite.ts";

export const DB_DIR = ".duckwright/local";
export const DB_FILE = "duckwright.db";
const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export class AccountError extends Error {
  override name = "AccountError";
}

export interface EnvSettings {
  name: string;
  baseUrl: string | null;
  loginOrigins: string[];
}

export interface Account {
  env: string;
  id: string;
  label: string;
  role: string;
  username: string;
  password: string;
  totpSecret: string | null;
}

export type AccountSummary = Omit<Account, "password" | "totpSecret"> & { hasPassword: boolean; hasTotp: boolean };

/** A missing `password` or `totpSecret` means "keep"; `totpSecret: null` means clear. */
export interface AccountInput {
  env: string;
  id: string;
  label: string;
  role: string;
  username: string;
  password?: string;
  totpSecret?: string | null;
}

/** The env var prefix for an account's credentials, e.g. `DW_DEV_ADMIN_C`. */
export function envVarBase(env: string, id: string): string {
  return `DW_${env}_${id}`.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

/** Schema migrations; entry N upgrades `user_version` N to N + 1. */
const MIGRATIONS: string[] = [
  `CREATE TABLE environments (
     name TEXT PRIMARY KEY,
     base_url TEXT,
     login_origins TEXT NOT NULL DEFAULT '[]'
   );
   CREATE TABLE accounts (
     env TEXT NOT NULL,
     id TEXT NOT NULL,
     label TEXT NOT NULL,
     role TEXT NOT NULL DEFAULT '',
     username TEXT NOT NULL,
     password TEXT NOT NULL,
     totp_secret TEXT,
     PRIMARY KEY(env, id)
   );`,
];

interface AccountRow {
  env: string;
  id: string;
  label: string;
  role: string;
  username: string;
  password: string;
  totp_secret: string | null;
}

function checkEnv(env: string): void {
  if (!isEnvName(env) || env === ENV_NONE) throw new AccountError(`invalid environment name: '${env}'`);
}

/** The http(s) origin of `value`, or an AccountError naming `what`. */
function httpOrigin(value: string, what: string): string {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new AccountError(`${what} is not a valid URL: '${value}'`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new AccountError(`${what} must be http or https: '${value}'`);
  return u.origin;
}

export class AccountStore {
  private readonly db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Opens the store under `cwd`; null when it does not exist and `create` is false (nothing is written then). */
  static open(cwd: string, opts: { create: boolean }): AccountStore | null {
    const dir = path.join(cwd, DB_DIR);
    const file = path.join(dir, DB_FILE);
    if (!fs.existsSync(file)) {
      if (!opts.create) return null;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, ".gitignore"), "*\n");
    }
    const db = openDatabase(file);
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("PRAGMA journal_mode = WAL");
      const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      if (version > MIGRATIONS.length) throw new AccountError(`account database is newer than this duckwright (schema ${version})`);
      for (let v = version; v < MIGRATIONS.length; v++) {
        db.exec("BEGIN IMMEDIATE");
        try {
          db.exec(MIGRATIONS[v]);
          db.exec(`PRAGMA user_version = ${v + 1}`);
          db.exec("COMMIT");
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      }
    } catch (e) {
      db.close();
      throw e;
    }
    return new AccountStore(db);
  }

  close(): void {
    this.db.close();
  }

  envSettings(env: string): EnvSettings {
    const row = this.db.prepare("SELECT base_url, login_origins FROM environments WHERE name = ?").get(env) as
      | { base_url: string | null; login_origins: string }
      | undefined;
    if (!row) return { name: env, baseUrl: null, loginOrigins: [] };
    return { name: env, baseUrl: row.base_url, loginOrigins: JSON.parse(row.login_origins) as string[] };
  }

  setEnvSettings(s: EnvSettings): void {
    checkEnv(s.name);
    if (s.baseUrl !== null) httpOrigin(s.baseUrl, "base URL");
    const baseUrl = s.baseUrl;
    const origins = [...new Set(s.loginOrigins.map((o) => httpOrigin(o, "login origin")))];
    this.db
      .prepare(
        `INSERT INTO environments (name, base_url, login_origins) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET base_url = excluded.base_url, login_origins = excluded.login_origins`,
      )
      .run(s.name, baseUrl, JSON.stringify(origins));
  }

  accounts(env: string): Account[] {
    const rows = this.db.prepare("SELECT * FROM accounts WHERE env = ? ORDER BY id").all(env) as unknown as AccountRow[];
    return rows.map((r) => ({
      env: r.env, id: r.id, label: r.label, role: r.role, username: r.username,
      password: r.password, totpSecret: r.totp_secret,
    }));
  }

  summaries(env: string): AccountSummary[] {
    return this.accounts(env).map(({ password, totpSecret, ...rest }) => ({
      ...rest,
      hasPassword: password !== "",
      hasTotp: totpSecret !== null,
    }));
  }

  saveAccount(a: AccountInput): void {
    checkEnv(a.env);
    if (!ID_RE.test(a.id)) throw new AccountError(`invalid account id: '${a.id}'`);
    if (this.envSettings(a.env).baseUrl === null) throw new AccountError(`environment '${a.env}' needs a base URL before accounts`);
    if (typeof a.totpSecret === "string") {
      try {
        parseSecret(a.totpSecret);
      } catch {
        throw new AccountError("TOTP secret is not valid base32");
      }
    }
    const base = envVarBase(a.env, a.id);
    const clash = this.db.prepare("SELECT env, id FROM accounts").all() as unknown as { env: string; id: string }[];
    for (const o of clash) {
      if ((o.env !== a.env || o.id !== a.id) && envVarBase(o.env, o.id) === base) {
        throw new AccountError(`${a.env}/${a.id} would share env var ${base} with ${o.env}/${o.id}`);
      }
    }
    const old = this.db.prepare("SELECT password, totp_secret FROM accounts WHERE env = ? AND id = ?").get(a.env, a.id) as
      | { password: string; totp_secret: string | null }
      | undefined;
    const password = a.password !== undefined ? a.password : old?.password;
    if (password === undefined || password === "") throw new AccountError("a new account needs a password");
    const totp = a.totpSecret === undefined ? (old?.totp_secret ?? null) : a.totpSecret;
    this.db
      .prepare(
        `INSERT INTO accounts (env, id, label, role, username, password, totp_secret) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(env, id) DO UPDATE SET label = excluded.label, role = excluded.role,
           username = excluded.username, password = excluded.password, totp_secret = excluded.totp_secret`,
      )
      .run(a.env, a.id, a.label, a.role, a.username, password, totp);
  }

  removeAccount(env: string, id: string): boolean {
    return Number(this.db.prepare("DELETE FROM accounts WHERE env = ? AND id = ?").run(env, id).changes) > 0;
  }

  removeEnv(env: string): void {
    this.db.prepare("DELETE FROM accounts WHERE env = ?").run(env);
    this.db.prepare("DELETE FROM environments WHERE name = ?").run(env);
  }
}
