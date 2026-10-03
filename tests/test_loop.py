import pytest

from pw_agent.brain import Action, BrainError, Decision
from pw_agent.loop import Agent
from pw_agent.proc import ProcResult
from pw_agent.pw import PlaywrightCLI, PlaywrightError


class FakePW(PlaywrightCLI):
    def __init__(self, open_code=0, snap_error=False, run_stdout="tabs"):
        self.calls = []
        self.closed = 0
        self.open_code = open_code
        self.snap_error = snap_error
        self.run_stdout = run_stdout

    def run(self, cmd, args):
        self.calls.append((cmd, list(args)))
        return ProcResult(0, self.run_stdout, "")

    def open(self, headed):
        self.calls.append(("open", [headed]))
        return ProcResult(self.open_code, "", "open failed")

    def close(self):
        self.closed += 1

    def snapshot(self, path):
        if self.snap_error:
            raise PlaywrightError("snap boom")
        return "- page"


class FakeBrain:
    def __init__(self, script):
        self.script = script
        self.prompts = []
        self.obs = []
        self.ctxs = []

    def decide(self, prompt, obs=None, ctx=None):
        self.prompts.append(prompt)
        self.obs.append(obs)
        self.ctxs.append(ctx)
        item = self.script[min(len(self.prompts) - 1, len(self.script) - 1)]
        if isinstance(item, Exception):
            raise item
        return item, 0.5


def dec(*actions, memory="m"):
    return Decision("ev", memory, "goal", [Action(c, a) for c, a in actions])


def test_finishes_on_done(tmp_path):
    pw = FakePW()
    brain = FakeBrain([dec(("goto", ["u"])), dec(("done", ["success", "ok"]))])
    r = Agent("t", pw, brain, tmp_path).run()
    assert (r.success, r.answer, r.steps) == (True, "ok", 2)
    assert r.cost_usd == 1.0
    assert pw.closed == 1


def test_stops_at_max_steps(tmp_path):
    pw = FakePW()
    brain = FakeBrain([dec(("hover", ["e1"])), dec(("hover", ["e2"])), dec(("hover", ["e3"]))])
    r = Agent("t", pw, brain, tmp_path, max_steps=3).run()
    assert (r.success, r.steps, r.answer) == (False, 3, "max steps reached")
    assert pw.closed == 1


def test_consecutive_brain_failures(tmp_path):
    pw = FakePW()
    brain = FakeBrain([BrainError("kaput")])
    r = Agent("t", pw, brain, tmp_path, max_failures=3).run()
    assert r.success is False
    assert r.steps == 3
    assert r.answer == "stopped after 3 consecutive brain failures: kaput"
    assert pw.closed == 1
    assert r.history[0].results == ["brain error: kaput"]


def test_brain_failure_counter_resets(tmp_path):
    pw = FakePW()
    brain = FakeBrain(
        [BrainError("a"), BrainError("b"), dec(("hover", ["e1"])), BrainError("c"),
         BrainError("d"), dec(("done", ["success", "x"]))]
    )
    r = Agent("t", pw, brain, tmp_path, max_failures=3).run()
    assert r.success is True and r.steps == 6


def test_repeat_nudge(tmp_path):
    pw = FakePW()
    brain = FakeBrain([dec(("hover", ["e1"]))])
    Agent("t", pw, brain, tmp_path, max_steps=4).run()
    assert all("You are repeating" not in p for p in brain.prompts[:3])
    assert "You are repeating the same actions; try a different approach." in brain.prompts[3]


def test_close_on_exception(tmp_path):
    pw = FakePW(snap_error=True)
    with pytest.raises(PlaywrightError):
        Agent("t", pw, FakeBrain([dec()]), tmp_path).run()
    assert pw.closed == 1


def test_open_failure_raises(tmp_path):
    pw = FakePW(open_code=1)
    with pytest.raises(PlaywrightError):
        Agent("t", pw, FakeBrain([dec()]), tmp_path).run()
    assert pw.closed == 1


def test_on_step_and_memory(tmp_path):
    seen = []
    pw = FakePW()
    brain = FakeBrain([dec(("hover", ["e1"]), memory="remember"), dec(("done", ["success", "x"]))])
    Agent("t", pw, brain, tmp_path, on_step=seen.append).run()
    assert len(seen) == 2
    assert "remember" in brain.prompts[1]


