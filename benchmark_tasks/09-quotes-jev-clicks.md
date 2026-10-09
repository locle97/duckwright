---
# Benchmark for --jev: ~20 steps made only of moves Jev can pick (click links, go back).
# The only text the run needs is the URL on the first step and the final answer.
# Expected answer: "love" has 14 quotes (10 + 4), "humor" 12 (10 + 2), "books" 11 (10 + 1);
# the 4 "love" quotes on page 2 are by C.S. Lewis, Alfred Tennyson, Jane Austen and J.M. Barrie;
# the only "books" quote on page 2 is by George R.R. Martin.
# Check by hand: run with and without --jev and compare cost, `jev_steps` / `claude_steps`
# and the answers.
max-steps: 30
---
Open https://quotes.toscrape.com/.
Click "Next" on the home page, then "Previous".
Click the tag "love" and go to its second page with "Next", then back to the
first page with "Previous" and to the second page again.
Click the "Quotes to Scrape" title to return to the home page, click the tag "humor",
and go to its second page with "Next", then back with "Previous".
Return to the home page, click the tag "books", and go to its second page.
On that page click the "(about)" link of the quote, then go back three times
to return to the home page.
Report how many quotes each of the tags "love", "humor" and "books" has in total,
the authors of the quotes on the second page of "love", and the author of the quote
on the second page of "books".
