import type { Effective, Overrides, TaskId } from "../runs/manager.ts";
import type { SnapshotMode } from "../observe.ts";
import { settingValue, TaskFileError } from "../taskfile.ts";
import type { KeyPress } from "./keypress.ts";

export type FieldKey = "model" | "maxSteps" | "headed" | "snapshot" | "video" | "screenshot" | "jev";
/** `effective` is the value ctrl+r restores; `raw` is the text being edited. */
export interface Field {
  key: FieldKey; label: string; raw: string; overridden: boolean; error: string | null; effective: string;
}
/** `taskId` null: the global options rather than one task's. */
export interface FormState { taskId: TaskId | null; fields: Field[]; focus: number }

const FRONT_MATTER_KEY = {
  model: "model", maxSteps: "max-steps", headed: "headed", snapshot: "snapshot",
  video: "video", screenshot: "screenshot", jev: "jev",
} as const;
const LABELS: Record<FieldKey, string> = {
  model: "model", maxSteps: "max steps", headed: "headed", snapshot: "snapshot mode", video: "video", screenshot: "screenshot", jev: "jev",
};
const ORDER: readonly FieldKey[] = ["model", "maxSteps", "headed", "snapshot", "video", "screenshot", "jev"];
export const FIELD_COUNT = ORDER.length;
const SNAPSHOT_CYCLE: readonly SnapshotMode[] = ["hybrid", "full", "grep"];

function validate(key: FieldKey, raw: string): string | null {
  try {
    settingValue(FRONT_MATTER_KEY[key], raw);
    return null;
  } catch (e) {
    if (e instanceof TaskFileError) return e.message;
    throw e;
  }
}

/** `focus`: the field the form starts on. */
export function openForm(taskId: TaskId | null, effective: Effective, overrides: Overrides, focus = 0): FormState {
  const fields = ORDER.map((k): Field => {
    const eff = String(effective[k]);
    const overridden = overrides[k] !== undefined;
    const raw = overridden ? String(overrides[k]) : eff;
    return { key: k, label: LABELS[k], raw, overridden, error: overridden ? validate(k, raw) : null, effective: eff };
  });
  return { taskId, fields, focus };
}

function edit(f: FormState, raw: string): FormState {
  const cur = f.fields[f.focus];
  const next: Field = { ...cur, raw, overridden: true, error: validate(cur.key, raw) };
  return { ...f, fields: f.fields.map((x, i) => (i === f.focus ? next : x)) };
}

export function formKey(f: FormState, k: KeyPress): FormState {
  const n = f.fields.length;
  if (k.name === "up") return { ...f, focus: (f.focus + n - 1) % n };
  if (k.name === "down" || k.name === "tab") return { ...f, focus: (f.focus + 1) % n };
  const cur = f.fields[f.focus];
  if (k.ctrl && k.input === "r") {
    const reset: Field = { ...cur, raw: cur.effective, overridden: false, error: null };
    return { ...f, fields: f.fields.map((x, i) => (i === f.focus ? reset : x)) };
  }
  const toggle = k.name === "left" || k.name === "right" || (k.name === null && !k.ctrl && !k.meta && k.input === " ");
  if (cur.key === "headed" || cur.key === "video" || cur.key === "screenshot" || cur.key === "jev") {
    return toggle ? edit(f, cur.raw === "true" ? "false" : "true") : f;
  }
  if (cur.key === "snapshot") {
    if (!toggle) return f;
    const i = SNAPSHOT_CYCLE.indexOf(cur.raw as SnapshotMode);
    return edit(f, SNAPSHOT_CYCLE[(i + 1) % SNAPSHOT_CYCLE.length]);
  }
  if (k.name === "backspace") return edit(f, cur.raw.slice(0, -1));
  if (k.name === null && !k.ctrl && !k.meta && k.input) return edit(f, cur.raw + k.input);
  return f;
}

export function formResult(f: FormState): { ok: true; overrides: Overrides } | { ok: false } {
  if (f.fields.some((x) => x.error !== null)) return { ok: false };
  const overrides: Record<string, string | number | boolean> = {};
  for (const x of f.fields) {
    if (x.overridden) overrides[x.key] = settingValue(FRONT_MATTER_KEY[x.key], x.raw);
  }
  return { ok: true, overrides: overrides as Overrides };
}
