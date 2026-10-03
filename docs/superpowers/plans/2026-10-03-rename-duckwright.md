# Rename to Duckwright Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The project ships as **Duckwright**: PyPI distribution `duckwright`, import package `duckwright`, command `duckwright`, GitHub repo `locle97/duckwright`.

**Architecture:** This is a pure rename with no behavior change. Task 1 renames the code (package directory, imports, packaging metadata, CLI defaults, tests, smoke script) as one atomic change, because a half-renamed package cannot pass its own tests. A guard test stops the old name from creeping back. Task 2 rewrites the README. Task 3 renames the GitHub repo, which only the owner can do in the GitHub UI, and then points the local remote at the new name.

**Tech Stack:** Python ≥3.11 standard library, setuptools, `build`, pytest, GitHub Actions (unchanged).

**Spec:** No separate spec file. These decisions were made in the brainstorming conversation on 2026-10-03:
- The brand is **Duckwright** (duck + Play*wright*: "the duck that builds your tests"). The user approved it over Mynah, Quack, and Duckling.
- The repo name changes too: `locle97/playwright-agent-loop` → `locle97/duckwright`.

## Facts (probed on 2026-10-03; do not re-derive)

- PyPI: `duckwright` returned 404, so the name is free. `playwright-agent-loop` was never published, so there are no PyPI users to migrate.
- Every reference to the old name outside `docs/` is in: `pyproject.toml`, `pw_agent/*.py` (imports; `DIST_NAME`, `prog`, `--session` default in `__main__.py`; `session` default in `pw.py`), `tests/*.py`, `scripts/smoke_install.sh`, and `README.md`. `.github/workflows/*.yml`, `.claude/` and `skills-lock.json` contain no references.
- The GitHub MCP tools have no "rename repository" call. The rename is a manual step in GitHub → Settings → General → Repository name. Afterwards, GitHub redirects old URLs (web, git, API) to the new name, but nothing redirects the other way.

## Global Constraints

- Distribution name `duckwright`. Import package `duckwright`. Console command `duckwright`. Brand in prose: **Duckwright**.
- **No `pw_agent` compatibility alias**, because the project was never released. Old command, old import path, and old env var all go away.
- Default playwright-cli session name: `duckwright` (was `pw-agent`).
- Live e2e opt-in env var: `DUCKWRIGHT_E2E=1` (was `PW_AGENT_E2E=1`).
- `--version` prints `duckwright <version>`. The version stays `0.1.0`.
- Do not use the word "Playwright" as part of the brand or a logo (it is a Microsoft trademark). Describing the tool as *built on* Playwright / `playwright-cli` is fine.
- Leave historical documents unchanged: `docs/plans/*` and `docs/superpowers/{plans,specs}/*` written before this plan keep the old names.
- Runtime `dependencies = []`, `requires-python = ">=3.11"`, `runs/` in the current directory: all unchanged.

## Review Focus

1. **A stray old name left somewhere** (a string, a URL, an env var). Expected: no `pw_agent`, `pw-agent`, `PW_AGENT` or `playwright-agent-loop` anywhere outside `docs/` and `.git/`. Pinned by `test_no_legacy_name` in Task 1.
2. **A dev clone with a stale `playwright_agent_loop.egg-info` from an earlier `pip install -e .`**: `importlib.metadata.version("duckwright")` raises, and `--version` prints `duckwright unknown`. Expected: the README's Development section says to re-run `pip install -e ".[dev]"` once after pulling the rename (Task 2).
3. **A user who already ran `pipx install` from the old repo URL**: their `pw_agent` command remains, an orphan of a distribution that no longer updates. Expected: the README gives the one-line migration `pipx uninstall playwright-agent-loop && pipx install "git+https://github.com/locle97/duckwright.git"` (Task 2).
4. **`python -m duckwright` from a checkout** must work exactly as `python -m pw_agent` did. Pinned by the existing `test_e2e.py` subprocess test after its rename in Task 1.
5. **Links clicked between merge and repo rename**: README links to `github.com/locle97/duckwright/...` 404 until the repo is renamed. Expected: rename the repo (Task 3) *before* merging the PR. The open PR moves with the repo.

---

### Task 1: Rename the code to `duckwright`

**Files:**
- Move: `pw_agent/` → `duckwright/` (with `git mv`, so history follows)
- Modify: `pyproject.toml`; `duckwright/__main__.py:9-14,29,37`; `duckwright/pw.py:13`; every `duckwright/*.py` import; `scripts/smoke_install.sh:32-41`
- Modify (tests): `tests/test_packaging.py`, `tests/test_main.py:212`, `tests/test_e2e.py:17,27,34-38`, every `from pw_agent…` import in `tests/`
- Create: `tests/test_naming.py`

**Interfaces:**
- Produces: import package `duckwright`; console script `duckwright = "duckwright.__main__:main"`; `DIST_NAME = "duckwright"`; `PlaywrightCLI(session="duckwright", …)` default; argparse `prog="duckwright"`.

- [ ] **Step 1: Write the failing tests**

`tests/test_naming.py`:

```python
LEGACY = ("pw_agent", "pw-agent", "PW_AGENT", "playwright-agent-loop", "playwright_agent_loop")
SKIP_DIRS = {".git", "docs", "build", "dist", ".pytest_cache", "runs", "__pycache__"}

def test_no_legacy_name():
    # walk ROOT; skip SKIP_DIRS, *.egg-info, and this file itself; read text files (skip undecodable)
    # collect f"{path}:{lineno}" for every line containing any LEGACY token
    assert hits == []
```

