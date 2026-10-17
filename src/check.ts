import fs from "node:fs";

import { ENV_MAX_BYTES, ENV_NONE, EnvError, envLabel, loadEnvironment } from "./environment.ts";
import { loadRunAccounts } from "./accounts/runAccounts.ts";
import { AccountError, AccountStore } from "./accounts/store.ts";
import { TaskFileError, loadTaskFile, taskPaths } from "./taskfile.ts";

export interface Finding {
  level: "error" | "warning";
  message: string;
}

export interface CheckResult {
  /** Files that loaded without an error. */
  ok: string[];
  findings: Finding[];
}

/**
 * Check task files the way a run would load them, without a browser, Claude or any CLI on the PATH:
 * front matter, task text, the `setup:` file, and the `env:` file (read from `cwd`, as a run does).
 * Each folder is expanded like `-f`. A missing `state:` file is a warning: people often git-ignore it,
 * but a run fails its preflight without it.
 */
export function checkTasks(paths: string[], cwd = process.cwd()): CheckResult {
  const result: CheckResult = { ok: [], findings: [] };
  const add = (level: Finding["level"], message: string) => result.findings.push({ level, message });
  for (const p of taskPaths(paths)) {
    if (p instanceof TaskFileError) {
      add("error", p.message);
      continue;
    }
    let before = result.findings.length;
    try {
      const tf = loadTaskFile(p);
      if (tf.settings.state && !isFile(tf.settings.state)) {
        add("warning", `${p}: state file not found: ${tf.settings.state} (a run fails its preflight without it)`);
      }
      if (tf.settings.env && tf.settings.env !== ENV_NONE) {
        try {
          const env = loadEnvironment(tf.settings.env, cwd);
          const size = Buffer.byteLength(env.text);
          if (size > ENV_MAX_BYTES * 0.8) {
            add("warning", `${p}: environment file ${env.path} is ${size} bytes; explore needs room for its generated block under ${ENV_MAX_BYTES}`);
          }
        } catch (e) {
          if (!(e instanceof EnvError)) throw e;
          add("error", `${p}: ${e.message}`);
        }
      }
      const pinned = tf.settings.accounts;
      if (pinned && pinned.length > 0) {
        if (!tf.settings.env || tf.settings.env === ENV_NONE) {
          add("warning", `${p}: accounts can't be verified here: the file has no env:`);
        } else {
          const name = envLabel(tf.settings.env) as string;
          try {
            const store = AccountStore.open(cwd, { create: false });
            if (store === null) {
              add("warning", `${p}: accounts can't be verified: no accounts database`);
            } else {
              store.close();
              loadRunAccounts(cwd, name, pinned);
            }
          } catch (e) {
            if (!(e instanceof AccountError)) throw e;
            add("error", `${p}: ${e.message}`);
          }
        }
      }
    } catch (e) {
      if (!(e instanceof TaskFileError)) throw e;
      add("error", e.message);
    }
    if (!result.findings.slice(before).some((f) => f.level === "error")) result.ok.push(p);
  }
  return result;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
