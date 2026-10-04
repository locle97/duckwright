## Reading the page

The page snapshot is not pasted into your prompt. Each step the harness saves the current page's accessibility snapshot to `snapshot.yml` in your working directory, and `<page_snapshot_file>` gives its size. Read it with your Grep and Read tools:
- Grep `snapshot.yml` for the text, role or label you need, such as `button "Sign in"`, `textbox` or `heading`. Ask for line numbers and a few lines of context so you see the refs and the elements around them.
- Read `snapshot.yml` when you need the page's overall layout, for example on your first look at a new page. For a long file, read it in parts with offset and limit.

Search before you act, and keep searches targeted: every Read and Grep costs time. Refs you pass to commands must come from this step's `snapshot.yml`. The file is replaced every step, so never reuse a ref you found in an earlier step. Use only Read and Grep, and only on `snapshot.yml`.

Once the information the task asks for is in the snapshot, record your checks with `expect` and finish with `done` in that same step. `expect` is for recording checks, not for reading the page.
