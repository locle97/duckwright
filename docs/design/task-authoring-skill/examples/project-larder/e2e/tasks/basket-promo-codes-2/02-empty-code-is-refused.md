---
# duckwright-tasks: basket promo codes, scenario BSK-5 (written 2026-10-15; review before committing)
# sources: user request; testing map R1 R3 R4 R8 R9; fact f-fc9d48 (confirmed intended by the user 2026-10-15); app/src/i18n/en.json coupon.empty
# derived: Oat Milk 1L $2.50, no discount, delivery $3.99, total $6.49
env: local
state: ../../.auth/shopper-b.json
setup: shared/setup.md
max-steps: 20
---
# BSK-5: Apply with an empty field shows a message and changes nothing

Preconditions:
- Signed in as shopper B by the state file. The basket starts empty with no code applied (shared setup).

Steps:
1. Open http://localhost:3000/product/oat-milk-1l and click "Add to basket".
2. Open http://localhost:3000/cart.
3. Leave the "Promo code" field empty and click "Apply".

Expected results:
- The message under the "Promo code" field reads "Enter a promo code.".
- There is no "Discount" row, and "Total" shows $6.49.
