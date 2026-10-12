/**
 * What happened in a trial, in one word. The pass rate must only count trials
 * where the MODEL had its say: a stalled server, a crashed harness or a
 * runner bug is not a model failure, and a run killed by the wall clock tells
 * you about the machine. So a trial is either valid (graded) or invalid (to be
 * re-run), and the report counts each class.
 */
import type { CheckResult } from "./checks.js";
import type { Session } from "./score.js";

export const CLASSES = [
  "passed",
  "checks_failed",
  "max_steps",
  "token_budget",
  "timeout_generation",
  "timeout_progress",
  "contaminated",
  "infra_error",
  "harness_error",
  "runner_error"
] as const;
export type TrialClass = (typeof CLASSES)[number];

/** The classes where the model's own behaviour decided the outcome. */
const VALID: TrialClass[] = ["passed", "checks_failed", "max_steps", "token_budget"];
export const isValid = (cls: TrialClass): boolean => VALID.includes(cls);

/** A request that had been running this long when the kill came was one runaway generation, not slow progress. */
export const LONG_GENERATION_S = 120;

export interface Facts {
  /** The runner itself threw. */
  runnerError?: string | null;
  /** The harness ran with other settings than the ones the runner asked for. */
  settingsMismatch?: string | null;
  timedOut: boolean;
  /** Seconds from the last finished model call (or the start) to the kill. Null without a wire log. */
  inFlightS?: number | null;
  exitCode: number | null;
  session: Session | null;
  checks: CheckResult[];
  /** The agent reached into the lab repo or another trial. */
  contaminated: boolean;
  /** The harness's logs disagree with each other (a wire log with fewer calls than the session has steps). Null when they agree. */
  integrity?: string | null;
  /** The last main-loop reply was cut off by max_tokens and made no tool call, so the turn ended on it. */
  endedOnTruncatedReply?: boolean;
}

export interface Classified {
  cls: TrialClass;
  /** One line: what to look at. Null for a clean pass or an ordinary failed check. */
  detail: string | null;
  valid: boolean;
}

const done = (cls: TrialClass, detail: string | null = null): Classified => ({ cls, detail, valid: isValid(cls) });

export function classify(facts: Facts): Classified {
  if (facts.runnerError) return done("runner_error", facts.runnerError);
  if (facts.settingsMismatch) return done("runner_error", facts.settingsMismatch);

  if (facts.timedOut) {
    const long = facts.inFlightS != null && facts.inFlightS >= LONG_GENERATION_S;
    const gap = facts.inFlightS != null ? `; no model call had finished for ${Math.round(facts.inFlightS)}s (one long generation, or a tool that hung)` : "";
    return done(long ? "timeout_generation" : "timeout_progress", `wall-clock safety net hit${gap}`);
  }
  if (facts.contaminated) return done("contaminated", "the agent reached outside its workspace (see escapes)");
  if (facts.integrity) return done("harness_error", facts.integrity);

  const { session } = facts;
  if (!session) return done("harness_error", "the harness wrote no session log");
  const turn = session.turn;

  // The turn record is how the harness says it failed. No record at all means it was killed or crashed.
  if (turn?.error) {
    const { name = "Error", message = "" } = turn.error;
    if (name === "ContextBudgetError") {
      // Before the conversation has a chance to grow: CONTEXT_WINDOW is too small for the tool schemas and system prompt. Every trial would fail the same way.
      if (/alone need/.test(String(message))) return done("runner_error", `context_window is too small for the harness's own prompt: ${String(message).slice(0, 160)}`);
      // The model filled its own context: its doing, like running out of steps.
      return facts.checks.every((c) => c.passed) ? done("passed") : done("token_budget", `context overflow: ${String(message).slice(0, 160)}`);
    }
    return done("infra_error", `${name}: ${String(message).slice(0, 200)}`);
  }
  if (facts.exitCode !== 0) return done("harness_error", `harness exited with code ${facts.exitCode} (see harness.log)`);
  if (!turn) return done("harness_error", "the harness exited 0 without a turn record: it did not finish the turn");
  if (turn.stop_reason === "cancelled") return done("harness_error", "the turn was cancelled: something signalled the harness");

  if (facts.checks.every((c) => c.passed)) return done("passed", turn.stop_reason && turn.stop_reason !== "done" ? `passed, but the turn stopped on ${turn.stop_reason}` : null);
  if (turn.stop_reason === "max_steps") return done("max_steps", "ran out of steps before the checks passed");
  if (turn.stop_reason === "token_budget") return done("token_budget", "ran out of its token budget before the checks passed");
  // The reply it ended on was cut off at max_tokens (typically a long thought with no answer): the per-request budget, not a wrong answer.
  if (facts.endedOnTruncatedReply) return done("token_budget", "its last reply hit the per-request max_tokens limit and made no tool call");
  return done("checks_failed");
}
