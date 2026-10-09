/** Trial results -> per-task and overall numbers, as JSON and as a Markdown report. */
import type { CheckResult } from "./checks.js";
import type { Defaults, ModelProfile } from "./config.js";
import type { HarnessInfo } from "./harness.js";
import type { Invalid, TranscriptScore } from "./score.js";

export interface TrialResult extends TranscriptScore {
  task: string;
  difficulty: string;
  trial: number;
  /** Every check passed and the run itself finished. */
  passed: boolean;
  /** Why the run itself failed (timeout, crash) - separate from failed checks. */
  error: string | null;
  exit_code: number | null;
  timed_out: boolean;
  duration_ms: number;
  checks: CheckResult[];
}

export interface TaskSummary {
  task: string;
  difficulty: string;
  trials: number;
  passes: number;
  pass_rate: number;
  /** Trials disagreed: the behaviour sits on an edge. */
  flaky: boolean;
  valid_tool_call_rate: number | null;
  mean_duration_ms: number;
  mean_steps: number | null;
  mean_cost_usd: number | null;
}

export interface Summary {
  model: string;
  profile: ModelProfile;
  harness: HarnessInfo;
  defaults: Defaults;
  started: string;
  finished: string;
  overall: {
    tasks: number;
    trials: number;
    /** k = trials per task. */
    k: number;
    /** Share of all trials that passed: the chance one attempt succeeds. */
    pass_at_1: number;
    /** Share of tasks solved at least once in k trials. */
    pass_at_k: number;
    /** Share of tasks solved in every one of k trials: reliability. */
    pass_pow_k: number;
    flaky_tasks: number;
    tool_calls: number;
    valid_tool_call_rate: number | null;
    invalid_by_reason: Partial<Record<Invalid["reason"], number>>;
    mean_cost_usd: number | null;
    total_cost_usd: number | null;
    p50_duration_ms: number;
    p95_duration_ms: number;
    mean_steps: number | null;
    timeouts: number;
    run_errors: number;
    global_install_attempts: number;
  };
  tasks: TaskSummary[];
}

const mean = (values: number[]): number | null => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

/** Nearest-rank percentile. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

const known = (values: Array<number | null>): number[] => values.filter((v): v is number => v !== null);

export function summarise(
  results: TrialResult[],
  meta: Pick<Summary, "model" | "profile" | "harness" | "defaults" | "started" | "finished">
): Summary {
  const byTask = new Map<string, TrialResult[]>();
  for (const result of results) byTask.set(result.task, [...(byTask.get(result.task) ?? []), result]);

  const tasks: TaskSummary[] = [...byTask.entries()].map(([task, trials]) => {
    const passes = trials.filter((t) => t.passed).length;
    const calls = trials.reduce((s, t) => s + t.tool_calls, 0);
    return {
      task,
      difficulty: trials[0].difficulty,
      trials: trials.length,
      passes,
      pass_rate: passes / trials.length,
      flaky: passes > 0 && passes < trials.length,
      valid_tool_call_rate: calls ? trials.reduce((s, t) => s + t.valid_tool_calls, 0) / calls : null,
      mean_duration_ms: mean(trials.map((t) => t.duration_ms)) ?? 0,
      mean_steps: mean(known(trials.map((t) => t.steps))),
      mean_cost_usd: mean(known(trials.map((t) => t.cost_usd)))
    };
  });

  const calls = results.reduce((s, r) => s + r.tool_calls, 0);
  const invalid_by_reason: Summary["overall"]["invalid_by_reason"] = {};
  for (const invalid of results.flatMap((r) => r.invalid_tool_calls)) {
    invalid_by_reason[invalid.reason] = (invalid_by_reason[invalid.reason] ?? 0) + 1;
  }
  const costs = known(results.map((r) => r.cost_usd));
  const durations = results.map((r) => r.duration_ms);

  return {
    ...meta,
    overall: {
      tasks: tasks.length,
      trials: results.length,
      k: Math.max(0, ...tasks.map((t) => t.trials)),
      pass_at_1: results.length ? results.filter((r) => r.passed).length / results.length : 0,
      pass_at_k: tasks.length ? tasks.filter((t) => t.passes > 0).length / tasks.length : 0,
      pass_pow_k: tasks.length ? tasks.filter((t) => t.passes === t.trials).length / tasks.length : 0,
      flaky_tasks: tasks.filter((t) => t.flaky).length,
      tool_calls: calls,
      valid_tool_call_rate: calls ? results.reduce((s, r) => s + r.valid_tool_calls, 0) / calls : null,
      invalid_by_reason,
      mean_cost_usd: mean(costs),
      total_cost_usd: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
      p50_duration_ms: percentile(durations, 50),
      p95_duration_ms: percentile(durations, 95),
      mean_steps: mean(known(results.map((r) => r.steps))),
      timeouts: results.filter((r) => r.timed_out).length,
      run_errors: results.filter((r) => r.error !== null).length,
      global_install_attempts: results.reduce((s, r) => s + r.global_installs.length, 0)
    },
    tasks
  };
}

// ---------------------------------------------------------------- markdown

export const pct = (value: number | null): string => (value === null ? "-" : `${(value * 100).toFixed(1)}%`);
export const usd = (value: number | null): string => (value === null ? "-" : `$${value.toFixed(4)}`);
export const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
/** "2026-10-09 14:28" in the local time zone. */
const localTime = (iso: string): string => new Date(iso).toLocaleString("sv-SE").slice(0, 16);
const num = (value: number | null): string => (value === null ? "-" : value.toFixed(1));

