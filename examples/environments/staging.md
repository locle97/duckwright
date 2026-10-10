---
login:
  method: script
  url: https://staging.example.com/login
  username-env: STAGING_USER
  password-env: STAGING_PASSWORD
  username-selector: "#email"
  password-selector: "#password"
  submit-selector: "button[type=submit]"
  check-url: https://staging.example.com/account
  check-text: Sign out
---
<!-- Sample environment context. Copy to environments/staging.md and edit.
     Use it with: duckwright --env staging "<task>"
     Delete this comment after copying.
     Keep it under 16 KB. Never put real passwords or tokens here. -->

# Staging

## Base URL

https://staging.example.com (the API is at https://api.staging.example.com)

## Test accounts

- admin: the account in STAGING_USER; Duckwright logs in with it automatically (see the `login:` block at the top). Its password is in STAGING_PASSWORD
- member: member@example.com, not used by the automatic login

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
