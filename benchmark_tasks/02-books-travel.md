---
# Benchmark: pick from a list of 11 products, then open a detail page.
# Expected answer: "A Year in Provence (Provence #1)", £56.88, and its stock line;
# cheapest is "The Road to Little Dribbling ..." at £23.21.
max-steps: 15
---
Open https://books.toscrape.com/ and open the "Travel" category.
Find the most expensive and the cheapest book in that category.
Open the most expensive book's page and check its price there.
Report the title and price of both books, and the stock availability
shown on the most expensive book's page.
