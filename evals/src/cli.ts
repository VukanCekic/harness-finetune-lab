/**
 *   run       npm run eval -- --model qwen3-8b [--trials 3] [--task a,b] [--concurrency 1]
 *   validate  npm run eval:validate [-- --task a,b]   every task red without a solution, green with one
 *   compare   npm run eval:compare [-- <run dir> ...]  latest run of each model when none are given
 *   list      npm run eval:list
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, loadTasks, RESULTS_DIR, TOOL_SCHEMAS_FILE, type ModelProfile, type Task } from "./config.js";
import { runChecks } from "./checks.js";
import { harnessInfo, preflight, runHarness, type HarnessInfo } from "./harness.js";
import { readSession, scoreSession, type ToolSchemas } from "./score.js";
import { comparison, secs, summarise, toMarkdown, usd, type Summary, type TrialResult } from "./summary.js";
import { addHidden, addSolution, keep, remove, seed, tempWorkspace } from "./workspace.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    model: { type: "string" },
    trials: { type: "string" },
    task: { type: "string" },
    concurrency: { type: "string" },
    out: { type: "string" }
  }
});
const [command, ...rest] = positionals;
const taskFilter = values.task?.split(",").map((t) => t.trim()).filter(Boolean);

const write = (file: string, data: unknown) =>
  fs.writeFileSync(file, typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`);

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

// --------------------------------------------------------------------- run

async function run(): Promise<number> {
  const config = loadConfig();
  const modelName = values.model;
  if (!modelName || !config.models[modelName]) {
    console.error(`--model must be one of: ${Object.keys(config.models).join(", ")}`);
    return 2;
  }
  const profile = config.models[modelName];
  const tasks = loadTasks(taskFilter);
  const trials = Number(values.trials ?? config.defaults.trials);
  const concurrency = Number(values.concurrency ?? 1);
  if (!Number.isInteger(trials) || trials < 1) throw new Error("--trials must be a positive integer");

  if (!fs.existsSync(TOOL_SCHEMAS_FILE)) throw new Error("No tool-schemas.json - run: npm run eval:sync-tools");
  const schemas: ToolSchemas = JSON.parse(fs.readFileSync(TOOL_SCHEMAS_FILE, "utf-8"));
  const harness: HarnessInfo = harnessInfo(config.harness.dir);
  if (harness.dirty) console.warn(`warning: the harness has uncommitted changes - this run is not reproducible from ${harness.commit}`);
  if (schemas.harness_commit !== harness.commit) {
    console.warn(`warning: tool-schemas.json is from harness ${schemas.harness_commit}, the harness is at ${harness.commit} - run npm run eval:sync-tools`);
  }
  const down = await preflight(profile);
  if (down) {
    console.error(down);
    return 1;
  }

  const runDir = path.join(RESULTS_DIR, `${stamp()}_${modelName}`);
  fs.mkdirSync(runDir, { recursive: true });
  const started = new Date().toISOString();
  write(path.join(runDir, "run.json"), {
    model: modelName,
    profile,
    harness,
    defaults: config.defaults,
    trials,
    concurrency,
    tasks: tasks.map((t) => t.id),
    started
  });
  console.log(`${modelName} (${profile.backend} ${profile.model}) · harness ${harness.commit} · ${tasks.length} tasks × ${trials} trials`);
  console.log(`-> ${path.relative(process.cwd(), runDir)}\n`);

  const jobs = tasks.flatMap((task) => Array.from({ length: trials }, (_, i) => ({ task, trial: i + 1 })));
  const results: TrialResult[] = [];
  let done = 0;

  await pool(jobs, concurrency, async ({ task, trial }) => {
    const result = await runTrial(task, trial, { runDir, harness, profile, schemas, config });
    results.push(result);
    done++;
    const mark = result.passed ? "✔" : "✘";
    const why = result.passed ? "" : `  ${result.error ?? result.checks.filter((c) => !c.passed).map((c) => c.name).join("; ")}`;
    console.log(
      `${mark} [${done}/${jobs.length}] ${task.id} #${trial}  ${secs(result.duration_ms)}  ${result.steps ?? "?"} steps  ` +
        `${result.valid_tool_calls}/${result.tool_calls} valid calls  ${usd(result.cost_usd)}${why}`
    );
  });

  results.sort((a, b) => a.task.localeCompare(b.task) || a.trial - b.trial);
  const summary = summarise(results, { model: modelName, profile, harness, defaults: config.defaults, started, finished: new Date().toISOString() });
  write(path.join(runDir, "summary.json"), summary);
  const markdown = toMarkdown(summary, results);
  write(path.join(runDir, "summary.md"), markdown);
  console.log(`\n${markdown}`);
  return 0;
}

async function runTrial(
  task: Task,
  trial: number,
  ctx: { runDir: string; harness: HarnessInfo; profile: ModelProfile; schemas: ToolSchemas; config: ReturnType<typeof loadConfig> }
): Promise<TrialResult> {
  const trialDir = path.join(ctx.runDir, "trials", task.id, String(trial));
  fs.mkdirSync(trialDir, { recursive: true });
  const workspace = tempWorkspace(`${task.id}-${trial}`);
  const base = { task: task.id, difficulty: task.difficulty, trial };

  let result: TrialResult;
  try {
    seed(task, workspace);
    const h = await runHarness({ harness: ctx.harness, profile: ctx.profile, defaults: ctx.config.defaults, task, workspace, trialDir });
    const session = readSession(h.sessionDir);
    addHidden(task, workspace);
    const checks = await runChecks(task, workspace);
    const timeout = task.timeout_s ?? ctx.config.defaults.timeout_s;
    const error = h.timedOut
      ? `timed out after ${timeout}s`
      : h.exitCode !== 0
        ? `harness exited with code ${h.exitCode} (see harness.log)`
        : session === null
          ? "harness wrote no session log"
          : null;
    result = {
      ...base,
      ...scoreSession(session, ctx.schemas),
      passed: error === null && checks.every((c) => c.passed),
      error,
      exit_code: h.exitCode,
      timed_out: h.timedOut,
      duration_ms: h.durationMs,
      checks
    };
    keep(workspace, path.join(trialDir, "workspace"));
  } catch (err: any) {
    result = {
      ...base,
      ...scoreSession(null, ctx.schemas),
      passed: false,
      error: `eval runner error: ${err?.message ?? err}`,
      exit_code: null,
      timed_out: false,
      duration_ms: 0,
      checks: []
    };
  } finally {
    remove(workspace);
  }
  write(path.join(trialDir, "result.json"), result);
  return result;
}

// ---------------------------------------------------------------- validate

/**
 * A task is only useful if its checks can fail and can pass: red on the
 * untouched workspace, green with the reference solution.
 */