Edit the existing assertions:
- `tests/test_packaging.py::test_dist_name` → `["duckwright-0.1.0-py3-none-any.whl", "duckwright-0.1.0.tar.gz"]`
- `test_sdist_contains_prompts` / `test_wheel_bundles_prompts` → `duckwright/prompts/system.md`, `duckwright/prompts/playwright-cli.md`
- `test_wheel_console_script` → `"[console_scripts]\nduckwright = duckwright.__main__:main"`
- `tests/test_main.py::test_version_flag` → `"duckwright 1.2.3"`
- Add to `tests/test_main.py`: `test_default_session` asserting `m._parse(["x"]).session == "duckwright"`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python -m pytest tests/test_naming.py tests/test_packaging.py tests/test_main.py -q`
Expected: FAIL. `test_no_legacy_name` lists the hits, the dist-name and console-script assertions fail, and the version and session values don't match.

- [ ] **Step 3: Rename**

1. `git mv pw_agent duckwright`
2. Replace `pw_agent` → `duckwright` in all `duckwright/*.py` and `tests/*.py` imports. `ROOT / "pw_agent"` and `"-m", "pw_agent"` in `tests/test_e2e.py` change the same way.
3. `pyproject.toml`: `name = "duckwright"`; `description = "Duckwright: a browser agent loop on playwright-cli + claude -p"`; URLs → `https://github.com/locle97/duckwright` and `…/issues`; `[project.scripts] duckwright = "duckwright.__main__:main"`; `packages = ["duckwright", "duckwright.prompts"]`; package-data key `"duckwright.prompts"`.
4. `duckwright/__main__.py`: `DIST_NAME = "duckwright"`, `prog="duckwright"`, description `"Duckwright: browser agent loop on playwright-cli + claude -p"`, `--session` default `"duckwright"`.
5. `duckwright/pw.py`: `session: str = "duckwright"`.
6. `tests/test_e2e.py`: env var `DUCKWRIGHT_E2E` (reason string `"set DUCKWRIGHT_E2E=1 to run live e2e"`), session `"duckwright-e2e"`.
7. `scripts/smoke_install.sh`: `$venv/bin/duckwright` (both calls) and the expected string `"duckwright $version"` in the check and its error message.
8. Delete the stale local `*.egg-info` and reinstall: `rm -rf *.egg-info && pip install -e ".[dev]"`.

- [ ] **Step 4: Run everything to verify it passes**

Run: `python -m pytest -q`
Expected: all pass, with e2e skipped. `test_no_legacy_name` still fails **only** on `README.md` lines, which Task 2 fixes. If that's the only failure, Task 1 is done.

Run: `python -m build && bash scripts/smoke_install.sh dist && rm -rf dist build`
Expected: last line `smoke ok`.

Run: `python -m duckwright --version`
Expected: `duckwright 0.1.0`

- [ ] **Step 5: Commit**

```bash
git add -A duckwright pw_agent pyproject.toml scripts tests
git commit -m "refactor: rename package and command pw_agent -> duckwright"
```

### Task 2: Rebrand the README

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: the names from Task 1 and the repo URL `https://github.com/locle97/duckwright`.

- [ ] **Step 1: Confirm the failing guard**

Run: `python -m pytest tests/test_naming.py -q`
Expected: FAIL, with only `README.md` hits.

- [ ] **Step 2: Rewrite**

- Title `# Duckwright`, followed by a one-line tagline under the badges: *"The rubber duck that drives your browser, then writes the regression test."*
- Every `pw_agent` command/path → `duckwright`. `pw-agent` session default → `duckwright`. `PW_AGENT_E2E` → `DUCKWRIGHT_E2E`. Every `locle97/playwright-agent-loop` URL (badges, install, clone, `cd`, source links) → `locle97/duckwright`.
- Install section: delete the sentence *"The package is named `playwright-agent-loop`, but the command it installs is `pw_agent`."* (Both names are now `duckwright`.) Add an **Upgrading from `pw_agent`** note with `pipx uninstall playwright-agent-loop && pipx install "git+https://github.com/locle97/duckwright.git"` (Review Focus 3).
- Roadmap PyPI line: publish `duckwright` so `pipx install duckwright` works.
- Development section: after the clone, add a note to re-run `pip install -e ".[dev]"` (after deleting any old `*.egg-info`) if the clone predates the rename (Review Focus 2).
- License section: keep the Apache-2.0 attribution for the playwright-cli skill and point it at `duckwright/prompts/playwright-cli.md`. Add one line: *"Duckwright is not affiliated with Microsoft or the Playwright project."*

- [ ] **Step 3: Verify**

Run: `python -m pytest -q`
Expected: all pass (e2e skipped), including `test_no_legacy_name`.

- [ ] **Step 4: Commit and push**

```bash
git add README.md
git commit -m "docs: rebrand README as Duckwright"
git push -u origin claude/ecstatic-hawking-m68ilk
```

### Task 3: Rename the GitHub repository (owner, manual)

Run this **before** merging the PR (Review Focus 5).

- [ ] **Step 1 (owner):** GitHub → `locle97/playwright-agent-loop` → Settings → General → Repository name → `duckwright` → Rename.
- [ ] **Step 2: Point the local clone at the new URL**

Run: `git remote set-url origin https://github.com/locle97/duckwright.git && git fetch origin`
Expected: the fetch succeeds. (The old URL would also keep working through GitHub's redirect.)

- [ ] **Step 3: Verify the links**

Open `https://github.com/locle97/duckwright` and check that the README's CI badge renders and the CI workflow runs green on the PR. If a PyPI trusted publisher was already set up for `playwright-agent-loop`, recreate it on PyPI for project `duckwright` with repo `locle97/duckwright`, workflow `release.yml`, environment `pypi`. A trusted publisher is tied to the repo name.

- [ ] **Step 4:** Merge the PR.
