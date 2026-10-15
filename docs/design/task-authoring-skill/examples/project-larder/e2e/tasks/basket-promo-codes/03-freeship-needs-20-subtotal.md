---
# duckwright-tasks: basket promo codes, scenario BSK-3 (written 2026-10-15; review before committing)
# sources: user request; testing map R1 R3 R4 R8 R9 and seed tables; app/src/i18n/en.json coupon.minimum; sitemap /products /cart
# derived: subtotal $3.75 is under $20.00, so delivery stays $3.99 and total is $7.74
env: local
state: ../../.auth/shopper-c.json
setup: shared/setup.md
max-steps: 25
---
# BSK-3: FREESHIP is refused below a $20.00 subtotal

Preconditions:
- Signed in as shopper C by the state file. The basket starts empty (shared setup).

Steps:
1. Open http://localhost:3000/products, open "Free-range Eggs (12)" and click "Add to basket".
2. Open http://localhost:3000/cart.
3. Type FREESHIP in the "Promo code" field and click "Apply".

Expected results:
- The message under the "Promo code" field reads "Spend $20.00 to use this code.".
- The Apply call POST /api/cart/coupon returned 422.
- "Delivery" still shows $3.99 and "Total" shows $7.74.
