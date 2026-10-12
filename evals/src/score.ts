/**
 * What a trial's logs say about the model, beyond pass/fail: are its tool
 * calls well formed, what did it cost, did it reach outside its workspace.
 *
 * Two sources. The session log (the main transcript, step records, the turn
 * record) is written as the run goes, so a run that timed out still has a
 * transcript, just no turn record. The wire log has every model call of every
 * agent - subagents too - with the exact tool list each request offered; when
 * it exists, tool calls are scored from it.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { callEscapes, uniqueEscapes, type Escape, type Where } from "./escape.js";
import { offeredTools, type WireCall } from "./wire.js";

export interface Session {
  messages: any[];
  /** Written when the turn finishes: steps, cost, tokens, stop reason, or the error that ended it. Absent if the run was killed. */
  turn: any | null;
  /** The first record: the settings the harness actually ran with. */
  meta: any | null;
  /** One per main-loop model call, written as each returns. */
  steps: any[];
}

export function readSession(dir: string): Session | null {
  if (!fs.existsSync(dir)) return null;
  const file = fs.readdirSync(dir).find((f) => f.endsWith(".jsonl"));
  if (!file) return null;
  const messages: any[] = [];
  const steps: any[] = [];
  let turn: any = null;
  let meta: any = null;
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
    if (record.type === "meta") meta = record;
    if (record.type === "step") steps.push(record);
  }
  return { messages, turn, meta, steps };
}

// ---------------------------------------------------------- tool validity

export interface ToolSchemas {
  harness_commit: string;
  /** Tool name -> JSON schema of its arguments. */
  tools: Record<string, any>;
  /** Extra names the harness accepts for a tool, e.g. string_replace -> str_replace. */
  aliases: Record<string, string>;
  /** Which tools the main agent is offered, by mode. A pipeline starts once it calls plan_task. */
  offered?: { default: string[]; pipeline: string[] };
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
 * `strict` also refuses keys a schema with `properties` does not list: no
 * harness tool sets additionalProperties: false, so without it a misspelled or
 * made-up argument passes.
 */
export function schemaError(schema: any, value: unknown, at = "args", strict = false): string | null {
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
        const closed = schema.additionalProperties === false || (strict && schema.properties && schema.additionalProperties === undefined);
        if (closed) return `${at}.${key} is not a known argument`;
        continue;
      }
      const error = schemaError(sub, item, `${at}.${key}`, strict);
      if (error) return error;
    }
  }
  if (Array.isArray(value) && schema.items) {
    for (const [i, item] of value.entries()) {
      const error = schemaError(schema.items, item, `${at}[${i}]`, strict);
      if (error) return error;
    }
  }
  return null;
}

export type Invalid = {
  tool: string;
  reason: "invalid_json" | "not_an_object" | "unknown_tool" | "not_offered" | "schema" | "unknown_argument" | "text_call";
  detail: string;
  /** Which agent made the call, when it was not the main one. */
  agent?: string;
};

/**
 * One tool call, as the model sent it: parseable JSON object, a real tool, one
 * it was offered, arguments that fit its schema and name nothing else.
 */
export function checkCall(call: any, schemas: ToolSchemas, offered?: string[] | null, requested?: Record<string, any> | null): Invalid | null {
  const tool = String(call?.function?.name ?? "");
  const raw = call?.function?.arguments;
  let args: unknown;
  try {
    args = JSON.parse(raw || "{}");
  } catch (err: any) {
    return { tool, reason: "invalid_json", detail: `${err.message}: ${String(raw).slice(0, 120)}` };
  }
  if (kind(args) !== "object") return { tool, reason: "not_an_object", detail: String(raw).slice(0, 120) };
  // `requested` is what the request itself carried: the tools as this agent was offered them, including any the
  // harness builds per run (the reviewer's submit_review) that a static snapshot cannot hold.
  const canonical = requested?.[tool] || schemas.tools[tool] ? tool : (schemas.aliases[tool] ?? "");
  const schema = requested?.[canonical] ?? schemas.tools[canonical];
  if (schema === undefined) return { tool, reason: "unknown_tool", detail: tool };
  if (offered && !offered.includes(tool) && !offered.includes(canonical)) {
    return { tool, reason: "not_offered", detail: `${tool} was not among the ${offered.length} tools offered to this agent` };
  }
  const error = schemaError(schema, args, "args", true);
  if (!error) return null;
  return { tool, reason: error.endsWith("is not a known argument") ? "unknown_argument" : "schema", detail: error };
}

