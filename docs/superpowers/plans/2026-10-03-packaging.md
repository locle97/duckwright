# Packaging and PyPI Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `pip install playwright-agent-loop` (or `pipx install`) gives a `pw_agent` command that works from any directory.

**Architecture:** Today, `pw_agent/__main__.py` finds `prompts/system.md` relative to the repo root and finds the default skill relative to the current directory. Both break after a non-editable install: probed, an installed wheel looks for `site-packages/prompts/system.md`, which does not exist. We move `prompts/` into the package as package data and resolve it relative to `pw_agent/`. Then we add a `[project.scripts]` entry point, PyPI metadata and `--version`. Finally we add a CI job that installs the built wheel and runs it from a different directory, plus a tag-triggered release workflow that publishes with PyPI trusted publishing.

**Tech Stack:** Python ≥3.11 standard library only at runtime; setuptools, `build`, pytest for development; GitHub Actions with `pypa/gh-action-pypi-publish`.

**Spec:** No separate spec file. The requirement is the README roadmap line: "**Packaging**: a console-script entry point and a PyPI release, so `pw_agent` runs from any directory."

## Facts (probed on 2026-10-03; do not re-derive)

- The PyPI name `pw-agent` (and `pw_agent`, which normalizes to it) **belongs to an unrelated project**. `playwright-agent-loop` returned 404, so it is free. The import package and the command both stay `pw_agent`.
- Listing `packages = ["pw_agent"]` with a `pw_agent/prompts/` directory triggers setuptools' "Package would be ignored" warning. `packages = ["pw_agent", "pw_agent.prompts"]` plus `[tool.setuptools.package-data] "pw_agent.prompts" = ["*.md"]` builds without warnings, and both the sdist and the wheel contain both `.md` files.
- The system Python here has setuptools 68 and no `wheel` module, so `pip wheel --no-build-isolation` fails. `python -m build` with build isolation works.

## Global Constraints

- Distribution name: `playwright-agent-loop`. Import package: `pw_agent`. Console command: `pw_agent`.
- `requires-python = ">=3.11"`; runtime `dependencies = []`. The "no Python dependencies" promise in the README must stay true.
- Version stays `0.1.0` (never released) and is defined only in `pyproject.toml`. `--version` reads it from installed metadata.
- `python3 -m pw_agent` keeps working from a checkout.
- `runs/` keeps being created in the current directory (unchanged behavior; document it).
- An explicit `--skill PATH` keeps resolving relative to the current directory.
- License: the repo has none. **This plan does not choose one.** The owner decides before the first publish (see the Release checklist at the end).

## Review Focus

1. **Non-editable install**: `__file__` lives in `site-packages`, and the prompts must be inside the wheel. Expected: the installed `pw_agent` gets past the file preflight checks. Pinned by Task 2's wheel-content test and Task 3's smoke script.
2. **Run from a directory other than the repo root, without `--skill`**. Expected: preflight finds both bundled prompts. Pinned by Task 1 `test_default_prompts_found_from_any_cwd`.
3. **Relative `--skill` override**. Expected: it still resolves against the current directory, not the package. Pinned by Task 1 `test_relative_skill_resolves_against_cwd`.
4. **`python3 -m pw_agent --version` from a checkout that was never pip-installed**. Expected: it prints `pw_agent unknown` and does not crash with `PackageNotFoundError`. Pinned by Task 2 `test_version_unknown_when_not_installed`.
5. **The release tag does not match `pyproject.toml`'s version**. Expected: the release workflow fails before uploading. Pinned by Task 3 Step 4, which runs the tag check locally with a wrong tag.

---

### Task 1: Bundle prompts inside the package

**Files:**
- Move: `prompts/system.md` → `pw_agent/prompts/system.md`, `prompts/playwright-cli.md` → `pw_agent/prompts/playwright-cli.md` (`git mv`; delete the empty `prompts/`)
- Modify: `pw_agent/__main__.py:13-14` (constants), `:25` (`--skill` default), `:44` (error message)
- Modify: `tests/test_main.py:126-132, 183-186`; `tests/test_e2e.py:34-35`
- Modify: `pyproject.toml` (`[tool.setuptools]` and `package-data` only)

