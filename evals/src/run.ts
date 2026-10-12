/**
 * `run`: all trials of a set of tasks against one model, then the summary.
 * Also `run --resume`: finish an interrupted run and re-run its invalid
 * trials, without repeating the ones that were graded.
 */
import fs from "node:fs";
import path from "node:path";
import { TOOL_SCHEMAS_FILE, type EvalConfig, type ModelProfile, type Task } from "./config.js";
import { budgetWarnings, collectConditions, fingerprint, type RunConditions } from "./conditions.js";
import { harnessInfo, harnessSupportsSettings, preflight, type HarnessInfo } from "./harness.js";
import type { ToolSchemas } from "./score.js";
import { secs, summarise, toMarkdown, usd, type ExcludedAttempt, type Summary, type TrialResult } from "./summary.js";
import { EXCLUDED, LAB_ROOT, runTrial } from "./trial.js";

export interface RunFile {
  model: string;
  tasks: string[];
  trials: number;
  concurrency: number;
  started: string;
  fingerprint?: string;
  /** What the run started with: a resumed run's summary describes these, not what is in force now. */
  profile?: ModelProfile;
  harness?: HarnessInfo;
  conditions?: RunConditions;
  resumed?: string[];
}

export interface RunOptions {
  config: EvalConfig;
  modelName: string;
  /** Tasks to run, or - when resuming - the tasks of the run being resumed. */
  tasks: Task[];
  trials: number;
  concurrency: number;
  resultsDir: string;
  /** Resume this run directory. */
  resumeDir?: string | null;
  /** Resume even though the conditions changed. */
  force?: boolean;
  /** Extra environment for the harness, for tests. */
  extraEnv?: Record<string, string>;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

export const EXIT = { ok: 0, failed: 1, usage: 2, incomplete: 4 } as const;

const write = (file: string, data: unknown) => fs.writeFileSync(file, typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`);

function stamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

async function pool<T>(items: T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
    while (next < items.length) await work(items[next++]);
  });
  await Promise.all(lanes);
}

/** Every trial folder of a run, with its result - null if that is missing or unreadable (a kill can cut it off). */
function trialFolders(runDir: string): Array<{ name: string; result: TrialResult | null }> {
  const out: Array<{ name: string; result: TrialResult | null }> = [];
  const root = path.join(runDir, "trials");
  if (!fs.existsSync(root)) return out;
  for (const task of fs.readdirSync(root)) {
    for (const name of fs.readdirSync(path.join(root, task))) {
      const file = path.join(root, task, name, "result.json");
      let result: TrialResult | null = null;
      try {
        result = JSON.parse(fs.readFileSync(file, "utf-8"));
      } catch {
        // no result: the trial never finished
      }
      out.push({ name, result });
    }
  }
  return out;
}

/** Valid results already on disk for this run: the trials a resume does not repeat. */
export function finishedTrials(runDir: string): TrialResult[] {
  return trialFolders(runDir).flatMap(({ name, result }) => (result && result.valid && !EXCLUDED.test(name) ? [result] : []));
}

/** Every trial of a run as it stands, valid or not; archived attempts are left out. */
export function currentResults(runDir: string): TrialResult[] {
  return trialFolders(runDir).flatMap(({ name, result }) => (result && !EXCLUDED.test(name) ? [result] : []));
}

/**
 * Rebuild summary.json and summary.md from what is on disk, without running
 * anything: after the way a number is computed changed, or for a run that was
 * cancelled before its summary was written. The trials themselves are not touched.
 */
export function resummarize(runDir: string): Summary {
  const run: RunFile & { profile: ModelProfile; harness: HarnessInfo; defaults: EvalConfig["defaults"] } = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf-8"));
  const results = currentResults(runDir).sort((a, b) => a.task.localeCompare(b.task) || a.trial - b.trial);
  if (results.length === 0) throw new Error(`${runDir} has no finished trials to summarise.`);
  if (results.some((r) => r.class === undefined)) throw new Error(`${runDir} was made by an older runner (its trials have no outcome class): it cannot be re-summarised.`);
  let finished = new Date().toISOString();
  try {
    finished = JSON.parse(fs.readFileSync(path.join(runDir, "summary.json"), "utf-8")).finished ?? finished;
  } catch {
    // no earlier summary: this is the first
  }
  const summary = summarise(results, {
    model: run.model,
    profile: run.profile,
    harness: run.harness,
    defaults: run.defaults,
    conditions: run.conditions,
    started: run.started,
    finished,
    excluded: excludedAttempts(runDir),
    resumes: run.resumed?.length ?? 0
  });
  write(path.join(runDir, "summary.json"), summary);
  write(path.join(runDir, "summary.md"), toMarkdown(summary, results));
  return summary;
}

/** Attempts a resume replaced (`<trial>.excluded-<n>`): left out of the numbers, but part of the record. */
export function excludedAttempts(runDir: string): ExcludedAttempt[] {
  return trialFolders(runDir).flatMap(({ name, result }) =>
    result && EXCLUDED.test(name) ? [{ task: result.task, trial: result.trial, class: result.class, detail: result.class_detail }] : []
  );
}

export async function runEval(options: RunOptions): Promise<{ code: number; runDir?: string; summary?: Summary }> {
  const log = options.log ?? ((line: string) => console.log(line));
  const warn = options.warn ?? ((line: string) => console.warn(line));
  const { config, modelName, tasks, trials, concurrency } = options;
  const profile = config.models[modelName];
  const previous: RunFile | null = options.resumeDir ? JSON.parse(fs.readFileSync(path.join(options.resumeDir, "run.json"), "utf-8")) : null;
  if (options.resumeDir && !previous?.fingerprint) {
    log(`${options.resumeDir} was made by an older runner (no run conditions recorded): it cannot be resumed.`);
    return { code: EXIT.usage };
  }
  if (previous && previous.model !== modelName) {
    log(`${options.resumeDir} is a run of ${previous.model}, not ${modelName}.`);
    return { code: EXIT.usage };
  }
  if (profile.backend === "local" && concurrency > 1) {
    warn("warning: concurrency above 1 on a local model shares one KV cache between requests and slows every generation - keep it at 1.");
  }

  if (!fs.existsSync(TOOL_SCHEMAS_FILE)) throw new Error("No tool-schemas.json - run: npm run eval:sync-tools");
  const schemas: ToolSchemas = JSON.parse(fs.readFileSync(TOOL_SCHEMAS_FILE, "utf-8"));
  const harness: HarnessInfo = harnessInfo(config.harness.dir);
  if (!harnessSupportsSettings(harness.dir)) {
    log(`The harness at ${harness.dir} predates the sampling and logging settings this runner depends on (no describeSettings in src/config.ts).`);
    return { code: EXIT.usage };
  }
  if (harness.dirty) warn(`warning: the harness has uncommitted changes - this run is not reproducible from ${harness.commit}`);
  if (schemas.harness_commit !== harness.commit) {
    warn(`warning: tool-schemas.json is from harness ${schemas.harness_commit}, the harness is at ${harness.commit} - run npm run eval:sync-tools`);
  }
  const down = await preflight(profile);
  if (down) {
    log(down);
    return { code: EXIT.failed };
  }

  const conditions = await collectConditions({ profile, defaults: config.defaults, tasks, lab: LAB_ROOT });
  const print = fingerprint(conditions, harness);
  for (const message of budgetWarnings(profile, config.defaults, conditions.lmstudio)) warn(`warning: ${message}`);
  if (conditions.unpinned.length > 0) {
    warn(`warning: unpinned run conditions: ${conditions.unpinned.join(", ")}. The server or provider picks these and nothing records what it picked - the results are not comparable or publishable.`);
  }
  if (conditions.lab.dirty) warn(`warning: the lab repo has uncommitted changes to the runner or tasks - this run is not reproducible from ${conditions.lab.commit}`);

  let runDir: string;
  let kept: TrialResult[] = [];
  let started = new Date().toISOString();
  if (options.resumeDir && previous) {
    if (previous.fingerprint !== print && !options.force) {
      log(
        `The conditions changed since ${path.basename(options.resumeDir)} started (sampling, thinking, budgets, task files or harness commit): ` +
          "a resumed run would mix two experiments. Start a new run, or pass --force."
      );
      return { code: EXIT.usage };
    }
    runDir = options.resumeDir;
    kept = finishedTrials(runDir);
    started = previous.started;
    write(path.join(runDir, "run.json"), { ...previous, resumed: [...(previous.resumed ?? []), new Date().toISOString()] });
  } else {
    runDir = path.join(options.resultsDir, `${stamp()}_${modelName}`);
    fs.mkdirSync(runDir, { recursive: true });
    write(path.join(runDir, "run.json"), {
      model: modelName,
      profile,
      harness,
      defaults: config.defaults,
      trials,
      concurrency,
      tasks: tasks.map((t) => t.id),
      started,
      fingerprint: print,
      conditions
    });
  }

  const done = new Set(kept.map((r) => `${r.task}#${r.trial}`));
  const jobs = tasks.flatMap((task) => Array.from({ length: trials }, (_, i) => ({ task, trial: i + 1 }))).filter(({ task, trial }) => !done.has(`${task.id}#${trial}`));
  log(`${modelName} (${profile.backend} ${profile.model}) · harness ${harness.commit} · ${tasks.length} tasks × ${trials} trials${kept.length ? ` · ${kept.length} already done, ${jobs.length} to run` : ""}`);
  log(`-> ${path.relative(process.cwd(), runDir)}\n`);

  const results: TrialResult[] = [...kept];
  let finished = 0;
  await pool(jobs, concurrency, async ({ task, trial }) => {
    const result = await runTrial(task, trial, { runDir, harness, profile, defaults: config.defaults, schemas, extraEnv: options.extraEnv });
    results.push(result);
    finished++;
    const mark = result.passed ? "✔" : result.valid ? "✘" : "⚠";
    const why = result.passed
      ? ""
      : `  ${result.valid && result.class === "checks_failed" ? result.checks.filter((c) => !c.passed).map((c) => c.name).join("; ") : `${result.class}: ${result.class_detail ?? ""}`}`;
    log(
      `${mark} [${finished}/${jobs.length}] ${task.id} #${trial}  ${secs(result.duration_ms)}  ${result.steps ?? "?"} steps  ` +
        `${result.valid_tool_calls}/${result.tool_calls} valid calls  ${usd(result.cost_usd)}${why}`
    );
  });

  results.sort((a, b) => a.task.localeCompare(b.task) || a.trial - b.trial);
  // A resumed run is described by what it started with (a --force resume may have changed the rest).
  const summary = summarise(results, {
    model: modelName,
    profile: previous?.profile ?? profile,
    harness: previous?.harness ?? harness,
    defaults: config.defaults,
    conditions: previous?.conditions ?? conditions,
    started,
    finished: new Date().toISOString(),
    excluded: excludedAttempts(runDir),
    resumes: previous ? (previous.resumed?.length ?? 0) + 1 : 0
  });
  write(path.join(runDir, "summary.json"), summary);
  const markdown = toMarkdown(summary, results);
  write(path.join(runDir, "summary.md"), markdown);
  log(`\n${markdown}`);
  if (summary.overall.invalid_trials > 0) {
    log(`${summary.overall.invalid_trials} invalid trial(s): re-run them with  npm run eval -- --resume ${path.relative(process.cwd(), runDir)}`);
    return { code: EXIT.incomplete, runDir, summary };
  }
  return { code: EXIT.ok, runDir, summary };
}
