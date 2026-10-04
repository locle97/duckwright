# TypeScript migration: parity check

Run on 2026-10-04 in a Claude Code cloud container, model `sonnet` (the default), snapshot mode `hybrid` (the default), with `--export`. Both versions ran back to back on the same machine, each with its own `--session`.

## Live e2e (`DUCKWRIGHT_E2E=1 node --test test/e2e.test.ts`)

| Mode | Result | Steps | Cost |
| --- | --- | --- | --- |
| full | pass | 4 | $0.0741 |
| grep | pass | 3 | $0.0771 |
| hybrid | pass | 4 | $0.0402 |

In two of the runs the agent first wrote an `expect` without its ref. The harness rejected it and refused the `done success` that followed, and the agent fixed the call on the next step.

## Benchmark tasks (`-f benchmark_tasks/ --export`)

| Task | TypeScript | Python (legacy) | Exported spec passes `npx playwright test` |
| --- | --- | --- | --- |
| 01-todomvc | pass, 8 steps, $0.1215 | pass, 8 steps, $0.1276 | both |
| 02-books-travel | pass, 4 steps, $0.0769 | pass, 5 steps, $0.1003 | both |
| 03-quotes-einstein | pass, 4 steps, $0.0640 | pass, 4 steps, $0.0668 | both |
| 04-tables-sort | pass, 3 steps, $0.0528 | pass, 3 steps, $0.0523 | both |
| 05-saucedemo-checkout | pass, 10 steps, $0.1693 | pass, 10 steps, $0.1680 | both |
| 06-wikipedia-python | pass, 2 steps, $0.0304 | pass, 2 steps, $0.0301 | both |
| **Total** | 6/6, $0.5148 | 6/6, $0.5451 | 12/12 |

Pass/fail is the same for every task. Step counts and costs are within normal run-to-run variation.

## Environment notes

These two changes were needed in this container only. Neither one is part of the repository.

- `playwright-cli` looks for Google Chrome by default. A local `.playwright/cli.config.json` pointed it at the preinstalled Chromium (`{"browser": {"browserName": "chromium", "launchOptions": {"executablePath": "/opt/pw-browsers/chromium"}}}`).
- The container's HTTPS proxy CA was added to Chromium's NSS store (`certutil -d sql:$HOME/.pki/nssdb -A -t "C,," ...`). Before that, every HTTPS site failed with `ERR_CERT_AUTHORITY_INVALID` in both versions. The agent declined to click through the warning and fell back to HTTP where a site offered it.
