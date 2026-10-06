---
# Benchmark: broken access control / IDOR (security testing), plus a direct `request` API call.
# Target: a LOCAL OWASP Juice Shop instance, an app built by OWASP specifically to be probed this
# way. Start it first with the docker-compose.yml next to this file:
#   docker compose -f benchmark_tasks/juiceshop-compose.yml up -d
# then point duckwright at this task once http://localhost:3000/ answers.
# NOT VERIFIED LIVE: I could not pull the image in this sandbox (Docker Hub rate-limited every
# attempt), so this task is written from Juice Shop's own documented IDOR, not from a run I watched
# end to end. Before trusting the "expected answer" below, run it once by hand and fix the numbers.
#
# The bug (OWASP Juice Shop's "Basket Access" IDOR, challenge category "Broken Access Control"):
# every basket has a numeric id, assigned in registration order. A logged-in user's own basket id
# is visible in the app's own network calls (GET /rest/basket/<id> when the cart page loads). The
# API does not check that the basket id in the URL belongs to the caller, so requesting a
# neighbouring id returns another account's basket contents.
# Expected answer: the agent's own basket starts empty (status 200, "products":[]); basket id 1
# (the shop's seeded admin/default account, almost always the very first basket) returns a
# different id in its response and is NOT empty when the seeded demo data includes seeded items -
# if it also shows empty on your instance, note that honestly instead of inventing items in the answer.
# Check by hand: two `request` results in history.json, both "ok 200", with different "id" values in
# the (redacted) excerpts; the step with the IDOR check must come before any further page
# interaction, or `duckwright export` will refuse the run.
max-steps: 15
---
Go to http://localhost:3000/ and dismiss the welcome banner and the cookie notice if they appear.
Register a new account with a throwaway email and a password of your choice, then log in with it.
Open your own shopping basket from the page (even though it is empty) so the app's own call to the
basket API is captured.
Right after that step, before clicking anything else, use request to call GET on your own basket
endpoint (the path you just saw in the network calls) and note the numeric "id" field in the
response.
In the same step, still before any other interaction, use request again to call GET on the basket
endpoint for id 1 instead of your own id, and note whether it succeeds and what "id" value its
response reports.
Report: your own basket's id and whether it was empty, and basket id 1's status and whether its
reported id and contents differ from your own basket (showing you were able to read another
account's basket by changing the id).
