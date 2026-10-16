# history.json, as this skill needs it

Where it lives: `runs/<id>/history.json`, or for a plan task `tasks/<plan>/<task>/history.json` (folder named
like the task file, only the latest run kept). Beside it: `events.jsonl`, screenshots, optional video, and
`duckwright.spec.ts` (the flat export of a successful run).

Top level: `task` (full task text), `task_file`, `env {name,path}`, `success`, `answer`, `steps`,
`cost_usd`, `history[]`.

Each `history[]` step: `next_goal`, `memory`, `actions[] {cmd, args, code}`, `results[]` (parallel to
actions; `ok` or `error: ...`), optional `network[]`, `request_origins[]`, `page {url,title}`.

`actions[].code` is the Playwright code `playwright-cli` ran, or null.

| cmd | Meaning for a test |
| --- | --- |
| goto, click, fill, type, press, select, check, uncheck, dblclick, hover, drag, go-back | UI step; `code` is replayable |
| expect | Assertion the harness verified on the live page: keep |
| expect-request | API check (method, path or URL, status, optional JSON field): becomes `page.waitForResponse(...)` armed in the step before |
| request | Setup call (`page.request.fetch`); only valid before the first UI action besides `goto`; needs cookies in the test context |
| twofa | `totp` replays via `DUCKWRIGHT_TOTP_SECRET`; sms/email/passkey are manual |
| tab-new, tab-select, tab-close | No code: hand-edit, tests assume one `page` |
| note, snapshot, screenshot, wait, done | Not test steps (`done` carries the verdict) |

Facts to remember:
- Only `success: true` runs are convertible.
- A run started with a state file leaves no sign-in code; the test must load the project's auth itself.
- `code` holds whatever the agent typed, passwords included. Typed 2FA codes are masked `[2FA CODE]`.
- Network values may be `[REDACTED]`; never rebuild them.
- Duckwright's own `duckwright export RUN -o FILE` renders the flat spec if a starting draft helps.
