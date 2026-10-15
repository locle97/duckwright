---
# Larder testing map. Read by the duckwright-tasks skill and by people writing tasks by hand.
# Flat key: value lines, same syntax as Duckwright task-file front matter.
default-env: local
write-envs: local
investigate-envs: local
data-prefix: RT-
off-limits-terms: /admin/users, Delete account, Refund, Stripe dashboard
allow-literals: larder-local-only, 4242 4242 4242 4242
---
# Larder testing map

Rules for writing Duckwright task files for Larder. Runtime facts the agent needs during a run
(base URL, accounts, quirks) are in `environments/local.md`, not here.

## Environments

- `local` (`environments/local.md`): http://localhost:3000 on a developer machine or in CI, seeded by
  `npm run db:seed`. Tasks may create data here.
- `staging`: shared, read-only for Duckwright, and not in `investigate-envs`: no probes there. No task that creates an order, a basket item or an account
  may name `env: staging`. There is no staging env file in this repo yet.

## Auth

- R1. Log in with a state file, never through the sign-in form, except in tasks under `tasks/auth/`
  that test signing in. Put the state file in the task's front matter (`state:`, relative to the task file).

  | Role | Account | State file (under `e2e/`) | How a person makes it |
  | --- | --- | --- | --- |
  | shopper A | shopper-a@larder.test | `.auth/shopper-a.json` | `npm run e2e:auth -- shopper-a` |
  | shopper B | shopper-b@larder.test | `.auth/shopper-b.json` | `npm run e2e:auth -- shopper-b` |
  | shopper C | shopper-c@larder.test | `.auth/shopper-c.json` | `npm run e2e:auth -- shopper-c` |
  | admin | admin@larder.test | `.auth/admin.json` | `npm run e2e:auth -- admin` (asks for a TOTP code) |

- R2. Sign-in tests use `login-test@larder.test` with the seed-only password `larder-local-only`
  (local only; it is in `allow-literals`). Admin sign-in has TOTP: write "complete the authenticator
  step" and add the note "set DUCKWRIGHT_TOTP_SECRET for unattended runs".
- R3. Every task with a state file says: if the page shows the "Sign in" form, finish with failure
  "state expired: recreate <state file>".

## Test data

Seeded by `npm run db:seed` (source: `app/prisma/seed.ts`):

| Product | Price |
| --- | --- |
| Oat Milk 1L | $2.50 |
| Sourdough Loaf | $4.00 |
| Free-range Eggs (12) | $3.75 |

| Coupon | Effect | State |
| --- | --- | --- |
| SAVE10 | 10% off the subtotal | active |
| SPRING24 | 15% off | expired |
| FREESHIP | delivery free, subtotal of $20.00 or more | active |

- Delivery is $3.99 when the subtotal (after discount) is under $20.00, else free.
  Total = subtotal - discount + delivery. Money is shown as `$0.00`.
- R4. The basket belongs to the account. Tasks in one folder that use the basket get different shopper
  accounts, A, B, C in turn. A folder with more than 3 basket tasks gets the note
  "run with --max-parallel 1: tasks share a shopper account".
- R5. Anything a task creates (addresses, lists, reviews) is named `RT-<task id>-...`, for example
  `RT-CHK1-home`, and the task deletes it at the end. Orders cannot be deleted; that is fine on `local`.
- R6. A task must not depend on another task having run. Start from the seeded state and empty the
  basket first (the shared setup does this).

## Setup: UI or API

- R7. Set up the basket through the UI ("Add to basket" on a product page). Do not use `request` for
  setup: the endpoints Larder calls on page load are GETs only, and a `request` for a POST that was first
  seen after a click makes `duckwright export` refuse the run.

## What the UI calls things

- The basket page is "Basket" at `/cart`. Product pages are `/product/<slug>`, reached from `/products`.
- Buttons: "Add to basket", "Remove", "Checkout", "Place order". Coupon field: "Promo code" with an
  "Apply" button. Totals rows: "Subtotal", "Discount", "Delivery", "Total".
- Messages are in `app/src/i18n/en.json` under `coupon.*`, `basket.*` and `checkout.*`. Quote them exactly.

## How to check results

- R8. Every task checks at least one visible text, value or URL, and every action that calls the API
  also gets an API check: method, path, status. Known calls:
  `POST /api/cart/coupon` (200 applied, 422 rejected), `POST /api/cart/items` (201), `POST /api/orders` (201).
- R9. Money is checked as the exact string shown, for example "$12.09". A value worked out from the
  tables above is marked in front matter with `# derived: ...`.
- R10. Never check generated values exactly (order numbers, dates, ids). Check that the text contains
  "Order #".

## Needs a person (plan notes, not task steps)

- `npm run db:seed` in `app/` before a plan that relies on seed data (it resets coupons and baskets).
- Creating the state files (table above).
- Emails: there is no mail catcher on `local`, so scenarios that read an email are skipped.
- Payments: the card form takes the Stripe test card 4242 4242 4242 4242, expiry 12/34, CVC 123, on `local` only.

## Naming

- Folder `tasks/<feature>/`, files `NN-<what-it-checks>.md`, heading `# <ID>: <title>`.
- IDs: CHK checkout, BSK basket, ACC account, ADM admin, AUTH sign-in. Numbered within the folder.

## Off-limits

- Changing anything under /admin/users, "Delete account", refunds, the Stripe dashboard link in admin.
