# harness-finetune-lab

**Build an agent → measure it → improve a small model with data → prove it with evals.**

The agent is [custom-harness](https://github.com/VukanCekic/custom-harness), a TypeScript coding agent
(tools, plan → work → review pipeline, context compaction, cost tracking). This repo is the lab around it:
an eval suite that runs the real agent on real tasks, baselines for a strong remote model and a small local
one, and, next, a QLoRA fine-tune of the small model on the strong model's successful runs.

| Phase | What | Status |
|---|---|---|
| 1 | Local model support in the harness (`--local`, any OpenAI-compatible server) | done - harness `f552961` |
| 2 | Eval suite: real agent runs, deterministic checks, tool-call validity | **in progress** - this repo, `evals/` |
| 3 | Baselines: DeepSeek V4.1 Flash (remote) vs Qwen3-8B (local, LM Studio) | next |
| 4 | Training data: DeepSeek runs on *non-eval* tasks, successful ones exported as JSONL | |
| 5 | Fine-tune: Unsloth QLoRA on Qwen3-8B, export GGUF | |
| 6 | Serve the fine-tune, run the same evals | |
| 7 | Compare, write up | |

Rules: never train on eval tasks; change only the model between runs; report honestly, even if the
fine-tune only beats its own base model. The original plan and its reasoning: [docs/plan.md](docs/plan.md).

## Layout

```
evals/
  eval.config.yaml   models (the rows of the results table) + the settings held fixed for all of them
  tasks/<id>/        task.yaml, workspace/ (agent sees), hidden/ (agent never sees), solution/ and fixtures/ (validate only)
  src/               the runner: adapter, checks, scoring, classification, statistics, summary, CLI
  test/              unit tests, and end-to-end tests that run the real harness against a scripted server
  tool-schemas.json  snapshot of the harness's tool schemas, for the validity scorer
  results/           one folder per run: summary.md / summary.json committed, trials/ ignored
probes/              raw LM Studio + Qwen3-8B responses captured while building Phase 1
docs/plan.md         the full plan
```

## Running the evals

Needs Node 20.3+, Git for Windows (checks are bash), the harness checked out (path in `eval.config.yaml`,
or `HARNESS_DIR`), and for remote models an `OPENROUTER_API_KEY` in the harness's `.env`. Only the keys
are read from that file - none of its other settings, so they cannot leak into a run.

```bash
npm install
npm run eval:sync-tools                  # snapshot the harness's tool schemas (again whenever its tools change)
npm run eval:validate                    # every task: red untouched, green with its solution (3x), known-wrong fixtures rejected
npm run eval -- --model qwen3-8b         # all tasks × 3 trials; LM Studio server must be running
npm run eval -- --model deepseek-v4.1-flash --task slugify,lru-cache --trials 1
npm run eval -- --resume evals/results/<run>   # finish an interrupted run, re-run its invalid trials
npm run eval:summarize -- evals/results/<run>  # rebuild a run's summary from its trials, no model calls
npm run eval:compare                     # latest run of each model, the first as the baseline
```

Options for `run`: `--trials N` (default 3), `--task a,b`, `--concurrency N` (default 1 - keep it at 1
for a local model: parallel requests share one KV cache and distort latency), `--resume <run dir>`
(refuses if the model, sampling, thinking, budgets, task files, the runner's own code or the harness code - its
commit and any uncommitted changes - differ from when the run started; `--force` overrides). A resume moves each
attempt it replaces aside as `<n>.excluded-<k>` and the report lists it, so an exclusion cannot vanish.

Exit code of `run`: `0` finished with every trial graded, `4` finished but some trials are invalid (re-run them
with `--resume`), `1` a server is not reachable, `2` a usage or configuration problem.

### What is pinned, and where

Everything that decides what a run measures is in `evals/eval.config.yaml` and is passed to the harness as
environment variables; the harness writes what it actually used into its session log and the runner compares
the two, so a setting that was not applied is a runner error, not a result.

| Setting | Where | Notes |
|---|---|---|
| sampling (`temperature`, `top_p`, `top_k`, `presence_penalty`, `seed`) | per model | unset = the server's or provider's own default, which nothing records: the run is reported as **unpinned**. `seed` is a base: trial n uses seed + n - 1 so repeated trials differ. `min_p` cannot be sent through LM Studio - set Min P to 0 in the model's preset and keep it there for every row |
| `thinking` | per local model | `default` (the model's own, on for Qwen3) or `off` (adds the `/no_think` soft switch from the Qwen3 model card) |
| `provider` | per remote model | OpenRouter upstream(s) to pin, fallbacks off. Unset = OpenRouter picks, and may switch between trials |
| `max_steps`, `max_tokens`, `max_turn_tokens` | defaults | the budget: steps, tokens per request, completion tokens per trial (subagents included) |
| `timeout_s` | defaults | a **safety net**, not a budget: a trial it kills is invalid, not a failure. It has to outlast the token budget, or slow trials are dropped and the pass rate favours fast models - the runner warns when `timeout_s < max_turn_tokens / 40 tok/s` |
| `context_window` | defaults | the harness compacts at 85% of it and a reply comes on top: the runner warns if that does not fit the context LM Studio reports |

The agent's environment is an allowlist (PATH, Windows system and profile variables, proxies), with npm's
additions to PATH removed and only the API key of the backend in use. Nothing from your shell, such as
`INIT_CWD`, which names this repo, reaches it, and its shell commands do not see `SESSION_DIR` or `WIRE_LOG`
(which point into the results folder). Its `npm install -g` prefix is a scratch folder in the temp dir. `run.json` records the conditions: settings, unpinned items,
the lab and harness commits and whether they were dirty (untracked files count), a hash of every task folder,
Node and Git versions, and what LM Studio reports about the loaded model (`/api/v0/models`).

### What one trial does

1. A fresh temp directory gets the task's `workspace/` and is committed to a new git repo.
2. The harness runs in it as a subprocess - `--local` or `--remote`, the task prompt, permissions bypassed
   (the directory is throwaway), stdin closed so `ask_user` cannot hang the run, a hard timeout that kills
   the whole process tree. `npm install -g` is redirected into a scratch folder.
3. `hidden/` is copied over the result: it restores any test file the agent edited and adds tests it never
   saw. Hidden tests are `.mjs`, so they still load if the agent edits `package.json`'s `"type"`. Then the
   task's checks run: `command` (bash, exit 0 = pass, optionally `stdout_includes`) and `file_exists`.
   A check marked `guard: true` is a regression guard that passes on the untouched workspace by design.
4. The harness's session log and **wire log** (every model call of every agent, subagents included, with the
   messages as the harness held them, the tool list sent and the thinking that came back) are read; if the two
   disagree - a wire log with fewer calls than the session has steps - the trial is a `harness_error`, the trial is classified, and the
   workspace, `session/`, `wire.jsonl`, `harness.log` and `result.json` are kept under
   `results/<run>/trials/<task>/<n>/`.

### How a trial is classified

Only **valid** trials are graded: the model had its say. Everything else is counted, listed in the report
and left out of every number until it is re-run with `--resume`.

| class | meaning | graded |
|---|---|---|
| `passed` | every check passed | yes |
| `checks_failed` | the turn finished and a check failed | yes |
| `max_steps` | ran out of steps before the checks passed | yes |
| `token_budget` | ran out of its token budget before the checks passed: the trial total, a reply cut off at `max_tokens` that ended the turn, or its own context filling up | yes |
| `timeout_generation` | the wall-clock safety net killed it with no model call finished for 120 s or more: one runaway generation (or a hung tool) | no |
| `timeout_progress` | the safety net killed it while calls were still finishing: slow progress | no |
| `contaminated` | a tool call reached into the lab repo or another trial's folder, or searched recursively over a folder above them | no |
| `infra_error` | the provider failed or stalled (the harness's turn record says what) | no |
| `harness_error` | the harness crashed, was cancelled, ended without a turn record, or its logs disagree | no |
| `runner_error` | the runner threw, the harness did not apply the requested settings, or `context_window` is too small for the harness's own prompt | no |

"Outside the workspace" is judged from every agent's tool calls: file-tool paths, shell commands (Git Bash
spellings, globs and 8.3 short names included) and the browser tool's `file:` URLs and scripts. A recursive
`grep`/`find` over a folder above the lab, or from a drive root or the home folder, counts: it prints the lab's
files. A path built at run time inside a script is invisible to it. It is a tripwire, not a sandbox: the agent
still runs unsandboxed on this machine.

### Metrics

| Metric | Meaning |
|---|---|
| pass@1 (95% CI) | the mean of per-task pass rates, with a 95% t-interval **across tasks**. Tasks, not trials, are the independent samples, so more trials do not narrow it. When every task agrees (11 of 11) the interval is the exact bound, not a point: [71.5, 100] |
| vs baseline | in `compare`: the paired per-task difference from the first run, with its interval |
| pass@k | share of tasks solved in at least one of k valid trials |
| pass^k | share of tasks solved in all k valid trials: reliability |
| flaky | tasks whose valid trials disagreed |
| valid tool calls | share of tool calls that are a JSON object, name a real tool the agent was *offered in that request*, fit its schema and name no unknown argument. Subagents' calls are included (from the wire log); a call written as text instead of a call counts as invalid. Reasons are broken down. "errored" counts results the harness reported as errors |
| cost | from OpenRouter, killed trials included as far as it is known; $0 for a local model, which reports no price |
| p50 / p95 time | wall time of a valid trial, the harness's start-up included |
| steps | model requests in the main loop |
| thinking | share of generated tokens that were thinking, where the server reports it |
| global installs, outside-workspace calls | counted per run |

At 11 tasks the interval is wide (4 of 11 is 36% [2, 70]); a fine-tune's gain of 15 points needs roughly 40
tasks × 3 trials to be detectable. See [the 2026-10-09 review](docs/reviews/2026-10-09-eval-review.md) and
[what was done about it](docs/reviews/2026-10-12-implementation-status.md).

### Tasks

11 tasks, plain Node.js with no dependencies, so nothing needs a network:

| task | difficulty | tests |
|---|---|---|
| hello-cli | easy | create a CLI from a spec |
| fix-off-by-one | easy | fix a bug without touching the failing test |
| rename-symbol | easy | rename across files, behaviour unchanged |
| slugify | medium | implement a function from a spec (Unicode) |
| word-count-cli | medium | file I/O, chars vs bytes, error exit code |
| csv-to-json | medium | quoted fields; re-checked on a CSV it never saw |
| add-json-flag | medium | add a feature, keep the old output byte-identical |
| callback-to-promise | medium | refactor an API and its caller |
| checkout-bugs | hard | two bugs in two files behind one failing test |
| lru-cache | hard | data structure with subtle recency rules |
| expr-eval | hard | a parser with precedence and errors, `eval` banned |

**Adding a task:** make `tasks/<id>/` with `task.yaml` (see any existing one; the schema is in
`evals/src/config.ts`), a `workspace/`, checks that can fail, a `hidden/` test (`.mjs`, and with inputs the
prompt does not show), a `solution/`, and `fixtures/<name>/` folders holding plausible wrong answers.
`npm run eval:validate -- --task <id>` then checks, per check, that it fails on the untouched workspace
(unless it is a `guard`), passes on the solution three times running, and that every fixture fails at least one
check. A fixture that passes means the checks are too weak. Write tasks *before* looking at model results,
and keep training tasks (Phase 4) in a separate folder.

## Development

```bash
npm run check    # typecheck + unit tests
```