/**
 * A tool call written into the reply text instead of the call channel - what
 * Qwen does when the server fails to parse its <tool_call> block. The harness
 * treats that text as a final answer, so no call is ever seen. Returns the
 * tool it names, or null if the text is not a call.
 */
export function textCall(content: string, schemas: ToolSchemas): string | null {
  if (!content) return null;
  const names = Object.keys(schemas.tools).concat(Object.keys(schemas.aliases));
  const tagged = /<tool_call>\s*([\s\S]*?)(?:<\/tool_call>|$)/.exec(content);
  const search = tagged ? tagged[1] : content;
  const json = /"name"\s*:\s*"([\w.-]+)"[\s\S]{0,400}?"(?:arguments|parameters)"\s*:/.exec(search);
  if (json && (tagged || names.includes(json[1]))) return json[1];
  const fn = /<function=([\w.-]+)>/.exec(content);
  if (fn) return fn[1];
  return tagged ? "?" : null;
}

// ------------------------------------------------------------ side effects

const GLOBAL_INSTALL = /\b(npm\s+(?:(?:i|install|add)\b[^\n;&|]*\s(?:-g|--global|--location[= ]global)\b|(?:-g|--global|--location[= ]global)\s+(?:i|install|add)\b)|yarn\s+global\s+add|pnpm\s+(add|install)\b[^\n;&|]*\s(-g|--global)\b)/;

// ------------------------------------------------------------------- score

export interface TranscriptScore {
  /** Every model's tool calls (subagents' too) when there is a wire log; the main agent's alone otherwise - see validity_scope. */
  tool_calls: number;
  valid_tool_calls: number;
  invalid_tool_calls: Invalid[];
  validity_scope: "all_agents" | "main_only";
  /** Tool results the harness reported as errors or refusals - the main agent's calls that went nowhere. */
  tool_errors: number;
  tools_used: Record<string, number>;
  /** bash commands that tried to install packages globally. */
  global_installs: string[];
  /** Tool calls that pointed outside the workspace. Contaminating ones make the trial invalid. */
  escapes: Escape[];
  steps: number | null;
  cost_usd: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  /** The part of completion_tokens that was thinking, when the server counts it. */
  reasoning_tokens: number | null;
  cached_tokens: number | null;
  /** Where the usage figures came from: the finished turn, or - for a killed run - what the wire log or step records had. Partial in the latter cases. */
  usage_source: "turn" | "wire" | "steps" | null;
  final_response: string | null;
  /** Why the loop ended: done, max_steps, token_budget. Null when there is no turn record. */
  stop_reason: string | null;
  /** The error that ended the turn, if one did. */
  turn_error: { name: string; message: string } | null;
  /** sha256 of what the agent was told: the system prompt, and the tools of its first request. */
  system_prompt_sha256: string | null;
  tools_sha256: string | null;
  /** What the harness says it ran with (the session's meta record). */
  harness_settings: unknown;
  /** Model calls in the wire log, or null without one. */
  wire_calls: number | null;
  /** OpenRouter upstreams that served the trial's requests, when the response says (best effort: not every response names one). */
  served_by: string[];
}

/** Replace every spelling of `dir` (either slash, any case) with <workspace>. */
export function maskPath(text: string, dir: string): string {
  const parts = dir.split(/[\\/]+/).filter(Boolean).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return parts.length === 0 ? text : text.replace(new RegExp(parts.join("[\\\\/]+"), "gi"), "<workspace>");
}

const sha = (text: string) => crypto.createHash("sha256").update(text).digest("hex");

