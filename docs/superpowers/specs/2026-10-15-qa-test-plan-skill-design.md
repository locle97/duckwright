# QA test plan skill (`writing-qa-test-plans`) design

Status: draft for review, 2026-10-15.

## Goal

A skill that reads a feature's spec and implementation plan, investigates the code the plan touches, and writes a QA test plan: a list of numbered, browser-runnable scenarios in a fixed template. The plan is the input to [plan mode](../../../README.md#plan-mode) (`duckwright plan <file>`), which turns each scenario into a task file.

The team knows how the application works, so the skill uses that knowledge instead of guessing: it asks when something is unclear, and it checks every step against the code before writing it down.

Success criteria:

- **SC1:** Given a spec and plan, the skill produces a test plan file in the template, in `docs/superpowers/test-plans/`.
- **SC2:** Every observable behavior in the spec is covered by at least one scenario, and the Coverage table shows it.
- **SC3:** Every step uses a screen, control, route, flag or copy that exists in the code (or in the plan as a task to be built), and every expected result is quoted from the spec.
- **SC4:** Unclear points are asked as clarifying questions in bounded rounds. Anything left unresolved is written as a labeled assumption, never guessed silently.
- **SC5:** The output works with plan mode without changes to duckwright.

Out of scope:

- Changes to duckwright's source, plan mode or the planner prompt.
- Running the scenarios or generating task files (the skill only offers `duckwright plan -p` as a next step).
- Unit and integration tests. The scenarios are black-box and go through what a user can reach.
- Replacing the duckor-flow `test-planner`. That agent stays black-box and does not read the plan; this skill is for people who want the plan and code used.

## Shape

```
.claude/skills/writing-qa-test-plans/
  SKILL.md       workflow, rules, self-review checklist
  template.md    the output template
  questions.md   the clarifying-question bank
```

`SKILL.md` stays short. It loads `template.md` when drafting and `questions.md` when clarifying. The frontmatter `description` states triggers only ("Use when you have a feature spec and implementation plan and need QA test scenarios..."), not the workflow.

Output file: `docs/superpowers/test-plans/YYYY-MM-DD-<topic>-test-plan.md`, the same place and naming as the existing plans.

## Source hierarchy

Each input has one job. This prevents a test plan that only proves the code does what the code does.

| Source | Used for | Never used for |
| --- | --- | --- |
| Spec | Expected results, copy, limits, errors, scope | |
| Implementation plan | Where behavior lives, what is new vs changed, task boundaries | Expected results |
| Code | How to reach a behavior: routes, selectors, labels, flags, defaults, how to start and seed | Expected results |
| The team (questions) | Anything the three above leave open or contradict | |

When the code disagrees with the spec, the skill does not pick a side: it asks (or, with no answer, writes the scenario against the spec and adds a `CONCERN`).

## Workflow

1. **Locate inputs.** Find the spec and the plan. If either is missing or several match, ask which file.
2. **Read the spec.** Goal, contracts, success criteria, error handling, out of scope.
3. **Read the plan.** Learn where each behavior is built, which behavior is new versus changed (changed surfaces drive Regression), and the task each behavior belongs to.
4. **Investigate the code.** For each plan task, open the files it names (and, for changed surfaces, the current code). Record per behavior: how to reach it (entry command, URL, screen, control), the real labels and copy, defaults, and how the app is started, seeded and reset. Use the repo's own commands and docs. Do not execute destructive commands.
5. **Build a behavior inventory.** One row per observable behavior: trigger, input, expected result, spec reference, plan task, code reference.
6. **Reconcile.** Each of these becomes a question: a spec behavior with no plan task, a plan task with no spec behavior, a spec/plan contradiction, a spec/code contradiction, or a surface the code does not expose.
7. **Clarify.** Ask only what the files and code cannot answer, using `questions.md`. At most 4 questions per round and 2 rounds. Each question carries a recommended default. Unresolved items become `ASSUMPTION` lines in the document.
8. **Draft scenarios** from `template.md`. A scenario must be runnable by an agent that has only a browser. Anything that needs a shell, files or several processes goes under "Manual / not browser-testable" with the reason.
9. **Verify steps** (the correctness gate, below). Fix, then re-check.
10. **Save and hand off.** Write the file, summarize the open assumptions and concerns, and offer `duckwright plan <file> -p`.

## Step verification (gate before saving)

For every scenario:

