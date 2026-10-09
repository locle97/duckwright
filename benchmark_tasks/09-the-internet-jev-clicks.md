---
# Benchmark for --jev: ~20 steps made only of moves Jev can pick (click, check, uncheck, hover,
# go-back). The only text the run needs is the URL on the first step and the final answer.
# Expected answer: checkboxes end as 1 checked / 2 unchecked; 2 "Delete" buttons left after
# adding three and deleting one; hover names user1, user2, user3; the checkbox is removed
# ("It's gone!") and added back ("It's back!").
# Check by hand: run with and without --jev and compare cost, `jev_steps` / `claude_steps`
# and the answers.
max-steps: 30
---
Open https://the-internet.herokuapp.com/.
Open the "Checkboxes" page. Tick "checkbox 1" and untick "checkbox 2", then go back.
Open the "Add/Remove Elements" page. Click "Add Element" three times,
then click "Delete" once, and check that two "Delete" buttons are left. Go back.
Open the "Hovers" page. Hover over each of the three avatars in turn
and note the user name shown for each one. Go back.
Open the "Dynamic Controls" page. Click "Remove" in the checkbox section and
check that the page says "It's gone!". Then click "Add" and check that it says "It's back!".
Report the state of the two checkboxes, the number of "Delete" buttons left,
the three user names, and the two messages from the Dynamic Controls page.