async function validate(): Promise<number> {
  const tasks = loadTasks(taskFilter);
  let problems = 0;
  for (const task of tasks) {
    const red = tempWorkspace(`${task.id}-red`);
    const green = tempWorkspace(`${task.id}-green`);
    try {
      seed(task, red);
      addHidden(task, red);
      const redChecks = await runChecks(task, red);

      seed(task, green);
      const hasSolution = addSolution(task, green);
      addHidden(task, green);
      const greenChecks = hasSolution ? await runChecks(task, green) : [];

      const issues: string[] = [];
      if (redChecks.every((c) => c.passed)) issues.push("passes with no work done - the checks prove nothing");
      if (!hasSolution) issues.push("no solution/ - cannot show the task is solvable");
      for (const c of greenChecks.filter((c) => !c.passed)) issues.push(`reference solution fails "${c.name}": ${c.detail.split("\n").slice(0, 6).join(" | ")}`);

      const redFails = redChecks.filter((c) => !c.passed).length;
      if (issues.length === 0) {
        console.log(`✔ ${task.id}  red ${redFails}/${redChecks.length} failing · green ${greenChecks.length}/${greenChecks.length} passing`);
      } else {
        problems++;
        console.log(`✘ ${task.id}`);
        for (const issue of issues) console.log(`    ${issue}`);
      }
    } finally {
      remove(red);
      remove(green);
    }
  }
  console.log(`\n${tasks.length - problems}/${tasks.length} tasks valid`);
  return problems === 0 ? 0 : 1;
}

// ----------------------------------------------------------------- compare

function compare(): number {
  const config = loadConfig();
  let dirs = rest.map((d) => path.resolve(d));
  if (dirs.length === 0) {
    // The newest finished run of each configured model, in config order.
    const runs = fs.existsSync(RESULTS_DIR) ? fs.readdirSync(RESULTS_DIR).sort().reverse() : [];
    dirs = Object.keys(config.models)
      .map((model) => runs.find((r) => r.endsWith(`_${model}`) && fs.existsSync(path.join(RESULTS_DIR, r, "summary.json"))))
      .filter((r): r is string => Boolean(r))
      .map((r) => path.join(RESULTS_DIR, r));
  }
  if (dirs.length === 0) {
    console.error("No finished runs found. Run: npm run eval -- --model <name>");
    return 1;
  }
  const summaries: Summary[] = dirs.map((d) => JSON.parse(fs.readFileSync(path.join(d, "summary.json"), "utf-8")));
  const table = comparison(summaries);
  console.log(table);
  if (values.out) {
    write(values.out, table);
    console.log(`-> ${values.out}`);
  }
  return 0;
}

// -------------------------------------------------------------------- list

function list(): number {
  for (const t of loadTasks(taskFilter)) {
    console.log(`${t.id.padEnd(24)} ${t.difficulty.padEnd(7)} ${t.checks.length} checks  ${t.tags.join(", ")}`);
  }
  return 0;
}

const commands: Record<string, () => number | Promise<number>> = { run, validate, compare, list };
const selected = commands[command ?? ""];
if (!selected) {
  console.error(`usage: tsx evals/src/cli.ts <${Object.keys(commands).join("|")}> [options]`);
  process.exit(2);
}
try {
  process.exitCode = await selected();
} catch (err: any) {
  console.error(err?.message ?? err);
  process.exitCode = 1;
}
