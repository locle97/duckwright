import subprocess

from pw_agent import proc


def test_run_process_uses_utf8_replace(monkeypatch):
    seen = {}

    def fake_run(argv, **kw):
        seen.update(kw)
        return subprocess.CompletedProcess(argv, 0, "o", "e")

    monkeypatch.setattr(proc.subprocess, "run", fake_run)
    r = proc.run_process(["x"], None, 1)
    assert (r.code, r.stdout, r.stderr) == (0, "o", "e")
    assert seen["encoding"] == "utf-8"
    assert seen["errors"] == "replace"
    assert "shell" not in seen


def test_run_process_decodes_bad_bytes():
    r = proc.run_process(["python3", "-c", "import sys; sys.stdout.buffer.write(b'a\\xffb')"], None, 10)
    assert r.stdout == "a�b"
