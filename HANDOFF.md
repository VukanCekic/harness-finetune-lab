## 2026-11-03 — Eval runner, 11 tasks and 1-trial baselines are on main; the rest is stale docs and an interrupted run
**Done**
- Eval runner, 11 tasks and baselines (qwen3-8b, qwen3-8b-nothink, deepseek-v4.1-flash; 11 tasks x 1 trial) are merged to `main` via PR #1 (merge commit `fdc0025`).
- 95/95 tests passed today.
- Local checkout is now `main`, fast-forwarded to `origin/main`. The old branch `feat/eval-review-fixes` is kept (already merged).
- `.gitignore` now ignores `/*.pdf`, so the personal PDF at the repo root stays out of git.

**Unverified**
- The 2026-10-12 Qwen3-8B thinking-on run (`evals/results/2026-10-12_15-29-58_qwen3-8b/`) was interrupted: only `run.json` (plus ignored `trials/`), no summary. Untracked.
- `evals/results/compare-think-nothink-flash.md` is stale and untracked. It shows the old zero-width interval `[100.0, 100.0]` for DeepSeek.
- README phase table (Phase 2 "in progress", Phase 3 "next"), `docs/plan.md` ("not pushed") and `docs/reviews/2026-10-12-implementation-status.md` ("Nothing is pushed") are stale.
- Only the unit tests were confirmed today. Typecheck and `eval:validate` were not re-run.
- `evals/tasks/fix-off-by-one/` has no `fixtures/` (validate reports it as "no fixtures" but does not fail it).

**Next**
1. Resume (`npm run eval -- --resume evals/results/2026-10-12_15-29-58_qwen3-8b`) or discard the interrupted run.
2. Qwen3 thinking-on baseline under final conditions, then a multi-trial DeepSeek run. This costs money: ask first.
3. Grow tasks toward ~40 and write the training-task list before Phase 4.
