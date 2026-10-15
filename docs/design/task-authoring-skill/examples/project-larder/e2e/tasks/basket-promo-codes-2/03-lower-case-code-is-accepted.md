---
# duckwright-tasks: basket promo codes, scenario BSK-6 (written 2026-10-15; review before committing)
# sources: user request; user in conversation 2026-10-15 ("codes should be case-insensitive; that is LAR-412"), recorded as fact f-bd3a82; testing map R1 R3 R4 R8 R9 and seed tables
# observed: today the app answers "This code is not valid." (probe runs/20261015-142210-basket-coupon-remove); this task checks the intended behaviour and fails until LAR-412 is fixed
# derived: Free-range Eggs (12) $3.75, 10% off = $0.38 discount (rounded), delivery $3.99, total $7.36
# assumption: the discount rounds half up to the cent, as for SAVE10 in BSK-1
env: local
state: ../../.auth/shopper-c.json
setup: shared/setup.md
max-steps: 20
---
# BSK-6: A promo code typed in lower case works like the upper-case code

Preconditions:
- Signed in as shopper C by the state file. The basket starts empty with no code applied (shared setup).

Steps:
1. Open http://localhost:3000/product/free-range-eggs-12 and click "Add to basket".
2. Open http://localhost:3000/cart.
3. Type save10 in the "Promo code" field and click "Apply".

Expected results:
- The message under the "Promo code" field reads "Promo code applied.".
- The Apply call POST /api/cart/coupon returned 200.
- "Total" shows $7.36.
