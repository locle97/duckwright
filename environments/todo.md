# TodoMVC

## Base URL

https://demo.playwright.dev/todomvc/ (public demo app; open this URL at the start of every task)

## Test accounts

None. There is no login.

## Seeded data

- None. The list starts empty in a new browser.
- Todos are kept in the browser's local storage, so they survive a page reload but not a fresh browser.

## Feature flags

None.

## Known quirks

- The new-todo input is labelled "What needs to be done?"; press Enter to add the item.
- The footer ("N item(s) left", the "All" / "Active" / "Completed" filters, "Clear completed") only appears once at least one todo exists. "Clear completed" only appears while a todo is completed.
- To edit a todo, double-click its text, change it and press Enter.
- If a task expects an empty list and old todos are still there, they came from local storage left by an earlier run.

## Off-limits

- Stay on the TodoMVC demo page; do not follow links to other sites.
