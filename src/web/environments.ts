// Environments and their accounts for the web API: the .md context lives in environments/, the base URL,
// login origins and accounts in the AccountStore. Secrets are write-only: nothing here returns one.
import fs from "node:fs";
import path from "node:path";

import { AccountStore } from "../accounts/store.ts";
import type { AccountInput, AccountSummary } from "../accounts/store.ts";
import { AccountError } from "../accounts/store.ts";
import { ENV_DIR, ENV_NONE, EnvError, isEnvName, listEnvironments, saveEnvironmentText } from "../environment.ts";

export interface EnvironmentView { name: string; baseUrl: string | null; loginOrigins: string[]; accounts: AccountSummary[] }

/** The environment's file (or rows) does not exist: the API answers 404. */
export class EnvNotFound extends EnvError {
  override name = "EnvNotFound";
}
/** The environment file already exists: the API answers 409. */
export class EnvExists extends EnvError {
  override name = "EnvExists";
}

export interface EnvironmentsLike {
  list(): EnvironmentView[];
  get(name: string): (EnvironmentView & { context: string }) | null;
  create(name: string, context: string): void;
  update(name: string, s: { baseUrl: string | null; loginOrigins: string[]; context?: string }): void;
  remove(name: string, deleteFile: boolean): void;
  saveAccount(a: AccountInput): void;
  removeAccount(env: string, id: string): boolean;
}

export function createEnvironments(cwd: string): EnvironmentsLike {
  const file = (name: string): string => path.join(cwd, ENV_DIR, name + ".md");
  const fileExists = (name: string): boolean => {
    try {
      return fs.statSync(file(name)).isFile();
    } catch {
      return false;
    }
  };
  const checkName = (name: string): void => {
    if (!isEnvName(name) || name === ENV_NONE) throw new EnvError(`invalid environment name: '${name}'`);
  };
  const viewOf = (store: AccountStore | null, name: string): EnvironmentView => {
    if (!store) return { name, baseUrl: null, loginOrigins: [], accounts: [] };
    const s = store.envSettings(name);
    return { name, baseUrl: s.baseUrl, loginOrigins: s.loginOrigins, accounts: store.summaries(name) };
  };
  const withStore = <T>(create: boolean, fn: (s: AccountStore | null) => T): T => {
    const store = AccountStore.open(cwd, { create });
    try {
      return fn(store);
    } finally {
      store?.close();
    }
  };
  const mustExist = (name: string): void => {
    if (!isEnvName(name) || !fileExists(name)) throw new EnvNotFound("no such environment");
  };

  return {
    list: () => withStore(false, (s) => listEnvironments(cwd).map((n) => viewOf(s, n))),
    get(name) {
      if (!isEnvName(name) || !fileExists(name)) return null;
      const context = fs.readFileSync(file(name), "utf8");
      return withStore(false, (s) => ({ ...viewOf(s, name), context }));
    },
    create(name, context) {
      checkName(name);
      if (fileExists(name)) throw new EnvExists(`environment '${name}' already exists`);
      saveEnvironmentText(name, context.trim() === "" ? `# ${name}\n` : context, cwd);
    },
    update(name, s) {
      mustExist(name);
      withStore(true, (store) => {
        if (s.baseUrl === null && store!.summaries(name).length > 0) {
          throw new AccountError(`environment '${name}' has accounts; it needs a base URL`);
        }
        store!.setEnvSettings({ name, baseUrl: s.baseUrl, loginOrigins: s.loginOrigins });
      });
      if (s.context !== undefined) saveEnvironmentText(name, s.context, cwd);
    },
    remove(name, deleteFile) {
      if (!isEnvName(name)) throw new EnvNotFound("no such environment");
      const hadFile = fileExists(name);
      const hadRows = withStore(false, (store) => {
        if (!store) return false;
        const v = viewOf(store, name);
        if (v.baseUrl === null && v.loginOrigins.length === 0 && v.accounts.length === 0) return false;
        store.removeEnv(name);
        return true;
      });
      if (!hadFile && !hadRows) throw new EnvNotFound("no such environment");
      if (deleteFile && hadFile) fs.rmSync(file(name));
    },
    saveAccount(a) {
      mustExist(a.env);
      withStore(true, (store) => store!.saveAccount(a));
    },
    removeAccount: (env, id) => withStore(false, (store) => (store ? store.removeAccount(env, id) : false)),
  };
}
