# Jev target confidence: arena synthesis

Problem: with `--jev`, Jev picked the right element but its target confidence was 0.3-0.7, so most steps went to Claude (4 of 20 accepted on the quotes.toscrape benchmark, 0 wrong).

Causes (measured against the live Jev API):
1. `state.task` was the whole multi-part task, so Jev could not tell which part it was on and spread its vote over every element the task names. Only `state.task` matters; adding the goal to the target question text did nothing.
2. The same destination listed several times (sidebar tag + tag under each quote) split the vote.

Arena: opus, sonnet and haiku candidates (fable dropped out: usage credits), cross-judged by opus.

| Candidate | Accepted (bench) | Idea | Verdict |
| --- | --- | --- | --- |
| haiku | 22/30 | merge duplicates + href; `state.task` = memory | simplest, but memory goes stale |
| sonnet | 27/30 | merge + href; sub-goal = clause after "then" in the previous goal, with a verb list | best number, brittle English parsing; also replaced the task in the action question |
| opus | 25-27/30 | merge + href; `state.task` = Claude's latest `next_goal` + memory, via `ctx.goal` | **base**: structured data, whole task kept in the action question |

Grafts into the base: only the previous step's goal counts, and none after a Jev step (from sonnet's rule, without its parsing); target limit counted after merging; targets scanned once; unused `refs` and the history-line fallback removed.

Result: 26/30 accepted, 0 wrong accepts, mean target confidence 0.89. The 0.8 threshold and all routing rules are unchanged.
Remaining Claude fallbacks: a tag whose sidebar and in-quote links go to different urls (`/tag/humor/` vs `/tag/humor/page/1/`); summing across those is unsafe in general (per-row "Edit" links).
Caveat: measured on one site, with Claude's memory notes naming the next step.
