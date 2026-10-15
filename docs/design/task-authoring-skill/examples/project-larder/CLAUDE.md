# Larder

Grocery ordering app: Next.js front end in `app/`, API routes under `app/src/app/api/`.
(The rest of this file is the project's usual CLAUDE.md content. Only the section below is for Duckwright.)

## Duckwright (browser tests)

- Duckwright root: `e2e/`. Run `duckwright` from there; `environments/`, `tasks/` and `.auth/` live there.
- Testing map: `e2e/.duckwright/testing-map.md`. Read it before writing or editing anything under `e2e/tasks/`.
- To write task files, use the `duckwright-tasks` skill (`/duckwright-tasks <what to test>`).
- UI strings for expected results: `app/src/i18n/en.json`. Seed data: `app/prisma/seed.ts`.
- Never read `e2e/.auth/*` or any `.env*` file.
