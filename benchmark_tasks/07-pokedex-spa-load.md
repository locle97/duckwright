---
# Benchmark: a single-page app that loads its data through many fetch/XHR calls (network capture).
# https://pokedex.org/ is a static demo SPA: on load it fetches 17 data files (skim-monsters,
# descriptions, evolutions, types, monsters-supplemental, moves, monster-moves), the same every
# time; after that, search and the detail pages use no further requests.
# Expected answer: 17 calls on load, all 200; Charizard is Pokémon #6 and evolves from
# Charmeleon at level 36.
# Check by hand: the step that opens the page has a `network` array with those 17 entries (the
# next prompt's <network> summary shows 10 lines and "…and 7 more"); the later steps have none.
# Open the page from a step, not before the run: the harness clears requests after the first open.
# API assertion (expect-request): in the step after the page loads, the agent should check one of
# the calls listed in <network> with expect-request (method, path, status 200). It only sees the
# previous step's calls, so the check must come right after the step that opened the page.
# Check by hand: that expect-request result is "ok" in history.json, and the exported spec holds a
# `page.waitForResponse(...)` armed before the goto, followed by `expect((await apiResponse1).status()).toBe(200)`.
max-steps: 15
---
Go to https://pokedex.org/ and wait until the list of Pokémon is shown.
Right after the page has loaded, check that at least one of the data requests it made returned 200.
Search for "Charizard" and open its page.
Report its Pokédex number and which Pokémon it evolves from, and at what level.
