import { test } from "node:test";
import assert from "node:assert/strict";
import type { TrialClass } from "../src/classify.js";
import { isValid } from "../src/classify.js";
import { comparison, percentile, summarise, toMarkdown, type TrialResult } from "../src/summary.js";

function trial(task: string, n: number, passed: boolean, extra: Partial<TrialResult> = {}): TrialResult {
  const cls: TrialClass = extra.class ?? (passed ? "passed" : "checks_failed");
  return {
    task,
    difficulty: "easy",
    trial: n,
    passed: cls === "passed",
    class: cls,
    class_detail: null,
    valid: isValid(cls),
    error: null,
    exit_code: 0,
    timed_out: false,
    duration_ms: 1000 * n,
    in_flight_s: null,
    checks: [{ name: "tests", passed, detail: passed ? "" : "exit 1" }],
    tool_calls: 4,
    valid_tool_calls: 3,
    invalid_tool_calls: [{ tool: "read_file", reason: "schema", detail: "args.path is required" }],
    validity_scope: "all_agents",
    tool_errors: 0,
    tools_used: {},
    global_installs: [],
    escapes: [],
    steps: 5,
    cost_usd: 0.001,
    prompt_tokens: 100,
    completion_tokens: 10,
    reasoning_tokens: null,
    cached_tokens: 0,
    usage_source: "turn",
    final_response: "ok",
    stop_reason: "done",
    turn_error: null,
    system_prompt_sha256: null,
    tools_sha256: null,
    harness_settings: null,
    wire_calls: null,
    served_by: [],
    ...extra
  };
}

const meta = {
  model: "m",
  profile: { backend: "local" as const, model: "m", sampling: { temperature: 0.6, top_p: 0.95, top_k: 20 }, thinking: "default" as const },
  harness: { dir: "h", commit: "abc1234", dirty: false },
  defaults: { context_window: 40000, timeout_s: 900, max_steps: 40, max_tokens: 8192, max_turn_tokens: 100000, trials: 3 },
  started: "2026-10-09T12:00:00.000Z",
  finished: "2026-10-09T12:10:00.000Z"
};

test("pass@1 averages tasks, not trials; invalid trials are counted but never graded", () => {
  // a: 3/3, b: 1/3 (flaky), c: 0/2 valid and one trial killed by the wall clock
  const results = [
    trial("a", 1, true), trial("a", 2, true), trial("a", 3, true),
    trial("b", 1, false), trial("b", 2, true), trial("b", 3, false),
    trial("c", 1, false), trial("c", 2, false),
    trial("c", 3, false, { class: "timeout_progress", timed_out: true, error: "wall-clock safety net hit", cost_usd: null })
  ];
  const s = summarise(results, meta);
  assert.equal(s.overall.tasks, 3);
  assert.equal(s.overall.trials, 8, "the killed trial is not graded");
  assert.equal(s.overall.invalid_trials, 1);
  assert.equal(s.overall.k, 3);
  assert.ok(Math.abs(s.overall.pass_at_1 - (1 + 1 / 3 + 0) / 3) < 1e-12, "mean of per-task pass rates");
  assert.equal(s.overall.trial_pass_rate, 4 / 8);
  assert.equal(s.overall.pass_at_k, 2 / 3, "a and b were solved at least once");
  assert.equal(s.overall.pass_pow_k, 1 / 3, "only a was solved every time");
  assert.equal(s.overall.flaky_tasks, 1);
  assert.equal(s.overall.valid_tool_call_rate, 27 / 36, "tool calls count in every trial, valid or not");
  assert.deepEqual(s.overall.invalid_by_reason, { schema: 9 });
  assert.deepEqual(s.overall.by_class, { passed: 4, checks_failed: 4, timeout_progress: 1 });
  assert.equal(s.overall.timeouts, 1);
  assert.equal(s.overall.run_errors, 1);
  assert.ok(Math.abs(s.overall.total_cost_usd! - 0.008) < 1e-12, "a run with no cost is left out, not counted as 0");
  assert.deepEqual(
    s.tasks.map((t) => [t.task, t.trials, t.invalid, t.passes, t.flaky]),
    [["a", 3, 0, 3, false], ["b", 3, 0, 1, true], ["c", 2, 1, 0, false]]
  );
  const [low, high] = [s.overall.pass_at_1_ci.low!, s.overall.pass_at_1_ci.high!];
  assert.ok(low >= 0 && high <= 1 && low < s.overall.pass_at_1 && s.overall.pass_at_1 < high, "an interval around the mean, inside [0, 1]");
});

