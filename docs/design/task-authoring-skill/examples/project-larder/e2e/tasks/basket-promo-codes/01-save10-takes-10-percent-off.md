---
# duckwright-tasks: basket promo codes, scenario BSK-1 (written 2026-10-15; review before committing)
# sources: user request; testing map R1 R3 R4 R8 R9 and seed tables; app/src/i18n/en.json coupon.applied; sitemap /products /cart
# derived: subtotal 2 x $2.50 + $4.00 = $9.00; discount 10% = $0.90; delivery $3.99 (under $20.00); total $12.09
env: local
state: ../../.auth/shopper-a.json
setup: shared/setup.md
max-steps: 30
---
# BSK-1: SAVE10 takes 10% off the subtotal

Preconditions:
- Signed in as shopper A by the state file. The basket starts empty (shared setup).

Steps:
1. Open http://localhost:3000/products and open "Oat Milk 1L".
2. Click "Add to basket" twice.
3. Open http://localhost:3000/products again, open "Sourdough Loaf" and click "Add to basket" once.
4. Open http://localhost:3000/cart.
5. Type SAVE10 in the "Promo code" field and click "Apply".

Expected results:
- The message under the "Promo code" field reads "Code SAVE10 applied.".
- The Apply call POST /api/cart/coupon returned 200.
- "Subtotal" shows $9.00, "Discount" contains $0.90, "Delivery" shows $3.99 and "Total" shows $12.09.