**Interfaces:**
- Produces: `pw_agent.__main__.PROMPTS_DIR: Path` = `Path(__file__).resolve().parent / "prompts"`; `SYSTEM_MD: Path` = `PROMPTS_DIR / "system.md"`; `DEFAULT_SKILL: Path` = `PROMPTS_DIR / "playwright-cli.md"` (now an absolute `Path`, not a str).

- [ ] **Step 1: Write the failing tests** in `tests/test_main.py`. Replace `test_default_skill_is_cwd_relative` and update the two path-reading tests:

```python
def test_default_prompts_live_in_package():
    pkg = Path(m.__file__).resolve().parent
    assert m.SYSTEM_MD == pkg / "prompts" / "system.md"
    assert m.DEFAULT_SKILL == pkg / "prompts" / "playwright-cli.md"
    assert m.SYSTEM_MD.is_file() and m.DEFAULT_SKILL.is_file()


def test_default_prompts_found_from_any_cwd(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)  # not the repo root
    monkeypatch.setattr(m.shutil, "which", lambda n: "/usr/bin/" + n)
    args = m._parse(["task"])
    assert m._preflight(Path(args.skill), None) is None


def test_relative_skill_resolves_against_cwd(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(m.shutil, "which", lambda n: "/usr/bin/" + n)
    (tmp_path / "my-skill.md").write_text("x")
    assert m._preflight(Path(m._parse(["t", "--skill", "my-skill.md"]).skill), None) is None
    assert "skill not found" in m._preflight(Path(m._parse(["t", "--skill", "nope.md"]).skill), None)
```

Update `test_agent_skill_omits_find_and_eval` to read `m.DEFAULT_SKILL.read_text()`. Update `test_system_prompt_says_browser_is_open` to read `m.SYSTEM_MD.read_text()`. In `tests/test_e2e.py`, use `ROOT / "pw_agent" / "prompts" / ...`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_main.py -v`
Expected: the three new tests FAIL (`DEFAULT_SKILL` is the str `"prompts/playwright-cli.md"`, and `SYSTEM_MD` points at the repo-root `prompts/`).

- [ ] **Step 3: Move the files and repoint the constants**

`git mv` the two prompt files. Set the three constants as in Interfaces. Pass `default=str(DEFAULT_SKILL)` to `--skill` so `--help` shows a readable path. Change the system-prompt preflight message suffix from `(is the checkout complete?)` to `(is the installation complete?)`. In `pyproject.toml`, set `packages = ["pw_agent", "pw_agent.prompts"]` and add `[tool.setuptools.package-data]` with `"pw_agent.prompts" = ["*.md"]` (see Facts). Do not add an `__init__.py` to `prompts/`.

- [ ] **Step 4: Run the full suite**

Run: `python3 -m pytest -v`
Expected: all PASS (e2e skipped). Also `grep -rn '"prompts/' pw_agent tests` returns nothing.

- [ ] **Step 5: Commit**

```bash
git add -A pw_agent prompts tests pyproject.toml
git commit -m "refactor: bundle prompts inside the pw_agent package"
```

---

### Task 2: Console-script entry point, PyPI metadata and `--version`

**Files:**
- Modify: `pyproject.toml`
- Modify: `pw_agent/__main__.py` (`_version()`, `--version` flag)
- Modify: `.gitignore` (add `build/`, `dist/`)
- Test: `tests/test_main.py`, Create: `tests/test_packaging.py`

**Interfaces:**
- Consumes: Task 1's package layout and `package-data`.
- Produces: `pw_agent.__main__.DIST_NAME = "playwright-agent-loop"`; `_version() -> str`, which returns the installed version or `"unknown"`; the console script `pw_agent = "pw_agent.__main__:main"` (`main` already returns an int exit code, which the console-script wrapper passes to `sys.exit`).

- [ ] **Step 1: Write the failing tests**

In `tests/test_main.py`:

```python
def test_version_flag(monkeypatch, capsys):
    monkeypatch.setattr(m, "version", lambda name: "1.2.3")
    with pytest.raises(SystemExit) as e:
        m._parse(["--version"])
    assert e.value.code == 0
    assert capsys.readouterr().out.strip() == "pw_agent 1.2.3"


def test_version_unknown_when_not_installed(monkeypatch):
    def missing(name):
        raise m.PackageNotFoundError(name)
    monkeypatch.setattr(m, "version", missing)
    assert m._version() == "unknown"
