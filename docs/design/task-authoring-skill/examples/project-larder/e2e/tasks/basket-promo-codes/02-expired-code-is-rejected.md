---
# duckwright-tasks: basket promo codes, scenario BSK-2 (written 2026-10-15; review before committing)
# sources: user request; testing map R1 R3 R4 R8 R9 and seed tables; app/src/i18n/en.json coupon.expired; sitemap /products /cart
# derived: subtotal $4.00, no discount, delivery $3.99 (under $20.00), total $7.99
env: local
state: ../../.auth/shopper-b.json
setup: shared/setup.md
max-steps: 25
---
# BSK-2: An expired code is rejected and the total does not change

Preconditions:
- Signed in as shopper B by the state file. The basket starts empty (shared setup).

Steps:
1. Open http://localhost:3000/products, open "Sourdough Loaf" and click "Add to basket".
2. Open http://localhost:3000/cart.
3. Type SPRING24 in the "Promo code" field and click "Apply".

Expected results:
- The message under the "Promo code" field reads "This code has expired.".
- The Apply call POST /api/cart/coupon returned 422.
- There is no "Discount" row, and "Total" shows $7.99.