export function toMarkdown(summary: Summary, results: TrialResult[]): string {
  const o = summary.overall;
  const lines = [
    `# ${summary.model}`,
    "",
    `${summary.profile.backend} \`${summary.profile.model}\` · harness \`${summary.harness.commit}\`${summary.harness.dirty ? " (dirty)" : ""} · ` +
      `${o.tasks} tasks × ${o.k} trials · context ${summary.defaults.context_window} · timeout ${summary.defaults.timeout_s}s · ` +
      `max steps ${summary.defaults.max_steps} · ${localTime(summary.started)}`,
    "",
    `| pass@1 | pass@${o.k} | pass^${o.k} | flaky | valid tool calls | mean cost | p50 / p95 time | mean steps | timeouts | global installs |`,
    "|---|---|---|---|---|---|---|---|---|---|",
    `| ${pct(o.pass_at_1)} | ${pct(o.pass_at_k)} | ${pct(o.pass_pow_k)} | ${o.flaky_tasks} | ${pct(o.valid_tool_call_rate)} of ${o.tool_calls} | ` +
      `${usd(o.mean_cost_usd)} | ${secs(o.p50_duration_ms)} / ${secs(o.p95_duration_ms)} | ${num(o.mean_steps)} | ${o.timeouts} | ${o.global_install_attempts} |`,
    "",
    "## Tasks",
    "",
    "| task | difficulty | passed | valid tool calls | mean time | mean steps | mean cost |",
    "|---|---|---|---|---|---|---|",
    ...summary.tasks.map(
      (t) =>
        `| ${t.task} | ${t.difficulty} | ${t.passes}/${t.trials}${t.flaky ? " (flaky)" : ""} | ${pct(t.valid_tool_call_rate)} | ` +
        `${secs(t.mean_duration_ms)} | ${num(t.mean_steps)} | ${usd(t.mean_cost_usd)} |`
    )
  ];

  const failed = results.filter((r) => !r.passed);
  if (failed.length > 0) {
    lines.push("", "## Failures", "");
    for (const r of failed) {
      const why = r.error ?? r.checks.filter((c) => !c.passed).map((c) => `\`${c.name}\``).join(", ");
      lines.push(`- **${r.task}** #${r.trial}: ${why}`);
    }
  }
  const invalid = results.flatMap((r) => r.invalid_tool_calls.map((i) => ({ ...i, task: r.task, trial: r.trial })));
  if (invalid.length > 0) {
    lines.push("", "## Invalid tool calls", "");
    for (const i of invalid.slice(0, 50)) lines.push(`- ${i.task} #${i.trial}: \`${i.tool}\` ${i.reason}: ${i.detail.replace(/\s+/g, " ")}`);
    if (invalid.length > 50) lines.push(`- … ${invalid.length - 50} more in the trial results`);
  }
  return `${lines.join("\n")}\n`;
}

/** Several runs side by side: the results table of the project. */
export function comparison(summaries: Summary[]): string {
  const k = Math.max(...summaries.map((s) => s.overall.k));
  const lines = [
    `| model | backend | harness | pass@1 | pass@${k} | pass^${k} | valid tool calls | mean cost | p50 / p95 time | mean steps |`,
    "|---|---|---|---|---|---|---|---|---|---|",
    ...summaries.map((s) => {
      const o = s.overall;
      return (
        `| ${s.model} | ${s.profile.backend} | \`${s.harness.commit}\` | ${pct(o.pass_at_1)} | ${pct(o.pass_at_k)} | ${pct(o.pass_pow_k)} | ` +
        `${pct(o.valid_tool_call_rate)} | ${usd(o.mean_cost_usd)} | ${secs(o.p50_duration_ms)} / ${secs(o.p95_duration_ms)} | ${num(o.mean_steps)} |`
      );
    })
  ];
  const taskIds = [...new Set(summaries.flatMap((s) => s.tasks.map((t) => t.task)))].sort();
  lines.push("", `| task | ${summaries.map((s) => s.model).join(" | ")} |`, `|---|${summaries.map(() => "---|").join("")}`);
  for (const id of taskIds) {
    const cells = summaries.map((s) => {
      const t = s.tasks.find((x) => x.task === id);
      return t ? `${t.passes}/${t.trials}` : "-";
    });
    lines.push(`| ${id} | ${cells.join(" | ")} |`);
  }
  return `${lines.join("\n")}\n`;
}
