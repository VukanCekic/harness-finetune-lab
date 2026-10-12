# What was done about the 2026-10-09 eval review (status, 2026-10-12)

The review is [2026-10-09-eval-review.md](2026-10-09-eval-review.md). This file says what became of each finding.
The harness changes are committed (`e694374` on `feat/openai-compatible-provider`); the lab changes are on the branch
`feat/eval-review-fixes`. Nothing is pushed. The sections below were written before the first live runs; the
[first live runs](#first-live-runs-2026-10-12-later-the-same-day) section at the end says what they settled.

**Verified:** harness `npm run check` (typecheck, lint, 88 tests), lab `npm run check` (typecheck, 94 tests,
including end-to-end tests that run the real harness against a scripted server), `npm run eval:validate` (11/11
tasks; reference solutions 3×; 11 known-wrong fixtures rejected), and, since the first live runs, a real LM Studio
and OpenRouter (see the last section).

A second reader (a fresh agent given only the code) reviewed the change; its findings are listed at the end, with
what was done about each.

## Findings → where they went

| Finding | Status | Where |
|---|---|---|
| **C1** run conditions not pinned or recorded | done | sampling, thinking, provider, budgets in `eval.config.yaml`, sent to the harness as env vars, read back from the session log's `meta.settings`; a mismatch is a `runner_error`. `run.json` records the conditions. Unpinned items are warned about and printed in the report |
| **C2** no uncertainty | done | `evals/src/stats.ts`: task-clustered t-interval, paired difference in `compare` |
| **C3** infra failures graded as model failures | done | harness exits 3 on a failed turn and writes `error` in the turn record; runner classifies every trial (`classify.ts`) |
| **H1** no isolation | partly | environment allowlist, scrubbed variables, outside-workspace tripwire (`escape.ts`), contaminated trials are invalid. **No sandbox** (open) |
| **H2.1** hidden tests depend on `package.json` | done | all hidden tests are `.mjs`; `validate` rejects an ESM `.js` |
| **H2.2–2.6** weak checks | done | slugify `ç`/`ñ`; hello-cli unseen names; word-count real-file-first; expr-eval run with `--disallow-code-generation-from-strings`; callback-to-promise `await` check |
| **H2.7** `validate` proves too little | done | red per check, `guard: true`, green ×3, `fixtures/` of known-wrong attempts |
| **H3** tool-call validity | done | subagents' calls (from the wire log), per-request offered tools and schemas, unknown arguments, calls written as text, errored results shown; labelled `all agents` / `main agent only` |
| **H4** wall clock decides results | done | steps and tokens are the budget; `timeout_s` is a safety net whose kills are invalid. A runner warning checks `timeout_s` against `max_turn_tokens` |
| **M1** cost lost for killed runs | done | usage from the wire log or step records when there is no turn record |
| **M2** reproducibility gaps | done | lab commit and dirty flag, hash of every task folder, runner-code hash, harness working-tree hash, Node/Git versions, LM Studio's model info, prompt and tool-list hashes per trial |
| **M3** Phase 4 data not kept | partly | `WIRE_LOG` has the exact requests and the thinking, from the main loop and every subagent. Not yet: a dedicated training-data export |
| **M4** `tool_errors` | done | counts `Tool error:` too, shown in the report |
| **M5** no resume | done | `--resume`; runner errors keep their duration |
| **L1–L7** | done, except L6/L7 in part | header at k=1, global-install forms, e2e tests, only the active backend's key, `.env` rejected by `validate`, a warning for concurrency above 1. Leftover temp folders are still not reported |
| §5.2 #1–#3 | done | exit code, sampling/`max_tokens`/provider pin, per-step records |
| §5.2 #4 | done | `WIRE_LOG` |
| §5.2 #5, #6 | open | see below |
| §5.3 #1, #2 | done | |
| §5.3 #3, #4 | open | see below |
| §5.4 | knobs done, decisions open | see below |

## Where this differs from the review's proposals

- **The libuv crash was not about HTTP 400.** Against a scripted server a *successful* turn exited with the
  assertion too (6 of 6, exit 0xC0000409), so the runner would have graded a correct run as a harness crash. Cause: the
  harness ended with `process.exit()` while a finished request's socket was still closing. It now sets
  `process.exitCode` and lets the loop drain (with an unref'd backstop). The earlier real run exited 0 on every
  trial, so this is a race, not something that always happened.
- **Sampling** is individual env vars (`LLM_TEMPERATURE`, `LLM_TOP_P`, `LLM_TOP_K`, `LLM_PRESENCE_PENALTY`,
  `LLM_SEED`), validated at start-up, not one `SAMPLING` JSON (D6).
- **The seed is a base**: trial n uses seed + n - 1. A fixed seed for every trial would make the k trials of a task
  near-copies and the k-trial statistics meaningless.
- **Thinking off** uses only the documented `/no_think` soft switch, added to the first system message on the wire.
  LM Studio's docs list no `chat_template_kwargs`/`enable_thinking` for `/v1/chat/completions`, so the hard switch is
  not used.
- **Provider pinning** reuses the harness's existing `PROVIDER_ONLY` (`only` plus `allow_fallbacks: false`), which
  does the same as `order` plus `allow_fallbacks: false` for one provider.
- **New classes**: `token_budget` and `contaminated` (the review's list had neither). The timeout split is by "no
  model call finished for ≥ 120 s": a judgement call, not a measured threshold.
- **Valid vs invalid trials**: only passed / checks_failed / max_steps / token_budget are graded. The rest are counted,
  listed, excluded and re-run with `--resume`. `--resume` keeps what it replaces as `<n>.excluded-<k>`.
- **Config values changed** from the earlier run: `context_window` 40000 → 32768, `timeout_s` 300 → 1800,
  `max_turn_tokens` 60000, `max_tokens` 8192, and sampling pinned to the Qwen3 model card's thinking-mode values.
  Reasons are in the comments in `eval.config.yaml`.

## Not done, and why

| Item | Why |
|---|---|
| Grow to ~40 tasks (§5.3 #3) | the large item; every claim about the fine-tune depends on it. Needs your design decisions on the task mix |
| Training-task list (§5.3 #4) | write it before looking at more results; a separate folder |
| "send a task subagent" advice in the system prompt (§5.2 #5) | your decision. Any prompt change has to land before the first baseline; the harness prompt is unchanged |
| Real sandbox, or the answers off this disk (H1 #3, §5.2 #6) | WSL2/bubblewrap or a container is a day or more of work. The tripwire flags and invalidates trials that reach the lab repo; it cannot stop them |
| Thinking on vs off (§5.4 #1) | needs two real 11×3 runs. `thinking: off` is ready in the config |
| DeepSeek baseline (§5.4 #6) | costs money, so it needs your go-ahead; the row also still needs a temperature and a pinned provider (`unpinned` warns) |
| `min_p` | not accepted by LM Studio's API (not in its documented list): set Min P to 0 in the model's preset |

## Not verified

- **LM Studio accepting the request fields.** `top_p`, `top_k`, `presence_penalty`, `seed`, `max_tokens` are in its
  documented list, but no request was sent to a real server. If one is rejected the first trial fails fast with HTTP
  400 (`infra_error`), so a one-trial smoke run will show it: `npm run eval -- --model qwen3-8b --task hello-cli --trials 1`.
- **`/api/v0/models` fields.** LM Studio's docs now recommend the v1 API and do not list `loaded_context_length` for
  v0. The runner stores whatever comes back and its warnings use it only if present.
- **`served_by`.** OpenRouter's docs list no provider field in responses; the SDK types carry
  `openrouterMetadata.attempts[].provider`. It is recorded when present. Pinning `provider` is what actually
  controls routing.
- **`/no_think` on this model**, and whether LM Studio separates `reasoning_content` as it did before: check the first
  `wire.jsonl` (`response.reasoning`) and the thinking share in the report.
- The harness REPL, a real Ctrl-C, the browser tool end to end, and concurrency above 1.

## The second reader's findings

A fresh agent reviewed both diffs without seeing my conclusions. All of these were checked against the code before
changing anything.

| # | Finding | Result |
|---|---|---|
| 1 | The 900 s clock fired before the step/token budgets (≈73 tok/s ⇒ 100k tokens ≈ 23 min), excluding slow trials and biasing toward fast models | **fixed**: 1800 s, 60k tokens, plus a warning when `timeout_s < max_turn_tokens / 40` |
| 2 | `--resume` deleted the evidence of excluded attempts | **fixed**: moved aside and reported |
| 3 | A missing or empty wire log silently switched off contamination and tool-call scoring | **fixed**: falls back to the transcript and is a `harness_error`; the support check also looks for `WIRE_LOG` |
| 4 | Detector holes: recursive grep from `/d/code`, globs, 8.3 names, `file:` URLs in the browser tool, scans not contaminating | **fixed**, with tests for each |
| 5 | The agent's `env` showed `SESSION_DIR`, `WIRE_LOG`, and an npm prefix inside the lab | **fixed**: scrubbed, and the prefix is a scratch folder |
| 6 | Misconfigured `CONTEXT_WINDOW`, cancelled turns and truncated final replies were graded as the model's | **fixed**: classified separately |
| 7 | `submit_review` (built per run) scored as an unknown tool | **fixed**: calls are checked against the schemas the request itself carried |
| 8 | `pass^k` counted tasks that had lost trials | **fixed** |
| 9 | The resume fingerprint omitted the model, the runner's rules and the harness's uncommitted state; the summary described the resume-time conditions | **fixed** |
| 10 | The seed does not make a trial repeatable; the prompt hash varied per temp folder | **fixed**: hash masks the workspace path; the config comment no longer claims repeatability |
| 11 | `--concurrency abc` ran nothing and exited 0 | **fixed** |
| – | expr-eval's flag is bypassable through a child process | **fixed**: the grep also bans `child_process`; a fixture covers it |
| – | the `await` grep was brittle | **fixed**: `grep -qw await main.js` |
| – | `finishedTrials` could throw on a truncated `result.json` | **fixed** |
| – | wire log did not contain the `/no_think` suffix, `finish_reason=error` was not logged | README corrected; the error is logged |
| – | the in-flight time includes tool time | wording corrected; it says "no model call had finished for N s" |

Not changed: the REPL's `/exit` after a failed turn exits 0 (the one-shot path, which the runner uses, exits 3).

## Before the first real run

1. Commit the harness changes (the runner records its commit and refuses to compare against a dirty one without
   saying so), then `npm run eval:sync-tools` so `tool-schemas.json` names the new commit.
2. LM Studio: load Qwen3-8B Q8_0 at context 40960, set Min P to 0 in its preset.
3. Smoke run: `npm run eval -- --model qwen3-8b --task hello-cli --trials 1`; look at `run.json` (conditions),
   `trials/hello-cli/1/wire.jsonl` and the summary.
4. Then the thinking decision (11×3 each way), then the other baselines.

## First live runs (2026-10-12, later the same day)

Two runs of 11 tasks × 1 trial, both graded in full (11 valid, 0 invalid):
`qwen3-8b-nothink` (Qwen3-8B Q8_0, LM Studio, `/no_think`) and `deepseek-v4.1-flash` (OpenRouter).
Table: [`evals/results/compare-nothink-flash.md`](../../evals/results/compare-nothink-flash.md).

| | pass@1 (95% CI over 11 tasks) | mean steps | p50 / p95 time | cost |
|---|---|---|---|---|
| Qwen3-8B, thinking off | 18.2% [0.0, 45.4] | 9.2 | 17.7 s / 651 s | $0 |
| DeepSeek V4.1 Flash | 100.0% [71.5, 100.0] | 6.2 | 25.5 s / 39.7 s | $0.0032 |

**Not publishable as a result.** 11 tasks × 1 trial; no thinking-on Qwen run under the final conditions yet, so
thinking on vs off is still undecided; and the comparison that matters (base vs fine-tune) does not exist yet.

**What the live runs settled**
- LM Studio accepted `top_p`, `top_k`, `seed` and `max_tokens`; the harness's settings round-trip check passed.
- The wire log works against real servers and scores subagents' calls; reasoning tokens are reported by both
  LM Studio and OpenRouter.
- `/no_think` works on this model: 0.1% of generated tokens were thinking (about 90% with it on).
- Flash thinks a little by default (about 20% of its tokens).

**What they exposed**
- **A provider pin that my own data-policy check missed.** I pinned DeepSeek's own endpoint; the account's privacy
  settings and a workspace guardrail forbid paid endpoints that may train on prompts, so every trial failed with
  `NotFoundResponseError` ("Paid model training violation"). It was correctly classified `infra_error` and excluded.
  The console line cut the message off after "Paid model" (error details are truncated at 200 characters; the full
  text is in `harness.log` and the wire log) - still open.
- **Which provider served a request cannot be read from OpenRouter's stream** (`served_by` is always empty). The
  Flash row is pinned to GMICloud (fp8), identified by matching each call's cost to the 31 listed per-endpoint prices
  (0% error over 4 calls; next best 5.6%). That is an inference from prices, not a recorded fact.
- **A zero-width interval.** Flash's 11 of 11 printed as `100.0% [100.0, 100.0]`: with no spread across tasks a
  t-interval collapses to a point. It now falls back to the exact (Clopper-Pearson) bound for all-pass / all-fail
  and a Wilson interval for other all-equal cases: 11 of 11 is [71.5, 100], identical runs differ by [-51, +51]. A
  test had called the old behaviour "honest"; it was not. `npm run eval:summarize -- <run dir>` rebuilds a run's
  summary from its trials without running anything.
- The first thinking-off failure (hello-cli) was a stray `}}` the model never ran: the "claims success without
  running it" behaviour from the review, not a runner problem.

**Still open:** a thinking-on Qwen run under the final conditions; more tasks (about 40) and 3 trials per task before
any claim about a fine-tune; the truncated error line; a sandbox.
