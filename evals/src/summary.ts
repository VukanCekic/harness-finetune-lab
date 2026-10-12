/**
 * Trial results -> per-task and overall numbers, as JSON and as a Markdown report.
 *
 * Only VALID trials are graded (the model had its say: passed, checks failed,
 * ran out of steps or tokens). A stalled server, a harness crash, a trial that
 * reached outside its workspace or one the wall clock killed is counted and
 * listed, never folded into the pass rate. The headline pass@1 is the mean of
 * per-task pass rates with a 95% interval across tasks, since the tasks - not
 * the trials - are the independent samples.
 */
import type { CheckResult } from "./checks.js";
import { CLASSES, type TrialClass } from "./classify.js";
import type { Defaults, ModelProfile } from "./config.js";
import type { RunConditions } from "./conditions.js";
import type { HarnessInfo } from "./harness.js";
import type { Invalid, TranscriptScore } from "./score.js";
import { clusteredCI, formatInterval, pairedDifference } from "./stats.js";

export interface TrialResult extends TranscriptScore {
  task: string;
  difficulty: string;
  trial: number;
  /** class === "passed". */
  passed: boolean;
  class: TrialClass;
  /** What to look at for a class other than passed / checks_failed. */
  class_detail: string | null;
  /** The model had its say: counted in the pass rate. */
  valid: boolean;
  /** Why the run itself failed (timeout, crash, provider) - the same as class_detail for an invalid trial. */
  error: string | null;
  exit_code: number | null;
  timed_out: boolean;
  duration_ms: number;
  /** For a timeout: seconds the last model request had been running when the kill came. */
  in_flight_s: number | null;
  checks: CheckResult[];
}

/** An earlier attempt at a trial that a resume replaced: out of the numbers, but part of the record. */
export interface ExcludedAttempt {
  task: string;
  trial: number;
  class: TrialClass;
  detail: string | null;
}

