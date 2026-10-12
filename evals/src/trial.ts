/**
 * One trial: a fresh workspace, the real harness on the task's prompt, the
 * hidden tests copied in, the checks run, the logs read and the outcome
 * classified. Kept apart from the CLI so it can be run against a scripted
 * server in tests.
 */
import fs from "node:fs";
import path from "node:path";
import { runChecks } from "./checks.js";
import { classify } from "./classify.js";
import { EVALS_DIR, type Defaults, type ModelProfile, type Task } from "./config.js";
import { contaminated } from "./escape.js";
import { expectedSettings, runHarness, settingsMismatch, type HarnessInfo } from "./harness.js";
import { readSession, scoreSession, type Session, type ToolSchemas } from "./score.js";
import type { TrialResult } from "./summary.js";
import { callEnd, readWire, type WireCall } from "./wire.js";
import { addHidden, keep, remove, seed, tempWorkspace } from "./workspace.js";

/** The lab repo's root: what an agent must never reach. */
export const LAB_ROOT = path.resolve(EVALS_DIR, "..");

export interface TrialContext {
  runDir: string;
  harness: HarnessInfo;
  profile: ModelProfile;
  defaults: Defaults;
  schemas: ToolSchemas;
  /** Extra environment for the harness, for tests (e.g. a short STALL_MS). */
  extraEnv?: Record<string, string>;
}

export const trialDirOf = (runDir: string, task: string, trial: number) => path.join(runDir, "trials", task, String(trial));

/** Folders of earlier attempts that were left out of the numbers: `<trial>.excluded-<n>`. */
export const EXCLUDED = /\.excluded-\d+$/;

/**
 * A re-run must not erase what it replaces: a trial that was contaminated or
 * killed is evidence, and the report counts it. The old attempt moves aside.
 */
function archiveAttempt(trialDir: string): void {
  if (!fs.existsSync(trialDir)) return;
  let n = 1;
  while (fs.existsSync(`${trialDir}.excluded-${n}`)) n++;
  fs.renameSync(trialDir, `${trialDir}.excluded-${n}`);
}

const write = (file: string, data: unknown) => fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);

/**
 * The wire log should hold every model call the session log has a step for.
 * When it does not (a harness without WIRE_LOG, a disk that would not take
 * the writes) the tool-call scores and the outside-the-workspace check would
 * silently see nothing - so that is an error of its own, not an empty log.
 */
function wireFor(file: string, session: Session | null): { wire: WireCall[] | null; integrity: string | null } {
  const found = readWire(file);
  const worked = session ? Math.max(session.steps.length, session.messages.filter((m) => m.role === "assistant").length) : 0;
  if (found === null) {
    // No file and no model call finished: a stall or a kill before the first reply. Otherwise logging did not work.
    return worked === 0 ? { wire: [], integrity: null } : { wire: null, integrity: "the harness wrote no wire log although the agent made model calls (WIRE_LOG not supported or not writable)" };
  }
  const main = found.filter((c) => c.role === "main" && c.response).length;
  const steps = session?.steps.length ?? 0;
  if (main < steps) return { wire: null, integrity: `the wire log has ${main} main-loop calls but the session log recorded ${steps} steps: wire logging failed part way` };
  return { wire: found, integrity: null };
}

export async function runTrial(task: Task, trial: number, ctx: TrialContext): Promise<TrialResult> {
  const trialDir = trialDirOf(ctx.runDir, task.id, trial);
  archiveAttempt(trialDir);
  fs.mkdirSync(trialDir, { recursive: true });
  const workspace = tempWorkspace(`${task.id}-${trial}`);
  const base = { task: task.id, difficulty: task.difficulty, trial };
  const started = Date.now();

  let result: TrialResult;
  try {
    // A leftover session or wire log from an earlier attempt would be read as this one's.
    if (fs.readdirSync(trialDir).length > 0) throw new Error(`${trialDir} is not empty before the trial starts`);
    seed(task, workspace);
    const h = await runHarness({
      harness: ctx.harness,
      profile: ctx.profile,
      defaults: ctx.defaults,
      task,
      trial,
      workspace,
      trialDir,
      lab: LAB_ROOT,
      extraEnv: ctx.extraEnv
    });
    const session = readSession(h.sessionDir);
    const { wire, integrity } = wireFor(h.wireLog, session);
    addHidden(task, workspace);
    const checks = await runChecks(task, workspace);

    const score = scoreSession(session, ctx.schemas, { wire, where: { workspace, lab: LAB_ROOT, allow: [h.npmPrefix] } });
    // How long since the last model call finished when the kill came: one runaway generation, a hung tool, or slow progress.
    const lastEnd = wire && wire.length > 0 ? Math.max(...wire.map(callEnd)) : h.startedMs;
    const inFlightS = h.timedOut && wire ? Math.max(0, (h.startedMs + h.durationMs - lastEnd) / 1000) : null;
    const lastStep = session?.steps.at(-1);
    const outcome = classify({
      timedOut: h.timedOut,
      inFlightS,
      exitCode: h.exitCode,
      session,
      checks,
      contaminated: contaminated(score.escapes),
      integrity,
      endedOnTruncatedReply: lastStep?.finish_reason === "length" && (lastStep.tool_calls ?? []).length === 0,
      settingsMismatch: session ? settingsMismatch(expectedSettings(ctx.profile, ctx.defaults, task, trial), session.meta?.settings) : null
    });
    result = {
      ...base,
      ...score,
      passed: outcome.cls === "passed",
      class: outcome.cls,
      class_detail: outcome.detail,
      valid: outcome.valid,
      error: outcome.valid ? null : outcome.detail,
      exit_code: h.exitCode,
      timed_out: h.timedOut,
      duration_ms: h.durationMs,
      in_flight_s: inFlightS,
      checks
    };
    keep(workspace, path.join(trialDir, "workspace"));
  } catch (err: any) {
    const message = `eval runner error: ${err?.message ?? err}`;
    result = {
      ...base,
      ...scoreSession(null, ctx.schemas),
      passed: false,
      class: "runner_error",
      class_detail: message,
      valid: false,
      error: message,
      exit_code: null,
      timed_out: false,
      duration_ms: Date.now() - started,
      in_flight_s: null,
      checks: []
    };
  } finally {
    remove(workspace);
  }
  write(path.join(trialDir, "result.json"), result);
  return result;
}
