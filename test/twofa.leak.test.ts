import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import type { RunArgs } from "../src/args.ts";
import type { Decision } from "../src/brain.ts";
import { Agent } from "../src/loop.ts";
import type { ProcResult } from "../src/proc.ts";
import { stepLine } from "../src/prompt.ts";
import { PlaywrightCLI } from "../src/pw.ts";
import { PROMPTS, startRun } from "../src/runs/run.ts";
import type { Human } from "../src/twofa.ts";
import { tmpDir } from "./helpers.ts";

const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const SMS = "493817";
const TYPED_TOTP = "718305";

/** Echoes whatever was last filled into the code field in the tab list, like a page that shows what you typed. */
class EchoPW extends PlaywrightCLI {
  filled: string[] = [];
  last = "";

  override async run(cmd: string, args: string[]): Promise<ProcResult> {
    if (cmd === "fill") {
      this.last = args[1];
      this.filled.push(args[1]);
      return { code: 0, stdout: `### Ran Playwright code\n\`\`\`js\nawait page.getByLabel('Code').fill('${args[1]}');\n\`\`\`\n`, stderr: "" };
    }
    if (cmd === "requests" && args[0] === "--clear") return { code: 0, stdout: "", stderr: "" };
    if (cmd === "requests") return { code: 0, stdout: `### Result\n1. [GET] http://h/a?c=${this.last} => [200] OK\n`, stderr: "" };
    if (cmd === "request") return { code: 0, stdout: `### Result\nGeneral\n  url: http://h/a?c=${this.last}\n  duration: 5ms\n`, stderr: "" };
    return { code: 0, stdout: `- tab 0 (current): Verify ${this.last}`, stderr: "" };
  }
  override async open(): Promise<ProcResult> { return { code: 0, stdout: "", stderr: "" }; }
  override async stateLoad(): Promise<void> {}
  override async close(): Promise<void> {}
  override async snapshot(file: string): Promise<string> {
    const text = `- textbox "Code" [ref=e5]\n- textbox "Code": "${this.last}"`;
    fs.writeFileSync(file, text);
    return text;
  }
}

class ScriptBrain {
  prompts: string[] = [];
  calls = 0;
  async decide(prompt: string): Promise<[Decision, number]> {
    this.prompts.push(prompt);
    const script: [string, string[]][] = [["twofa", ["totp", "e5"]], ["twofa", ["sms", "e5"]], ["done", ["success", "logged in"]]];
    const [cmd, args] = script[Math.min(this.calls++, script.length - 1)];
    return [{ evaluationPreviousGoal: "ok", memory: "m", nextGoal: "g", actions: [{ cmd, args }] }, 0];
  }
}

function filesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? filesUnder(p) : [p];
  });
}

const scenarios = [
  { name: "env_secret", env: { DUCKWRIGHT_TOTP_SECRET: SECRET } as Record<string, string>, typedTotp: false },
  { name: "typed_totp_code", env: {} as Record<string, string>, typedTotp: true },
];

for (const sc of scenarios) for (const snapshot of ["full", "grep"] as const) test(`no_secret_or_code_reaches_any_file_prompt_or_output_${sc.name}_${snapshot}`, async () => {
  const tmp = tmpDir();
  const pw = new EchoPW();
  const brain = new ScriptBrain();
  const human: Human = { code: async (kind) => (kind === "totp" ? TYPED_TOTP : SMS), approve: async () => {} };
  const args: RunArgs = {
    task: "log in", file: null, maxSteps: 5, model: "m", headed: false, skill: PROMPTS.defaultSkill, session: "s-1",
    state: null, allowFileAccess: false, export: true, snapshot, print: false, maxParallel: null, network: true,
    twofaTimeout: 300,
  };
  const printed: string[] = [];
  const handle = startRun({ task: "log in", taskFile: null, args }, {
    prompts: PROMPTS, signal: new AbortController().signal, runsDir: path.join(tmp, "runs"),
    env: sc.env,
    humanFor: () => human,
    createAgent: (opts) => new Agent({ ...opts, pw, brain }),
  });
  handle.events.subscribe((e) => { if (e.type === "step:end") printed.push(stepLine(e.record)); });
  const outcome = await handle.done;
  assert.equal(outcome.status, "pass", outcome.error ?? "");
  assert.equal(pw.filled.length, 2);
  const [totp, sms] = pw.filled;
  assert.match(totp, /^\d{6}$/);
  if (sc.typedTotp) assert.equal(totp, TYPED_TOTP);
  assert.equal(sms, SMS);

  assert.ok(filesUnder(handle.workdir).some((f) => f.endsWith(path.join("page", "snapshot.yml"))), "no snapshot file, so the scan would be vacuous");
  const networkFiles = filesUnder(path.join(handle.workdir, "network"));
  assert.ok(networkFiles.length > 0, "network capture wrote no files, so the scan would be vacuous");

  const secrets = sc.typedTotp ? [totp, SMS] : [SECRET, totp, SMS];
  const haystacks: [string, string][] = [
    ...filesUnder(handle.workdir).map((f): [string, string] => [f, fs.readFileSync(f, "utf8")]),
    ...brain.prompts.map((p, i): [string, string] => [`prompt ${i + 1}`, p]),
    ["printed steps", printed.join("\n")],
    ["outcome", JSON.stringify(outcome)],
  ];
  for (const [name, text] of haystacks) {
    for (const s of secrets) assert.ok(!text.includes(s), `${name} contains ${s === SECRET ? "the secret" : "a code"}`);
  }

  const spec = fs.readFileSync(path.join(handle.workdir, "duckwright.spec.ts"), "utf8");
  assert.ok(spec.includes("fill(totp()); // 2FA"));
  assert.ok(spec.includes("// MANUAL: enter the sms code here"));
  assert.ok(spec.includes("DUCKWRIGHT_TOTP_SECRET"));
  const history = JSON.parse(fs.readFileSync(path.join(handle.workdir, "history.json"), "utf8"));
  assert.deepEqual(history.history.map((s: { actions: { cmd: string }[] }) => s.actions[0].cmd), ["twofa", "twofa", "done"]);
  assert.ok(history.history[0].actions[0].code.includes("[2FA CODE]"));
  assert.ok(history.history[1].actions[0].code.includes("[2FA CODE]"));
  const events = fs.readFileSync(path.join(handle.workdir, "events.jsonl"), "utf8");
  assert.ok(events.includes('"twofa:wait"'));
});
