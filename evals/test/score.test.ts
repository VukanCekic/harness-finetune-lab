import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkCall, maskPath, readSession, schemaError, scoreSession, textCall, type ToolSchemas } from "../src/score.js";
import type { WireCall } from "../src/wire.js";

const schemas: ToolSchemas = {
  harness_commit: "test",
  tools: {
    read_file: {
      type: "object",
      properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } },
      required: ["path"]
    },
    write_todos: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: { content: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] } },
            required: ["content", "status"],
            additionalProperties: false
          }
        }
      },
      required: ["todos"]
    },
    str_replace: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    bash: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    plan_task: { type: "object", properties: { goal: { type: "string" } }, required: ["goal"] }
  },
  aliases: { string_replace: "str_replace" },
  offered: {
    default: ["read_file", "write_todos", "str_replace", "bash", "plan_task"],
    pipeline: ["bash", "plan_task", "read_file"]
  }
};

const call = (name: string, args: unknown) => ({
  id: "c",
  type: "function",
  function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) }
});

test("schemaError: types, required, enums, nested arrays and unknown keys", () => {
  const readFile = schemas.tools.read_file;
  assert.equal(schemaError(readFile, { path: "a.txt" }), null);
  assert.equal(schemaError(readFile, { path: "a.txt", offset: 10 }), null);
  assert.match(schemaError(readFile, {})!, /args\.path is required/);
  assert.match(schemaError(readFile, { path: "a", offset: "10" })!, /args\.offset should be integer, got string/);
  assert.match(schemaError(readFile, { path: "a", offset: 1.5 })!, /should be integer, got number/);
  assert.equal(schemaError(readFile, { path: "a", extra: true }), null, "extra keys are fine unless additionalProperties is false");
  assert.match(schemaError(readFile, { path: "a", extra: true }, "args", true)!, /args\.extra is not a known argument/, "strict mode closes every object that lists its properties");

  const todos = schemas.tools.write_todos;
  assert.equal(schemaError(todos, { todos: [{ content: "x", status: "pending" }] }), null);
  assert.match(schemaError(todos, { todos: [{ content: "x", status: "doing" }] })!, /args\.todos\[0\]\.status must be one of/);
  assert.match(schemaError(todos, { todos: [{ content: "x", status: "pending", id: 1 }] })!, /args\.todos\[0\]\.id is not a known argument/);
  assert.equal(schemaError({ type: "number" }, 3), null, "an integer is a number");
});

test("checkCall: each way a tool call can be invalid", () => {
  assert.equal(checkCall(call("read_file", { path: "a" }), schemas), null);
  assert.equal(checkCall(call("string_replace", { path: "a" }), schemas), null, "aliases the harness accepts are valid");
  assert.equal(checkCall(call("read_file", '{"path": "a"'), schemas)?.reason, "invalid_json");
  assert.equal(checkCall(call("read_file", "[1,2]"), schemas)?.reason, "not_an_object");
  assert.equal(checkCall(call("open_file", { path: "a" }), schemas)?.reason, "unknown_tool");
  assert.equal(checkCall(call("read_file", { file: "a" }), schemas)?.reason, "schema");
  assert.equal(checkCall(call("read_file", ""), schemas)?.reason, "schema", "empty arguments parse as {} and then miss `path`");
  assert.equal(checkCall(call("read_file", { path: "a", encoding: "utf8" }), schemas)?.reason, "unknown_argument", "a made-up argument is not valid");
  assert.equal(checkCall(call("bash", { command: "ls" }), schemas, ["read_file"])?.reason, "not_offered", "a real tool this agent was not offered");
  assert.equal(checkCall(call("string_replace", { path: "a" }), schemas, ["str_replace"]), null, "an alias counts as the tool it names");
});

function sessionDir(records: unknown[], trailingGarbage = ""): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hfl-score-"));
  fs.writeFileSync(path.join(dir, "s.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n" + trailingGarbage);
  return dir;
}

