# Needs harness change (v2, not required for v1): `duckwright explore URL --focus "<questions>"`

v1 investigates with plain `duckwright -p -f <probe>` runs and checks the answer afterwards. That works,
with three gaps this change closes:

1. **Evidence only from the last page.** A run folder keeps one snapshot (`page/snapshot.yml`, overwritten
   each step by `src/observe.ts`). A value seen three pages back is provable only if the agent ran an
   `expect` on it. v1 asks for that in the probe text; the agent does not always comply.
2. **Writes probes have no guard.** The marker, the delete-click guard, `audit.jsonl` and the created-items
   ledger exist only for `explore --allow-writes` (`src/runs/run.ts` builds `WriteGuard` from
   `spec.explore.writes`). A `-p` probe that applies a coupon or creates a list relies on prompt rules.
3. **Pages a probe saw do not refresh the sitemap.** A probe that walked `/cart` does not update its
   `last_seen_run`, so the sitemap can call a page stale that a probe saw yesterday.

`--focus` is a narrow explore: the explore pipeline (notes, guard, marker, ledger, sitemap merge, env
block) with a question list instead of the "careful first-time visitor" mandate.

## Sketch

`src/args.ts` (`parseExploreArgs`): accept `--focus TEXT` (the probe's questions, or `@file` to read them
from a file). With `--focus` and no `--max-steps`, the budget is 20 (30 with `--allow-writes`) instead of
60/100. `--write-tasks` with `--focus` is a usage error.

`src/explore/task.ts`: a second prompt builder.

```ts
export function focusTask(url: string, questions: string, opts: { brief?: string; writes?: { marker: string } } = {}): string {
  // Same Rules block as exploreTask (host, destructive actions, off-limits, login), same writesBlock when
  // opts.writes is set, and the off-limits part of the brief only (not the frontier: no map extension).
  // Then:
  //   Answer these questions about the app, nothing else:
  //   <questions, neutralise(flat(...)) per line>
  //   For each answer, on the page that shows it, record
  //     {"cmd":"note","args":["fact","<Qn> <kind> <area path> | <subject> | <exact text>","<URL>"]}
  //   Finish with done success and {"answered":["Q1",...],"not_found":["Q3: why"]}.
}
```

`src/explore/notes.ts`: one more kind, `fact`, explore-only like the others.

```ts
// in NoteSink.add, after checkNoteArgs passed and kind === "fact":
const [head, subject, value] = text.split(" | ");            // "<Qn> <kind> <area>", subject, value
const snap = readFileSync(path.join(this.workdir, "page", SNAPSHOT_FILE), "utf8");  // this step's snapshot
const seen = unescapeSnapshot(snap).includes(flat(value));
fs.appendFileSync(path.join(this.workdir, "facts.jsonl"),
  JSON.stringify({ step: this.step, q: head, subject, value, url, seen, excerpt: seen ? around(snap, value, 200) : null }) + "\n");
return seen ? "ok" : "ok (not found on this step's page; it will not be kept)";
```

The check runs at note time, against the snapshot the agent is looking at, so a value from any page in
the run is provable. `NOTE_TEXT_MAX` (400) and `looksLikeSecret` already apply.

`src/explore/merge.ts`: `fact` notes are skipped like `created`/`removed` (they are not site memory);
pages seen still merge as usual, so `last_seen_run` stays honest.

`src/cli.ts` (`exploreMain`): pick `focusTask` when `focus` is set; after the run print
`Facts: <run>/facts.jsonl (N seen, M not seen)`. `saveMemory` unchanged.

Skill side: `facts.mjs ingest --run <dir>` reads `facts.jsonl` when it exists (evidence `how: "note"`,
`ref: "facts.jsonl step N"`, keep only `seen: true`) and falls back to the v1 answer parsing otherwise.
Writes probes switch to `duckwright explore <url> --focus @<probe file> --allow-writes` and get the
guard and ledger; leftovers then show up in the sitemap's `created` list like any explore leftover.

Tests: `test/explore-notes.test.ts` (fact kind, snapshot check, secret refusal), `test/args.test.ts`
(`--focus` budget, `--write-tasks` conflict), `test/explore-merge.test.ts` (facts skipped by the merge).

Size: about 150 lines of `src/` plus tests; no new files outside `src/explore/`.

## Also worth doing (separate)

- **A host allow-list for `--allow-writes`** (`DUCKWRIGHT_WRITE_HOSTS=localhost:3000,...`, refuse others
  with exit 2). The README says there is no host guard; the skill's gates are prompt-level only.
- **Not proposed:** keeping every step's snapshot (`--keep-snapshots`). The note-time check gives the
  same proof for the values that matter, without megabytes per run.
