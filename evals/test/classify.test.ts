import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, isValid, LONG_GENERATION_S, type Facts } from "../src/classify.js";
import type { Session } from "../src/score.js";

const pass = [{ name: "t", passed: true, detail: "" }];
const fail = [{ name: "t", passed: false, detail: "exit 1" }];
const session = (turn: any): Session => ({ messages: [], steps: [], meta: null, turn });
const facts = (over: Partial<Facts> = {}): Facts => ({
  timedOut: false,
  exitCode: 0,
  session: session({ stop_reason: "done" }),
  checks: pass,
  contaminated: false,
  ...over
});

test("a clean run is passed or checks_failed - the only outcomes about the model's work", () => {
  assert.deepEqual(classify(facts()), { cls: "passed", detail: null, valid: true });
  assert.deepEqual(classify(facts({ checks: fail })), { cls: "checks_failed", detail: null, valid: true });
});

test("the model ran out of steps or tokens: its failure, and it says which", () => {
  const steps = classify(facts({ checks: fail, session: session({ stop_reason: "max_steps" }) }));
  assert.equal(steps.cls, "max_steps");
  assert.equal(steps.valid, true);
  assert.equal(classify(facts({ checks: fail, session: session({ stop_reason: "token_budget" }) })).cls, "token_budget");
  const lucky = classify(facts({ session: session({ stop_reason: "max_steps" }) }));
  assert.equal(lucky.cls, "passed", "the checks decide; the stop is noted");
  assert.match(lucky.detail!, /max_steps/);
});

test("a stalled or failing provider is not the model's failure", () => {
  const stalled = classify(facts({ exitCode: 3, checks: fail, session: session({ error: { name: "Error", message: "no data from the provider for 90000ms" } }) }));
  assert.equal(stalled.cls, "infra_error");
  assert.equal(stalled.valid, false);
  assert.match(stalled.detail!, /no data from the provider/);
  // Even when the workspace happens to pass: the turn did not finish, so the trial is re-run.
  assert.equal(classify(facts({ exitCode: 3, session: session({ error: { name: "Error", message: "HTTP 500" } }) })).cls, "infra_error");
});

test("a context overflow is the model's own doing", () => {
  const overflow = session({ error: { name: "ContextBudgetError", message: "This request needs ~41000 tokens" } });
  assert.equal(classify(facts({ exitCode: 3, checks: fail, session: overflow })).cls, "token_budget");
});

test("a crash or a kill leaves no turn record: harness_error, whatever the exit code", () => {
  assert.equal(classify(facts({ exitCode: 3221226505, session: session(null) })).cls, "harness_error");
  const silent = classify(facts({ exitCode: 0, session: session(null) }));
  assert.equal(silent.cls, "harness_error");
  assert.match(silent.detail!, /without a turn record/);
  assert.equal(classify(facts({ session: null })).cls, "harness_error");
  assert.equal(classify(facts({ exitCode: 1, session: session({ stop_reason: "done" }) })).cls, "harness_error", "a good turn record does not excuse a crash on the way out");
});

test("the wall clock tells a runaway generation from slow progress, and neither is graded", () => {
  const runaway = classify(facts({ timedOut: true, inFlightS: LONG_GENERATION_S + 1, exitCode: null, session: session(null) }));
  assert.equal(runaway.cls, "timeout_generation");
  assert.equal(runaway.valid, false);
  assert.match(runaway.detail!, /no model call had finished for 121s/);
  assert.equal(classify(facts({ timedOut: true, inFlightS: 12, exitCode: null, session: session(null) })).cls, "timeout_progress");
  assert.equal(classify(facts({ timedOut: true, inFlightS: null, exitCode: null, session: null })).cls, "timeout_progress");
});

test("contamination, a runner error and ignored settings invalidate a trial that would otherwise pass", () => {
  assert.equal(classify(facts({ contaminated: true })).cls, "contaminated");
  assert.equal(classify(facts({ runnerError: "boom" })).cls, "runner_error");
  const mismatch = classify(facts({ settingsMismatch: "temperature: asked 0.6, ran with undefined" }));
  assert.equal(mismatch.cls, "runner_error");
  assert.match(mismatch.detail!, /temperature/);
  assert.equal(classify(facts({ timedOut: true, runnerError: "x" })).cls, "runner_error", "the runner's own failure wins over everything");
});

test("only four classes count in the pass rate", () => {
  const valid = ["passed", "checks_failed", "max_steps", "token_budget"] as const;
  const invalid = ["timeout_generation", "timeout_progress", "contaminated", "infra_error", "harness_error", "runner_error"] as const;
  for (const cls of valid) assert.equal(isValid(cls), true, cls);
  for (const cls of invalid) assert.equal(isValid(cls), false, cls);
});

test("a context too small for the harness's own prompt is a configuration error, not the model overflowing", () => {
  const tooSmall = session({ error: { name: "ContextBudgetError", message: "The tool schemas and system prompt alone need ~9000 tokens, more than the 8500-token budget" } });
  const c = classify(facts({ exitCode: 3, checks: fail, session: tooSmall }));
  assert.equal(c.cls, "runner_error", "every trial would fail the same way, whatever the model did");
  assert.match(c.detail!, /context_window is too small/);
});

test("a cancelled turn means something signalled the harness: not the model's failure", () => {
  assert.equal(classify(facts({ checks: fail, session: session({ stop_reason: "cancelled" }) })).cls, "harness_error");
});

test("a last reply cut off at max_tokens is the per-request budget, not a wrong answer", () => {
  const cut = classify(facts({ checks: fail, endedOnTruncatedReply: true }));
  assert.equal(cut.cls, "token_budget");
  assert.equal(cut.valid, true);
  assert.match(cut.detail!, /max_tokens/);
  assert.equal(classify(facts({ endedOnTruncatedReply: true })).cls, "passed", "if the checks pass, they pass");
});

test("logs that disagree with each other cannot be trusted: harness_error", () => {
  const broken = classify(facts({ integrity: "the wire log has 1 main-loop calls but the session log recorded 3 steps" }));
  assert.equal(broken.cls, "harness_error");
  assert.equal(broken.valid, false);
  assert.equal(classify(facts({ integrity: null })).cls, "passed");
});
