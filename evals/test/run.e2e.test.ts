/**
 * `run` and `run --resume` against a scripted server and the real harness:
 * which trials are graded, which are repeated, and when a resume must refuse.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, type EvalConfig } from "../src/config.js";
import { harnessSupportsSettings } from "../src/harness.js";
import { EXIT, finishedTrials, resummarize, runEval } from "../src/run.js";
import { fakeServer, type Reply } from "./support/fakeServer.js";
import { defaults, makeTask, profileFor } from "./support/kit.js";

const real = loadConfig();
const present = fs.existsSync(path.join(real.harness.dir, "node_modules", "tsx")) && harnessSupportsSettings(real.harness.dir);
const opts = { skip: present ? false : `no harness checkout with settings support at ${real.harness.dir}` };

const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "hfl-e2e-results-"));
after(() => fs.rmSync(resultsDir, { recursive: true, force: true }));

const write: Reply = { kind: "tool", name: "write_file", args: { path: "greet.js", content: "console.log('hi')\n" } };
const done: Reply = { kind: "text", content: "Done." };

async function go(script: Reply[], extra: Partial<Parameters<typeof runEval>[0]> & { sampling?: object } = {}) {
  const server = await fakeServer(script);
  try {
    const profile = profileFor(server, extra.sampling ? { sampling: extra.sampling } : {});
    const config: EvalConfig = { harness: real.harness, defaults, models: { fake: profile } };
    const lines: string[] = [];
    const warnings: string[] = [];
    const outcome = await runEval({
      config,
      modelName: "fake",
      tasks: [makeTask("alpha"), makeTask("beta")],
      trials: 1,
      concurrency: 1,
      resultsDir,
      log: (l) => lines.push(l),
      warn: (w) => warnings.push(w),
      ...extra
    });
    return { ...outcome, lines, warnings, server };
  } finally {
    await server.close();
  }
}

test("an invalid trial is reported, left out of the numbers, and re-run by --resume without repeating the graded one", opts, async () => {
  // alpha: writes the file and answers. beta: the provider rejects its first call.
  const first = await go([write, done, { kind: "http", status: 400 }]);
  assert.equal(first.code, EXIT.incomplete);
  const summary = first.summary!;
  assert.equal(summary.overall.trials, 1, "only the graded trial counts");
  assert.equal(summary.overall.invalid_trials, 1);
  assert.deepEqual(summary.overall.by_class, { passed: 1, infra_error: 1 });
  assert.equal(summary.overall.pass_at_1, 1, "beta is not a failure, it is missing");
  assert.equal(summary.tasks.find((t) => t.task === "beta")!.pass_rate, null);
  assert.ok(first.lines.some((l) => l.includes("--resume")), "it says how to finish the run");
  assert.deepEqual(finishedTrials(first.runDir!).map((r) => r.task), ["alpha"]);

  // Resume with a healthy server: only beta runs.
  const second = await go([write, done], { resumeDir: first.runDir });
  assert.equal(second.code, EXIT.ok);
  assert.equal(second.runDir, first.runDir);
  assert.equal(second.server.requests.length, 2, "alpha was not run again: beta's two model calls are all the server saw");
  assert.equal(second.summary!.overall.trials, 2);
  assert.equal(second.summary!.overall.invalid_trials, 0);
  assert.equal(second.summary!.overall.pass_at_1, 1);
  const run = JSON.parse(fs.readFileSync(path.join(first.runDir!, "run.json"), "utf-8"));
  assert.equal(run.resumed.length, 1, "the resume is recorded");

  // The replaced attempt is evidence: it stays on disk, and in the report.
  const archived = path.join(first.runDir!, "trials", "beta", "1.excluded-1");
  assert.ok(fs.existsSync(path.join(archived, "result.json")), "the first attempt's folder was moved aside, not deleted");
  assert.equal(JSON.parse(fs.readFileSync(path.join(archived, "result.json"), "utf-8")).class, "infra_error");
  assert.deepEqual(second.summary!.excluded!.map((a) => [a.task, a.trial, a.class]), [["beta", 1, "infra_error"]]);
  assert.equal(second.summary!.resumes, 1);
  assert.ok(fs.readFileSync(path.join(first.runDir!, "summary.md"), "utf-8").includes("Earlier attempts left out and re-run"));
  assert.deepEqual(finishedTrials(first.runDir!).map((r) => r.task).sort(), ["alpha", "beta"], "archived attempts never count as finished");
  assert.ok(fs.existsSync(path.join(first.runDir!, "summary.md")));
});

test("a resume refuses when the conditions changed, unless forced", opts, async () => {
  const first = await go([{ kind: "http", status: 400 }]);
  assert.equal(first.code, EXIT.incomplete);

  const changed = await go([write, done], { resumeDir: first.runDir, sampling: { temperature: 0.9, top_p: 0.95, top_k: 20, seed: 7 } });
  assert.equal(changed.code, EXIT.usage);
  assert.ok(changed.lines.some((l) => l.includes("would mix two experiments")));
  assert.equal(changed.server.requests.length, 0, "nothing was sent to the model");

  const forced = await go([write, done], { resumeDir: first.runDir, force: true, sampling: { temperature: 0.9, top_p: 0.95, top_k: 20, seed: 7 } });
  assert.notEqual(forced.code, EXIT.usage);
});

test("a run made before run conditions were recorded cannot be resumed", opts, async () => {
  const old = path.join(resultsDir, "old-run");
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, "run.json"), JSON.stringify({ model: "fake", tasks: ["alpha"], trials: 1, concurrency: 1, started: "2026-10-09T12:00:00Z" }));
  const attempt = await go([done], { resumeDir: old });
  assert.equal(attempt.code, EXIT.usage);
  assert.ok(attempt.lines.some((l) => l.includes("older runner")));
});

test("a run with unpinned conditions says so up front and in its report", opts, async () => {
  const run = await go([write, done, write, done], { sampling: {} });
  assert.ok(run.warnings.some((w) => w.includes("unpinned run conditions: sampling.temperature, sampling.top_p, sampling.top_k")));
  assert.match(fs.readFileSync(path.join(run.runDir!, "summary.md"), "utf-8"), /Unpinned run conditions: sampling\.temperature/);
  const conditions = JSON.parse(fs.readFileSync(path.join(run.runDir!, "run.json"), "utf-8")).conditions;
  assert.deepEqual(conditions.unpinned, ["sampling.temperature", "sampling.top_p", "sampling.top_k"]);
  assert.equal(conditions.max_tokens, 4096);
  assert.equal(conditions.lmstudio[0].quantization, "Q8_0", "what the server said about the model is kept");
  assert.match(conditions.node, /^v\d+/);
  assert.equal(Object.keys(conditions.tasks).length, 2);
});

test("resummarize rebuilds a run's summary from its trials without running anything, and refuses an older run", opts, async () => {
  const run = await go([write, done, write, done]);
  const dir = run.runDir!;
  const before = fs.readFileSync(path.join(dir, "summary.md"), "utf-8");
  fs.writeFileSync(path.join(dir, "summary.md"), "stale");
  fs.rmSync(path.join(dir, "summary.json"));

  const sent = run.server.requests.length;
  const rebuilt = resummarize(dir);
  assert.deepEqual(rebuilt.overall.by_class, run.summary!.overall.by_class);
  assert.equal(rebuilt.overall.pass_at_1, run.summary!.overall.pass_at_1);
  assert.equal(fs.readFileSync(path.join(dir, "summary.md"), "utf-8"), before, "the same report, rebuilt from the trial files");
  assert.ok(fs.existsSync(path.join(dir, "summary.json")));
  assert.equal(run.server.requests.length, sent, "no model was called");

  const old = path.join(resultsDir, "older-run");
  fs.mkdirSync(path.join(old, "trials", "alpha", "1"), { recursive: true });
  fs.writeFileSync(path.join(old, "run.json"), JSON.stringify({ model: "fake", started: "2026-10-09T12:00:00Z" }));
  fs.writeFileSync(path.join(old, "trials", "alpha", "1", "result.json"), JSON.stringify({ task: "alpha", trial: 1, passed: true }));
  assert.throws(() => resummarize(old), /older runner/);
});
