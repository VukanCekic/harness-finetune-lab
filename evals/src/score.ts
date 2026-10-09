/**
 * What a trial's transcript says about the model, beyond pass/fail: are its
 * tool calls well formed, what did it cost, did it do anything it should not.
 * Reads the harness's session log, which is written as the run goes - so a
 * run that timed out still has a transcript, just no turn record.
 */
import fs from "node:fs";
import path from "node:path";

export interface Session {
  messages: any[];
  /** Written when the turn finishes: steps, cost, tokens. Absent if the run was killed. */
  turn: any | null;
}

export function readSession(dir: string): Session | null {
  if (!fs.existsSync(dir)) return null;
  const file = fs.readdirSync(dir).find((f) => f.endsWith(".jsonl"));
  if (!file) return null;
  const messages: any[] = [];
  let turn: any = null;
  for (const line of fs.readFileSync(path.join(dir, file), "utf-8").split("\n")) {
    if (!line.trim()) continue;
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // a line cut off by the kill
    }
    // The log is append-only: each message appears once as a `message` record.
    // `replace` records (compaction) repeat earlier messages and are skipped.
    if (record.type === "message") messages.push(record.message);
    if (record.type === "turn") turn = record;
  }
  return { messages, turn };
}

// ---------------------------------------------------------- tool validity

export interface ToolSchemas {
  harness_commit: string;
  /** Tool name -> JSON schema of its arguments. */
  tools: Record<string, any>;
  /** Extra names the harness accepts for a tool, e.g. string_replace -> str_replace. */
  aliases: Record<string, string>;
}

const kind = (value: unknown): string =>
  value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;

function matchesType(type: string, value: unknown): boolean {
  const actual = kind(value);
  return type === actual || (type === "number" && actual === "integer");
}

/**
 * The subset of JSON Schema tool definitions use: type, enum, required,
 * properties, additionalProperties: false, items. Returns the first problem.
 */
export function schemaError(schema: any, value: unknown, at = "args"): string | null {
  if (!schema || typeof schema !== "object") return null;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return `${at} must be one of ${schema.enum.map((v: unknown) => JSON.stringify(v)).join(", ")}`;
  }
  if (schema.type !== undefined) {
    const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(t, value))) return `${at} should be ${types.join(" or ")}, got ${kind(value)}`;
  }
  if (kind(value) === "object") {
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in object)) return `${at}.${key} is required`;
    for (const [key, item] of Object.entries(object)) {
      const sub = schema.properties?.[key];
      if (sub === undefined) {
        if (schema.additionalProperties === false) return `${at}.${key} is not a known argument`;
        continue;
      }
      const error = schemaError(sub, item, `${at}.${key}`);
      if (error) return error;
    }
  }
  if (Array.isArray(value) && schema.items) {
    for (const [i, item] of value.entries()) {
      const error = schemaError(schema.items, item, `${at}[${i}]`);
      if (error) return error;
    }
  }
  return null;
}

export type Invalid = { tool: string; reason: "invalid_json" | "not_an_object" | "unknown_tool" | "schema"; detail: string };

/** One tool call, as the model sent it: parseable JSON object, a real tool, arguments that fit its schema. */
export function checkCall(call: any, schemas: ToolSchemas): Invalid | null {
  const tool = String(call?.function?.name ?? "");
  const raw = call?.function?.arguments;
  let args: unknown;
  try {
    args = JSON.parse(raw || "{}");
  } catch (err: any) {
    return { tool, reason: "invalid_json", detail: `${err.message}: ${String(raw).slice(0, 120)}` };
  }
  if (kind(args) !== "object") return { tool, reason: "not_an_object", detail: String(raw).slice(0, 120) };
  const schema = schemas.tools[tool] ?? schemas.tools[schemas.aliases[tool] ?? ""];
  if (schema === undefined) return { tool, reason: "unknown_tool", detail: tool };
  const error = schemaError(schema, args);
  return error ? { tool, reason: "schema", detail: error } : null;
}

// ------------------------------------------------------------ side effects

const GLOBAL_INSTALL = /\b(npm\s+(i|install|add)\b[^\n;&|]*\s(-g|--global)\b|yarn\s+global\s+add|pnpm\s+(add|install)\b[^\n;&|]*\s(-g|--global)\b)/;

// ------------------------------------------------------------------- score

export interface TranscriptScore {
  tool_calls: number;
  valid_tool_calls: number;
  invalid_tool_calls: Invalid[];
  /** Tool results the harness reported as errors or refusals - the model's calls that went nowhere. */
  tool_errors: number;
  tools_used: Record<string, number>;
  /** bash commands that tried to install packages globally. */
  global_installs: string[];
  steps: number | null;
  cost_usd: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cached_tokens: number | null;
  final_response: string | null;
}

export function scoreSession(session: Session | null, schemas: ToolSchemas): TranscriptScore {
  const score: TranscriptScore = {
    tool_calls: 0,
    valid_tool_calls: 0,
    invalid_tool_calls: [],
    tool_errors: 0,
    tools_used: {},
    global_installs: [],
    steps: null,
    cost_usd: null,
    prompt_tokens: null,
    completion_tokens: null,
    cached_tokens: null,
    final_response: null
  };
  if (!session) return score;

  for (const message of session.messages) {
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) {
        score.tool_calls++;
        const name = String(call?.function?.name ?? "?");
        score.tools_used[name] = (score.tools_used[name] ?? 0) + 1;
        const invalid = checkCall(call, schemas);
        if (invalid) score.invalid_tool_calls.push(invalid);
        else score.valid_tool_calls++;
        if (name === "bash") {
          try {
            const command = String(JSON.parse(call.function.arguments || "{}").command ?? "");
            if (GLOBAL_INSTALL.test(command)) score.global_installs.push(command.slice(0, 200));
          } catch {
            // already counted as invalid
          }
        }
      }
      if (typeof message.content === "string" && message.content.trim()) score.final_response = message.content;
    }
    if (message.role === "tool" && /^(Error|Permission denied)\b/.test(String(message.content ?? ""))) score.tool_errors++;
  }

  const turn = session.turn;
  if (turn) {
    score.steps = typeof turn.steps === "number" ? turn.steps : null;
    score.cost_usd = typeof turn.cost === "number" ? turn.cost : null;
    const roles = Object.values(turn.cost_by_role ?? {}) as any[];
    if (roles.length > 0) {
      score.prompt_tokens = roles.reduce((sum, r) => sum + (r.promptTokens ?? 0), 0);
      score.completion_tokens = roles.reduce((sum, r) => sum + (r.completionTokens ?? 0), 0);
      score.cached_tokens = roles.reduce((sum, r) => sum + (r.cachedTokens ?? 0), 0);
    }
  } else {
    score.steps = session.messages.filter((m) => m.role === "assistant").length;
  }
  return score;
}
