<!-- Sample environment context. Copy to environments/staging.md and edit.
     Use it with: duckwright --env staging "<task>"
     Delete this comment after copying.
     Keep it under 16 KB. Never put real passwords or tokens here. -->

# Staging

## Base URL

https://staging.example.com (the API is at https://api.staging.example.com)

## Test accounts

Log-in accounts (ids, usernames, passwords, TOTP secrets) are kept on the
Environments page of the web UI, not in this file. See "Accounts" in the README.
Do not write a password here.

- member: already logged in by `--state auth.json`

## Seeded data

- Project "Demo" with 3 tasks; customer "Acme Ltd" with 2 orders.

## Feature flags

- new-checkout: on
- beta-dashboard: off

## Known quirks

- Emails arrive 1 to 2 minutes late.
- The first page load after midnight UTC is slow.

## Off-limits

- Do not delete projects or customers.
- Do not use the billing page.