1. **Reachable:** each route, control, label or flag it uses exists in the code, or in a plan task that creates it. Cite the file or task in the scenario's `Source`.
2. **One action per step,** with exact input. No "etc." or "as appropriate".
3. **Observable results:** each expected line is something visible from outside, quoted from the spec character for character.
4. **Self-contained:** preconditions name test data from the Test data section. No scenario depends on another's leftovers unless its preconditions say so.
5. **Ordered correctly:** setup comes before use. Anything the scenario creates is either reset by the Environment section or cleaned up by the scenario.

For the document as a whole:

6. **Coverage:** every inventory row appears in the Coverage table with at least one scenario. Every error row in the spec has its own scenario. Each limit the spec names is tested at the limit and one past it.
7. **No invention:** no scenario asserts behavior that is not in the spec. Where the spec is silent, the scenario tests the defined part and adds a `CONCERN`.
8. **Plan-mode ready:** shared setup is identical across scenarios that need it, and setup a person must do is listed under Environment, not buried in steps.

## Template

Same sections as existing plans (see `docs/superpowers/test-plans/2026-10-10-exploration-mode-explore-test-plan.md`), plus a Source on each scenario and two sections for honesty.

```markdown
# <Feature> QA Test Plan

**Goal:** <one sentence>
**Spec:** <repo-relative path>
**Implementation plan:** <repo-relative path>
**Scope:** Black-box browser scenarios against the spec. Unit and integration tests are not repeated here.

## Environment
- Start: `<command>` → <base URL>
- Accounts / auth: <how to get a user or auth state>
- Reset: <how to return to a clean state between scenarios>
- Before you run: <setup a person must do; the browser agent cannot>

## Test data
- **NAME:** <exact values, referenced by name below>

## Assumptions and open questions
- ASSUMPTION: <what was assumed, why, and the question that was not answered>
- CONCERN: <spec/plan/code disagreement or gap, and how the scenario handles it>

## Coverage
| Behavior | Spec | Plan task | Scenarios |
| --- | --- | --- | --- |

## Scenarios
### TS-1: <what is being proved>
**Behavior:** B1 · **Priority:** P1 | P2 | P3 · **Source:** spec §<n>, plan Task <n>, `<code path>`
**Preconditions:** <state and test data, by name>
**Steps:**
1. <one action, exact input>
**Expected:**
- <observable result, exact value>

## Regression
<TS scenarios for existing surfaces the change touches, or "None">

## Manual / not browser-testable
- <behavior> — <why a browser-only agent cannot run it>

## Out of scope
- <from the spec>
```

Priority rule: P1 is the happy path of every success criterion, P2 is each error row and boundary, P3 is the rest.

## Question bank (`questions.md`)

Grouped by what blocks a correct step. Each entry has the question, when to ask it (the trigger), and a default to recommend.

- **Reach:** how to start the app, URL and port, how to get an account, whether auth state or 2FA is involved.
- **Data:** how to seed and reset, the exact values to use, whether a write is safe against this environment.
- **Behavior gaps:** the spec is silent on a boundary, an error message, or an empty, loading or error state.
- **Conflict:** spec vs plan, or spec vs code. Which one is right?
- **Scope:** which existing surfaces need regression, and how deep to go (smoke or exhaustive).
- **Limits:** a scenario needs more than a browser. Skip it, split it, or mark it manual?

Rules for asking:

- Do not ask what the spec, plan or code answers. Read first.
- One decision per question, with a recommended default as the first option.
- At most 4 questions per round, 2 rounds. After that, write assumptions.

## Error handling

- No spec or no plan found: ask for the path. Do not proceed on one alone.
- Plan has no task touching a user-facing surface: write only the Regression and Manual sections, and say why.
- Code unreadable or too large to follow: cite the plan instead, mark the step `UNVERIFIED` in the scenario, and add a `CONCERN`.

## Testing the skill

Per `superpowers:writing-skills`, no skill without a failing baseline.

1. **Baseline (RED):** on a repo spec+plan pair that has a hand-written test plan (start with `2026-10-09-environment-context`), run a fresh agent with the same request and no skill. Record what it gets wrong: missing coverage, invented behavior, steps against controls that do not exist, no questions asked.
2. **With skill (GREEN):** run the same pair with the skill and compare against the baseline and the hand-written plan.
3. **Second pair (generalization):** run a different pair (for example `2026-10-10-debug-mode-prompt-logging`) to confirm the workflow is not tuned to one feature.
4. **Refactor:** close each gap found, then re-run.

Pass condition: every behavior in the hand-written plan's Coverage table is covered, no scenario asserts anything the spec does not define, and the step gate catches at least one planted bad step (a route that is not in the code).
