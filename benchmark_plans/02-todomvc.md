# TodoMVC regression checklist

App: https://demo.playwright.dev/todomvc/

Setup for every case: open the app URL. The list starts empty in a new browser (todos are kept in the browser's local storage).

1. Add a todo
   - Type "Buy milk" in "What needs to be done?" and press Enter.
   - Expected: the list has one item "Buy milk" and the footer says "1 item left".

2. Complete a todo
   - Add "Buy milk" and "Walk the dog".
   - Tick the checkbox of "Walk the dog".
   - Expected: "Walk the dog" is shown as completed and the footer says "1 item left".

3. Filters
   - Add "A", "B" and "C", then complete "B".
   - Click "Active", then "Completed", then "All".
   - Expected: Active shows A and C; Completed shows only B; All shows all three.

4. Clear completed
   - Add "A" and "B", complete "A", click "Clear completed".
   - Expected: only "B" remains and "Clear completed" is no longer shown.

5. Edit a todo
   - Add "Buy milk", double-click it, replace the text with "Buy oat milk" and press Enter.
   - Expected: the item now reads "Buy oat milk" and there is still one item.

6. Todos survive a reload
   - Add "Pay rent", then reload the page.
   - Expected: "Pay rent" is still in the list.
