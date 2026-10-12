/**
 *   run       npm run eval -- --model qwen3-8b [--trials 3] [--task a,b] [--concurrency 1]
 *             npm run eval -- --resume <run dir>     finish an interrupted run, and re-run its invalid trials
 *   validate  npm run eval:validate [-- --task a,b]   red / green / known-wrong fixtures for every task
 *   summarize npm run eval:summarize -- <run dir>   rebuild a run's summary from its trials, without running anything
 *   compare   npm run eval:compare [-- <run dir> ...]  latest run of each model when none are given; the first is the baseline
 *   list      npm run eval:list
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, loadTasks, RESULTS_DIR, type Task } from "./config.js";
import { EXIT, resummarize, runEval, type RunFile } from "./run.js";
import { comparison, type Summary } from "./summary.js";
import { validateTask } from "./validate.js";
import { fixtureNames } from "./workspace.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    model: { type: "string" },
    trials: { type: "string" },
    task: { type: "string" },
    concurrency: { type: "string" },
    resume: { type: "string" },
    "green-runs": { type: "string" },
    force: { type: "boolean" },
    out: { type: "string" }
  }
});
const [command, ...rest] = positionals;
const taskFilter = values.task?.split(",").map((t) => t.trim()).filter(Boolean);

const write = (file: string, data: unknown) =>
  fs.writeFileSync(file, typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`);

// --------------------------------------------------------------------- run

async function run(): Promise<number> {
  const config = loadConfig();
  const resumeDir = values.resume ? path.resolve(values.resume) : null;
  const previous: RunFile | null = resumeDir ? JSON.parse(fs.readFileSync(path.join(resumeDir, "run.json"), "utf-8")) : null;

  const modelName = values.model ?? previous?.model;
  if (!modelName || !config.models[modelName]) {
    console.error(`--model must be one of: ${Object.keys(config.models).join(", ")}`);
    return EXIT.usage;
  }
  const trials = previous ? previous.trials : Number(values.trials ?? config.defaults.trials);
  if (!Number.isInteger(trials) || trials < 1) throw new Error("--trials must be a positive integer");

  const concurrency = Number(values.concurrency ?? previous?.concurrency ?? 1);
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("--concurrency must be a positive integer");

  const { code } = await runEval({
    config,
    modelName,
    tasks: loadTasks(previous ? previous.tasks : taskFilter),
    trials,
    concurrency,
    resultsDir: RESULTS_DIR,
    resumeDir,
    force: values.force,
    log: console.log,
    warn: console.warn
  });
  return code;
}

// ---------------------------------------------------------------- validate

async function validate(): Promise<number> {
  const tasks = loadTasks(taskFilter);
  const greenRuns = Number(values["green-runs"] ?? 3);
  let problems = 0;
  for (const task of tasks) {
    const v = await validateTask(task, greenRuns);
    if (v.issues.length === 0) {
      console.log(`✔ ${task.id}  ${v.summary}`);
    } else {
      problems++;
      console.log(`✘ ${task.id}  ${v.summary}`);
      for (const issue of v.issues) console.log(`    ${issue}`);
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

// --------------------------------------------------------------- summarize

function summarize(): number {
  const dir = rest[0];
  if (!dir) {
    console.error("usage: npm run eval:summarize -- <run dir>");
    return EXIT.usage;
  }
  const summary = resummarize(path.resolve(dir));
  console.log(`${path.resolve(dir)}: ${summary.overall.trials} graded trials, ${summary.overall.invalid_trials} invalid -> summary.json, summary.md`);
  return EXIT.ok;
}

// -------------------------------------------------------------------- list

function list(): number {
  for (const t of loadTasks(taskFilter) as Task[]) {
    const fixtures = fixtureNames(t).length;
    console.log(`${t.id.padEnd(24)} ${t.difficulty.padEnd(7)} ${t.checks.length} checks  ${fixtures} fixtures  ${t.tags.join(", ")}`);
  }
  return 0;
}

const commands: Record<string, () => number | Promise<number>> = { run, validate, compare, summarize, list };
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
