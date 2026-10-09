import { test } from "node:test";
import assert from "node:assert/strict";
import { comparison, percentile, summarise, toMarkdown, type TrialResult } from "../src/summary.js";

function trial(task: string, n: number, passed: boolean, extra: Partial<TrialResult> = {}): TrialResult {
  return {
    task,
    difficulty: "easy",
    trial: n,
    passed,
    error: null,
    exit_code: 0,
    timed_out: false,
    duration_ms: 1000 * n,
    checks: [{ name: "tests", passed, detail: passed ? "" : "exit 1" }],
    tool_calls: 4,
    valid_tool_calls: 3,
    invalid_tool_calls: [{ tool: "read_file", reason: "schema", detail: "args.path is required" }],
    tool_errors: 0,
    tools_used: {},
    global_installs: [],
    steps: 5,
    cost_usd: 0.001,
    prompt_tokens: 100,
    completion_tokens: 10,
    cached_tokens: 0,
    final_response: "ok",
    ...extra
  };
}

const meta = {
  model: "m",
  profile: { backend: "local" as const, model: "m" },
  harness: { dir: "h", commit: "abc1234", dirty: false },
  defaults: { context_window: 40000, timeout_s: 300, max_steps: 40, trials: 3 },
  started: "2026-10-09T12:00:00.000Z",
  finished: "2026-10-09T12:10:00.000Z"
};

test("pass@1, pass@k and pass^k", () => {
  // a: 3/3, b: 1/3 (flaky), c: 0/3
  const results = [
    trial("a", 1, true), trial("a", 2, true), trial("a", 3, true),
    trial("b", 1, false), trial("b", 2, true), trial("b", 3, false),
    trial("c", 1, false), trial("c", 2, false), trial("c", 3, false, { timed_out: true, error: "timed out after 300s", cost_usd: null })
  ];
  const s = summarise(results, meta);
  assert.equal(s.overall.k, 3);
  assert.equal(s.overall.pass_at_1, 4 / 9);
  assert.equal(s.overall.pass_at_k, 2 / 3, "a and b were solved at least once");
  assert.equal(s.overall.pass_pow_k, 1 / 3, "only a was solved every time");
  assert.equal(s.overall.flaky_tasks, 1);
  assert.equal(s.overall.valid_tool_call_rate, 27 / 36);
  assert.deepEqual(s.overall.invalid_by_reason, { schema: 9 });
  assert.equal(s.overall.timeouts, 1);
  assert.equal(s.overall.run_errors, 1);
  assert.ok(Math.abs(s.overall.total_cost_usd! - 0.008) < 1e-12, "a run with no cost is left out, not counted as 0");
  assert.deepEqual(
    s.tasks.map((t) => [t.task, t.passes, t.flaky]),
    [["a", 3, false], ["b", 1, true], ["c", 0, false]]
  );
});

test("percentile is nearest-rank", () => {
  const values = [5, 1, 4, 2, 3, 6, 7, 8, 9, 10];
  assert.equal(percentile(values, 50), 5);
  assert.equal(percentile(values, 95), 10);
  assert.equal(percentile([42], 95), 42);
  assert.equal(percentile([], 50), 0);
});

test("the markdown report and the comparison table carry the headline numbers", () => {
  const results = [trial("a", 1, true), trial("b", 1, false)];
  const s = summarise(results, meta);
  const md = toMarkdown(s, results);
  assert.match(md, /^# m/);
  assert.match(md, /\| 50\.0% \| 50\.0% \| 50\.0% \|/);
  assert.match(md, /## Failures\n\n- \*\*b\*\* #1: `tests`/);
  assert.match(md, /## Invalid tool calls/);

  const table = comparison([s, { ...s, model: "other" }]);
  assert.match(table, /\| m \| local \| `abc1234` \| 50\.0%/);
  assert.match(table, /\| a \| 1\/1 \| 1\/1 \|/);
});
