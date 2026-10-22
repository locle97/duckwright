#!/usr/bin/env node
// Turn successful duckwright-agent runs into a draft Playwright spec: the recorded Playwright code of
// each action plus the `expect` assertions the runner verified on the live page. Only success runs are
// converted. The duckwright-playwright skill then restyles the draft to the project's own conventions.
//
//   node export-spec.mjs <run folder>... [-o tests/feature.spec.ts]
//
// One file, one test() per run, in the order given. Zero dependencies.
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const oi = args.indexOf("-o");
const out = oi === -1 ? null : args.splice(oi, 2)[1];
const runs = args;
if (!runs.length) {
  process.stderr.write("usage: export-spec.mjs <run folder>... [-o FILE]\n");
  process.exit(2);
}

const q = (s) => JSON.stringify(s);
const outDir = path.resolve(out ? path.dirname(out) : ".");
const skipped = [];
const tests = [];

for (const dir of runs) {
  const file = path.join(dir, "history.json");
  if (!fs.existsSync(file)) {
    skipped.push(`${dir}: no history.json`);
    continue;
  }
  const h = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!h.success) {
    skipped.push(`${dir}: not a success run`);
    continue;
  }
  const title = (h.task_file ? path.parse(h.task_file).name : path.basename(dir)).replace(/^\d+-/, "").replaceAll("-", " ");
  const lines = [];
  if (h.state) {
    const rel = path.relative(outDir, path.resolve(h.state)).split(path.sep).join("/");
    lines.push(`  test.use({ storageState: ${q(rel.startsWith(".") ? rel : `./${rel}`)} });`);
  }
  const body = [];
  for (const step of h.history) {
    step.actions.forEach((a, i) => {
      const ok = step.results[i] === "ok";
      if (!ok) return; // an action that failed on the way is not part of the scenario
      if (a.cmd === "expect") {
        if (a.code) body.push(`    ${a.code}`);
      } else if (a.cmd === "snapshot" || a.cmd === "screenshot") {
        // not a test step
      } else if (a.code) {
        body.push(`    ${a.code}`);
      } else if (a.cmd.startsWith("tab-")) {
        body.push(`    // TODO(duckwright-agent): ${a.cmd} ${a.args.join(" ")} has no recorded code; tests assume one page`);
      } else {
        body.push(`    // TODO(duckwright-agent): ${a.cmd} ${a.args.map(q).join(" ")} was not recorded as code`);
      }
    });
  }
  if (!body.some((l) => l.includes("expect("))) {
    skipped.push(`${dir}: no recorded assertion, nothing to protect`);
    continue;
  }
  tests.push(
    `  // source: ${dir}${h.task_file ? ` (${h.task_file})` : ""}\n`
    + `${lines.length ? `${lines.join("\n")}\n` : ""}`
    + `  test(${q(title)}, async ({ page }) => {\n${body.join("\n")}\n  });`,
  );
}

const spec = `import { test, expect } from '@playwright/test';\n\ntest.describe('duckwright-agent draft', () => {\n${tests.join("\n\n")}\n});\n`;
if (tests.length) {
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, spec);
    process.stdout.write(`wrote ${out}: ${tests.length} test(s)\n`);
  } else process.stdout.write(spec);
}
for (const s of skipped) process.stderr.write(`skipped ${s}\n`);
process.exit(tests.length ? 0 : 1);
