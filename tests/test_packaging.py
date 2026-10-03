import subprocess
import sys
import tarfile
import zipfile
from pathlib import Path

import pytest

pytest.importorskip("build")

ROOT = Path(__file__).resolve().parent.parent


def _read(wheel, suffix):
    name = next(n for n in wheel.namelist() if n.endswith(".dist-info/" + suffix))
    return wheel.read(name).decode()


@pytest.fixture(scope="module")
def dists(tmp_path_factory):
    out = tmp_path_factory.mktemp("dist")
    sdist_run = subprocess.run(
        [sys.executable, "-m", "build", "--sdist", "--outdir", str(out), str(ROOT)],
        capture_output=True, text=True,
    )
    assert sdist_run.returncode == 0, sdist_run.stdout + sdist_run.stderr
    sdists = list(out.glob("*.tar.gz"))
    assert len(sdists) == 1
    wheel_run = subprocess.run(
        [sys.executable, "-m", "build", "--wheel", "--outdir", str(out), str(sdists[0])],
        capture_output=True, text=True,
    )
    assert wheel_run.returncode == 0, wheel_run.stdout + wheel_run.stderr
    assert "!!" not in wheel_run.stderr + sdist_run.stderr
    return out


@pytest.fixture(scope="module")
def wheel(dists):
    with zipfile.ZipFile(next(dists.glob("*.whl"))) as z:
        yield z


def test_dist_name(dists):
    assert sorted(p.name for p in dists.iterdir()) == [
        "duckwright-0.1.0-py3-none-any.whl",
        "duckwright-0.1.0.tar.gz",
    ]


def test_sdist_contains_prompts(dists):
    with tarfile.open(next(dists.glob("*.tar.gz"))) as t:
        names = t.getnames()
    assert any(n.endswith("duckwright/prompts/system.md") for n in names)


def test_wheel_bundles_prompts(wheel):
    names = wheel.namelist()
    assert "duckwright/prompts/system.md" in names
    assert "duckwright/prompts/playwright-cli.md" in names
    assert not any(n.startswith(("prompts/", "tests/")) for n in names)


def test_wheel_console_script(wheel):
    ep = _read(wheel, "entry_points.txt")
    assert "[console_scripts]\nduckwright = duckwright.__main__:main" in ep


def test_wheel_has_no_runtime_deps(wheel):
    meta = _read(wheel, "METADATA")
    assert "Requires-Python: >=3.11" in meta
    assert all("extra ==" in l for l in meta.splitlines() if l.startswith("Requires-Dist:"))


def test_wheel_declares_mit_license(wheel):
    meta = _read(wheel, "METADATA")
    assert "License-Expression: MIT" in meta
    assert any(n.endswith(".dist-info/licenses/LICENSE") for n in wheel.namelist())
