# Quotes to Scrape: acceptance tests

Site: https://quotes.toscrape.com/

## Shared setup

Each test begins at https://quotes.toscrape.com/login. Log in with username "qa" and any password, for example "qa" (the site accepts any login). After logging in the header shows "Logout".

## Test data

The quotes are fixed: 10 per page, 10 pages, 100 quotes in total.

## Cases

**Q1. Author page.** On page 1, open the "(about)" link of the first quote's author (Albert Einstein). Expected: the page shows "Born: March 14, 1879 in Ulm, Germany".

**Q2. Tag page.** Click the tag "inspirational" under any quote. Expected: the URL ends with /tag/inspirational/ and every quote on the page has the tag "inspirational".

**Q3. Last page.** Press "Next" until there is no "Next" button. Expected: you are on page 10, and the page has a "Previous" button but no "Next" button.

**Q4. Logout.** Press "Logout". Expected: the header shows "Login" again.

**Q5. Count all quotes by script.** Run `python count_quotes.py` against the site and compare its total with the test data above. Expected: it prints 100.
