# Arena synthesis: investigation and long-term memory

Ask: when `duckwright-tasks` lacks context it should investigate with Duckwright itself and keep what it
learns as long-term memory. Three candidates, one cross-judge. Full base design: `design.md` (this folder).

**Base: candidate 1 (opus).** Parent and cross-judge (opus) agreed independently. Judge scores 27/30 against
22 (candidate 2, sonnet) and 23 (candidate 3, haiku). Candidate 2 (fable in the first arena) is not involved
here; fable was skipped for lack of usage credits.

**Why the base.** It is the only design whose script checks a fact against what the harness recorded
instead of trusting the agent's answer. The probe must `expect` every value; a passed `expect` stores its
code in `history.json`, so `facts.mjs ingest` keeps a value only if it is in a passed expect, the last
snapshot or a captured call. Verified here: the genuine fixture run keeps 5 facts and rejects 1 paraphrase;
a run whose answer text was altered (not its evidence) keeps nothing for the altered value, and a flow whose
quoted steps no longer match the executed actions is rejected too. Candidate 2's check searched the whole run
folder, which includes the agent's own answer; candidate 3 had no check in the script.

**The design in one paragraph.** Probe (a read-only `duckwright -p` run from `templates/probe.md`) is the v1
investigation tool; scoped explore only for an area the sitemap lacks. Facts live in an append-only
`<root>/.duckwright/facts/<slug>.jsonl`, written only by `scripts/facts.mjs`, committed to git with
`merge=union`. Statuses: observed / intended / bug / retired. Facts go stale by date, by a later commit to a
file they cite, or when the sitemap marks the page stale. The authoring skill reads a 4 KB area-filtered
`brief` next to `sitemap-brief`. Facts never go into the env file or the run-time agent's prompt. No harness
change in v1; `explore --focus` is sketched for v2 (`harness-v2-explore-focus.md`).

**Grafts.**
- From candidate 2: `scripts/gate.mjs`, a deterministic preflight (opted-in env, same host as the env's
  Base URL, not production, no off-limits term in the URL, write env, state file exists), adapted to the
  base's `investigate-envs` key. Tested: refuses another host, an off-limits path, a non-opted-in env.
- From candidate 3: the "fails loudly vs passes for the wrong reason" test as the core of assume vs probe;
  a `suspect` flag (`facts.mjs suspect`) for when a task run citing a fact fails, kept separate from the
  status so the user's `intended` verdict survives. Tested: the fact moves to re-verify and keeps INTENDED.

**Rejected.**
- Candidate 3's reuse of `default-env`/`write-envs` instead of a new `investigate-envs` key: an explicit
  per-env opt-in is the safer default for a tool that drives a real app, and the gate cannot detect an
  unlabelled production host. One extra key is the price.
- Candidate 2's markdown facts file and freshness bands (30/90 days): the base's per-kind dates plus code
  and sitemap triggers are more precise; JSONL merges cleanly in git.
- Candidate 2's `index` command and leftover-first ordering: the filtered brief already costs one command.
  Not ported; revisit if briefs get long.
- Candidate 3's "no `add` evidence check": kept the base's check.

**Fixed in the base.** Two references to `test/skill-check.test.ts` pointed at a file that does not exist in
`test/`; they now name it as a proposed drift test. The candidates' patch for the base SKILL.md was replaced
by its full text.

**Verification.** `node --check` passes for all five scripts. `check-tasks.mjs`: 0 errors on the Larder
example including the new probe and three new tasks (warnings are the expected missing state files).
`doctor.mjs` runs and reports the facts file. `facts.mjs brief`, `ingest`, `suspect` and `gate.mjs` exercised
as above. NOT done: no real Duckwright probe or explore was run against a live app, so the probe wording and
the model's compliance with "`expect` before you report" are untested. That is the acceptance test for v1:
one real probe on one real app. The drift test is still a proposal.
