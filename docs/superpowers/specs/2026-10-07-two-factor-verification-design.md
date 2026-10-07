# Two-factor verification: design

Date: 2026-10-07 · Branch: `claude/great-clarke-sdie1u`

## Summary

A run can get past a 2FA prompt. A new `twofa` action tells the harness that the page is asking for a verification code or a passkey approval. The harness, not the model, obtains the code and submits it:

- **TOTP:** the code is generated from a secret the user supplies (`DUCKWRIGHT_TOTP_SECRET`, or typed when first needed).
- **SMS and email:** the run pauses and asks the human for the code.
- **Passkey:** the run pauses and asks the human to approve on their device.

It works in print mode and in `--tui`. The secret and every code stay out of `history.json`, `events.jsonl`, `network/`, prompts and the exported spec.

## Intent

- **Goal:** let an agent run, and the regression test exported from it, get past a login that has 2FA.
- **Constraints (user-stated):** TOTP codes come from a user-supplied secret and are never recorded in `history.json`. SMS, email and passkeys pause the run and ask the human. Print mode and TUI mode must both work.
- **Decisions made with the user:**
  - Secret source: a single env var, with a prompt on first need as the fallback (not a flag, not named secrets).
  - Agent interface: a dedicated `twofa` action (not placeholders in `fill`, not harness-side detection).
  - Export: TOTP becomes an inline helper in the spec; SMS, email and passkey become marked manual steps (option C).
  - No human attached: fail fast. Human attached: wait up to a timeout (default 5 minutes).
  - Architecture: an injected `TwoFactor` provider (approach 1).
- **Success:** `duckwright "log in to the demo app"` with `DUCKWRIGHT_TOTP_SECRET` set completes a TOTP login unattended. The same task with an SMS code asks on the terminal in print mode and in a dialog in the TUI, then continues. A grep of every file the run wrote finds neither the secret nor any code.

## Decisions

| # | Topic | Decision |
|---|---|---|
| D1 | Action shape | `{"cmd":"twofa","args":[KIND, ref]}` for `KIND` in `totp`, `sms`, `email` (`ref` is the snapshot ref of the code field), and `{"cmd":"twofa","args":["passkey"]}`. The model never sees or types a code. |
| D2 | Static checks (`rejection()`) | `args[0]` must be one of `totp`, `sms`, `email`, `passkey`. The first three need exactly one more arg, a non-empty string that matches the snapshot ref pattern used by other element commands. `passkey` takes none. Each failure has its own `error: ...` string. Like `expect`, the args never reach playwright-cli as given. |
| D3 | Execution (code kinds) | Get the code from the provider, then run `playwright-cli fill <ref> <code> --submit`. The result string is `ok` or an `error:` and never contains the code. The code is passed to the child process as an argument only, never logged. |
| D4 | Execution (passkey) | Ask the provider for an approval, then return `ok`. No browser command is run. The agent re-reads the page on its next step. |
| D5 | Page-changing | `twofa` is added to `PAGE_CHANGING`. Actions after it in the same step are skipped, so the agent re-reads the page. |
| D6 | Loop cap | At most 5 `twofa` actions per run. The 6th returns `error: too many 2FA attempts in this run`. This stops loops on a page that keeps rejecting the code. |
| D7 | Provider | `interface TwoFactor { totp(signal): Promise<string>; askCode(kind: "sms" \| "email", signal): Promise<string>; askApproval(signal): Promise<void> }`. The run is given one through `RunDeps` and `AgentOptions`, like `createAgent`. The agent loop and `execute()` know only this interface. Tests pass a fake. |
| D8 | TOTP generation | `src/totp.ts`: RFC 6238, HMAC-SHA1, 30-second step, 6 digits, `node:crypto` only, no new dependency. It accepts a base32 secret (spaces and case ignored, padding optional) or an `otpauth://totp/...?secret=...` URI. Invalid input throws a `TotpSecretError` whose message never includes the secret. |
| D9 | Secret source | `DUCKWRIGHT_TOTP_SECRET`, read once at run start. If unset, the first `twofa totp` asks the human for the secret (hidden or masked input) and keeps it in memory for the rest of the run only. It is never written to disk or to the environment. |
| D10 | Preflight | If `DUCKWRIGHT_TOTP_SECRET` is set but invalid, the run exits `2` before the browser opens, with `DUCKWRIGHT_TOTP_SECRET is not a valid TOTP secret`. In a batch the check runs once, before the first task. |
| D11 | Scrubber | A per-run `Scrubber` holds the secret and every code the provider has returned. `scrub(text)` replaces each value with `[2FA CODE]` (codes) or `[REDACTED]` (the secret). It is applied to the recorded Playwright `code` for the fill, to action results, and to everything written to `history.json`, `events.jsonl` and `network/`, and to the prompt text built for the next step, in case a page echoes a code back. Codes shorter than 4 characters are not scrubbed from free text, to avoid mangling unrelated output. |
| D12 | Recorded action | `history.json` stores `{cmd:"twofa", args:["sms","e12"], code:<fill line with the code replaced by "[2FA CODE]">}`. For `passkey` and for failed actions `code` is `null`. The result is `ok` or an `error:`. |
| D13 | Print mode, with a TTY | The prompt goes to stderr so stdout stays clean. Codes are read as a line. The secret is read with echo off. A passkey prompt says to approve on the device and press Enter. In a batch the prompt names the task, for example `[2/3] tasks/b.md: SMS code?`. Tasks run one at a time, so prompts never interleave. |
| D14 | Print mode, no TTY | Uses the existing `isTTY()` in `cli.ts`. Without a TTY every human-needed call returns `error: no way to ask for a code (stdin is not a terminal)` at once. `totp` still works unattended when the env secret is set. |
| D15 | Wait and timeout | A human wait lasts at most `--twofa-timeout <sec>` (default 300, also a task-file setting). On timeout the action returns `error: timed out waiting for the 2FA code`. Ctrl-C in print mode aborts the whole run through the existing `AbortSignal`: exit `130`, `history.json` still written. |
| D16 | TUI provider | The TUI never reads stdin directly, because Ink owns it. Its provider emits `twofa:wait` (kind, task id, deadline) and awaits an answer. `runs/manager.ts` keeps the pending request on that run's state and exposes `answerTwoFactor(id, value \| null)`. `null` is cancel and returns `error: cancelled` for that action, and the run continues. |
| D17 | TUI presentation | The sidebar marks a waiting run "needs input". Other runs keep going. A modal dialog, in the style of `dialog.ts`, `form.ts` and `confirm.ts`, takes the answer: masked input for codes and the secret, approve or cancel for a passkey. Typed characters are never put in TUI state, the event log or the timeline. A second request while a dialog is open queues. The timeline shows `twofa sms e12 → ok` with no code. |
| D18 | Events | `RunEvents` gains `twofa:wait` (`kind`, `deadline`) and `twofa:done` (`outcome`: `answered`, `cancelled` or `timeout`). Neither carries a value. Print mode ignores both. |
| D19 | Export (`totp`) | `renderSpec` emits one small inline helper (RFC 6238 via `node:crypto`, about 15 lines) that reads `process.env.DUCKWRIGHT_TOTP_SECRET` and throws a clear error if it is unset. The step becomes `await <locator>.fill(totp()); // 2FA`, with the locator derived from the recorded fill code, as for `fill` today. The spec contains no code and no secret. |
| D20 | Export (`sms`, `email`, `passkey`) | Each becomes a marked manual step: `// MANUAL: enter the <kind> code here` (or `approve the passkey prompt`) followed by `await page.pause();`. The spec gets a header comment saying it cannot run unattended. A warning names the steps. |
| D21 | Export edge cases | `exportApi.ts` (`--api`) ignores `twofa` steps. A `twofa` step with no usable recorded code (other than `passkey`) fails the export with a message naming the step, like other actions. A failed `twofa` is skipped with a warning. |
| D22 | System prompt | `prompts/system.md` adds `twofa` to the command list and a short section: use it when the page asks for a verification code, authenticator code or passkey. Give the kind and the field ref. Never type or guess a code with `fill`. The page may change afterwards, so re-read it. |
| D23 | Schema | `DECISION_SCHEMA` gets a branch for `twofa` (`args` of 1 to 2 strings, with `contains: {enum: [totp, sms, email, passkey]}`). `ALLOWED_COMMANDS` gains `twofa`, and the generic branch's filter excludes it. |
| D24 | Docs | The README gets a "Two-factor verification" section: the env var, the prompts in each mode, `--twofa-timeout`, the export behaviour and the security note. The existing warning about `code` containing typed secrets gets a line saying 2FA codes are the exception. |

