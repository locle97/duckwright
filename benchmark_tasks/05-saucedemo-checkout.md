---
# Benchmark: a long multi-page flow (login, cart, checkout form, confirmation).
# standard_user / secret_sauce are the public credentials shown on the demo's login page.
# Expected answer: Item total $39.98, Tax $3.20, Total $43.18, then the order confirmation.
max-steps: 25
---
Open https://www.saucedemo.com/ and log in with username "standard_user"
and password "secret_sauce".
Add "Sauce Labs Backpack" and "Sauce Labs Bike Light" to the cart.
Open the cart and check that it holds exactly those two items.
Check out with first name "Linh", last name "Le" and postal code "70000".
On the overview page, report the item total, tax and total.
Finish the order and check that the page says "Thank you for your order!".