test("scoreSession: counts calls, invalid calls, errors, global installs, cost and tokens", () => {
  const dir = sessionDir([
    { type: "meta", model: "m" },
    { type: "message", message: { role: "system", content: "sys" } },
    { type: "message", message: { role: "user", content: "do it" } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: "",
        toolCalls: [call("bash", { command: "npm install -g tsx || npm i --save-dev tsx" }), call("read_file", { nope: 1 })]
      }
    },
    { type: "message", message: { role: "tool", toolCallId: "c", content: "added 3 packages" } },
    { type: "message", message: { role: "tool", toolCallId: "c", content: "Error: path is required" } },
    { type: "message", message: { role: "tool", toolCallId: "c", content: "Tool error: ENOENT" } },
    { type: "message", message: { role: "tool", toolCallId: "c", content: "Permission denied by user for bash." } },
    { type: "replace", reason: "compaction", messages: [{ role: "assistant", toolCalls: [call("bash", { command: "ls" })] }] },
    { type: "message", message: { role: "assistant", content: "Done." } },
    {
      type: "turn",
      steps: 2,
      cost: 0.0012,
      cost_by_role: { main: { promptTokens: 100, completionTokens: 20, cachedTokens: 50 }, worker: { promptTokens: 10, completionTokens: 5, cachedTokens: 0 } }
    }
  ]);
  const score = scoreSession(readSession(dir), schemas);
  assert.equal(score.tool_calls, 2, "messages repeated in a replace record are not counted twice");
  assert.equal(score.valid_tool_calls, 1);
  assert.deepEqual(score.invalid_tool_calls.map((i) => i.reason), ["schema"]);
  assert.equal(score.tool_errors, 3, "Error:, Tool error: and Permission denied all count");
  assert.deepEqual(score.tools_used, { bash: 1, read_file: 1 });
  assert.equal(score.validity_scope, "main_only", "no wire log: only the main transcript is scored");
  assert.equal(score.global_installs.length, 1);
  assert.equal(score.steps, 2);
  assert.equal(score.cost_usd, 0.0012);
  assert.equal(score.prompt_tokens, 110);
  assert.equal(score.completion_tokens, 25);
  assert.equal(score.cached_tokens, 50);
  assert.equal(score.final_response, "Done.");
});

test("scoreSession: a killed run has a transcript but no turn record", () => {
  const dir = sessionDir(
    [
      { type: "message", message: { role: "assistant", content: "", toolCalls: [call("bash", { command: "npm test" })] } },
      { type: "message", message: { role: "assistant", content: "", toolCalls: [call("bash", { command: "npm test" })] } }
    ],
    '{"type":"message","message":{"role":"assis' // cut off mid-line by the kill
  );
  const score = scoreSession(readSession(dir), schemas);
  assert.equal(score.tool_calls, 2);
  assert.equal(score.steps, 2, "steps fall back to the number of assistant messages");
  assert.equal(score.cost_usd, null);
  assert.equal(score.global_installs.length, 0, "a local install is not a global one");
});

test("readSession: no directory or no log is null, and scoring null is all zeros", () => {
  assert.equal(readSession(path.join(os.tmpdir(), "hfl-does-not-exist")), null);
  const score = scoreSession(null, schemas);
  assert.equal(score.tool_calls, 0);
  assert.equal(score.steps, null);
});

test("the transcript path checks each call against the tools of its mode: a pipeline starts after plan_task", () => {
  const dir = sessionDir([
    { type: "message", message: { role: "assistant", toolCalls: [call("str_replace", { path: "a" }), call("plan_task", { goal: "g" })] } },
    { type: "message", message: { role: "assistant", toolCalls: [call("str_replace", { path: "a" })] } }
  ]);
  const score = scoreSession(readSession(dir), schemas);
  assert.deepEqual(score.invalid_tool_calls.map((i) => i.reason), ["not_offered"], "str_replace was offered before the pipeline started, not after");
  assert.equal(score.valid_tool_calls, 2);
});

test("textCall: a call written into the reply is found; ordinary prose is not", () => {
  assert.equal(textCall('<tool_call>\n{"name": "bash", "arguments": {"command": "ls"}}\n</tool_call>', schemas), "bash");
  assert.equal(textCall('I will run {"name": "read_file", "arguments": {"path": "a"}} now', schemas), "read_file");
  assert.equal(textCall("<tool_call>garbled", schemas), "?", "a tag with nothing parseable is still an attempt");
  assert.equal(textCall("<function=bash>", schemas), "bash");
  assert.equal(textCall('The config has {"name": "app", "arguments": 3}', schemas), null, "a JSON blob that names no tool is just text");
  assert.equal(textCall("Done. All tests pass.", schemas), null);
});