```

`tests/test_packaging.py` builds the sdist, then a wheel from that sdist, using `python -m build --outdir <tmp_path> <repo root>`. Use build isolation, not `--no-isolation` (see Facts). The test is skipped with `pytest.importorskip("build")`. It needs one module-scoped fixture that returns the wheel's `ZipFile` plus the sdist path. Tests:

```python
def test_dist_name(dists):        # exactly one playwright_agent_loop-0.1.0-py3-none-any.whl and one playwright_agent_loop-0.1.0.tar.gz
def test_wheel_bundles_prompts(wheel):
    names = wheel.namelist()
    assert "pw_agent/prompts/system.md" in names
    assert "pw_agent/prompts/playwright-cli.md" in names
    assert not any(n.startswith(("prompts/", "tests/")) for n in names)
def test_wheel_console_script(wheel):
    ep = _read(wheel, "entry_points.txt")       # the file under *.dist-info/
    assert "[console_scripts]\npw_agent = pw_agent.__main__:main" in ep
def test_wheel_has_no_runtime_deps(wheel):
    meta = _read(wheel, "METADATA")
    assert "Requires-Python: >=3.11" in meta
    assert all("extra ==" in l for l in meta.splitlines() if l.startswith("Requires-Dist:"))
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pip install -e ".[dev]" && python3 -m pytest tests/test_main.py tests/test_packaging.py -v`
Expected: the version tests FAIL (`m.version` doesn't exist, and `--version` is an unrecognized argument). The packaging tests FAIL on the dist name (`pw_agent-0.1.0…`) and on the missing `entry_points.txt`. (`build` is not in the dev extras yet, so install it by hand for this run: `pip install build`.)

- [ ] **Step 3: Implement**

`pyproject.toml`:
- `name = "playwright-agent-loop"`
- `description = "Browser agent loop: playwright-cli + claude -p"`
- `readme = "README.md"`
- `classifiers`: Python 3.11, 3.12 and 3.13, `Environment :: Console`, `Topic :: Software Development :: Testing`
- `[project.urls]`: `Homepage` and `Issues` → `https://github.com/locle97/playwright-agent-loop` (`/issues`)
- `[project.scripts] pw_agent = "pw_agent.__main__:main"`
- add `"build"` to the `dev` extra

No `license` field (see Global Constraints).

