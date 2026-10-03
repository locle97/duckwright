---
# Settings for this task. Every line is optional; delete what you don't need.
# Flags on the command line override these. Relative paths are resolved
# from this file's folder. allow-file-access can only be set on the command line.
model: sonnet        # model passed to claude -p
max-steps: 25        # stop after this many steps
# state: auth.json   # storage state loaded before the first step
# session: login     # playwright-cli session name
# headed: true       # show the browser window
# export: true       # write duckwright.spec.ts after a successful run
---
Open https://example.com/form.
Enter the name Linh in the Name field and submit the form.
Check that the page greets "Hello, Linh!".