test("a call written as text is an invalid attempt, counted in the total", () => {
  const dir = sessionDir([
    { type: "message", message: { role: "assistant", content: '<tool_call>{"name": "bash", "arguments": {"command": "ls"}}</tool_call>' } },
    { type: "message", message: { role: "assistant", content: "All done." } }
  ]);
  const score = scoreSession(readSession(dir), schemas);
  assert.equal(score.tool_calls, 1);
  assert.equal(score.valid_tool_calls, 0);
  assert.deepEqual(score.invalid_tool_calls.map((i) => [i.tool, i.reason]), [["bash", "text_call"]]);
});

const wireCall = (role: string, offered: string[], toolCalls: any[], usage: any = null, content = ""): WireCall => ({
  type: "call",
  role,
  at: "2026-10-09T12:00:00.000Z",
  duration_ms: 1000,
  backend: "local",
  model: "m",
  request: { messages: [], tools: offered.map((name) => ({ type: "function", function: { name } })) },
  response: { content, tool_calls: toolCalls, finish_reason: toolCalls.length ? "tool_calls" : "stop", usage }
});

test("with a wire log every agent's calls are scored against the tools its own request offered", () => {
  const wire = [
    wireCall("main", ["bash", "plan_task"], [call("bash", { command: "ls" })]),
    wireCall("researcher", ["read_file", "bash"], [call("read_file", { path: "a" }), call("str_replace", { path: "a" })]),
    wireCall("compaction", [], [], null, '{"name": "bash", "arguments": {}}')
  ];
  const score = scoreSession(null, schemas, { wire });
  assert.equal(score.validity_scope, "all_agents");
  assert.equal(score.wire_calls, 3);
  assert.equal(score.tool_calls, 3, "the compaction reply is not a tool call attempt");
  assert.deepEqual(score.served_by, []);
  assert.equal(score.valid_tool_calls, 2);
  assert.deepEqual(score.invalid_tool_calls.map((i) => [i.tool, i.reason, i.agent]), [["str_replace", "not_offered", "researcher"]]);
  assert.match(score.tools_sha256!, /^[0-9a-f]{64}$/);
});

test("a killed run keeps its cost and tokens: from the wire log, else from the step records", () => {
  const session = readSession(
    sessionDir([
      { type: "meta", settings: { sampling: {} } },
      { type: "message", message: { role: "system", content: "sys" } },
      { type: "step", step: 1, prompt_tokens: 100, completion_tokens: 40, reasoning_tokens: 30, cached_tokens: 0, cost: 0.01 },
      { type: "step", step: 2, prompt_tokens: 150, completion_tokens: 60, reasoning_tokens: 50, cached_tokens: 20, cost: 0.02 }
    ])
  )!;
  const fromSteps = scoreSession(session, schemas);
  assert.equal(fromSteps.usage_source, "steps");
  assert.deepEqual([fromSteps.prompt_tokens, fromSteps.completion_tokens, fromSteps.cached_tokens, fromSteps.reasoning_tokens], [250, 100, 20, 80]);
  assert.ok(Math.abs(fromSteps.cost_usd! - 0.03) < 1e-12);
  assert.equal(fromSteps.steps, 2);
  assert.equal(fromSteps.turn_error, null);

  const usage = (p: number, c: number, r: number) => ({ prompt_tokens: p, completion_tokens: c, reasoning_tokens: r, cached_tokens: 0, cost: null });
  const wire = [wireCall("main", [], [], usage(100, 40, 30)), wireCall("worker", [], [], usage(200, 80, 60))];
  const fromWire = scoreSession(session, schemas, { wire });
  assert.equal(fromWire.usage_source, "wire");
  assert.deepEqual([fromWire.prompt_tokens, fromWire.completion_tokens, fromWire.reasoning_tokens], [300, 120, 90], "subagents' tokens are included");
  assert.equal(fromWire.cost_usd, null, "no cost reported anywhere means no cost, not zero");
});

test("a finished turn's own figures win, and its stop reason and error are kept", () => {
  const dir = sessionDir([
    { type: "meta", settings: { thinking: "default" } },
    { type: "message", message: { role: "system", content: "sys" } },
    { type: "step", step: 1, prompt_tokens: 1, completion_tokens: 1, cost: 5 },
    { type: "turn", steps: 1, cost: 0.5, stop_reason: "max_steps", cost_by_role: { main: { promptTokens: 7, completionTokens: 3, cachedTokens: 0 } } }
  ]);
  const score = scoreSession(readSession(dir), schemas);
  assert.equal(score.usage_source, "turn");
  assert.equal(score.cost_usd, 0.5);
  assert.equal(score.prompt_tokens, 7);
  assert.equal(score.stop_reason, "max_steps");
  assert.deepEqual(score.harness_settings, { thinking: "default" });
  assert.match(score.system_prompt_sha256!, /^[0-9a-f]{64}$/);

  const failed = scoreSession(readSession(sessionDir([{ type: "turn", error: { name: "Error", message: "HTTP 400" } }])), schemas);
  assert.deepEqual(failed.turn_error, { name: "Error", message: "HTTP 400" });
});

