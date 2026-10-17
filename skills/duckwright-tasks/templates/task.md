---
# duckwright-tasks: <feature>, scenario <ID> (written <YYYY-MM-DD>; review before committing)
# sources: <user request | ticket>; testing map <R..>; env <section>; sitemap <paths>; <code file and key>
# derived: <value> = <arithmetic from documented data>          (delete when unused)
# assumption: <what you inferred and could not confirm>          (delete when unused)
env: <env name from the map's default-env or the user's choice>
accounts: <account id>                                          (an environment account for the role; delete when unused)
state: <path to the role's state file, relative to THIS file>   (only when no environment account covers the role; delete when unused)
setup: shared/setup.md                                           (delete when there is no shared setup)
max-steps: <map default, or 2 per numbered step + 3>
---
# <ID>: <title: what it checks, in a few words>

Preconditions:
- <who is signed in and how; what data must exist; what the shared setup guarantees>

Steps:
1. Open <full URL on the env's host>.
2. <one intent per step; elements named by their visible label in quotes>
3. <values the user or a cited source gave, never invented ones>

Expected results:
- <exact visible text, input value, checked state or URL, quoted from a cited source>
- <for an action that calls the API: METHOD /path returned STATUS>

Cleanup:
1. <delete what this task created, named <data-prefix><ID>-...>   (delete the section when nothing is created)