interface CallRef {
  agent: string;
  call: any;
  /** Tools this agent was offered at that moment, when known. */
  offered: string[] | null;
  /** Their argument schemas, as the request carried them. */
  requested?: Record<string, any> | null;
}

/** The main agent's calls from its transcript. A pipeline starts after the message that calls plan_task. */
function transcriptCalls(messages: any[], schemas: ToolSchemas, texts: Invalid[]): CallRef[] {
  const out: CallRef[] = [];
  let mode: "default" | "pipeline" = "default";
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const offered = schemas.offered?.[mode] ?? null;
    const calls = message.toolCalls ?? [];
    for (const call of calls) out.push({ agent: "main", call, offered });
    if (calls.length === 0) {
      const named = textCall(typeof message.content === "string" ? message.content : "", schemas);
      if (named) texts.push({ tool: named, reason: "text_call", detail: String(message.content).replace(/\s+/g, " ").slice(0, 120) });
    }
    if (mode === "default" && calls.some((c: any) => c?.function?.name === "plan_task")) mode = "pipeline";
  }
  return out;
}

/** Every agent's calls from the wire log, each against the tools its own request offered. */
function wireCalls(wire: WireCall[], schemas: ToolSchemas, texts: Invalid[]): CallRef[] {
  const out: CallRef[] = [];
  for (const call of wire) {
    if (!call.response) continue;
    const offered = call.request.tools ? offeredTools(call) : null;
    const requested = call.request.tools
      ? Object.fromEntries(call.request.tools.map((t: any) => [String(t?.function?.name ?? ""), t?.function?.parameters ?? {}]))
      : null;
    const calls = call.response.tool_calls ?? [];
    for (const c of calls) out.push({ agent: call.role, call: c, offered, requested });
    if (calls.length === 0 && call.role !== "compaction") {
      const named = textCall(call.response.content ?? "", schemas);
      if (named) texts.push({ tool: named, reason: "text_call", detail: String(call.response.content).replace(/\s+/g, " ").slice(0, 120), agent: call.role });
    }
  }
  return out;
}