test("global installs: the forms the first pattern missed", () => {
  const installs = ["npm -g install tsx", "npm i -g tsx", "npm install --global tsx", "npm install --location=global tsx", "yarn global add tsx", "pnpm add -g tsx"];
  const fine = ["npm install --save-dev tsx", "npm run build", "npm install lodash"];
  const dir = sessionDir(
    [...installs, ...fine].map((command) => ({ type: "message", message: { role: "assistant", toolCalls: [call("bash", { command })] } }))
  );
  const score = scoreSession(readSession(dir), schemas);
  assert.deepEqual(score.global_installs, installs);
});

test("tool calls that point outside the workspace are collected, once each", () => {
  const where = { workspace: path.join(os.tmpdir(), "hfl-demo-1-abc"), lab: "D:/code/harness-finetune-lab" };
  const dir = sessionDir([
    { type: "message", message: { role: "assistant", toolCalls: [call("read_file", { path: "D:/code/harness-finetune-lab/evals/tasks/x/solution/a.js" }), call("read_file", { path: "src/a.js" })] } },
    { type: "message", message: { role: "assistant", toolCalls: [call("read_file", { path: "D:/code/harness-finetune-lab/evals/tasks/x/solution/a.js" })] } }
  ]);
  const score = scoreSession(readSession(dir), schemas, { where });
  assert.deepEqual(score.escapes.map((e) => e.kind), ["lab"]);
});

test("with a wire log, a call is checked against the schema its own request carried - including tools built per run", () => {
  const request = (name: string, parameters: object): WireCall => ({
    ...wireCall("reviewer", ["read_file", name], [call(name, { verdict: "approved" })]),
    request: {
      messages: [],
      tools: [
        { type: "function", function: { name: "read_file", parameters: schemas.tools.read_file } },
        { type: "function", function: { name, parameters } }
      ]
    }
  });
  const submit = { type: "object", properties: { verdict: { type: "string", enum: ["approved", "changes_requested"] } }, required: ["verdict"] };
  const ok = scoreSession(null, schemas, { wire: [request("submit_review", submit)] });
  assert.equal(ok.valid_tool_calls, 1, "submit_review is in no static snapshot, but the request offered it");
  assert.deepEqual(ok.invalid_tool_calls, []);

  const wrong = scoreSession(null, schemas, { wire: [request("submit_review", { ...submit, properties: { verdict: { type: "string", enum: ["lgtm"] } } })] });
  assert.match(wrong.invalid_tool_calls[0].detail, /must be one of "lgtm"/, "the request's own schema is the one that decides");
  assert.equal(checkCall(call("submit_review", { verdict: "approved" }), schemas)?.reason, "unknown_tool", "without the request there is nothing to check it against");
});

test("the system prompt hashes the same whichever temp folder the trial ran in", () => {
  const prompt = (dir: string) => ({ type: "message", message: { role: "system", content: "You are an agent. Your current working directory is: " + dir + " - be careful." } });
  const hash = (dir: string, as = dir) => scoreSession(readSession(sessionDir([prompt(as)])), schemas, { where: { workspace: dir, lab: "D:/lab" } }).system_prompt_sha256;
  const a = path.join(os.tmpdir(), "hfl-slugify-1-abc123");
  const b = path.join(os.tmpdir(), "hfl-slugify-1-zzz999");
  assert.equal(hash(a), hash(b), "only the random folder name differs");
  assert.equal(hash(a), hash(a, a.split(path.sep).join("/")), "slash direction does not matter");
  const other = scoreSession(readSession(sessionDir([{ type: "message", message: { role: "system", content: "You are another agent." } }])), schemas, { where: { workspace: a, lab: "D:/lab" } });
  assert.notEqual(hash(a), other.system_prompt_sha256, "a different prompt is a different hash");
  assert.equal(maskPath("in C:/Temp/x/y and C:/Temp/x/y/z", "C:/Temp/x/y"), "in <workspace> and <workspace>/z");
});
