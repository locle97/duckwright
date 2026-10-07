# Benchmark plans

Written test plans on public demo sites, for checking [plan mode](../README.md#plan-mode): how the planner splits a plan, and how the planned tasks run. Each plan is written in a different style (sections, a numbered checklist, a table, bold paragraphs), and most have something the planner must keep out of the tasks: setup every scenario shares, steps only a person can do, and a scenario that needs more than a browser.

```bash
duckwright plan benchmark_plans/01-saucedemo-shop.md      # plan, review in the TUI, run
duckwright plan benchmark_plans/01-saucedemo-shop.md -p   # only write the task files
```

What a good split looks like:

| Plan | Tasks | Shared setup | Notes (for a person) | Skipped |
| --- | --- | --- | --- | --- |
| `01-saucedemo-shop.md` | SD-1 to SD-4 | open the shop, log in as `standard_user` / `secret_sauce` | turn the office proxy off | SD-5 (a shell command on a server) |
| `02-todomvc.md` | 1 to 6 | open the app | none | none |
| `03-the-internet.md` | TI-01 to TI-06 | open the base URL | confirm the site is up with the QA lead | TI-07 (opens a file from the Downloads folder) |
| `04-quotes-site.md` | Q1 to Q4 | log in at /login as `qa` | none | Q5 (runs a Python script) |

Things to check in the planned folder:

- No task repeats the shared setup's login steps, and every task file has `setup: shared/setup.md`.
- Concrete values survive: the user names, passwords, product names, prices and messages quoted in the plan.
- The expected results stay checkable on the page (for example SD-3's totals $39.98, $3.20 and $43.18).

Every scenario's expected result is written in its plan, so a run's answers can be checked against the plan itself. The plans read public sites, so a result can drift if a site changes.
