// `{{BASE_URL}}` in task text: the run's environment base URL, filled in when the run starts, so one task
// file runs on any environment and never pins the URL a probe or plan was written against.
import { AccountStore } from "./accounts/store.ts";
import { EnvError, envLabel, loadEnvironment } from "./environment.ts";

export const BASE_URL = "{{BASE_URL}}";

export function usesBaseUrl(text: string): boolean {
  return text.includes(BASE_URL);
}

/** The first http(s) URL after a "Base URL" heading or label in an environment file, or null. */
export function baseUrlOfText(envText: string): string | null {
  const m = /base url[^\n]*\n*\s*(?:[-*]\s*)?<?(https?:\/\/[^\s)>]+)/i.exec(envText);
  if (!m) return null;
  try {
    return new URL(m[1]!).href;
  } catch {
    return null;
  }
}

/**
 * The base URL of environment `env` (a name or a path): the one set on the Environments page,
 * else the environment file's Base URL; null when neither has one.
 */
export function envBaseUrl(env: string, cwd = process.cwd(), envText?: string): string | null {
  const store = AccountStore.open(cwd, { create: false });
  if (store !== null) {
    try {
      const set = store.envSettings(envLabel(env) as string).baseUrl;
      if (set !== null) return set;
    } finally {
      store.close();
    }
  }
  try {
    return baseUrlOfText(envText ?? loadEnvironment(env, cwd).text);
  } catch (e) {
    if (e instanceof EnvError) return null;
    throw e;
  }
}

/** `base` without its trailing slashes, so `{{BASE_URL}}/cart` reads as one URL. */
const trimmed = (base: string): string => base.replace(/\/+$/, "");

/** Fill `{{BASE_URL}}` in `text`; throws EnvError when it is used and there is no base URL. */
export function fillBaseUrl(text: string, env: string | null, base: string | null): string {
  if (!usesBaseUrl(text)) return text;
  if (env === null) throw new EnvError(`the task uses ${BASE_URL} but has no environment (set env: or --env)`);
  if (base === null) {
    throw new EnvError(`the task uses ${BASE_URL} but environment '${envLabel(env)}' has no base URL`);
  }
  return text.split(BASE_URL).join(trimmed(base));
}

/** Why `text` cannot be filled for environment `env` (for preflight), or null. */
export function baseUrlProblem(text: string, env: string | null, cwd = process.cwd()): string | null {
  if (!usesBaseUrl(text)) return null;
  try {
    fillBaseUrl(text, env, env === null ? null : envBaseUrl(env, cwd));
    return null;
  } catch (e) {
    if (e instanceof EnvError) return e.message;
    throw e;
  }
}

/** `text` with every URL under `base` written as `{{BASE_URL}}<rest>`. */
export function toBaseUrl(text: string, base: string): string {
  const b = trimmed(base);
  if (!/^https?:\/\/./i.test(b)) return text;
  const escaped = b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Only where the base ends: not https://shop.example.com.evil or https://shop.example.com:8080.
  return text.replace(new RegExp(`${escaped}(?![\\w.:@-])`, "gi"), BASE_URL);
}
