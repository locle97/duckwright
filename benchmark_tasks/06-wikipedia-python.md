---
# Benchmark: one very large page (well over 40k characters of snapshot),
# with answers far down the page, past the --snapshot-full truncation point.
# Expected answer: Guido van Rossum; 1991; Python 2.0 in 2000; Python 3.0 in 2008.
max-steps: 15
---
Open https://en.wikipedia.org/wiki/Python_(programming_language).
From the infobox, report who designed Python and the year it first appeared.
From the article's History section, report the year Python 2.0 was released
and the year Python 3.0 was released.
