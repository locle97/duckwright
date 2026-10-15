---
# duckwright-tasks: basket promo codes, scenario BSK-4 (written 2026-10-15; review before committing)
# sources: user request; testing map R1 R3 R4 R7 R8 R9 and seed tables; sitemap /cart; fact f-866975 f-c2af40 f-63f94f
# observed: the control is "Remove code" and removing calls DELETE /api/cart/coupon (probe runs/20261015-142210-basket-coupon-remove, 2026-10-15)
# derived: Sourdough Loaf $4.00, no discount, delivery $3.99 (under $20.00), total $7.99
env: local
state: ../../.auth/shopper-a.json
setup: shared/setup.md
max-steps: 25
---
# BSK-4: Removing an applied code brings the total back

Preconditions:
- Signed in as shopper A by the state file. The basket starts empty with no code applied (shared setup).

Steps:
1. Open http://localhost:3000/product/sourdough-loaf and click "Add to basket".
2. Open http://localhost:3000/cart.
3. Type SAVE10 in the "Promo code" field and click "Apply".
4. Click "Remove code".

Expected results:
- The Remove call DELETE /api/cart/coupon returned 200.
- There is no "Discount" row, and "Total" shows $7.99.