export interface TaskSummary {
  task: string;
  difficulty: string;
  /** Valid trials. */
  trials: number;
  invalid: number;
  passes: number;
  /** Over valid trials; null when there are none. */
  pass_rate: number | null;
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
  conditions?: RunConditions;
  started: string;
  finished: string;
  /** Attempts that were left out and re-run (`--resume`): the report counts them so an exclusion cannot disappear. */
  excluded?: ExcludedAttempt[];
  /** How many times this run was resumed. */
  resumes?: number;
  overall: {
    /** Tasks with at least one valid trial. */
    tasks: number;
    /** Valid trials: the ones graded. */
    trials: number;
    invalid_trials: number;
    /** k = valid trials per task (the most any task has). */
    k: number;
    /** Mean of per-task pass rates: the chance one attempt at a task of this set succeeds. */
    pass_at_1: number;
    /** 95% t-interval across tasks. NaN (null in JSON) with fewer than two tasks. */
    pass_at_1_ci: { low: number | null; high: number | null };
    /** Share of valid trials that passed. Equals pass_at_1 when every task has the same number of valid trials. */
    trial_pass_rate: number;
    /** Share of tasks solved at least once in their valid trials. */
    pass_at_k: number;
    /** Share of tasks solved in every one of k trials: reliability. A task that lost a trial to an invalid attempt cannot claim it. */
    pass_pow_k: number;
    flaky_tasks: number;
    by_class: Partial<Record<TrialClass, number>>;
    tool_calls: number;
    valid_tool_call_rate: number | null;
    /** "all_agents" when every trial had a wire log, else the main agent alone. */
    tool_call_scope: "all_agents" | "main_only";
    tool_errors: number;
    invalid_by_reason: Partial<Record<Invalid["reason"], number>>;
    /** Valid trials with a known cost. */
    mean_cost_usd: number | null;
    /** Everything spent, killed and invalid trials included, as far as it is known. */
    total_cost_usd: number | null;
    p50_duration_ms: number;
    p95_duration_ms: number;
    mean_steps: number | null;
    /** Share of generated tokens that were thinking, where the server says. */
    thinking_share: number | null;
    timeouts: number;
    /** Same as invalid_trials; kept for older readers. */
    run_errors: number;
    global_install_attempts: number;
    /** Trials with a tool call that pointed outside the workspace. */
    trials_with_escapes: number;
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
const num2null = (v: number): number | null => (Number.isNaN(v) ? null : v);

export function summarise(
  results: TrialResult[],
  meta: Pick<Summary, "model" | "profile" | "harness" | "defaults" | "started" | "finished"> & {
    conditions?: RunConditions;
    excluded?: ExcludedAttempt[];
    resumes?: number;
  }
): Summary {
  const byTask = new Map<string, TrialResult[]>();
  for (const result of results) byTask.set(result.task, [...(byTask.get(result.task) ?? []), result]);

  const tasks: TaskSummary[] = [...byTask.entries()].map(([task, all]) => {
    const valid = all.filter((t) => t.valid);
    const passes = valid.filter((t) => t.passed).length;
    const calls = all.reduce((s, t) => s + t.tool_calls, 0);
    return {
      task,
      difficulty: all[0].difficulty,
      trials: valid.length,
      invalid: all.length - valid.length,
      passes,
      pass_rate: valid.length ? passes / valid.length : null,
      flaky: passes > 0 && passes < valid.length,
      valid_tool_call_rate: calls ? all.reduce((s, t) => s + t.valid_tool_calls, 0) / calls : null,
      mean_duration_ms: mean(valid.map((t) => t.duration_ms)) ?? 0,
      mean_steps: mean(known(valid.map((t) => t.steps))),
      mean_cost_usd: mean(known(valid.map((t) => t.cost_usd)))
    };
  });
  const graded = tasks.filter((t) => t.pass_rate !== null);
  const validResults = results.filter((r) => r.valid);

  const calls = results.reduce((s, r) => s + r.tool_calls, 0);
  const invalid_by_reason: Summary["overall"]["invalid_by_reason"] = {};
  for (const invalid of results.flatMap((r) => r.invalid_tool_calls)) {
    invalid_by_reason[invalid.reason] = (invalid_by_reason[invalid.reason] ?? 0) + 1;
  }
  const by_class: Summary["overall"]["by_class"] = {};
  for (const cls of CLASSES) {
    const n = results.filter((r) => r.class === cls).length;
    if (n > 0) by_class[cls] = n;
  }
  const costs = known(results.map((r) => r.cost_usd));
  const durations = validResults.map((r) => r.duration_ms);
  const ci = clusteredCI(graded.map((t) => t.pass_rate as number));
  const k = Math.max(0, ...graded.map((t) => t.trials));
  const completion = results.reduce((s, r) => s + (r.completion_tokens ?? 0), 0);
  const thinking = results.reduce((s, r) => s + (r.reasoning_tokens ?? 0), 0);
  const thinkingKnown = results.some((r) => r.reasoning_tokens !== null);

  return {
    ...meta,
    overall: {
      tasks: graded.length,
      trials: validResults.length,
      invalid_trials: results.length - validResults.length,
      k,
      pass_at_1: ci.mean,
      pass_at_1_ci: { low: num2null(ci.low), high: num2null(ci.high) },
      trial_pass_rate: validResults.length ? validResults.filter((r) => r.passed).length / validResults.length : NaN,
      pass_at_k: graded.length ? graded.filter((t) => t.passes > 0).length / graded.length : NaN,
      pass_pow_k: graded.length ? graded.filter((t) => t.passes === k).length / graded.length : NaN,
      flaky_tasks: graded.filter((t) => t.flaky).length,
      by_class,
      tool_calls: calls,
      valid_tool_call_rate: calls ? results.reduce((s, r) => s + r.valid_tool_calls, 0) / calls : null,
      tool_call_scope: results.length > 0 && results.every((r) => r.validity_scope === "all_agents") ? "all_agents" : "main_only",
      tool_errors: results.reduce((s, r) => s + r.tool_errors, 0),
      invalid_by_reason,
      mean_cost_usd: mean(known(validResults.map((r) => r.cost_usd))),
      total_cost_usd: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
      p50_duration_ms: percentile(durations, 50),
      p95_duration_ms: percentile(durations, 95),
      mean_steps: mean(known(validResults.map((r) => r.steps))),
      thinking_share: thinkingKnown && completion > 0 ? thinking / completion : null,
      timeouts: results.filter((r) => r.timed_out).length,
      run_errors: results.length - validResults.length,
      global_install_attempts: results.reduce((s, r) => s + r.global_installs.length, 0),
      trials_with_escapes: results.filter((r) => r.escapes.length > 0).length
    },
    tasks
  };
}

// ---------------------------------------------------------------- markdown

export const pct = (value: number | null | undefined): string => (value == null || Number.isNaN(value) ? "-" : `${(value * 100).toFixed(1)}%`);
export const usd = (value: number | null): string => (value === null ? "-" : `$${value.toFixed(4)}`);
export const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
/** "2026-10-09 14:28" in the local time zone. */
const localTime = (iso: string): string => new Date(iso).toLocaleString("sv-SE").slice(0, 16);
const num = (value: number | null): string => (value === null ? "-" : value.toFixed(1));

/** The headline pass@1 with its interval, from a summary's own numbers. */
function headline(o: Summary["overall"]): string {
  return formatInterval({ mean: o.pass_at_1 ?? NaN, low: o.pass_at_1_ci?.low ?? NaN, high: o.pass_at_1_ci?.high ?? NaN, n: o.tasks });
}

/** What was pinned, in one line: so a table can never be read without the conditions that produced it. */
function conditionsLine(s: Summary): string {
  const sampling = s.profile.sampling ?? {};
  const set = [
    sampling.temperature !== undefined ? `temp ${sampling.temperature}` : null,
    sampling.top_p !== undefined ? `top_p ${sampling.top_p}` : null,
    sampling.top_k !== undefined ? `top_k ${sampling.top_k}` : null,
    sampling.presence_penalty !== undefined ? `presence ${sampling.presence_penalty}` : null,
    sampling.seed !== undefined ? `seed ${sampling.seed}+` : null
  ].filter(Boolean);
  const d = s.defaults as Defaults & { max_tokens?: number; max_turn_tokens?: number };
  return (
    `sampling ${set.length ? set.join(", ") : "not pinned"} · thinking ${s.profile.thinking ?? "default"}` +
    `${s.profile.provider ? ` · provider ${s.profile.provider.join(",")}` : ""} · ` +
    `budget ${d.max_steps} steps, ${d.max_tokens ?? "no"} tokens/request, ${d.max_turn_tokens ?? "no"} tokens/trial, safety net ${d.timeout_s}s`
  );
}

export function toMarkdown(summary: Summary, results: TrialResult[]): string {
  const o = summary.overall;
  const single = o.k <= 1;
  const unpinned = summary.conditions?.unpinned ?? [];
  const lines = [
    `# ${summary.model}`,
    "",
    `${summary.profile.backend} \`${summary.profile.model}\` · harness \`${summary.harness.commit}\`${summary.harness.dirty ? " (dirty)" : ""}` +
      `${summary.conditions ? ` · lab \`${summary.conditions.lab.commit}\`${summary.conditions.lab.dirty ? " (dirty)" : ""}` : ""} · ` +
      `${o.tasks} tasks × ${o.k} trial${o.k === 1 ? "" : "s"} · context ${summary.defaults.context_window} · ${localTime(summary.started)}`,
    "",
    conditionsLine(summary),
    ""
  ];
  if (unpinned.length > 0) {
    lines.push(`> **Unpinned run conditions: ${unpinned.join(", ")}.** The server or provider chose these and nothing records what it chose. Do not compare this run or publish it.`, "");
  }
  if (summary.harness.dirty) lines.push("> The harness had uncommitted changes: this run cannot be reproduced from its commit.", "");
  if (o.invalid_trials > 0) {
    lines.push(
      `> **${o.invalid_trials} of ${o.trials + o.invalid_trials} trials are invalid and left out of every number below** (see "Trial outcomes"). ` +
        "Re-run them with `--resume <run dir>` before using this run.",
      ""
    );
  }

  const head = [`pass@1 (95% CI over ${o.tasks} tasks)`];
  const cells = [headline(o)];
  if (!single) {
    head.push(`pass@${o.k}`, `pass^${o.k}`, "flaky");
    cells.push(pct(o.pass_at_k), pct(o.pass_pow_k), String(o.flaky_tasks));
  }
  head.push(`valid tool calls (${o.tool_call_scope === "all_agents" ? "all agents" : "main agent only"})`, "mean cost", "p50 / p95 time", "mean steps", "thinking");
  cells.push(
    `${pct(o.valid_tool_call_rate)} of ${o.tool_calls}${o.tool_errors > 0 ? `, ${o.tool_errors} errored` : ""}`,
    usd(o.mean_cost_usd),
    `${secs(o.p50_duration_ms)} / ${secs(o.p95_duration_ms)}`,
    num(o.mean_steps),
    o.thinking_share === null ? "-" : `${pct(o.thinking_share)} of tokens`
  );
  lines.push(`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, `| ${cells.join(" | ")} |`);

  lines.push("", "## Trial outcomes", "", "| outcome | trials | counted in the pass rate |", "|---|---|---|");
  for (const cls of CLASSES) {
    const n = o.by_class[cls];
    if (n) lines.push(`| ${cls} | ${n} | ${["passed", "checks_failed", "max_steps", "token_budget"].includes(cls) ? "yes" : "**no**"} |`);
  }
  if (o.global_install_attempts > 0 || o.trials_with_escapes > 0) {
    lines.push("", `Global installs attempted: ${o.global_install_attempts}. Trials with a tool call outside the workspace: ${o.trials_with_escapes}.`);
  }

  lines.push(
    "",
    "## Tasks",
    "",
    "| task | difficulty | passed | invalid | valid tool calls | mean time | mean steps | mean cost |",
    "|---|---|---|---|---|---|---|---|",
    ...summary.tasks.map(
      (t) =>
        `| ${t.task} | ${t.difficulty} | ${t.trials ? `${t.passes}/${t.trials}` : "-"}${t.flaky ? " (flaky)" : ""} | ${t.invalid || ""} | ${pct(t.valid_tool_call_rate)} | ` +
        `${secs(t.mean_duration_ms)} | ${num(t.mean_steps)} | ${usd(t.mean_cost_usd)} |`
    )
  );

  const failed = results.filter((r) => r.valid && !r.passed);
  if (failed.length > 0) {
    lines.push("", "## Failures", "");
    for (const r of failed) {
      const why = r.class === "checks_failed" ? r.checks.filter((c) => !c.passed).map((c) => `\`${c.name}\``).join(", ") : `${r.class}: ${r.class_detail ?? ""}`;
      lines.push(`- **${r.task}** #${r.trial}: ${why}`);
    }
  }
  const invalidTrials = results.filter((r) => !r.valid);
  if (invalidTrials.length > 0) {
    lines.push("", "## Invalid trials (not graded)", "");
    for (const r of invalidTrials) lines.push(`- **${r.task}** #${r.trial}: ${r.class} - ${r.class_detail ?? ""}`);
  }
  if (summary.excluded && summary.excluded.length > 0) {
    lines.push("", "## Earlier attempts left out and re-run", "", `Resumed ${summary.resumes ?? "at least one"} time(s). Their folders are kept beside the trial's, as <n>.excluded-<k>.`, "");
    for (const a of summary.excluded) lines.push(`- **${a.task}** #${a.trial}: ${a.class}${a.detail ? ` - ${a.detail}` : ""}`);
  }
  const escapes = results.flatMap((r) => r.escapes.map((e) => ({ ...e, task: r.task, trial: r.trial })));
  if (escapes.length > 0) {
    lines.push("", "## Tool calls outside the workspace", "");
    for (const e of escapes.slice(0, 30)) lines.push(`- ${e.task} #${e.trial}: ${e.kind} - \`${e.tool}\` ${e.target}`);
    if (escapes.length > 30) lines.push(`- … ${escapes.length - 30} more in the trial results`);
  }
  const invalid = results.flatMap((r) => r.invalid_tool_calls.map((i) => ({ ...i, task: r.task, trial: r.trial })));
  if (invalid.length > 0) {
    lines.push("", "## Invalid tool calls", "");
    for (const i of invalid.slice(0, 50)) lines.push(`- ${i.task} #${i.trial}${i.agent ? ` (${i.agent})` : ""}: \`${i.tool}\` ${i.reason}: ${i.detail.replace(/\s+/g, " ")}`);
    if (invalid.length > 50) lines.push(`- … ${invalid.length - 50} more in the trial results`);
  }
  return `${lines.join("\n")}\n`;
}

// ------------------------------------------------------------------ compare

const rates = (s: Summary): Record<string, number> =>
  Object.fromEntries(s.tasks.filter((t) => t.pass_rate !== null).map((t) => [t.task, t.pass_rate as number]));

/**
 * Several runs side by side: the results table of the project. The first run
 * is the baseline: every other row shows its per-task difference from it, with
 * an interval - the paired comparison, which is what a fine-tune's claim rests on.
 */
export function comparison(summaries: Summary[]): string {
  const base = summaries[0];
  const baseRates = rates(base);
  const lines = [
    `| model | backend | harness | k | pass@1 (95% CI over tasks) | vs ${base.model} (paired, 95% CI) | pass^k | valid tool calls | mean cost | p50 / p95 time | mean steps | invalid trials |`,
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...summaries.map((s, i) => {
      const o = s.overall;
      const own = clusteredCI(Object.values(rates(s)));
      const diff = i === 0 ? null : pairedDifference(baseRates, rates(s));
      const vs = diff === null ? "baseline" : `${formatInterval(diff, true)} on ${diff.shared.length} tasks`;
      return (
        `| ${s.model} | ${s.profile.backend} | \`${s.harness.commit}\` | ${o.k} | ${formatInterval(own)} | ${vs} | ${pct(o.pass_pow_k)} | ` +
        `${pct(o.valid_tool_call_rate)} | ${usd(o.mean_cost_usd)} | ${secs(o.p50_duration_ms)} / ${secs(o.p95_duration_ms)} | ${num(o.mean_steps)} | ${o.invalid_trials ?? "-"} |`
      );
    })
  ];
  const warnings = summaries.flatMap((s) => (s.conditions?.unpinned?.length ? [`${s.model}: unpinned ${s.conditions.unpinned.join(", ")}`] : []));
  const mixed = new Set(summaries.map((s) => s.overall.k)).size > 1;
  const taskSets = new Set(summaries.map((s) => Object.keys(rates(s)).sort().join(",")));
  if (warnings.length > 0) lines.push("", `> **Unpinned run conditions** - ${warnings.join("; ")}. These rows are not comparable.`);
  if (mixed) lines.push("", "> The runs have different numbers of trials per task: compare pass@1, not pass^k.");
  if (taskSets.size > 1) lines.push("", "> The runs do not cover the same tasks: the paired difference uses only the shared ones.");

  const taskIds = [...new Set(summaries.flatMap((s) => s.tasks.map((t) => t.task)))].sort();
  lines.push("", `| task | ${summaries.map((s) => s.model).join(" | ")} |`, `|---|${summaries.map(() => "---|").join("")}`);
  for (const id of taskIds) {
    const cells = summaries.map((s) => {
      const t = s.tasks.find((x) => x.task === id);
      return t && t.trials > 0 ? `${t.passes}/${t.trials}` : "-";
    });
    lines.push(`| ${id} | ${cells.join(" | ")} |`);
  }
  return `${lines.join("\n")}\n`;
}