export function scoreSession(
  session: Session | null,
  schemas: ToolSchemas,
  options: { wire?: WireCall[] | null; where?: Where } = {}
): TranscriptScore {
  const wire = options.wire ?? null;
  const score: TranscriptScore = {
    tool_calls: 0,
    valid_tool_calls: 0,
    invalid_tool_calls: [],
    validity_scope: wire ? "all_agents" : "main_only",
    tool_errors: 0,
    tools_used: {},
    global_installs: [],
    escapes: [],
    steps: null,
    cost_usd: null,
    prompt_tokens: null,
    completion_tokens: null,
    reasoning_tokens: null,
    cached_tokens: null,
    usage_source: null,
    final_response: null,
    stop_reason: null,
    turn_error: null,
    system_prompt_sha256: null,
    tools_sha256: null,
    harness_settings: null,
    wire_calls: wire ? wire.length : null,
    served_by: wire ? [...new Set(wire.flatMap((c) => (c.response?.served_by ? [c.response.served_by] : [])))].sort() : []
  };

  // Calls that were written as text are attempts that never became calls: invalid, and counted.
  const texts: Invalid[] = [];
  const calls = wire ? wireCalls(wire, schemas, texts) : session ? transcriptCalls(session.messages, schemas, texts) : [];
  const escapes: Escape[] = [];
  for (const { agent, call, offered, requested } of calls) {
    score.tool_calls++;
    const name = String(call?.function?.name ?? "?");
    score.tools_used[name] = (score.tools_used[name] ?? 0) + 1;
    const invalid = checkCall(call, schemas, offered, requested);
    if (invalid) score.invalid_tool_calls.push(agent === "main" ? invalid : { ...invalid, agent });
    else score.valid_tool_calls++;
    let args: any = null;
    try {
      args = JSON.parse(call?.function?.arguments || "{}");
    } catch {
      // already counted as invalid
    }
    if (name === "bash" && args && GLOBAL_INSTALL.test(String(args.command ?? ""))) score.global_installs.push(String(args.command).slice(0, 200));
    if (args && options.where) escapes.push(...callEscapes(name, args, options.where));
  }
  for (const text of texts) {
    score.tool_calls++;
    score.invalid_tool_calls.push(text);
  }
  score.escapes = uniqueEscapes(escapes);

  if (wire && wire.length > 0) {
    const first = wire.find((c) => c.role === "main") ?? wire[0];
    if (first.request.tools) score.tools_sha256 = sha(JSON.stringify(first.request.tools));
  }

  if (!session) return score;

  for (const message of session.messages) {
    if (message.role === "assistant" && typeof message.content === "string" && message.content.trim()) score.final_response = message.content;
    if (message.role === "tool" && /^(Error|Permission denied|Tool error)\b/.test(String(message.content ?? ""))) score.tool_errors++;
  }
  // The prompt names the working directory, which is random per trial; with it masked, the same prompt hashes the same.
  const system = session.messages.find((m) => m.role === "system");
  if (system && typeof system.content === "string") {
    const masked = options.where ? maskPath(system.content, options.where.workspace) : system.content;
    score.system_prompt_sha256 = sha(masked);
  }
  score.harness_settings = session.meta?.settings ?? null;

  const turn = session.turn;
  if (turn) {
    score.steps = typeof turn.steps === "number" ? turn.steps : session.steps.length;
    score.stop_reason = typeof turn.stop_reason === "string" ? turn.stop_reason : null;
    if (turn.error) score.turn_error = { name: String(turn.error.name ?? "Error"), message: String(turn.error.message ?? "") };
    score.cost_usd = typeof turn.cost === "number" ? turn.cost : null;
    const roles = Object.values(turn.cost_by_role ?? {}) as any[];
    if (roles.length > 0) {
      score.prompt_tokens = roles.reduce((sum, r) => sum + (r.promptTokens ?? 0), 0);
      score.completion_tokens = roles.reduce((sum, r) => sum + (r.completionTokens ?? 0), 0);
      score.cached_tokens = roles.reduce((sum, r) => sum + (r.cachedTokens ?? 0), 0);
      score.usage_source = "turn";
    }
  } else {
    score.steps = session.steps.length || session.messages.filter((m) => m.role === "assistant").length;
  }

  // A killed run has no turn record, so its cost and tokens used to vanish (and with them the money spent on it).
  // The wire log or the step records still hold every call that finished before the kill.
  const reasoning = (rows: Array<{ reasoning_tokens?: number | null }>) => {
    const known = rows.filter((r) => typeof r.reasoning_tokens === "number");
    return known.length > 0 ? known.reduce((s, r) => s + (r.reasoning_tokens as number), 0) : null;
  };
  const usages = wire ? wire.flatMap((c) => (c.response?.usage ? [c.response.usage] : [])) : [];
  if (wire && usages.length > 0) {
    score.reasoning_tokens = reasoning(usages);
    if (score.usage_source === null) {
      const sum = (pick: (u: (typeof usages)[number]) => number | null) => usages.reduce((s, u) => s + (pick(u) ?? 0), 0);
      const costs = usages.filter((u) => typeof u.cost === "number");
      score.cost_usd = costs.length > 0 ? costs.reduce((s, u) => s + (u.cost as number), 0) : null;
      score.prompt_tokens = sum((u) => u.prompt_tokens);
      score.completion_tokens = sum((u) => u.completion_tokens);
      score.cached_tokens = sum((u) => u.cached_tokens);
      score.usage_source = "wire";
    }
  } else if (session.steps.length > 0) {
    score.reasoning_tokens = reasoning(session.steps);
    if (score.usage_source === null) {
      const sum = (key: string) => session.steps.reduce((s, r) => s + (typeof r[key] === "number" ? r[key] : 0), 0);
      const costs = session.steps.filter((r) => typeof r.cost === "number");
      score.cost_usd = costs.length > 0 ? costs.reduce((s, r) => s + r.cost, 0) : null;
      score.prompt_tokens = sum("prompt_tokens");
      score.completion_tokens = sum("completion_tokens");
      score.cached_tokens = sum("cached_tokens");
      score.usage_source = "steps";
    }
  }
  return score;
}
