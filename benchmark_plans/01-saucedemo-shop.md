# Test plan: Swag Labs shop

**App:** https://www.saucedemo.com/ (public demo shop)
**Version under test:** current production demo

## Environment

- Make sure your machine can reach www.saucedemo.com. On the office network, turn the corporate proxy off first.
- Any recent desktop browser. No test data needs loading: the demo resets itself on every login.

## Test account

Unless a scenario says otherwise, log in with username `standard_user` and password `secret_sauce`. Every scenario starts from the login page at https://www.saucedemo.com/ and logs in with this account.

## Scenarios

### SD-1: Sort products by price

1. On the Products page, choose "Price (low to high)" in the sort menu.
2. Read the first and the last product in the list.

**Expected:** the first product is "Sauce Labs Onesie" at $7.99 and the last is "Sauce Labs Fleece Jacket" at $49.99.

### SD-2: Cart badge follows adds and removes

1. Add "Sauce Labs Backpack" to the cart.
2. Add "Sauce Labs Bolt T-Shirt" to the cart.
3. Remove "Sauce Labs Backpack" with its "Remove" button on the Products page.

**Expected:** the cart badge shows 1, 2, then 1 after each step. The cart holds only "Sauce Labs Bolt T-Shirt".

### SD-3: Checkout totals

Precondition: the cart is empty.

1. Add "Sauce Labs Backpack" and "Sauce Labs Bike Light" to the cart.
2. Open the cart and press "Checkout".
3. Fill in first name "Linh", last name "Le", postal code "70000" and press "Continue".
4. Press "Finish".

**Expected:**
- The overview shows Item total: $39.98, Tax: $3.20, Total: $43.18.
- After Finish the page says "Thank you for your order!".

### SD-4: Checkout needs a first name

1. Add "Sauce Labs Fleece Jacket" to the cart.
2. Open the cart, press "Checkout", leave every field empty and press "Continue".

**Expected:** the error "Error: First Name is required" is shown and the page stays on the information step.

### SD-5: Order emails reach the warehouse

1. Place an order as in SD-3.
2. On the warehouse server, run `tail -n 50 /var/log/orders.log` and check the order id is there.

**Expected:** the log has one line with the new order id.