def test_brain_error_cost_is_counted(tmp_path):
    pw = FakePW()
    err = BrainError("refused")
    err.cost = 0.25
    brain = FakeBrain([err, dec(("done", ["success", "x"]))])
    agent = Agent("t", pw, brain, tmp_path)
    r = agent.run()
    assert r.cost_usd == 0.75
    assert agent.cost_usd == 0.75


def test_running_cost_survives_exception(tmp_path):
    class SnapFailsSecond(FakePW):
        n = 0

        def snapshot(self, path):
            self.n += 1
            if self.n == 2:
                raise PlaywrightError("snap boom")
            return "- page"

    pw = SnapFailsSecond()
    agent = Agent("t", pw, FakeBrain([dec(("hover", ["e1"]))]), tmp_path)
    with pytest.raises(PlaywrightError):
        agent.run()
    assert agent.cost_usd == 0.5


def test_state_loaded_after_open(tmp_path):
    pw = FakePW()
    loaded = []
    pw.state_load = lambda path: (loaded.append(path), pw.calls.append(("state-load", [path])))
    brain = FakeBrain([dec(("done", ["success", "ok"]))])
    Agent("t", pw, brain, tmp_path, state=tmp_path / "auth.json").run()
    assert pw.calls[:2] == [("open", [False]), ("state-load", [tmp_path / "auth.json"])]


def test_no_state_skips_state_load(tmp_path):
    pw = FakePW()
    brain = FakeBrain([dec(("done", ["success", "ok"]))])
    Agent("t", pw, brain, tmp_path).run()
    assert all(c[0] != "state-load" for c in pw.calls)


GOTO_OUT = "### Ran Playwright code\n```js\nawait page.goto('u');\n```\n"


def test_step_records_generated_code(tmp_path):
    pw = FakePW(run_stdout=GOTO_OUT)
    brain = FakeBrain([dec(("goto", ["u"])), dec(("done", ["success", "ok"]))])
    r = Agent("t", pw, brain, tmp_path).run()
    assert r.history[0].codes == ["await page.goto('u');"]
    assert r.history[1].codes == [None]


def test_brain_error_step_has_no_codes(tmp_path):
    pw = FakePW(run_stdout=GOTO_OUT)
    brain = FakeBrain([BrainError("x"), dec(("done", ["success", "ok"]))])
    r = Agent("t", pw, brain, tmp_path).run()
    assert r.history[0].codes == []


def test_state_load_failure_closes_browser(tmp_path):
    pw = FakePW()

    def boom(path):
        raise PlaywrightError("bad state")

    pw.state_load = boom
    with pytest.raises(PlaywrightError, match="bad state"):
        Agent("t", pw, FakeBrain([]), tmp_path, state=tmp_path / "a.json").run()
    assert pw.closed == 1


def test_brain_gets_obs_and_ctx(tmp_path):
    brain = FakeBrain([dec(("hover", ["e1"])), dec(("done", ["success", "x"]))])
    Agent("t", FakePW(), brain, tmp_path).run()
    c1, c2 = brain.ctxs
    assert (c1.step, c1.task, c1.memory, c1.history_lines, c1.nudged, c1.previous_failed) == (1, "t", "", [], False, False)
    assert (c2.step, c2.memory, len(c2.history_lines)) == (2, "m", 1)
    assert brain.obs[0].snapshot == "- page"


def test_previous_failed_after_rejected_action(tmp_path):
    brain = FakeBrain([dec(("eval", ["x"])), dec(("hover", ["e1"])), dec(("done", ["success", "x"]))])
    Agent("t", FakePW(), brain, tmp_path).run()
    assert [c.previous_failed for c in brain.ctxs] == [False, True, False]


def test_previous_failed_after_brain_error(tmp_path):
    brain = FakeBrain([BrainError("x"), dec(("done", ["success", "x"]))])
    Agent("t", FakePW(), brain, tmp_path).run()
    assert brain.ctxs[1].previous_failed is True


def test_nudged_in_ctx(tmp_path):
    brain = FakeBrain([dec(("hover", ["e1"]))])
    Agent("t", FakePW(), brain, tmp_path, max_steps=4).run()
    assert [c.nudged for c in brain.ctxs] == [False, False, False, True]


def test_step_cost_recorded(tmp_path):
    err = BrainError("x", cost=0.25)
    brain = FakeBrain([err, dec(("done", ["success", "x"]))])
    r = Agent("t", FakePW(), brain, tmp_path).run()
    assert [h.cost for h in r.history] == [0.25, 0.5]
