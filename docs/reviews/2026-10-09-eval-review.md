# Eval review: harness-finetune-lab, 2026-10-09

**What was reviewed:**
- the lab repo at `dcb761a` (tag `v1.0.0` plus the review prompt);
- the harness at `f552961` (clean);
- the latest run, `evals/results/2026-10-09_14-30-12_qwen3-8b`: Qwen3-8B Q8_0 in LM Studio, 11 tasks × 1 trial;
- `docs/plan.md`, for intent.

**How:**
- I read all of `evals/src`, `evals/test`, `eval.config.yaml`, all 11 tasks, and every harness module the runner depends on.
- For every trial I read the transcript, `harness.log`, `result.json` and the final workspace.
- LM Studio's own server log covers the same run with per-request timings: `%USERPROFILE%\.lmstudio\server-logs\2026-10\2026-10-09.1.log`.
- I ran five local experiments that call no model (Appendix C).
- For Part 3 I read the docs and source of each compared tool.

**Not done:**
- No code was edited and nothing was committed.
- No DeepSeek or OpenRouter calls. There was one free GET of OpenRouter's public model list, for prices.
- No Qwen re-runs. The LM Studio log answered the timeout questions without one.

Unverified points are marked **UNVERIFIED**.

---

## 1. Verdict

- **Keep your runner and don't migrate.** Its core is right and the right size:
  - it runs the real agent on real files, with real tools;
  - it grades with deterministic hidden tests that are copied in after the run;
  - it uses unseen inputs, so hard-coded output can't pass;
  - it validates every task red without a solution and green with the reference solution.

  None of the established tools does this for a Windows-hosted TypeScript agent with less work (Part 3).
- **Not publishable yet:**
  - Sampling, thinking mode, `max_tokens` and OpenRouter's provider routing are neither pinned nor recorded.
  - The report shows no uncertainty.
  - 11 tasks cannot detect the effect you want to claim. 4/11 has a 95% CI of **15–65%**, and a +15-point fine-tune gain has about **25% power** at 3 trials per task. You need **about 40 tasks × 3 trials**, or about 30 × 5.
- **Failure attribution is the weakest part:**
  - 3 of the 7 failures were wall-clock timeouts caused by thinking that is never recorded. csv-to-json was a single 19,205-token generation that ran for 298 s and produced nothing.
  - A stalled model server makes the harness exit 0, so the runner would grade that trial as a model failure. I reproduced this.
  - The "100% valid tool calls" headline ignores the 26 of 70 model requests made by subagents, and 4 edits that returned errors.
- **The model's main weakness is behaviour, not knowledge.** Of the 10 trials where it did anything, **7 never ran the code or tests it was working on**. Four of its final answers claim a success that is false.
  - Every failure that wasn't a timeout would have been caught by one run.
  - lru-cache's own usage example, in its own final answer, prints `2` where its comment says `undefined`.

  That makes a clean, trainable Phase 4 target.
- **Grading holes that would let the numbers drift:**
  - slugify passed with code that turns "Façade Niño" into `fa-ade-ni-o`.
  - All 11 hidden test files stop loading if the agent sets `"type": "commonjs"`.
  - The agent runs unsandboxed, with every permission auto-approved, on the same disk as the reference solutions and hidden tests.

---

## 2. Code findings, ranked by severity

**Critical** means it invalidates or misattributes published numbers. **High** means it can flip a trial or mislead a headline metric. **Medium** means it biases a secondary metric or blocks Phase 4. **Low** is hygiene.

Paths starting `evals/` are in this repo. Paths starting `harness/` are in `D:\code\coding-harness`.

### Critical

**C1. The run conditions that matter most are neither pinned nor recorded.**

- **Sampling.** Neither backend sends a sampling parameter:
  - local request body: `model, messages, stream, stream_options, tools, tool_choice, max_tokens` (`harness/src/openaiCompat.ts:220-229`);
  - OpenRouter body: the same, without the stream options (`harness/src/llm.ts:321-331`).

  So Qwen runs on whatever LM Studio's per-model settings were at the time. Those aren't recorded anywhere, and LM Studio doesn't document what it does when a parameter is omitted (**UNVERIFIED** what this run used). DeepSeek gets each upstream provider's defaults.
