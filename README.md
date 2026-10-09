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
  tasks/<id>/        task.yaml, workspace/ (agent sees), hidden/ (agent never sees), solution/ (validate only)
  src/               the runner: adapter, checks, scoring, summary, CLI
  test/              unit tests for the scoring maths
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
npm run eval:validate                    # every task: fails untouched, passes with its reference solution
npm run eval -- --model qwen3-8b         # all tasks × 3 trials; LM Studio server must be running
npm run eval -- --model deepseek-v4.1-flash --task slugify,lru-cache --trials 1
npm run eval:compare                     # latest run of each model, side by side
```

Options for `run`: `--trials N` (default 3), `--task a,b`, `--concurrency N` (default 1 - keep it at 1
for a local model, parallel requests share one GPU and distort latency).

### What one trial does

1. A fresh temp directory gets the task's `workspace/` and is committed to a new git repo.
2. The harness runs in it as a subprocess - `--local` or `--remote`, the task prompt, permissions bypassed
   (the directory is throwaway), stdin closed so `ask_user` cannot hang the run, a hard timeout that kills
   the whole process tree. `npm install -g` is redirected into the trial folder.
3. `hidden/` is copied over the result: it restores any test file the agent edited and adds tests it never
   saw. Then the task's checks run: `command` (bash, exit 0 = pass, optionally `stdout_includes`) and
   `file_exists`.
4. The harness's session log (written live, so it survives a timeout) is scored, and the workspace,
   transcript, `harness.log` and `result.json` are kept under `results/<run>/trials/<task>/<n>/`.

A trial **passes** only if every check passes and the run finished (no timeout, no crash).

### Metrics

| Metric | Meaning |
|---|---|
| pass@1 | share of all trials that passed: the chance one attempt succeeds |
| pass@k | share of tasks solved in at least one of k trials |
| pass^k | share of tasks solved in all k trials: reliability |
| flaky | tasks whose trials disagreed |
| valid tool calls | share of the model's tool calls that are a JSON object, name a real tool, and fit that tool's schema (main agent only; reasons are broken down: `invalid_json`, `not_an_object`, `unknown_tool`, `schema`) |
| cost | from OpenRouter; always $0 for a local model, which reports no price |
| p50 / p95 time | wall time of a trial, the harness's start-up included |
| steps | model requests in the main loop |
| global installs | `npm/yarn/pnpm` global install attempts |

Each run records the harness commit (and whether it had uncommitted changes), the model profile and the
fixed settings, so a row in the table can be reproduced.

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
`evals/src/config.ts`), a `workspace/`, checks that can fail, ideally a `hidden/` test, and a `solution/`.
Then `npm run eval:validate -- --task <id>` must show it red without the solution and green with it.
Write tasks *before* looking at model results, and keep training tasks (Phase 4) in a separate folder.

## Development

```bash
npm run check    # typecheck + unit tests
```
