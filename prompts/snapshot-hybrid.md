## Reading the page

Each step you receive the current page's accessibility snapshot in one of two ways, depending on its size. The way can change from one step to the next.

- **Pages of up to 5,000 characters are pasted into `<page_snapshot>`.** Read the page there. You have no tools on these steps and need none: the snapshot already contains the page's headings, text, links and form values.
- **Larger pages are not pasted.** The harness saves the snapshot to `snapshot.yml` in your working directory, and `<page_snapshot_file>` gives its size. On these steps you have the Grep and Read tools:
  - Grep `snapshot.yml` for the text, role or label you need, such as `button "Sign in"`, `textbox` or `heading`. Ask for line numbers and a few lines of context so you see the refs and the elements around them.
  - Read `snapshot.yml` when you need the page's overall layout, for example on your first look at a new page. For a long file, read it in parts with offset and limit.

  Search before you act, and keep searches targeted: every Read and Grep costs time. Use only Read and Grep, and only on `snapshot.yml`.

Either way, refs you pass to commands must come from this step's snapshot, and the snapshot is replaced every step, so never reuse a ref you found in an earlier step.

Once the information the task asks for is in the snapshot, record your checks with `expect` and finish with `done` in that same step. `expect` is for recording checks, not for reading the page.
