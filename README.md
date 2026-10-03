# pw_agent

A browser-use style agent loop built on `playwright-cli` and `claude -p`.

## Install

- Python >= 3.11 (standard library only), plus `pytest` for tests
- Playwright CLI and its skill:
  ```
  npm i -g @playwright/cli@latest
  playwright-cli install --skills
  ```
- Claude Code CLI (`claude`) on your PATH, logged in

## Usage

```
python3 -m pw_agent "<task>" [--max-steps N] [--model M] [--headed]
                             [--skill PATH] [--session NAME] [--allow-file-access]
```

- `--max-steps` (default 25), `--model` (default `sonnet`)
- `--headed` shows the browser window
- `--skill` path to the playwright-cli skill (default `.claude/skills/playwright-cli/SKILL.md`)
- `--session` playwright-cli session name (default `pw-agent`)
- `--allow-file-access` permit `file://` URLs (blocked by playwright-cli by default). This only takes effect when the session's browser is first opened, so close any existing session first

Each step's history line is printed live, followed by the result, answer, step count and cost.
A run directory `runs/<timestamp>/` holds `snapshot.yml` and `history.json`.
Exit code: 0 on success, 1 on failure, 2 on a failed preflight check (missing skill, `claude` or `playwright-cli`).

## Architecture

The harness owns the loop, not the model. Each step it takes a `playwright-cli snapshot`,
asks `claude -p` (all tools disabled) for one structured decision (evaluation, memory,
next goal, and a list of commands), validates the commands against an allow-list, executes
them through `playwright-cli`, and appends a compact line to the history that feeds the next
prompt. The loop ends on a `done` action, max steps, or repeated failures, and the browser
is always closed.

## Tests

```
python3 -m pytest                                   # unit tests
PW_AGENT_E2E=1 python3 -m pytest tests/test_e2e.py -v -s   # live e2e: real claude + headless browser
```
