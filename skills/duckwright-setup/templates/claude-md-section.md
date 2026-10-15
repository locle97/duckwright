## Duckwright (browser tests)

- Duckwright root: `<folder, e.g. e2e/ or .>`. Run `duckwright` from there; `environments/`, `tasks/` and `.auth/` live there.
- Testing map: `<root>/.duckwright/testing-map.md`. Read it before writing or editing anything under `<root>/tasks/`.
- To write task files, use the `duckwright-tasks` skill (`/duckwright-tasks <what to test>`).
- Verified app facts (labels, messages, flows) from earlier probes: `<root>/.duckwright/facts/`. Read them with the skill's `facts.mjs brief`, not raw.
- UI strings for expected results: `<path to i18n or copy file>`. Seed data: `<path to seed script>`.
- Never read `<root>/.auth/*` or any `.env*` file.
