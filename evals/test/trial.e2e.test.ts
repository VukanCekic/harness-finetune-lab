/**
 * The whole path of one trial, with a scripted server instead of a model: the
 * runner builds the environment, spawns the REAL harness in a temp workspace,
 * reads its logs, runs the checks and classifies the outcome. This is what
 * keeps the infrastructure failures from the 2026-10-09 review (a stalled
 * server graded as a model failure, a crash on exit, settings that were never
 * applied) from coming back. Skipped when the harness checkout is not there.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, TOOL_SCHEMAS_FILE, type ModelProfile, type Task } from "../src/config.js";
import { harnessInfo, harnessSupportsSettings } from "../src/harness.js";
import type { ToolSchemas } from "../src/score.js";
import { runTrial, trialDirOf } from "../src/trial.js";
import { fakeServer, type Reply } from "./support/fakeServer.js";
import { defaults, makeTask, profileFor } from "./support/kit.js";

const config = loadConfig();
const present = fs.existsSync(path.join(config.harness.dir, "node_modules", "tsx")) && harnessSupportsSettings(config.harness.dir);
const opts = { skip: present ? false : `no harness checkout with settings support at ${config.harness.dir}` };

const schemas: ToolSchemas = JSON.parse(fs.readFileSync(TOOL_SCHEMAS_FILE, "utf-8"));
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "hfl-e2e-run-"));
after(() => fs.rmSync(runDir, { recursive: true, force: true }));

async function trial(id: string, script: Reply[], taskOver: Partial<Task> = {}, profileOver: Partial<ModelProfile> = {}, extraEnv?: Record<string, string>) {
  const server = await fakeServer(script);
  try {
    const task = makeTask(id, taskOver);
    const result = await runTrial(task, 1, { runDir, harness: harnessInfo(config.harness.dir), profile: profileFor(server, profileOver), defaults, schemas, extraEnv });
    return { result, server, dir: trialDirOf(runDir, id, 1) };
  } finally {
    await server.close();
  }
}

const write = (content = "console.log('hi')\n"): Reply => ({ kind: "tool", name: "write_file", args: { path: "greet.js", content } });
const done: Reply = { kind: "text", content: "Done." };
const messages = (dir: string): any[] => {
  const file = fs.readdirSync(path.join(dir, "session")).find((f) => f.endsWith(".jsonl"))!;
  return fs.readFileSync(path.join(dir, "session", file), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
};

test("a model that does the work passes, and every log of it is kept", opts, async () => {
  const { result, server, dir } = await trial("passes", [write(), done]);
  assert.equal(result.class, "passed", JSON.stringify(result.class_detail));
  assert.equal(result.valid, true);
  assert.equal(result.exit_code, 0);
  assert.equal(result.stop_reason, "done");
  assert.equal(result.steps, 2);
  assert.equal(result.tool_calls, 1);
  assert.equal(result.valid_tool_calls, 1);
  assert.equal(result.validity_scope, "all_agents");
  assert.equal(result.wire_calls, 2, "both model calls are in the wire log");
  assert.match(result.system_prompt_sha256!, /^[0-9a-f]{64}$/);
  assert.match(result.tools_sha256!, /^[0-9a-f]{64}$/);
  assert.equal(result.prompt_tokens, 200, "usage from the finished turn");
  assert.equal(result.usage_source, "turn");
  assert.deepEqual(result.escapes, []);

  // What the harness says it ran with is what the config asked for.
  const settings: any = result.harness_settings;
  assert.deepEqual(settings.sampling, { temperature: 0.6, topP: 0.95, topK: 20, seed: 7 });
  assert.equal(settings.max_output_tokens, 4096);
  assert.equal(settings.max_turn_tokens, 100000);
  // ... and it reached the wire, in the OpenAI field names.
  const body = server.requests[0];
  assert.deepEqual([body.temperature, body.top_p, body.top_k, body.seed, body.max_tokens], [0.6, 0.95, 20, 7, 4096]);

  for (const file of ["result.json", "harness.log", "wire.jsonl", "session"]) assert.ok(fs.existsSync(path.join(dir, file)), file);
  assert.ok(fs.existsSync(path.join(dir, "workspace", "greet.js")), "the agent's files are kept");
  assert.equal(messages(dir).filter((r) => r.type === "step").length, 2, "a step record per model call");
});

test("the model's thinking is kept in the wire log, though the harness never shows it", opts, async () => {
  const { dir } = await trial("thinks", [{ kind: "text", content: "Done.", reasoning: "let me think about greet.js" }]);
  const calls = fs.readFileSync(path.join(dir, "wire.jsonl"), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(calls[0].response.reasoning, "let me think about greet.js");
  assert.equal(calls[0].response.content, "Done.");
  assert.ok(!fs.readFileSync(path.join(dir, "harness.log"), "utf-8").includes("let me think"));
});

test("thinking off reaches the model as the soft switch", opts, async () => {
  const { server } = await trial("nothink", [done], {}, { thinking: "off" });
  assert.match(server.requests[0].messages[0].content, /\n\n\/no_think$/);
});

test("an HTTP error from the provider is infra_error, with exit code 3 - not a model failure", opts, async () => {
  const { result } = await trial("http400", [{ kind: "http", status: 400 }]);
  assert.equal(result.class, "infra_error");
  assert.equal(result.valid, false);
  assert.equal(result.exit_code, 3, "the harness no longer exits 0 on a failed turn");
  assert.match(result.class_detail!, /HTTP 400/);
  assert.equal(result.turn_error?.message.includes("HTTP 400"), true);
});

test("a stalled server is infra_error too (it used to be graded as the model failing)", opts, async () => {
  const { result } = await trial("stall", [{ kind: "stall" }], {}, {}, { STALL_MS: "1500" });
  assert.equal(result.class, "infra_error");
  assert.equal(result.exit_code, 3);
  assert.match(result.class_detail!, /no data from the provider/);
});

test("the wall clock kills a hung run: timeout, not graded, with the time it was stuck", opts, async () => {
  const { result } = await trial("hung", [{ kind: "stall" }], { timeout_s: 4 } as Partial<Task>, {}, { STALL_MS: "60000" });
  assert.equal(result.class, "timeout_progress", "a few seconds in flight is not a runaway generation");
  assert.equal(result.valid, false);
  assert.equal(result.timed_out, true);
  assert.ok(result.in_flight_s! >= 1 && result.in_flight_s! < 30);
  assert.equal(result.stop_reason, null, "no turn record: it was killed");
});

test("running out of steps is the model's failure, and says so", opts, async () => {
  const { result } = await trial("steps", [{ kind: "tool", name: "bash", args: { command: "echo hi" } }], { max_steps: 2 } as Partial<Task>);
  assert.equal(result.class, "max_steps");
  assert.equal(result.valid, true);
  assert.equal(result.stop_reason, "max_steps");
  assert.equal(result.exit_code, 0);
});

test("the turn token budget ends a runaway: token_budget", opts, async () => {
  // The fake server reports 20 completion tokens per reply; allow one reply's worth.
  const server = await fakeServer([{ kind: "tool", name: "bash", args: { command: "echo hi" } }]);
  try {
    const task = makeTask("tokens");
    const result = await runTrial(task, 1, { runDir, harness: harnessInfo(config.harness.dir), profile: profileFor(server), defaults: { ...defaults, max_turn_tokens: 20 }, schemas });
    assert.equal(result.class, "token_budget");
    assert.equal(result.valid, true);
    assert.equal(result.stop_reason, "token_budget");
  } finally {
    await server.close();
  }
});

test("reaching into the lab repo contaminates the trial, even if its checks pass", opts, async () => {
  const lab = path.resolve(import.meta.dirname, "../..").replace(/\\/g, "/");
  const { result } = await trial("peek", [write(), { kind: "tool", name: "bash", args: { command: `cat ${lab}/package.json` } }, done]);
  assert.equal(result.class, "contaminated");
  assert.equal(result.valid, false);
  assert.equal(result.checks.every((c) => c.passed), true, "it would have passed");
  assert.equal(result.escapes[0].kind, "lab");
});

test("a wire log the harness could not write is a harness error - not a silently empty one", opts, async () => {
  // WIRE_LOG pointing at a directory: the harness swallows the write errors, so the runner's own file never appears.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hfl-e2e-notafile-"));
  const { result } = await trial("nowire", [write(), done], {}, {}, { WIRE_LOG: dir });
  assert.equal(result.class, "harness_error");
  assert.equal(result.valid, false);
  assert.match(result.class_detail!, /no wire log although the agent made model calls/);
  assert.equal(result.validity_scope, "main_only", "its tool calls are still scored, from the transcript");
  assert.equal(result.tool_calls, 1);
});

test("the agent's environment is an allowlist: npm's variables and other keys are not in it", opts, async () => {
  const planted = { INIT_CWD: "D:\\code\\harness-finetune-lab", npm_package_json: "D:\\code\\harness-finetune-lab\\package.json", ANTHROPIC_API_KEY: "sk-ant-planted", GITHUB_TOKEN: "ghp_planted" };
  const saved = Object.fromEntries(Object.keys(planted).map((k) => [k, process.env[k]]));
  Object.assign(process.env, planted);
  try {
    const { result, dir } = await trial("env", [{ kind: "tool", name: "bash", args: { command: "env" } }, done]);
    const output = messages(dir).filter((r) => r.type === "message" && r.message.role === "tool").map((r) => String(r.message.content)).join("\n");
    assert.ok(output.length > 0, "the env command ran");
    for (const name of Object.keys(planted)) assert.ok(!output.includes(name), `${name} reached the agent`);
    assert.ok(!output.includes("harness-finetune-lab"), "nothing in its environment names this repo");
    for (const name of ["SESSION_DIR", "WIRE_LOG"]) assert.ok(!new RegExp(`^${name}=`, "m").test(output), `${name} would point the agent at the runner's results folder`);
    assert.match(output, /npm_config_prefix=.*hfl-npm-/, "its npm prefix is a scratch folder in the temp dir");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
