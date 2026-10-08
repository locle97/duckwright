import fs from "node:fs";
import path from "node:path";

import type { RunEvent, RunOutcome } from "../events.ts";
import type { HistoryData } from "../export.ts";
import { loadTaskFile } from "../taskfile.ts";
import type { TaskSettings } from "../taskfile.ts";
import type { TaskSource } from "./manager.ts";

export interface PastRun {
  id: string; workdir: string; text: string; source: TaskSource; fileSettings: TaskSettings;
  events: RunEvent[]; outcome: RunOutcome; startedAt: number;
}

export interface PastFs {
  listDirs(p: string): string[];
  readFile(p: string): string;
  mtimeMs(p: string): number;
  exists(p: string): boolean;
}

const nodeFs: PastFs = {
  listDirs(p) {
    try {
      return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return [];
    }
  },
  readFile: (p) => fs.readFileSync(p, "utf8"),
  mtimeMs: (p) => fs.statSync(p).mtimeMs,
  exists: (p) => fs.existsSync(p),
};

const RUN_DIR = /^\d{8}-\d{6}-/;
const EVENT_TYPES = new Set([
  "run:start", "step:start", "phase", "decision", "action:start", "action:result",
  "brain:error", "step:end", "control", "twofa:wait", "twofa:done", "run:end",
]);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

function validHistory(d: unknown): d is HistoryData {
  if (!isObject(d)) return false;
  if (typeof d.task !== "string" || typeof d.success !== "boolean" || typeof d.answer !== "string") return false;
  if (typeof d.steps !== "number" || typeof d.cost_usd !== "number") return false;
  if (d.task_file !== undefined && d.task_file !== null && typeof d.task_file !== "string") return false;
  if (!Array.isArray(d.history)) return false;
  return d.history.every((h) =>
    isObject(h) && typeof h.step === "number"
    && typeof h.evaluation_previous_goal === "string" && typeof h.memory === "string" && typeof h.next_goal === "string"
    && Array.isArray(h.actions)
    && h.actions.every((a) =>
      isObject(a) && typeof a.cmd === "string" && isStrings(a.args)
      && (a.code === undefined || a.code === null || typeof a.code === "string"))
    && isStrings(h.results));
}

function validOutcome(o: unknown): boolean {
  if (!isObject(o)) return false;
  if (o.status !== "pass" && o.status !== "fail" && o.status !== "stop") return false;
  if (o.exitCode !== 0 && o.exitCode !== 1 && o.exitCode !== 130) return false;
  if (typeof o.success !== "boolean" || typeof o.answer !== "string") return false;
  if (typeof o.steps !== "number" || typeof o.costUsd !== "number") return false;
  if (o.historyPath !== null && typeof o.historyPath !== "string") return false;
  if (o.error !== null && typeof o.error !== "string") return false;
  return isObject(o.export) && isStrings(o.warnings);
}

/** Parse an events.jsonl; null unless every line is a RunEvent and the last is run:end. */
export function readEventsJsonl(text: string): RunEvent[] | null {
  const ls = text.split("\n");
  if (ls[ls.length - 1] === "") ls.pop();
  if (!ls.length) return null;
  const out: RunEvent[] = [];
  for (const line of ls) {
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      return null;
    }
    if (!isObject(v) || typeof v.type !== "string" || !EVENT_TYPES.has(v.type) || typeof v.at !== "number") return null;
    if (v.type !== "run:start" && v.type !== "run:end" && v.type !== "control" && v.type !== "step:end"
      && v.type !== "twofa:wait" && v.type !== "twofa:done" && typeof v.step !== "number") return null;
    if (v.type === "step:end" && !(isObject(v.record) && typeof v.record.step === "number")) return null;
    out.push(v as unknown as RunEvent);
  }
  const last = out[out.length - 1];
  return last.type === "run:end" && validOutcome(last.outcome) ? out : null;
}

export function outcomeFromHistory(h: HistoryData, historyPath: string): RunOutcome {
  const status = h.success ? "pass" : h.answer === "interrupted" ? "stop" : "fail";
  return {
    status, exitCode: status === "pass" ? 0 : status === "stop" ? 130 : 1, success: h.success,
    answer: h.answer, steps: h.steps, costUsd: h.cost_usd, historyPath,
    export: { kind: "off" }, warnings: [], ...(h.video === "video.webm" ? { video: h.video } : {}),
    error: h.success ? null : h.answer,
  };
}

