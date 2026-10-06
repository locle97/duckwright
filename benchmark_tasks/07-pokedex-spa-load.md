---
# Benchmark: a single-page app that loads its data through many fetch/XHR calls (network capture
# and `expect-request` API assertions).
# https://pokedex.org/ is a static demo SPA: on load it fetches 7 data files from /assets/ (skim-monsters,
# descriptions, evolutions, types, monsters-supplemental, moves, monster-moves), the same every
# time; after that, search and the detail pages use no further requests.
# Expected answer: 7 data calls on load, all GET 200; Charizard is Pokémon #6 and evolves from
# Charmeleon at level 36.
# Check by hand: the step that opens the page has a `network` array with those calls; the later steps
# have none. `expect-request` only checks the previous step's calls, so the agent must assert right
# after the step that opened the page: the agent picks the calls itself from the <network> summary; the
# run should contain at least one `expect-request` with result "ok" for an /assets/ file, and the exported spec should have one `page.waitForResponse(...)` arm
# per assertion, hoisted to the start of the step that opened the page.
# Open the page from a step, not before the run: the harness clears requests after the first open.
# API assertion (expect-request): in the step after the page loads, the agent should check one of
# the calls listed in <network> with expect-request (method, path, status 200). It only sees the
# previous step's calls, so the check must come right after the step that opened the page.
# Check by hand: that expect-request result is "ok" in history.json, and the exported spec holds a
# `page.waitForResponse(...)` armed before the goto, followed by `expect((await apiResponse1).status()).toBe(200)`.
max-steps: 15
---
Go to https://pokedex.org/ and wait until the list of Pokémon is shown.
Right after that step, use expect-request to assert that the page loaded its data through the
network calls listed for that step. Do this before any other action, since expect-request only
looks at the previous step's calls.
Search for "Charizard" and open its page.
Report its Pokédex number and which Pokémon it evolves from, and at what level.