test("a task with no valid trial is left out of the means, not counted as zero", () => {
  const results = [trial("a", 1, true), trial("b", 1, false, { class: "infra_error", error: "HTTP 500", cost_usd: null })];
  const s = summarise(results, meta);
  assert.equal(s.overall.tasks, 1);
  assert.equal(s.overall.pass_at_1, 1);
  assert.equal(s.tasks.find((t) => t.task === "b")!.pass_rate, null);
  assert.deepEqual(s.overall.pass_at_1_ci, { low: null, high: null }, "one task has no spread to estimate");
});

test("thinking share and the tool-call scope are reported where known", () => {
  const withReasoning = summarise([trial("a", 1, true, { completion_tokens: 100, reasoning_tokens: 91 }), trial("b", 1, true, { completion_tokens: 100, reasoning_tokens: 91 })], meta);
  assert.equal(withReasoning.overall.thinking_share, 0.91);
  assert.equal(withReasoning.overall.tool_call_scope, "all_agents");
  const without = summarise([trial("a", 1, true, { validity_scope: "main_only" })], meta);
  assert.equal(without.overall.thinking_share, null);
  assert.equal(without.overall.tool_call_scope, "main_only", "one trial without a wire log makes the headline main-agent only");
});

test("percentile is nearest-rank", () => {
  const values = [5, 1, 4, 2, 3, 6, 7, 8, 9, 10];
  assert.equal(percentile(values, 50), 5);
  assert.equal(percentile(values, 95), 10);
  assert.equal(percentile([42], 95), 42);
  assert.equal(percentile([], 50), 0);
});