export function eventsFromHistory(h: HistoryData, workdir: string, at: number): RunEvent[] {
  const events: RunEvent[] = [{
    type: "run:start", at, task: h.task, maxSteps: Math.max(1, h.steps), model: "", snapshot: "hybrid",
    headed: false, session: "", workdir,
  }];
  for (const s of h.history) {
    const decision = {
      evaluationPreviousGoal: s.evaluation_previous_goal, memory: s.memory, nextGoal: s.next_goal,
      actions: s.actions.map((a) => ({ cmd: a.cmd, args: [...a.args] })),
    };
    const codes = s.actions.map((a) => a.code ?? null);
    events.push({ type: "step:start", at, step: s.step });
    events.push({ type: "decision", at, step: s.step, decision, cost: 0 });
    s.actions.forEach((_, i) => {
      events.push({
        type: "action:result", at, step: s.step, index: i, result: i < s.results.length ? s.results[i] : "", code: codes[i],
      });
    });
    events.push({
      type: "step:end", at, cost: 0, durationMs: 0,
      record: {
        step: s.step, decision, results: [...s.results], codes,
        ...(typeof s.screenshot === "string" ? { screenshot: s.screenshot } : {}),
        ...(typeof s.screenshot_error === "string" ? { screenshotError: s.screenshot_error } : {}),
        ...(s.network ? { network: s.network } : {}),
        ...(s.network_errors?.length ? { networkErrors: [...s.network_errors] } : {}),
      },
    });
  }
  events.push({ type: "run:end", at, outcome: outcomeFromHistory(h, path.join(workdir, "history.json")) });
  return events;
}

function sourceOf(h: HistoryData, cwd: string, fsx: PastFs): { text: string; source: TaskSource; fileSettings: TaskSettings } {
  const typed = { text: h.task, source: { kind: "typed" } as TaskSource, fileSettings: {} as TaskSettings };
  const tf = h.task_file;
  if (typeof tf !== "string") return typed;
  const resolved = path.resolve(cwd, tf);
  if (!fsx.exists(resolved)) return typed;
  try {
    const f = loadTaskFile(resolved);
    const { session: _session, ...settings } = f.settings;
    return { text: f.task, source: { kind: "file", path: tf }, fileSettings: settings };
  } catch {
    return typed;
  }
}

export function loadPastRuns(o: { runsDir: string; limit: number; cwd?: string; fs?: PastFs }): { runs: PastRun[]; skipped: number } {
  const fsx = o.fs ?? nodeFs;
  const cwd = o.cwd ?? process.cwd();
  const runs: PastRun[] = [];
  let skipped = 0;
  if (o.limit <= 0) return { runs, skipped };
  const names = fsx.listDirs(o.runsDir).filter((n) => RUN_DIR.test(n)).sort().reverse();
  for (const id of names) {
    if (runs.length >= o.limit) break;
    const workdir = path.join(o.runsDir, id);
    const historyFile = path.join(workdir, "history.json");
    let h: HistoryData;
    let at: number;
    try {
      const data: unknown = JSON.parse(fsx.readFile(historyFile));
      if (!validHistory(data)) throw new Error("bad shape");
      h = { ...data, task_file: data.task_file ?? null };
      at = fsx.mtimeMs(historyFile);
    } catch {
      skipped++;
      continue;
    }
    let events: RunEvent[] | null = null;
    try {
      events = readEventsJsonl(fsx.readFile(path.join(workdir, "events.jsonl")));
    } catch {
      events = null;
    }
    const last = events?.[events.length - 1];
    const outcome = last?.type === "run:end" ? last.outcome : outcomeFromHistory(h, historyFile);
    const chosen = events ?? eventsFromHistory(h, workdir, at);
    const first = chosen.find((e) => e.type === "run:start");
    let startedAt: number;
    if (first) startedAt = first.at;
    else {
      try {
        startedAt = fsx.mtimeMs(workdir);
      } catch {
        startedAt = 0;
      }
    }
    runs.push({ id, workdir, ...sourceOf(h, cwd, fsx), events: chosen, outcome, startedAt });
  }
  return { runs: runs.reverse(), skipped };
}