## Errors

All are returned as the action's `error:` result so the agent can react, and none change the exit code by themselves, except the preflight (D10) and print-mode Ctrl-C (D15).

| Case | Result |
|---|---|
| No TTY and no env secret, or no human available | `error: no way to ask for a code (stdin is not a terminal)` |
| Wait timed out | `error: timed out waiting for the 2FA code` |
| TUI cancel | `error: cancelled` |
| Invalid secret typed at the prompt | `error: not a valid TOTP secret` (never includes the secret) |
| Page rejects the code | Not a harness error. The agent sees the page and may retry, within D6. |
| More than 5 `twofa` actions | `error: too many 2FA attempts in this run` |

## Testing

- `test/totp.test.ts`: RFC 6238 SHA-1 vectors, base32 and `otpauth://` parsing, invalid input, and that error messages omit the secret.
- `test/scrubber.test.ts`: values replaced in nested JSON, strings and `code` fields. Short codes are not over-matched.
- `test/actions.test.ts`: arg validation per kind, page-changing skip, the loop cap, and results that never contain the code. A fake provider drives the action path.
- `test/export.test.ts`: fixtures for the TOTP helper and the manual-step placeholders, the header comment, and the failed-step and no-code cases.
- Print mode (`test/cli.test.ts`): a fake TTY provider covers the prompt, hidden input, timeout and the no-TTY fallback, plus the preflight exit `2`.
- TUI (`test/tui/`): state and manager tests for `twofa:wait` and `answerTwoFactor`, queueing, cancel and the sidebar marker. Rendering tests cover the masked dialog, and a test checks that typed characters never reach state or the event log.
- Leak test, end to end with a fake brain: run a `twofa totp` task and a `twofa sms` task, then search `history.json`, `events.jsonl`, `network/`, the exported spec, and captured stdout and stderr for the secret and the codes. Nothing may match.

## Out of scope

Multiple named secrets, secrets in task files, a `--totp-secret` flag, push-notification approvals other than passkeys, and harness-side detection of 2FA pages.
