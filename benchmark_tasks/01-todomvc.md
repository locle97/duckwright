---
# Benchmark: many small interactions on a small page.
# Expected answer: 2 items left; after clearing, 2 todos remain.
max-steps: 20
---
Open https://demo.playwright.dev/todomvc/.
Add three todos, in this order: "Buy milk", "Walk the dog", "Pay rent".
Mark "Walk the dog" as completed.
Show only the Active todos and check that the counter says "2 items left".
Show All todos again, click "Clear completed", and check that exactly
"Buy milk" and "Pay rent" remain.
Report the final list of todos.
