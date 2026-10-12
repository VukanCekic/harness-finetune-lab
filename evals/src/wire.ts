/**
 * The harness's wire log (WIRE_LOG): one JSON line per model call, from the
 * main loop, subagents and compaction. Unlike the session log it has what the
 * model was actually sent (the late <env> reminder, the exact tool list) and
 * what came back (thinking included), and it keeps every call that finished
 * before a kill.
 */
import fs from "node:fs";

export interface WireCall {
  type: "call";
  /** "main", "planner", "worker", "reviewer", "researcher" or "compaction". */
  role: string;
  /** When the request was sent (ISO), and how long it ran. */
  at: string;
  duration_ms: number;
  backend: string;
  model: string;
  request: { messages: any[]; tools?: any[]; tool_choice?: string | null; sampling?: unknown; max_tokens?: number | null; thinking?: string };
  response?: {
    content: string;
    reasoning?: string;
    tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
    finish_reason: string | null;
    served_by?: string;
    usage: { prompt_tokens: number; completion_tokens: number; reasoning_tokens: number | null; cached_tokens: number | null; cost: number | null } | null;
  };
  /** A call that failed (provider error, stall, abort). */
  error?: { name: string; message: string };
}

/** Null when there is no file: the run was made without a wire log. */
export function readWire(file: string): WireCall[] | null {
  if (!fs.existsSync(file)) return null;
  const calls: WireCall[] = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record?.type === "call") calls.push(record);
    } catch {
      // a line cut off by the kill
    }
  }
  return calls;
}

/** Epoch ms at which a finished call ended. */
export const callEnd = (call: WireCall): number => Date.parse(call.at) + call.duration_ms;

/** Names of the tools a request offered. */
export const offeredTools = (call: WireCall): string[] => (call.request.tools ?? []).map((t: any) => String(t?.function?.name ?? ""));