test("the markdown report carries the interval, the outcome classes and the conditions", () => {
  const results = [trial("a", 1, true), trial("b", 1, false)];
  const s = summarise(results, meta);
  const md = toMarkdown(s, results);
  assert.match(md, /^# m/);
  assert.match(md, /sampling temp 0\.6, top_p 0\.95, top_k 20 · thinking default/);
  assert.match(md, /budget 40 steps, 8192 tokens\/request, 100000 tokens\/trial, safety net 900s/);
  assert.match(md, /\| pass@1 \(95% CI over 2 tasks\) \| valid tool calls \(all agents\)/, "one trial per task: no pass@1 | pass@1 | pass^1 columns");
  assert.match(md, /\| 50\.0% \[0\.0, 100\.0\] \|/);
  assert.match(md, /\| passed \| 1 \| yes \|/);
  assert.match(md, /## Failures\n\n- \*\*b\*\* #1: `tests`/);
  assert.match(md, /## Invalid tool calls/);
  assert.doesNotMatch(md, /Unpinned|invalid and left out/);
});

test("the report refuses to look comparable when the conditions were unpinned or trials were invalid", () => {
  const results = [trial("a", 1, true), trial("b", 1, false, { class: "infra_error", class_detail: "ProviderError: no data from the provider for 90000ms", error: "x" })];
  const conditions = { unpinned: ["sampling.temperature", "provider"], lab: { commit: "c0ffee1", dirty: true } } as any;
  const s = summarise(results, { ...meta, harness: { ...meta.harness, dirty: true }, conditions });
  const md = toMarkdown(s, results);
  assert.match(md, /Unpinned run conditions: sampling\.temperature, provider/);
  assert.match(md, /1 of 2 trials are invalid and left out/);
  assert.match(md, /--resume/);
  assert.match(md, /## Invalid trials \(not graded\)\n\n- \*\*b\*\* #1: infra_error - ProviderError/);
  assert.match(md, /harness had uncommitted changes/);
});

test("a run with several trials per task shows pass@k, pass^k and flaky", () => {
  const results = [trial("a", 1, true), trial("a", 2, false)];
  const md = toMarkdown(summarise(results, meta), results);
  assert.match(md, /\| pass@1 \(95% CI over 1 tasks\) \| pass@2 \| pass\^2 \| flaky \|/);
});

test("compare: every run against the first, task by task, with an interval; mismatched runs are flagged", () => {
  const base = summarise([trial("a", 1, false), trial("b", 1, false), trial("c", 1, true), trial("d", 1, false)], { ...meta, model: "base" });
  const better = summarise([trial("a", 1, true), trial("b", 1, true), trial("c", 1, true), trial("d", 1, false)], { ...meta, model: "tuned" });
  const table = comparison([base, better]);
  assert.match(table, /\| base \| local \| `abc1234` \| 1 \| 25\.0% \[/);
  assert.match(table, /vs base \(paired, 95% CI\)/);
  assert.match(table, /\| baseline \|/);
  assert.match(table, /\| tuned \| local \| `abc1234` \| 1 \| 75\.0% \[[^|]*\| \+50\.0% \[[^|]* on 4 tasks \|/);
  assert.match(table, /\| a \| 0\/1 \| 1\/1 \|/);

  const fewer = summarise([trial("a", 1, true), trial("e", 1, true)], { ...meta, model: "odd" });
  assert.match(comparison([base, fewer]), /do not cover the same tasks/);
  const unpinned = summarise([trial("a", 1, true)], { ...meta, model: "u", conditions: { unpinned: ["sampling.temperature"] } as any });
  assert.match(comparison([base, unpinned]), /Unpinned run conditions[^\n]*u: unpinned sampling\.temperature/);
});

test("compare reads summaries written before classes and intervals existed", () => {
  const old: any = {
    model: "old",
    profile: { backend: "local", model: "old" },
    harness: { commit: "f552961" },
    overall: { k: 1, pass_pow_k: 0.36, valid_tool_call_rate: 1, mean_cost_usd: null, p50_duration_ms: 1000, p95_duration_ms: 2000, mean_steps: 3 },
    tasks: [{ task: "a", trials: 1, passes: 1, pass_rate: 1 }, { task: "b", trials: 1, passes: 0, pass_rate: 0 }]
  };
  const table = comparison([old]);
  assert.match(table, /\| old \| local \| `f552961` \| 1 \| 50\.0% \[0\.0, 100\.0\] \| baseline \|/);
});

test("a task that lost a trial to an invalid attempt cannot claim pass^k", () => {
  // t1: 3 of 3. t2: only one valid trial left (it passed), two were killed.
  const results = [
    trial("t1", 1, true), trial("t1", 2, true), trial("t1", 3, true),
    trial("t2", 1, true),
    trial("t2", 2, false, { class: "timeout_progress", error: "x" }),
    trial("t2", 3, false, { class: "timeout_progress", error: "x" })
  ];
  const s = summarise(results, meta);
  assert.equal(s.overall.k, 3);
  assert.equal(s.overall.pass_pow_k, 0.5, "only t1 was solved in all 3 trials");
  assert.equal(s.overall.pass_at_k, 1);
});

test("attempts a resume replaced stay in the report, so an exclusion cannot disappear", () => {
  const results = [trial("a", 1, true)];
  const excluded = [
    { task: "a", trial: 1, class: "contaminated" as const, detail: "the agent reached outside its workspace (see escapes)" },
    { task: "b", trial: 2, class: "timeout_generation" as const, detail: null }
  ];
  const s = summarise(results, { ...meta, excluded, resumes: 2 });
  assert.deepEqual(s.excluded, excluded);
  const md = toMarkdown(s, results);
  assert.match(md, /## Earlier attempts left out and re-run/);
  assert.match(md, /Resumed 2 time\(s\)/);
  assert.match(md, /- \*\*a\*\* #1: contaminated - the agent reached outside/);
  assert.match(md, /- \*\*b\*\* #2: timeout_generation\n/);
  assert.doesNotMatch(toMarkdown(summarise(results, meta), results), /Earlier attempts/);
});