- **`max_tokens`.** It is sent only if `MAX_OUTPUT_TOKENS` is set (`harness/src/llm.ts:172`). The runner strips that variable from the inherited environment (`evals/src/harness.ts:38`) and never sets it. One generation can therefore run until the context is full, which is what consumed csv-to-json (§4.2).
- **Thinking mode.** It is on because that is the Qwen3 chat template's default and nothing turns it off. `eval.config.yaml:27` mentions it in a free-text `notes` field; the runner neither controls nor records it.
  - The [Qwen3-8B model card](https://huggingface.co/Qwen/Qwen3-8B) gives different sampling per mode: thinking `Temperature=0.6, TopP=0.95, TopK=20, MinP=0`; non-thinking `Temperature=0.7, TopP=0.8, TopK=20, MinP=0`.
  - It says "DO NOT use greedy decoding", which "can lead to performance degradation and endless repetitions".
- **Provider routing.** OpenRouter's provider is set only from `PROVIDER_ONLY` (`harness/src/config.ts:123-125`), and the runner strips that too (`evals/src/harness.ts:38`). The DeepSeek row will mix upstream providers.
- **Reasoning round-trip.** `REASONING_ROUNDTRIP` is also stripped, which leaves the harness default on (`harness/src/config.ts:142`). For DeepSeek, that changes what is sent back each step. It is a fixed setting that lives outside `eval.config.yaml`.
- **Why this is critical.** The fine-tuned GGUF will load in LM Studio as a new model, possibly with different preset values. "Only the model changed" would then be false, and you couldn't prove otherwise.
- **Fix:**
  - Put `sampling` (temperature, top_p, top_k, presence_penalty, seed, max_tokens) and `thinking` in `eval.config.yaml`, and pass them through to the harness.
  - Record the effective values, LM Studio's `GET /api/v0/models` and OpenRouter's per-response provider. `/api/v0/models` already reports `quantization: "Q8_0"` and `loaded_context_length: 40960`.
  - LM Studio documents `top_p, top_k, temperature, max_tokens, stop, presence_penalty, frequency_penalty, logit_bias, repeat_penalty, seed` as accepted ([docs](https://lmstudio.ai/docs/developer/openai-compat/chat-completions)). `min_p` is not listed.

**C2. No uncertainty is reported, and 11 tasks can't support a fine-tuning claim.**

- `summary.md` and `compare` print point estimates only (`evals/src/summary.ts:156-160, 193-201`).
- This run is 4/11 = 36.4%, with a Wilson 95% CI of **15.2%–64.6%**.
- Simulation (Appendix B):
  - task difficulty spread similar to this run;
  - the fine-tune modelled as a logit shift that raises the mean by 15 points;
  - a paired t-test on per-task pass rates, which clusters by task, at α = .05.

  Where a cell has two values, the first is a homogeneous effect and the second a heterogeneous one (per-task shift with SD 1 on the logit scale).

| | k=1 | k=3 | k=5 | k=10 |
|---|---|---|---|---|
| 95% CI half-width on one model's pass@1, 11 tasks | ±32 pp | ±24 pp | – | ±21 pp |
| power for +15 pp, 11 tasks | 0.12 | 0.27 / 0.23 | 0.40 / 0.32 | 0.67 / 0.46 |
| power for +15 pp, 30 tasks | 0.29 / 0.26 | 0.69 / 0.58 | 0.89 / 0.78 | 0.99 / 0.92 |
| power for +15 pp, 40 tasks | 0.37 | 0.83 / 0.75 | 0.96 / 0.89 | 1.00 / 0.97 |
| power for +15 pp, 60 tasks | 0.55 / 0.53 | 0.95 / 0.89 | 1.00 / 0.98 | 1.00 |

- More trials don't rescue 11 tasks, because the number of tasks is the binding constraint. **About 40 tasks × 3 trials, or about 30 × 5,** reaches roughly 80% power for +15 pp.
- **Fix:**
  - Report pass@1 as the mean of per-task pass rates, with a CI clustered by task.
  - Make `compare` report the paired per-task difference with its CI.
  - Grow the task set (§5.3).
  - Miller, ["Adding Error Bars to Evals"](https://arxiv.org/abs/2411.00640), recommends exactly this: clustered SEs in §2.2, paired analysis in §4.2, resampling in §3.1, power analysis in §5.

**C3. Infrastructure failures can be graded as model failures, and timeouts can't be explained from the run's own files.**

- **A stalled server is graded as a model failure.**
  - The harness catches every error in a turn and prints `Execution error: …` (`harness/src/index.ts:280-282`). `main()` then exits 0 (`harness/src/index.ts:495-496`).
  - Experiment E2: a fake server sends one SSE chunk, then goes silent. After 92 s the harness prints `Execution error: no data from the provider for 90000ms` and **exits with code 0**.
  - The runner only treats a timeout or a non-zero exit as an error (`evals/src/cli.ts:133-139`), so that trial would be graded on its checks like any other.
- **The HTTP-error path only looks right by accident.**
  - Experiment E1: a fake server returns HTTP 400 mid-turn. The harness prints the same `Execution error`, then Node aborts while exiting: `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94` (exit `3221226505` = 0xC0000409; 9 of 9 runs).
  - The runner records that as a harness crash only because of an unrelated libuv crash on Windows. If that crash goes away, for example with a Node upgrade, these runs become exit-0 "model failures" too.
- **Hitting `MAX_STEPS` ends the loop normally** (`harness/src/agent.ts:173-178`). The only trace is a final text, "(stopped after N steps …)", which the runner doesn't look for.
- **A missing turn record is tolerated without a flag.** That record's absence is the sign of a crash or a kill (`evals/src/score.ts:183-185`).
- **Timeouts are one bucket.**
  - The session log has no per-message timestamps.
  - Qwen's thinking is thrown away: `reasoning_content` becomes `delta.reasoning` (`harness/src/openaiCompat.ts:50`) and is only used for time-to-first-token (`harness/src/llm.ts:352-356`).
  - With `STREAM=0`, `harness.log` shows nothing while a generation runs.

  I could only tell a single runaway generation (csv-to-json) apart from slow progress (expr-eval) by reading LM Studio's log.
- **Fix in the harness:**
  - exit non-zero when a one-shot turn fails (Appendix D, D1);
  - write a `step` record after every model call, with usage, timestamps and finish reason, and mark a max-steps stop.
- **Fix in the runner:**
  - classify every trial as one of `passed | checks_failed | max_steps | timeout_generation | timeout_progress | harness_error | infra_error | runner_error`, using the exit code, the `Execution error` marker in `harness.log`, the turn and step records, and LM Studio's log or `/api/v0` stats for local runs;
  - print the counts per class.

### High

**H1. No isolation, every permission auto-approved, and the answers are on the same disk.**

- **No sandbox on Windows.** `sandbox.name()` returns `"none"` and `wrap()` returns `null` (`harness/src/sandbox.ts:89-90, 117-142`). Bash runs in Git Bash with your user rights.
- **Every permission is approved.**
  - The runner sets `BYPASS_PERMISSIONS=1` (`evals/src/harness.ts:71`), which approves every "ask" (`harness/src/index.ts:167-172`).
  - A comment in the config says "Hard-deny rules still apply" (`harness/src/config.ts:138`), but no rule ever returns `deny` (`harness/src/permissions.ts:209-277, 394-443`).
  - So `rm`, `curl`, `git push`, and reads or writes anywhere outside the workspace are all allowed.
- **The answers are on the same disk.** Reference solutions, hidden tests, and every earlier trial's transcript and workspace sit under `D:\code\harness-finetune-lab`, and the agent can read them.
- **The environment says where they are.** Started with `npm run eval`, npm sets `INIT_CWD=D:\code\harness-finetune-lab` and `npm_package_json=…\package.json` (checked with `npm run env`). The runner passes through the whole environment except a short denylist (`evals/src/harness.ts:38, 61-62`).
- **Evidence so far.** No trial in this run touched a path outside its workspace; I grepped every transcript. The risk is latent but real for the teacher: one broad `find` or `grep -r` by DeepSeek would contaminate both the baseline and the Phase 4 data.
- **Host risk.** A confused 8B model has unrestricted bash on your daily machine. The `npm install -g` redirect (`evals/src/harness.ts:74-75`) covers the one incident you've seen.
- **Fix, cheapest first:**
  1. A scorer check that flags any tool call whose path or command reaches outside the workspace, and especially into the lab repo. Quarantine those trials.
  2. Pass an allowlisted environment instead of a denylisted one.
  3. Keep `solution/` and `hidden/` encrypted or outside your user profile, or run trials under WSL2 (the harness already uses bubblewrap on Linux, `harness/src/sandbox.ts:124-139`) or in a container (Part 3).

**H2. Grading holes that can flip a trial.**

1. **Hidden tests depend on a file the agent can edit.** All 11 hidden test files, across 10 tasks, are ESM `.js` files, so they only load while `package.json` says `"type": "module"`.
   - Experiment E3: a correct CommonJS `wc.js` with `"type": "commonjs"` gives `SyntaxError: Cannot use import statement outside a module`. 0 tests run and the trial fails.
   - With no `type` field at all, Node 24's syntax detection rescues it.
   - This run's word-count-cli agent wrote CommonJS, so "fix package.json" is a likely repair.
   - **Fix:** ship hidden tests as `.mjs`. Two of them are restored copies of visible tests, `checkout-bugs/test/cart.test.js` and `fix-off-by-one/test/range.test.js`; rename those in `workspace/` too, along with the `npm test` script.
2. **slugify passed with a wrong implementation.**
   - The model hand-wrote an accent table, and the hidden tests only use letters that are in it. `slugify("Façade Niño")` returns `"fa-ade-ni-o"` (I ran the trial's final code).
   - The spec says accented letters become their ASCII letter, and the reference NFD solution returns `"facade-nino"`.
   - **Fix:** add `ç` and `ñ` cases. The reference handles them; don't add `ø` or `ß`, which NFD can't decompose.
3. **hello-cli can be hard-coded.** Its three checks are exactly the three examples in the prompt. Add one unseen name.
4. **word-count-cli has vacuous sub-tests.** With `wc.js` crashing on line 1, 2 of 4 tests still pass:
   - "prints a single line": empty stdout splits into one line;
   - "a missing file is an error": any crash exits 1 and writes to stderr.

   The all-or-nothing check hides this today, but any partial-credit metric wouldn't. Assert exit 0 and valid JSON in the first test, and show that a real file works before testing the error path.
5. **expr-eval's "no eval" check is both evadable and over-strict.**
   - `! grep -nE "\beval\s*\(|Function\s*\("` misses `globalThis["ev"+"al"]` and `node:vm`.
   - It rejects a comment such as `// no eval()` and an identifier such as `parseFunction(`.
   - **Fix:** run the tests under `node --disallow-code-generation-from-strings --test …`. Experiment E4 confirmed that `eval` and `new Function` then throw `EvalError`, and that the flag reaches the child processes `--test` starts. Add a grep for `vm`.
6. **callback-to-promise doesn't check that `main.js` uses `await`**, which the prompt asks for.
7. **`validate` proves less than it seems.**
   - It flags a task only when every check passes on the untouched workspace (`evals/src/cli.ts:192`). A check that passes vacuously goes unreported: expr-eval's grep passes when `src/calc.js` doesn't exist.
   - It runs the green case once, so flaky checks go unnoticed.
   - It has no "plausible wrong answer" fixtures.
   - **Fix:** report red per check, run green 3 times, and keep this run's failed final workspaces as must-fail fixtures. That gives mutation tests for free.

**H3. The tool-call validity headline, "100.0% of 34", carries almost no information and is biased upward.**

- **Subagent calls aren't scored.** The scorer only reads the main transcript's assistant messages (`evals/src/score.ts:150-169`). Subagent transcripts aren't written anywhere in structured form; the code comments that "Internal tool calls/results are private" (`harness/src/subagent.ts:44-45`). In this run, **26 of 70 model requests (37%)** came from subagents.
- **Tool calls written as text are invisible.**
  - When LM Studio can't parse a call, the text lands in `content`. The harness treats that as a final answer, so the scorer never sees a call.
  - `plan.md` §3 says this "is precisely the failure the Phase 2 tool-call validity scorer should count". The scorer can't count it.
  - None happened in this run; I scanned every assistant message.
- **Unknown arguments always pass.** No harness tool schema sets `additionalProperties: false` (checked in `tool-schemas.json`), so misspelled or made-up arguments count as valid.
- **The tool list is wrong for some calls.** The snapshot is a flat union of every role's tools (`evals/src/syncTools.ts:18-23`; lookup at `evals/src/score.ts:104`). A main-agent call to a tool it isn't offered in its current mode, such as `str_replace` in pipeline mode, counts as valid.
- **Valid isn't successful.** callback-to-promise is "10/10 valid" with 4 calls that returned errors: three `old_str was not found` and one duplicated edit.
- **Fix:**
  - score subagent calls, once the harness logs them;
  - detect tool calls written as text;
  - add an unknown-argument reason;
  - check each call against the tools offered in its mode;
  - report "calls that returned an error" next to validity.

**H4. A wall-clock timeout decides results.**

- `timeout_s: 300` (`evals/eval.config.yaml:12`, `evals/src/harness.ts:78`) makes pass or fail depend on GPU speed, on concurrency, and on whatever else the machine is doing.
- Generation also slows as the context grows: from 76 to 58 tok/s inside csv-to-json's single request.
- DeepSeek through OpenRouter runs at a different speed entirely, so the two rows aren't comparable.
- 3 of 7 failures here were this timeout.
- **Fix:**
  - budget by steps (already 40) plus a per-request `max_tokens` and a total-token cap;
  - keep a generous wall-clock safety net, for example 900 s;
  - report a safety-net kill as `infra_error`, not as a model failure.

### Medium

**M1. Cost and tokens disappear for killed runs.**

- Usage exists only in the end-of-turn record (`harness/src/index.ts:250-264`). The 3 timed-out trials therefore have `cost_usd: null` and `prompt_tokens: null`.
- `evals/src/summary.ts:109-110, 125-126` leaves them out of the mean, so mean cost is biased low exactly when runs are long. DeepSeek money spent on killed runs is never counted.
- **Fix:** per-step records (C3).

**M2. The reproducibility metadata has gaps.**

- `dirty` ignores untracked files (`--untracked-files=no`, `evals/src/harness.ts:24`). A new untracked module that the harness imports still counts as "clean".
- The lab repo's own commit and its task files aren't recorded, so editing a task silently changes a row.
- The model's identity is only its id string.
- The system prompt depends on the state of the machine:
  - skills come from `~/.agents/skills` (`harness/src/skills.ts:13-14`; none are installed today);
  - it includes the temp path (`harness/src/config.ts:80`);
  - the reminder includes the clock.
- **Fix:** record:
  - the lab repo's commit and dirty flag;
  - a hash of each task folder;
  - `/api/v0/models`;
  - Node and Git versions;
  - a hash of the system prompt and the tool list for each trial.

**M3. Not everything Phase 4 needs is being kept** (§4.5). The gaps:
- the thinking text, which is dropped;
- the `<env>` reminder, sent as an extra user message on every step (`harness/src/agent.ts:239-250`). It shows in LM Studio's request log but not in the session log;
- the exact tool list for each step;
- subagent transcripts;
- the in-place `strip`/`fit` edits to older messages (`harness/src/session.ts:164-168`).

**M4. `tool_errors` undercounts and is never shown.**
- It matches `^(Error|Permission denied)\b` (`evals/src/score.ts:170`), but the harness reports tool exceptions as `Tool error: …` (`harness/src/execute.ts:123`). The harness's own subagent code matches `Tool error`.
- It is computed but not printed in `summary.md`.

**M5. No resume, and runner errors lose their evidence.**
- An interrupted run has no summary and must be redone, even though `result.json` is written per trial (`evals/src/cli.ts:165`). A `--resume <runDir>` option that skips finished trials is about 20 lines.
- A runner exception records `duration_ms: 0` and no `harness.log` (`evals/src/cli.ts:151-161`).

### Low

- **L1.** `summary.md` prints `pass@1 | pass@1 | pass^1` when k=1 (`evals/src/summary.ts:156`). `compare` labels its columns with the largest k across runs (`evals/src/summary.ts:191`).
- **L2.** The global-install regex misses `npm -g install x` and `--location=global`, and never sees subagents' bash commands (`evals/src/score.ts:112`).
- **L3.** Unit tests cover only `score.ts` and `summary.ts`. These have no tests:
  - the environment filter (`evals/src/harness.ts:38, 61-76`);
  - timeouts and process-tree kills (`shell.ts`);
  - the checks;
  - workspace seeding;
  - `runTrial`.

  The fake servers in Appendix C are ready-made end-to-end fixtures.
- **L4.** Both API keys are passed to every run, whichever backend it uses (`evals/src/harness.ts:33`).
- **L5.** The harness runs `dotenv.config()` in the workspace directory (`harness/src/config.ts:4`). A task that ships a `.env` would silently set any option the runner leaves unset, such as `SYSTEM_PROMPT` or `COMPACT_AT`. Make `validate` reject it.
- **L6.** Concurrency above 1 isn't safe with this LM Studio setup: 4 slots share one unified 40,960-token KV cache (`n_slots = 4, n_ctx_slot = 40960, kv_unified = 'true'`, server log line 8). That comes on top of H4. Keep concurrency at 1.
- **L7.** `remove()` swallows failures (`evals/src/workspace.ts:54-60`). Leftover folders stay in `%TEMP%`, which is Git Bash's `/tmp`, where later trials can see them.

### What is good and should stay

- The real harness runs as a subprocess, exactly as a user would run it, with real tools on real files.
- `hidden/` is copied in after the run: it restores any test the agent edited and adds tests it never saw. The unseen inputs in csv-to-json and add-json-flag defeat hard-coding.
- `validate` red/green is the same idea as SWE-bench's gold-patch validation.
- The session log is written as the run goes, so killed runs keep a partial transcript.
- The process tree is killed on Windows, and stdin is closed.
- The zod config is strict, and the harness commit and a tool-schema snapshot are recorded.
- pass^k is reported.
- The code is small enough to read in an hour.

Nothing is badly over-engineered. The effort went to the wrong places: tool-call validity got a careful validator and unit tests, while confidence intervals, failure classes and pinned run conditions got nothing.

### One trial, end to end (fix-off-by-one)

**In the runner:**
1. `run` starts (`evals/src/cli.ts:48`) and loads the config and tasks (`config.ts:46, 99`).
2. `harnessInfo` reads the harness commit (`harness.ts:20`).
3. `preflight` sends `GET /v1/models` (`harness.ts:92`).
4. It writes `run.json` (`cli.ts:77`), and `pool` hands each trial to `runTrial` (`cli.ts:94, 115`).
5. `tempWorkspace` creates the trial folder under `%TEMP%` (`workspace.ts:11`).
6. `seed` copies `workspace/`, then runs `git init`, `add` and `commit` (`workspace.ts:28-33`).
7. `runHarness` builds the environment (`harness.ts:61-76`). It spawns `node …/tsx/dist/cli.mjs src/index.ts --local "<prompt>"`, with the workspace as cwd and a 300 s kill timer (`harness.ts:78-83`, `shell.ts:39-71`).

**Inside the harness:**
1. It picks the backend (`config.ts:97-108`) and checks the server (`index.ts:417-421`).
2. It creates the session log in `SESSION_DIR` (`index.ts:455`) and runs one turn (`index.ts:469-471`).
3. Each step of the agent loop (`agent.ts:169-376`):
   - POSTs to LM Studio (`openaiCompat.ts:219`);
   - runs the requested tools with no sandbox (`execute.ts:74`, `sandbox.ts:185`);
   - appends every message to the JSONL (`session.ts:170-179`).
4. It writes the turn record (`index.ts:264`) and exits 0.

**Back in the runner:**
1. It writes `harness.log` (`harness.ts:84-87`) and reads the session (`score.ts:16`).
2. `addHidden` restores `test/range.test.js` (`workspace.ts:36`).
3. The check runs `node --test test/range.test.js` in Git Bash with a 60 s limit (`checks.ts:30`).
4. It decides whether the run itself errored (`cli.ts:133-139`) and scores the transcript (`score.ts:133`).
5. `keep` copies the workspace without `.git` (`workspace.ts:47`), and `result.json` is written (`cli.ts:165`).

**In this trial:** the agent ran `npm test` (3 failing), globbed, listed the files, read `src/range.js`, changed `<` to `<=`, re-ran `npm test` (6/6 passing) and answered. That took 7 steps and 78.5 s.

---

## 3. Comparison with established tools

**Sources:**
- Discovery list: [danielrosehill/Awesome-AI-Evaluations-Tools](https://github.com/danielrosehill/Awesome-AI-Evaluations-Tools) at `4d040f8` (2026-10-05). Its `data/repos.csv` gives stars and last-commit dates at that snapshot.
- Live numbers: the GitHub API, 2026-10-09.
- Each tool: its docs plus a shallow clone of its source, read but never run:

| tool | commit | date |
|---|---|---|
| Inspect AI | `ba238b0` | 2026-10-08 |
| Harbor | `d5ac1be` | 2026-10-09 |
| SWE-bench | `02e7a74` | 2026-09-02 |
| Gorilla/BFCL | `6ea5797` | 2026-03-23 |
| promptfoo | `2e59ebb` | 2026-10-09 |
| Evalite | `e18a793` | default branch |

| | isolation | task format | grading | multi-trial statistics | tool-call scoring | cost / latency | trace viewer | stack | stars (list → live) · last commit · licence | fit for you |
|---|---|---|---|---|---|---|---|---|---|---|
| **yours** | none: host temp dir, every permission approved (H1) | `task.yaml`, `workspace/`, `hidden/`, `solution/` | bash exit code, stdout match, file exists; hidden tests copied in after the run; red/green `validate` | pass@1, pass@k, pass^k, flaky; no CI | JSON, name and a schema subset; main agent only | OpenRouter's billed cost; tokens; p50/p95 wall time | none (Markdown and JSONL) | TypeScript, ~1.1k lines | private | the system under test: **keep** |
| **Inspect AI** (UK AISI) | Docker per sample (`local` = none); the external-agent bridge needs a Linux sandbox | Python `Task`/`Sample` with `files` and `setup` | custom `@scorer` running commands in the sandbox | epochs and reducers, incl. unbiased `pass_at_k`, `at_least_k`, `pass_k_k`; `stderr(cluster=…)`, bootstrap, `ci()`, `ci_wilson()` | none built in; malformed arguments are repaired, then re-serialised for the agent | tokens per call; cost from price tables, not OpenRouter's bill | `inspect view`, VS Code extension, dataframes | Python ≥ 3.10 | 2,936 → 2,966 · 2026-10-08 · MIT | **borrow** the statistics; don't adopt |
| **Harbor** (Terminal-Bench team) | Docker locally, plus many cloud sandboxes; Windows task containers only for `oracle`/`nop` | folder: `instruction.md`, `task.toml`, `environment/Dockerfile`, `tests/test.sh`, `solution/solve.sh` | `test.sh` writes a reward to `/logs/verifier/reward.txt` (or JSON, multi-dimensional); `oracle` and `nop` agents | `n_attempts`; pass@k for binary rewards; mean reward or a custom `metric.py`; no CI | none; trajectories recorded in ATIF JSON | if the agent reports it | results viewer over ATIF trajectories | Python | 5,830 → 5,950 · 2026-10-09 · Apache-2.0 | **best migration target**, if you ever need isolation or outside credibility |
| **SWE-bench harness** | Docker image per instance (3 layers); Windows via Docker Desktop and WSL2; x86_64 recommended | instance: repo, commit, issue, `FAIL_TO_PASS` and `PASS_TO_PASS` test lists; predictions are patches | per-test status parsed from logs; FULL = every F2P passes and every P2P still passes; PARTIAL = some F2P | none (one run per prediction) | n/a (grades patches, not agents) | n/a | per-instance logs | Python | 5,971 → 5,993 · 2026-09-18 · MIT | **borrow** F2P/P2P and per-test results |
| **HarnessLab** | – | – | – | – | – | – | – | – | listed as `polskiTran/HarnessLab` with an empty CSV row; GitHub API returns **404** | **can't evaluate**: not public |
| **BFCL** (Gorilla) | n/a: runs simulated APIs | JSON entries with acceptable answers | AST match on name, required params, types (int→float allowed for Python), allowed values and unexpected params; multi-turn compares final API state | per-category accuracy | its whole purpose | on the leaderboard (**UNVERIFIED**) | leaderboard site | Python | 13,039 → 13,043 · 2026-04-13 · Apache-2.0 | **borrow** the error taxonomy; ignore as a runner |
| **promptfoo** | none for `exec:` providers | YAML: prompts × providers × tests with assertions | JS/Python assertions; `cost`, `latency`; `is-valid-openai-tools-call`, `tool-call-f1`; `trajectory:*` over traced tool calls; LLM rubrics | `--repeat N`, resume, caching | `is-valid-openai-tools-call`, `tool-call-f1` (also parses calls out of mixed text) | yes, as assertions | `promptfoo view` web UI | TypeScript | 25,717 → 25,840 · 2026-10-09 · MIT | **ignore** as a runner |
| **Evalite** | none | `.eval.ts` files on Vitest: `data`, `task`, `scorers` | TypeScript scorers | `trialCount` per eval | none | – | local web UI | TypeScript | 1,705 → 1,710 · 2026-04-28 · MIT | **ignore**: built for LLM-app outputs |

### Inspect AI

**What it does that yours doesn't:**
- confidence intervals, including clustered SEs and Wilson intervals;
- unbiased pass@k when you run more trials than k;
- a Docker sandbox per sample;
- resume (`eval-retry`, `inspect log recover`) and a viewer;
- per-sample limits on tokens, time and cost;
- adaptive concurrency;
- `inspect_swe`, which could run Claude Code or Codex on your tasks as reference rows.

**What yours does that it doesn't:**
- runs natively on Windows without Docker;
- measures tool-call validity from the agent's own log;
- uses OpenRouter's billed cost;
- detects global installs;
- has `validate` built in;
- puts nothing between the agent and the model.

**Verdict: borrow, don't adopt.** Running your harness under `sandbox_agent_bridge()` means:
- **A Linux container.** Tool injection raises "Only Linux containers are currently supported" (`src/inspect_ai/util/_sandbox/recon.py:43-50`).
- **A proxy that parses every tool call and repairs some malformed ones.** It recovers stray trailing quotes and parses non-JSON as YAML (`src/inspect_ai/model/_call_tools.py:1655-1735`). It then hands the call back re-serialised with `json.dumps` (`src/inspect_ai/model/_openai.py:372-379`). That hides exactly the malformed calls your fine-tune is meant to reduce.
- **Settings dropped.** Temperature and `max_tokens` are dropped unless `forward_generation_config=True`.
- **Polling.** About 0–2 s per model call (from the code, not measured).
- **Strict tool schemas** by default on the `openai-api` provider.

Estimated effort: 3–5 days, plus re-running every baseline.

### Harbor

**What it does that yours doesn't:**
- a container per trial, which fixes H1;
- `oracle` and `nop` agents (`src/harbor/agents/oracle.py`, `nop.py`): the same idea as your red/green;
- `n_attempts` and pass@k (`src/harbor/utils/pass_at_k.py`);
- `harbor jobs resume` (`src/harbor/cli/jobs.py:2294`);
- ATIF trajectories (messages, reasoning, tool calls and metrics in one JSON) with a viewer. That is close to the Phase 4 SFT format you'll need anyway;
- adapters for Terminal-Bench, SWE-bench and others;
- RL rollouts.

**What yours does that it doesn't:**
- runs the exact system you ship (Git Bash on Windows) without Docker;
- the validity scorer;
- OpenRouter cost.

**Integration path, from the docs and not tried:**
1. A `BaseInstalledAgent` subclass ([custom agents](https://harborframework.com/docs/agents/custom-agents)) that installs Node and your harness, then runs `node …/src/index.ts --local "<instruction>"` with `LOCAL_BASE_URL=http://host.docker.internal:1234/v1`.
2. One `node:24` Dockerfile shared by the tasks.
3. For each task, `tests/test.sh` wrapping your checks and writing the reward, and `solution/solve.sh` copying `solution/`.
4. Optionally, convert your session JSONL to ATIF in `populate_context_post_run`.

Estimated effort: about 2–3 days.

**Blockers:**
- Docker Desktop with WSL2 on Windows. Harbor's support for a Windows host is **UNVERIFIED**.
- LM Studio must listen beyond 127.0.0.1 (**UNVERIFIED**).
- The agent would run Linux bash, which makes it a different system under test, so every baseline has to be re-run.

**Verdict: not now. This is the one to move to if:**
- isolation becomes a must for the teacher runs; or
- you want "evaluated on Harbor" credibility; or
- you want to run your agent on Terminal-Bench as an external benchmark.

Your task layout already separates prompt, tests and solution, so converting later is mechanical.

### SWE-bench

**Has:**
- **Per-test status and explicit lists.** "Resolved" means every `FAIL_TO_PASS` test passes and every `PASS_TO_PASS` test still passes (`swebench/harness/grading.py:309-326`).
- **Gold-patch validation.**
- **A real-world task distribution.**

**Yours has:** an agent runner, multi-trial statistics, cost and tool scoring. SWE-bench grades patches; it doesn't run agents.

**Borrow:**
- List in each `task.yaml` which hidden tests must flip and which must keep passing. add-json-flag's "text output unchanged" is a P2P test.
- Report per-test results instead of a single exit code. "Failed" then becomes "fixed 2 of 3, broke none", which is also far better error analysis.

### HarnessLab

- The discovery list links `github.com/polskiTran/HarnessLab`, described as a "Benchmark that evaluates the harness around the LLM — context management, retry policies, tool selection, memory architecture".
- Its CSV row is empty, and the GitHub API returns 404 today. There is nothing to evaluate.
- The idea still matters. Your evals measure model and harness together. To claim anything about the harness itself, hold the model fixed and vary one harness setting, for example the "send a task subagent" advice (§4.3). That's an ablation row in your own runner, not another tool.

### BFCL

**Has:** call-level correctness against ground truth:
- name, required parameters, types, allowed values and unexpected parameters (`bfcl_eval/eval_checker/ast_eval/ast_checker.py:333-510`);
- irrelevance detection;
- multi-turn checks of the final state (`multi_turn_eval/multi_turn_checker.py:162-190`).

**Yours:** open-ended tasks with no ground-truth call sequence, so AST matching doesn't apply. Your grading is state-based (tests), like BFCL's multi-turn checker.

**Borrow** the invalid-call taxonomy (`missing_required`, `type_error`, unexpected parameter) and make unknown parameters invalid (H3). **Ignore** it as a runner.

### promptfoo and Evalite

- **promptfoo:**
  - It could wrap your CLI as an `exec:` provider and gives you `--repeat`, resume, caching, `cost`/`latency` assertions, tool-call assertions and a web viewer.
  - Its `tool-call-f1` assertion parses tool calls out of mixed text, a useful idea for detecting text-mode calls (H3).
  - But the workspace setup, hidden tests, process-tree kills and session-log scoring would all still be yours, written as a custom provider plus JS assertions. **Ignore.**
- **Evalite:** TypeScript-native evals on Vitest, with `trialCount` and a UI. It's built for LLM-app outputs under per-test timeouts; your trials are 5-minute subprocess runs. **Ignore.**

### Should you run the harness inside one of these instead of your own runner?

**No, not now.**
- Your runner is about 1.1k lines, you understand all of it, and every gap in this review is a small fix in code you own.
- Moving now buys statistics and a viewer, both cheap to add yourself.
- The price would be:
  - Docker on Windows;
  - a different shell for the agent;
  - re-running every baseline;
  - for Inspect, a proxy that repairs and re-serialises tool calls, hiding the very failure the fine-tune targets.

**The trade-off tips toward Harbor, not Inspect,** if you need real isolation for the teacher runs, outside credibility, or Terminal-Bench as a second, external benchmark. That costs an estimated 2–3 days.

**Borrow now** (about a day in total):
- task-clustered CIs and a paired comparison (Inspect; Miller 2024);
- F2P/P2P lists and per-test results (SWE-bench);
- an unknown-parameter error class (BFCL);
- resume (Harbor, Inspect and promptfoo all have it).

---

## 4. The latest run (Qwen3-8B, 11 tasks × 1 trial)

### 4.1 Per trial

"Steps" are main-loop model calls; "+N sub" is extra requests made by subagents, taken from LM Studio's log.

| task | result | steps | time | root cause | evidence |
|---|---|---|---|---|---|
| add-json-flag (med) | ✘ | 3 +3 sub | 57 s | **Model:** broken edit, never ran it | Step 2's `str_replace` inserted `let command = args[0]` below the existing `const [command]`, used an undefined `todos`, and left the if/else braces unbalanced. Result: `SyntaxError: Identifier 'command' has already been declared`. Step 3: "Would you like me to test this change?" |
| callback-to-promise (med) | ✘ timeout | 10 +7 sub | 300 s | **Model errors + time budget** | Step 7's code `{ ...parsed, port: 3000, host: "localhost" }` lets the defaults override the file, and returns defaults when the file is missing (the spec says reject). Steps 3, 5 and 6: `old_str was not found` (multi-line code collapsed into one line). Step 8 repeats step 7. Step 10 asks the read-only `task` subagent to edit `main.js`, which gets "Permission denied … this agent cannot ask". Steps 1–3 took 48 + 58 + 62 s. |
| checkout-bugs (hard) | ✘ | 8 +7 sub | 125 s | **Model:** half a fix, never ran the tests | Step 5's researcher named both bugs (dividing by 10, missing zero-padding). Step 7 only wraps `cents % 100` in `Math.abs`. The final answer claims it "ensures two-digit cents", which is false. `npm test` never ran, though the prompt says it fails. |
| csv-to-json (med) | ✘ timeout | 0 | 300 s | **Infra/config:** runaway thinking | One request generated 19,205 tokens in 298 s, produced no output, and was killed (LM Studio log lines 22422–22527). |
| expr-eval (hard) | ✘ timeout | 3 | 300 s | **Model logic + time budget** | Steps 1–2 generated 18.9k tokens in 280 s. The final `calc.js` fails `2*(3+4)-5/(1+1)` and `"2 3" throws`. Its only test was `evaluate('2+3')`. |
| fix-off-by-one (easy) | ✔ | 7 | 79 s | — | Ran `npm test` before (3 failing) and after (6/6). Changed `<` to `<=`. |
| hello-cli (easy) | ✔ | 2 | 19 s | pass; its claims are unverified | One `write_file`, then a list of outputs it never ran. |
| lru-cache (hard) | ✘ | 2 | 68 s | **Model:** logic bug, never ran it | `removeTail()` unlinks the node but never calls `this.cache.delete(key)`, so evicted keys stay in the Map. Its own example prints `2` where its comment says `undefined`. 4 of 8 hidden tests fail. Final answer: "The implementation is correct". |
| rename-symbol (easy) | ✔ | 3 +9 sub | 105 s | pass, through the pipeline | `plan_task` then `work_task`. The worker made 3 `str_replace` calls and ran `node main.js` (`harness.log:134`). `review_task` was skipped. |
| slugify (med) | ✔ *questionable* | 2 | 115 s | pass on narrow tests | Hand-written accent table. `slugify("Façade Niño")` returns `"fa-ade-ni-o"`. Never ran its code. |
| word-count-cli (med) | ✘ | 2 | 54 s | **Model:** ignored `"type": "module"`, never ran it | `const fs = require('fs')` gives `ReferenceError: require is not defined in ES module scope`. The prompt pointed at `samples/poem.txt`. |

**Behaviour per trial:**

| task | explored before editing | ran code or tests before claiming done | misread the task | looped |
|---|---|---|---|---|
| add-json-flag | only through a subagent; never read `todo.js` itself | no | ignored the existing argument parsing | no |
| callback-to-promise | through a subagent; read the file only after an edit failed | no | yes: missing-file semantics, default precedence | yes: 3 failed edits, then a repeat of a successful one |
| checkout-bugs | yes: grep, read `cart.js`, subagent | no | dropped half of the subagent's diagnosis | no |
| csv-to-json | – (never acted) | – | – | in its thinking: 19k tokens, no action |
| expr-eval | no (the workspace held only `package.json`) | one smoke test | no | no |
| fix-off-by-one | yes: tests, `ls`, read | yes, before and after | no | no |
| hello-cli | no (empty workspace) | no | no | no |
| lru-cache | no (empty workspace) | no | no | no |
| rename-symbol | yes: the planner grepped | yes: the worker ran `node main.js` | no | no |
| slugify | no | no | no | no |
| word-count-cli | no: never looked at `package.json` or the sample | no | yes: the module type | no |

### 4.2 Where the time went

I matched LM Studio's server-log requests to trials by start time (Appendix A). For every trial that finished, the generated-token total matches `result.json` exactly.

- **csv-to-json: one request, task 45160.**
  - Started 14:38:18 local time.
  - `n_gen` was 229 at 14:38:22, running at 76 tok/s.
  - `n_gen` was 19,205 at 14:43:14, running at 58 tok/s.
  - At 14:43:16 the log reads "Client disconnected. Stopping generation…", with `n_tokens = 22261`.

  The model never produced a visible token, never called a tool and never answered. It is a textbook unbounded-thinking runaway, and the model card warns about exactly this.
- **expr-eval: slow but progressing, not a runaway.**
  - Step 1: 12,938 tokens in 191 s, to write `calc.js`.
  - Step 2: 5,932 tokens in 89 s, to decide on `node -e "require('./src/calc.js')"`.
  - Step 3: 426 tokens in 6 s.
  - Step 4 was killed 12 s in.
- **callback-to-promise: 17 requests**, 10 from the main loop and 7 from subagents. Three main steps took 48, 58 and 62 s (3.7k–4.7k tokens each). A researcher subagent's request was still running when the kill came.
- **Overall:**
  - At least 105,014 tokens were generated in 25.4 minutes.
  - In the 8 finished trials, about **91%** of the tokens the main agent generated never appear in the transcript. That is thinking (estimated from transcript length at 3.5 characters per token).
  - The runner's own overhead (git, copies, checks, harness start-up) is about 2 s per trial, under 2% of the 138 s mean.

**What the recommended protocol costs:**
- At this run's mean of 138 s per trial, with thinking on:
  - 11 × 3 takes about 1.3 h per local row;
  - 40 × 3 takes about 4.6 h per local row.
- Thinking off should be much shorter (**UNVERIFIED** until it's measured, §5.4).
- The runner isn't the bottleneck: generation is, and most of it is thinking.
- DeepSeek costs money but little time (§5.4 #6). Once the budget is in steps and tokens rather than seconds (H4), remote rows can run with concurrency above 1. Keep local rows at 1 (L6).

### 4.3 Failure taxonomy

Following Hamel Husain's approach: notes on each failure in my own words first, then grouped.

**Notes:**
- edited without reading the surrounding code;
- trusted a subagent's paraphrase instead of the file;
- collapsed whitespace in `old_str`;
- repeated an edit that had already succeeded;
- changed the semantics against the spec (precedence, missing file);
- delegated an edit to a read-only helper;
- missed the module type in `package.json`;
- dropped half of a correct diagnosis;
- eviction logic bug;
- parser logic bug;
- one smoke test standing in for a test suite;
- never ran anything;
- asked the user whether it should test;
- claimed outputs it never saw;
- thought for 19k tokens without acting;
- thought for 280 s over two steps.

**Groups:**

| group | trials | count |
|---|---|---|
| **Finished without running the code or tests** | failures: add-json-flag, checkout-bugs, lru-cache, word-count-cli; passes: hello-cli, slugify | 4 failures (6 trials) |
| **Faulty implementation that one run would expose** | add-json-flag, lru-cache, expr-eval, callback-to-promise | 4 |
| **Misread the spec or project context** | word-count-cli (ESM package), callback-to-promise (missing file must reject), checkout-bugs (half the diagnosis dropped) | 3 |
| **Tool mechanics** | callback-to-promise (3 failed `old_str`, 1 duplicate edit, an edit delegated to read-only `task`); `task` used for one-file lookups in add-json-flag and checkout-bugs | 3 trials |
| **Thinking used up the time budget** | csv-to-json (19k tokens, no action), expr-eval (280 s in two steps), callback-to-promise (168 s in three steps) | 3 |
| **False success claims** | false: add-json-flag, checkout-bugs, lru-cache, word-count-cli; claimed checks it never ran: hello-cli, slugify | 4 + 2 |

**Primary root cause, one per failure:**
- model error: 4 (add-json-flag, checkout-bugs, lru-cache, word-count-cli);
- infrastructure or configuration: 1 (csv-to-json: unbounded thinking plus a wall-clock timeout);
- model error and time budget together: 2 (expr-eval, callback-to-promise);
- harness bug: 0;
- task flaw that changed a result: 0, plus one questionable pass (slugify).

**A contributing harness factor.** The system prompt says to "send a task subagent instead of grepping your way there yourself" (`harness/src/config.ts:69-73`). That is tuned for a strong model. The 8B model over-delegated trivial lookups in 3 trials, and once handed an edit to a read-only subagent.

### 4.4 Passes to treat with care

- **slugify:** wrong for `ç` and `ñ` (H2.2). It never ran its code, yet said it "passes the provided examples and edge cases".
- **hello-cli:** correct, but it listed outputs it never saw.
- **rename-symbol:** a legitimate pass, but:
  - it used the plan → work pipeline for a 3-file rename and skipped `review_task`;
  - the worker's tool calls exist only as rendered text in `harness.log`.

### 4.5 Is what each trial keeps enough to build Phase 4 training data?

**Partly.** For each trial you keep:
- the main transcript (session JSONL and `runs/*.json`);
- the rendered `harness.log`;
- the final workspace;
- pass or fail.

For supervised fine-tuning, each example has to equal what the model actually saw. These are missing:
1. **The `<env>` reminder.** It is sent as an extra user message on every request (in LM Studio's request log, `"content": "<env>\ntime: … git branch: main\n</env>"`), but it isn't in the session log (`harness/src/agent.ts:239-250`).
2. **The exact tool list per step.** It changes once the pipeline starts (`harness/src/agent.ts:364-369`, `harness/src/tools/index.ts:64-69`).
3. **Reasoning.**
   - Local `reasoning_content` is dropped.
   - For DeepSeek, `reasoningDetails` reach the session log only because round-trip is on by default (`harness/src/llm.ts:364`, `harness/src/agent.ts:280-285`).
   - Whether OpenRouter returns reasoning text for V4.1 Flash is **UNVERIFIED**.
4. **Subagent transcripts.** They were 37% of the calls in this run. A teacher run that uses `task` or the pipeline leaves gaps: tool results summarising work the training data never shows.
5. **`strip`/`fit` edits.** Older tool results can be shrunk in place without being logged (`harness/src/session.ts:164-168`).
6. **Sampling and thinking settings** (C1).

**Recommendation:**
- Add a harness flag, for example `WIRE_LOG=<file>`, that appends the exact request (messages and tools) and the full response (content, reasoning, tool calls, finish reason, usage, timestamps) for every call, from the main loop and from subagents.
- That one file becomes the source of truth for training data. It also fixes C3 (timing) and M1 (cost). `toWireMessages()` (`harness/src/openaiCompat.ts:156`) already produces the OpenAI shape.

---

## 5. Next steps

Effort: XS < 1 h, S ≈ ½ day, M 1–2 days, L ≥ 3 days.

**★ = must be done before any baseline is published.**

### 5.1 Eval-tool fixes

| # | action | impact | effort | |
|---|---|---|---|---|
| 1 | Failure classes. Flag a missing turn record, the `Execution error` marker and a max-steps stop (C3) | High | S | ★ |
| 2 | Per-task-clustered 95% CI in `summary`, and the paired difference with its CI in `compare` (C2) | High | S | ★ |
| 3 | Record run conditions (C1, M2): sampling, thinking, LM Studio `/api/v0/models`, the OpenRouter provider, the lab commit and task hashes, untracked files counted as dirty, a prompt and tool hash | High | S | ★ |
| 4 | Flag tool calls that reach outside the workspace; allowlist the environment (H1) | High | S | ★ |
| 5 | Budget by steps and tokens; the wall-clock limit becomes a safety net reported as `infra_error` (H4) | High | S | ★ |
| 6 | Validity metric (H3): detect text-mode tool calls, flag unknown arguments, use per-mode tool lists, report calls that returned an error. Label it "main agent only" until subagents are logged | Med | M | |
| 7 | `--resume`; keep timing when the runner errors (M5) | Med | S | |
| 8 | `validate`: red per check, green run 3×, failed attempts as must-fail fixtures (H2.7) | Med | S | |
| 9 | `tool_errors` regex and display, the k=1 header, an end-to-end test with a fake server (M4, L1, L3) | Low | S | |

### 5.2 Harness fixes

Freeze the harness after these, for every row. Any change after the first published row means re-running every row.

| # | action | impact | effort | |
|---|---|---|---|---|
| 1 | Exit non-zero when a one-shot turn fails (D1). Also look at the libuv assertion on the HTTP-error exit path (C3) | High | XS | ★ |
| 2 | Pass sampling, `max_tokens` and `presence_penalty` from the environment to both backends. Pin OpenRouter's provider (`order` plus `allow_fallbacks: false`) (C1) | High | S | ★ |
| 3 | Per-step records in the session log: usage, timestamps, finish reason, max-steps stop (C3, M1) | High | S | ★ |
| 4 | A wire log of every request and response, including reasoning, from the main loop and subagents (M3, H3) | High (Phase 4) | M | before generating Phase 4 data |
| 5 | Decide whether the "send a task subagent" advice stays in the prompt the small model sees. Any prompt change has to land before the first baseline | Med | XS | ★ (the decision) |
| 6 | In eval mode, deny paths outside the workspace, or run under WSL2 with bubblewrap (H1) | Med | M | |

### 5.3 Task set

| # | action | impact | effort | |
|---|---|---|---|---|
| 1 | Ship hidden tests as `.mjs` (H2.1) | High | XS | ★ |
| 2 | Fix slugify (`ç`/`ñ`), hello-cli (an unseen name), word-count-cli (vacuous sub-tests), expr-eval (`--disallow-code-generation-from-strings`) and callback-to-promise (`await` in `main.js`) (H2) | High | S | ★ |
| 3 | Grow to about 40 tasks, with a difficulty spread that puts base Qwen at 30–60%. Mirror the failure taxonomy: ESM and CJS projects, "the tests are failing" tasks, edits to existing code, error semantics | High | L | ★ for any claim about the fine-tune |
| 4 | Write the Phase 4 training-task list now, in a separate folder, before seeing more eval results. Add an overlap check: no shared files or prompts | High | M | before Phase 4 |

### 5.4 Baseline protocol

| # | action | impact | effort | |
|---|---|---|---|---|
| 1 | **Decide thinking on or off.** Run base Qwen at 11 × 3 once each way: thinking on with `max_tokens` capped, and thinking off via `/no_think` or the template's hard switch, both [documented on the model card](https://huggingface.co/Qwen/Qwen3-8B). Pick one and freeze it. With about 91% of tokens spent thinking and 3 of 11 trials timing out, "off" will be much faster. Whether it is better is an empirical question | High | S (≈2–3 h of GPU) | ★ |
| 2 | **Sampling.** Use the model card's values for the chosen mode (0.6 / 0.95 / 20 / 0 thinking, 0.7 / 0.8 / 20 / 0 non-thinking). Never greedy. Fix the `seed`, and add `presence_penalty` if repetition persists. DeepSeek: an explicit temperature and a pinned provider | High | XS | ★ |
| 3 | k ≥ 3 for every row (5 if time allows), with the same tasks, the same k and the same budgets | High | – | ★ |
| 4 | Budget: `max_steps` 40, a per-request `max_tokens` (for example 8k), and a 900 s wall-clock safety net | High | XS | ★ |
| 5 | Publish, per row: pass@1 with a task-clustered 95% CI, the paired difference against base with its CI, pass^k, and failure-class counts. Write "local cost = $0 (electricity not counted)" | High | S | ★ |
| 6 | **DeepSeek baseline cost.** Estimated $0.2–1.6 for 11 × 3 and $0.7–6 for 40 × 3, based on OpenRouter's list price on 2026-10-09 ($0.30/M input, $1.20/M output, $0.006/M cache read) and your 12 earlier remote harness turns ($0.006 median, $0.048 at p90). **It needs your go-ahead** | Med | XS | |

### 5.5 What Phase 4 training data should target

| # | behaviour | why (this run) |
|---|---|---|
| 1 | **Run it before claiming it.** Execute the program or tests after the last edit and before answering | 7 of 10 acting trials never ran anything. All 4 non-timeout failures would have been caught by one run |
| 2 | Read before editing; copy `old_str` exactly from `read_file` output; never repeat an edit that succeeded | callback-to-promise: 3 failed edits and 1 duplicate |
| 3 | Respect project conventions: `package.json` `type`, existing declarations | word-count-cli, add-json-flag |
| 4 | Delegate with discipline: no `task` on tiny repos, and never send an edit to a read-only subagent | add-json-flag, checkout-bugs, callback-to-promise |
| 5 | Deliberate briefly. With thinking on, prefer teacher trajectories with short reasoning; with thinking off, train in the non-thinking format | csv-to-json, expr-eval |
| 6 | Follow the spec on errors and defaults: reject versus fall back, precedence | callback-to-promise |

**Selection rule for teacher data:**
- Keep a DeepSeek trajectory only if it passed **and** ran code after its last edit.
- Generate it in default mode, or with subagents logged.
- Capture it with the wire log (§5.2 #4), so each training example equals what the model saw.

---

## 6. `plan.md`: what held up and what didn't

| plan item | status |
|---|---|
| §5.1 licence first; own runner instead of forking | Done, and the right call (Part 3) |
| §5.3 adapter, `command` check, validity scorer | Done. The scorer misses text-mode calls, which §3 of the plan explicitly asked for (H3) |
| §5.4 10–15 eval tasks; **training-task list kept separately** | 11 eval tasks exist. There is no training-task folder yet: write it before looking at more results |
| §5.6 "At least 3 trials. Change only the model between runs." | The latest run used 1 trial. "Only the model" isn't guaranteed while sampling, thinking, provider routing and the timeout float (C1, H4) |
| §4 "Qwen3 thinking … decide how you want it handled, and keep it consistent" | Still open. In LM Studio thinking arrives in `reasoning_content`, and the harness drops it |
| §2 Step 6 "Set `REASONING_ROUNDTRIP=0` in your local `.env`" | Doesn't matter in evals: the runner ignores `.env` apart from keys, and the local path never produces `reasoningDetails`. For DeepSeek the default (on) applies, so pin it explicitly |
| §5.5 fix the 4 known harness issues (Git Bash `nul` / `cd /d`, `/tmp` and `node_modules`) | Not verified. None showed up in this run, and tasks without dependencies make `/tmp` and `node_modules` moot |
| §0 table: `contextWindow` defaults to 64k | Stale: the local default is now 32k (`harness/src/config.ts:127`). Harmless, since the runner sets 40,000 |
| §6 reuse `toWireMessages()` for Phase 4 | Yes, but training data also needs the reminder, the tool list, reasoning and subagent turns (§4.5) |
| Phase 1 "Done when" checkboxes | Still unticked, though the status note says Phase 1 is done. Tick them or delete them |

---

## Appendix A: matching LM Studio requests to trials

Run with `node lmslog.mjs <LM Studio log> <run>/trials`. It prints one row per `/v1/chat/completions` request, with message count, context size, generated tokens, duration and whether it was killed.

<details><summary>lmslog.mjs</summary>

```js
import fs from "node:fs";
import path from "node:path";

const [logFile, trialsDir] = process.argv.slice(2);
const text = fs.readFileSync(logFile, "utf-8").split(/\r?\n/);

// Trial windows from session meta (start) + result duration.
const windows = [];
for (const task of fs.readdirSync(trialsDir)) {
  const dir = path.join(trialsDir, task, "1");
  const sdir = path.join(dir, "session");
  const jsonl = fs.readdirSync(sdir).find((f) => f.endsWith(".jsonl"));
  const meta = JSON.parse(fs.readFileSync(path.join(sdir, jsonl), "utf-8").split("\n")[0]);
  const result = JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf-8"));
  const start = new Date(meta.created).getTime();
  windows.push({ task, start, end: start + result.duration_ms + 2000 });
}
windows.sort((a, b) => a.start - b.start);

const ts = (line) => {
  const m = line.match(/^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\]/);
  return m ? new Date(m[1].replace(" ", "T") + "+02:00").getTime() : null; // log is local time (CEST)
};

const reqs = [];
let cur = null;
let lastTs = null;
for (const line of text) {
  const t = ts(line);
  if (t) lastTs = t;
  if (line.includes("Received request: POST to /v1/chat/completions")) {
    cur = { start: t, msgs: null, gen: null, maxNgen: 0, disconnected: false, end: null };
    reqs.push(cur);
    continue;
  }
  if (!cur) continue;
  let m;
  if ((m = line.match(/Running chat completion on conversation with (\d+) messages/))) cur.msgs = Number(m[1]);
  if ((m = line.match(/n_gen =\s+(\d+)/))) cur.maxNgen = Math.max(cur.maxNgen, Number(m[1]));
  if ((m = line.match(/\s eval time =\s+([\d.]+) ms \/\s+(\d+) tokens/)) && !line.includes("prompt eval")) cur.gen = Number(m[2]);
  if (line.includes("Client disconnected")) cur.disconnected = true;
  if ((m = line.match(/stop processing: n_tokens = (\d+)/))) cur.nTokens = Number(m[1]);
  if (line.includes("Finished streaming response")) cur.end = lastTs;
}

const run0 = windows[0].start - 5000;
const runEnd = windows[windows.length - 1].end + 5000;
let lastTask = null;
for (const r of reqs) {
  if (!r.start || r.start < run0 || r.start > runEnd) continue;
  const w = windows.filter((w) => r.start >= w.start - 1500).pop();
  const task = w ? w.task : "?";
  if (task !== lastTask) console.log(`\n### ${(lastTask = task)}`);
  const dur = r.end ? ((r.end - r.start) / 1000).toFixed(0) : "?";
  const gen = r.gen ?? (r.maxNgen ? `~${r.maxNgen}+` : "?");
  console.log(`${new Date(r.start).toISOString().slice(11, 19)}Z msgs=${r.msgs} ctx=${r.nTokens ?? "?"} gen=${gen} dur=${dur}s${r.disconnected ? "  KILLED" : ""}`);
}
```
</details>

## Appendix B: power simulation

Task difficulty is drawn from `Beta(0.6, 1.05)` (mean 0.36, wide spread). The fine-tune adds a logit shift calibrated so the mean rises by 15 points: either the same shift for every task, or a per-task shift drawn from N(μ, 1). Each model gets k Bernoulli trials per task. The test is a paired t-test on per-task pass-rate differences, one-sided at the 0.025 level, which is the same as two-sided at 0.05. 3,000 simulations per cell.

<details><summary>power.mjs (core)</summary>

```js
const rand = Math.random;
function gammaSample(k) {
  if (k < 1) return gammaSample(k + 1) * Math.pow(rand(), 1 / k);
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do { const u1 = rand(), u2 = rand(); x = Math.sqrt(-2 * Math.log(u1 + 1e-12)) * Math.cos(2 * Math.PI * u2); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = rand();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
const beta = (a, b) => { const x = gammaSample(a), y = gammaSample(b); return x / (x + y); };
const logit = (p) => Math.log(p / (1 - p)), sigm = (x) => 1 / (1 + Math.exp(-x));
const clamp = (p) => Math.min(1 - 1e-4, Math.max(1e-4, p));
const tcrit = (df) => (df >= 60 ? 2.0 : df >= 40 ? 2.021 : df >= 30 ? 2.042 : df >= 20 ? 2.086 : df >= 10 ? 2.228 : 2.262);
const A = 0.6, B = 1.05, DELTA = 1.01; // DELTA: logit shift that adds +15 pp on average

function power(nTasks, k, sims = 3000) {
  let hits = 0;
  for (let s = 0; s < sims; s++) {
    const d = [];
    for (let i = 0; i < nTasks; i++) {
      const p0 = clamp(beta(A, B)), p1 = sigm(logit(p0) + DELTA);
      let x0 = 0, x1 = 0;
      for (let j = 0; j < k; j++) { if (rand() < p0) x0++; if (rand() < p1) x1++; }
      d.push((x1 - x0) / k);
    }
    const m = d.reduce((a, b) => a + b, 0) / nTasks;
    const se = Math.sqrt(d.reduce((a, b) => a + (b - m) ** 2, 0) / (nTasks - 1) / nTasks);
    if (se === 0 ? m > 0 : m / se > tcrit(nTasks - 1)) hits++;
  }
  return hits / sims;
}
for (const n of [11, 20, 30, 40, 60]) console.log(n, [1, 3, 5, 10].map((k) => power(n, k).toFixed(2)).join(" "));
```
</details>

## Appendix C: experiments run for this review

No model was called in any of them.

| id | what | result |
|---|---|---|
| E1 | Harness against a fake server: `/v1/models` OK, `/chat/completions` returns HTTP 400 | Prints `Execution error: … HTTP 400 …`, then `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94`. Exit 127 under Git Bash and 3221226505 when spawned from Node, in 9 of 9 runs. No assistant message and no turn record in the session |
| E2 | Harness against a fake server that sends one SSE chunk and then stalls | After 92 s: `Execution error: no data from the provider for 90000ms`, **exit 0**, no assertion |
| E3 | word-count-cli workspace with a correct CommonJS `wc.js` and the hidden tests | With no `type`: 4/4 pass, because Node 24 detects the syntax. With `"type": "commonjs"`: `SyntaxError: Cannot use import statement outside a module`, 0 tests run |
| E4 | `node --disallow-code-generation-from-strings` | `eval` and `new Function` throw `EvalError`, including inside `node --test` child processes |
| E5 | `npm_config_local_prefix` and `INIT_CWD` pointing at another package, then `npm test` in a workspace | npm still runs the workspace's own script. The npm variables leak information (the lab path) but don't hijack npm |

Also checked by running the trials' final code: add-json-flag's `node --check todo.js`, word-count-cli's `node wc.js samples/poem.txt`, slugify on unseen input, and lru-cache on its own example.

## Appendix D: proposed diffs (not applied)

**D1. Harness: a failed one-shot turn must not exit 0** (`harness/src/index.ts`)
```diff
+let turnFailed = false;
 ...
   } catch (err: any) {
     pause();
     ui.note(`Execution error: ${err.message || String(err)}`);
+    turnFailed = true;
   } finally {
 ...
     if (cliPrompt) {
       await runTurn(cliPrompt);
+      if (turnFailed) process.exitCode = 3; // scripts and evals must see a failed turn
       return;
     }
 ...
 main()
-  .then(() => process.exit(0))
+  .then(() => process.exit(process.exitCode ?? 0))
```

**D2. Runner: count `Tool error:` results** (`evals/src/score.ts:170`)
```diff
-    if (message.role === "tool" && /^(Error|Permission denied)\b/.test(String(message.content ?? ""))) score.tool_errors++;
+    if (message.role === "tool" && /^(Error|Permission denied|Tool error)\b/.test(String(message.content ?? ""))) score.tool_errors++;
```

**D3. Runner: untracked files make the harness dirty** (`evals/src/harness.ts:24`)
```diff
-  return { dir, commit, dirty: git("status", "--porcelain", "--untracked-files=no").length > 0 };
+  return { dir, commit, dirty: git("status", "--porcelain").length > 0 };
```

**D4. Runner: CI clustered by task** (`evals/src/summary.ts`). This is a t-interval on per-task pass rates; a bootstrap over tasks is the robust alternative when there are few tasks.
```ts
const T975 = [NaN, 12.71, 4.30, 3.18, 2.78, 2.57, 2.45, 2.36, 2.31, 2.26, 2.23, 2.20, 2.18, 2.16, 2.14, 2.13, 2.12, 2.11, 2.10, 2.09, 2.09];
/** Mean of per-task values with a 95% t-interval: tasks, not trials, are the independent units. */
export function clusteredCI(values: number[]): { mean: number; low: number; high: number } {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { mean, low: NaN, high: NaN };
  const sd = Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1));
  const half = ((n - 1 < T975.length ? T975[n - 1] : 1.96) * sd) / Math.sqrt(n);
  return { mean, low: mean - half, high: mean + half };
}
// one model: clusteredCI(tasks.map((t) => t.pass_rate))
// base vs fine-tune: clusteredCI(sharedTaskIds.map((id) => ft[id].pass_rate - base[id].pass_rate))
```

**D5. Task: expr-eval without a grep** (`evals/tasks/expr-eval/task.yaml`, with hidden tests renamed to `.mjs`)
```yaml
checks:
  - name: evaluates and rejects correctly, with eval and Function disabled
    type: command
    run: node --disallow-code-generation-from-strings --test eval_tests/calc.test.mjs
  - name: no vm module
    type: command
    run: '! grep -nE "node:vm|require\(.vm.\)|from .vm." src/calc.js'
```

**D6. Harness: sampling from the environment** (sketch, `harness/src/openaiCompat.ts` and `harness/src/config.ts`)
```diff
+  // config.ts: sampling: process.env.SAMPLING ? JSON.parse(process.env.SAMPLING) : undefined
   const body = {
     model: request.model,
     messages: toWireMessages(request.messages),
+    ...(request.sampling ?? {}), // temperature, top_p, top_k, presence_penalty, seed
     stream: true,
```
The runner then sets `SAMPLING` and `MAX_OUTPUT_TOKENS` from `eval.config.yaml` and records them in `run.json`.
