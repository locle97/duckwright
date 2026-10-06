---
# Benchmark: a direct `request` API call (GET) against a freshly generated REST endpoint, plus
# verifying a UI-triggered POST by reading the collection back.
# Target: https://crudcrud.com/, a public, free mock REST API made for exactly this kind of testing.
# No local setup needed; it is reachable from anywhere duckwright can make requests, and nothing
# needs to be started or torn down.
# How it works: every visit gets its own random endpoint id (set via a cookie and printed on the
# page as https://crudcrud.com/api/<id>), good for creating, reading, updating and deleting any
# "resource" you append to it. The page also has a "Click to create a unicorn" button that POSTs
# a fixed JSON record ({"name":"Sparkle Angel","age":2,"colour":"blue"}) to <endpoint>/unicorns.
# VERIFIED LIVE: curl against a real generated endpoint. GET <endpoint>/unicorns starts as "[]";
# after the POST, the same GET returns one object with name "Sparkle Angel", age 2, colour "blue"
# and a generated "_id" (a random hex string, different every run).
# Check by hand: a `request` result in history.json reading "ok 200 []", recorded in the step right
# after the agent navigated straight to its own <endpoint>/unicorns (so that exact GET was already
# captured) and before any click; `duckwright export` will refuse the run otherwise.
max-steps: 15
---
Go to https://crudcrud.com/ and find your unique REST endpoint URL printed on the page (it looks
like https://crudcrud.com/api/<id>).
Go directly to that endpoint with /unicorns appended (so the page's own GET on that exact path is
captured).
Right after that step, before clicking anything else, use request to call GET on that same
/unicorns path again and note the response body.
Go back to https://crudcrud.com/ and click "Click to create a unicorn" to create one unicorn record
through the page's own POST call.
Go to your endpoint's /unicorns path again to see the created record.
Report: your endpoint's unique id, what the collection's GET returned before you created anything,
and the "name", "age", "colour" and generated "_id" of the unicorn afterwards.
