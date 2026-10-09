import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkCall, readSession, schemaError, scoreSession, type ToolSchemas } from "../src/score.js";

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
    bash: { type: "object", properties: { command: { type: "string" } }, required: ["command"] }
  },
  aliases: { string_replace: "str_replace" }
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
  assert.equal(score.tool_errors, 1);
  assert.deepEqual(score.tools_used, { bash: 1, read_file: 1 });
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