`__main__.py`: `from importlib.metadata import PackageNotFoundError, version`. `_version()` wraps `version(DIST_NAME)`. `_parse` adds `p.add_argument("--version", action="version", version=f"%(prog)s {_version()}")`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pip install -e ".[dev]" && python3 -m pytest -v`
Expected: all PASS. The build emits no `!!` warning block.

- [ ] **Step 5: Commit**

```bash
git add pyproject.toml pw_agent/__main__.py .gitignore tests/test_main.py tests/test_packaging.py
git commit -m "feat: pw_agent console script, PyPI metadata and --version"
```

---

### Task 3: Install smoke test, release workflow and README

**Files:**
- Create: `scripts/smoke_install.sh`
- Modify: `.github/workflows/ci.yml` (new `package` job)
- Create: `.github/workflows/release.yml`
- Modify: `README.md`

**Interfaces:**
- Consumes: the `pw_agent` console script and `--version` output format `pw_agent <version>` from Task 2.
- Produces: `scripts/smoke_install.sh <dist-dir>`. It exits 0 only when the wheel in `<dist-dir>` installs into a fresh venv and passes the checks below, all run from a fresh temp directory.

- [ ] **Step 1: Write `scripts/smoke_install.sh`** (`set -euo pipefail`, executable). It must:
  1. create a venv in `mktemp -d` and `pip install` the single `*.whl` from `$1`;
  2. `cd` to another `mktemp -d`;
  3. assert that `pw_agent --version` prints exactly `pw_agent <version>`, where the version is read from `pyproject.toml` with `tomllib`;
  4. run `PATH="$venv/bin" "$venv/bin/pw_agent" x` and assert exit code `2` and that stderr contains `claude CLI not found`. Restricting `PATH` stops a real run on machines that have `claude` installed. Reaching that check also proves both bundled prompt files resolved.

  It prints `smoke ok` at the end.

- [ ] **Step 2: Run it against a wheel built from the parent commit to verify it fails**

Run: `git worktree add "$TMPDIR/old" origin/main && python3 -m build --wheel --outdir "$TMPDIR/old-dist" "$TMPDIR/old" && bash scripts/smoke_install.sh "$TMPDIR/old-dist"; git worktree remove --force "$TMPDIR/old"`. Any scratch directory works in place of `$TMPDIR`.
Expected: non-zero exit, because the pre-change wheel has no `pw_agent` executable.

Then run: `rm -rf dist && python3 -m build && bash scripts/smoke_install.sh dist`
Expected: `smoke ok`.

- [ ] **Step 3: Add the CI `package` job and the release workflow**

`ci.yml`: add a `package` job on Python 3.11 that runs `pip install build`, `python -m build`, then `bash scripts/smoke_install.sh dist`.

`release.yml`:
- Trigger: `on: push: tags: ["v*"]`.
- Job `build`: checkout, setup-python 3.11, then a tag check step:

  ```bash
  test "${GITHUB_REF_NAME#v}" = "$(python -c 'import tomllib;print(tomllib.load(open("pyproject.toml","rb"))["project"]["version"])')"
  ```

  Then `python -m build`, `bash scripts/smoke_install.sh dist`, and `actions/upload-artifact@v4` with `dist/`.
- Job `publish`: `needs: build`, `environment: pypi`, `permissions: id-token: write`, `actions/download-artifact@v4`, then `pypa/gh-action-pypi-publish@release/v1`. No API token secret: it uses trusted publishing.

- [ ] **Step 4: Verify the workflows locally**

Run: `python3 -c "import yaml; [yaml.safe_load(open(f)) for f in ['.github/workflows/ci.yml','.github/workflows/release.yml']]"` (`pip install pyyaml` if needed).
Expected: no error.

Run the tag check with `GITHUB_REF_NAME=v9.9.9`, then with `GITHUB_REF_NAME=v0.1.0`.
Expected: exit 1, then exit 0.

- [ ] **Step 5: Update `README.md`**

- **Install:** lead with `pipx install playwright-agent-loop` (or `pip install playwright-agent-loop`). Note that the PyPI name differs from the `pw_agent` command. Keep the clone + `pip install -e ".[dev]"` path under Development.
- **Usage:** delete "Run from the repo root…". Show `pw_agent "<task>" …` as the primary form and mention that `python3 -m pw_agent` also works. Change the `--skill` default cell to "bundled `pw_agent/prompts/playwright-cli.md`". State that `runs/` is created in the current directory.
- **Replace** `python3 -m pw_agent` with `pw_agent` in the example console output and the auth example.
- **NOTE block:** change the path to `pw_agent/prompts/playwright-cli.md`. **Exit-code table:** change "missing `prompts/system.md`" to "missing system prompt".
- **Prompt link:** in How it works, update the `prompts/system.md` link.
- **Badges:** add a PyPI version badge.
- **Roadmap:** tick the Packaging line.
- **Development:** add "Releasing: bump `version` in `pyproject.toml`, merge, then push tag `vX.Y.Z`; `release.yml` publishes to PyPI."

Run: `grep -n "prompts/\|repo root" README.md`
Expected: only `pw_agent/prompts/...` paths remain.

- [ ] **Step 6: Commit**

```bash
git add scripts/smoke_install.sh .github/workflows/ci.yml .github/workflows/release.yml README.md
git commit -m "ci: smoke-test installed wheel and publish releases to PyPI"
```

---

## Release checklist (owner, manual, after merge)

These steps need the PyPI account and the repo settings, so no task can do them:

1. Choose a license, then add `LICENSE` and `license = "<SPDX>"` to `pyproject.toml` in a follow-up commit. Do not publish without one.
2. On PyPI, add a pending trusted publisher for project `playwright-agent-loop`: owner `locle97`, repo `playwright-agent-loop`, workflow `release.yml`, environment `pypi`. Create the `pypi` environment in the GitHub repo settings.
3. Run `git tag v0.1.0 && git push origin v0.1.0`, then confirm that `pipx install playwright-agent-loop && cd ~ && pw_agent --version` prints `pw_agent 0.1.0`.
