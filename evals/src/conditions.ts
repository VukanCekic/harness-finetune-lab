/**
 * Everything that decides what a run measured, written next to its results so
 * a number can be traced back to the conditions that produced it - and so a
 * later run can be checked against them. Nothing here changes a run.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { EVALS_DIR, unpinned, type Defaults, type ModelProfile, type Task } from "./config.js";
import type { HarnessInfo } from "./harness.js";

export interface LabInfo {
  commit: string;
  /** Uncommitted changes to what the runner is made of: src, tasks, config, tool schemas. Results and docs do not count. */
  dirty: boolean;
}

const LAB_PATHS = ["evals/src", "evals/tasks", "evals/eval.config.yaml", "evals/tool-schemas.json", "package.json"];

export function labInfo(lab: string): LabInfo {
  const git = (...args: string[]) => spawnSync("git", args, { cwd: lab, encoding: "utf-8" }).stdout.trim();
  return { commit: git("rev-parse", "--short", "HEAD") || "unknown", dirty: git("status", "--porcelain", "--", ...LAB_PATHS).length > 0 };
}

/** sha256 over every file of a folder: names and contents, in a fixed order. Editing a task changes it. */
export function hashTree(dir: string): string {
  const hash = crypto.createHash("sha256");
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        hash.update(`${path.relative(dir, full).replace(/\\/g, "/")}\0`);
        hash.update(fs.readFileSync(full).toString("latin1").replace(/\r\n/g, "\n")); // checkout line endings must not change it
        hash.update("\0");
      }
    }
  };
  walk(dir);
  return hash.digest("hex").slice(0, 16);
}

/** What `GET <server>/api/v0/models` says about the loaded models (quantisation, context), or why it could not be read. */
export async function lmStudioModels(baseUrl: string | undefined): Promise<unknown> {
  const origin = (baseUrl ?? "http://localhost:1234/v1").replace(/\/+$/, "").replace(/\/v1$/, "");
  try {
    const response = await fetch(`${origin}/api/v0/models`, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) return { error: `HTTP ${response.status}` };
    const json: any = await response.json();
    return json?.data ?? json;
  } catch (err: any) {
    return { error: String(err?.message ?? err) };
  }
}

const version = (cmd: string): string => {
  const out = spawnSync(cmd, ["--version"], { encoding: "utf-8" });
  return (out.stdout || out.stderr || "").trim().split("\n")[0] || "unknown";
};

export interface RunConditions {
  backend: ModelProfile["backend"];
  /** The model id: a resume must not switch to another. */
  model: string;
  sampling: ModelProfile["sampling"];
  thinking: ModelProfile["thinking"];
  provider: string[] | null;
  max_tokens: number;
  max_turn_tokens: number;
  max_steps: number;
  context_window: number;
  timeout_s: number;
  /** Settings the config leaves to a default nobody recorded. Non-empty: do not compare or publish this run. */
  unpinned: string[];
  lab: LabInfo;
  /** Task id -> hash of its folder. */
  tasks: Record<string, string>;
  /** Hash of the runner's own code (evals/src): classification and scoring rules decide what a trial counts as. */
  runner: string;
  node: string;
  git: string;
  os: string;
  /** Local models: what the server reported about them at the start of the run. */
  lmstudio: unknown;
}

export async function collectConditions(options: { profile: ModelProfile; defaults: Defaults; tasks: Task[]; lab: string }): Promise<RunConditions> {
  const { profile, defaults } = options;
  return {
    backend: profile.backend,
    model: profile.model,
    sampling: profile.sampling,
    thinking: profile.thinking,
    provider: profile.provider ?? null,
    max_tokens: defaults.max_tokens,
    max_turn_tokens: defaults.max_turn_tokens,
    max_steps: defaults.max_steps,
    context_window: defaults.context_window,
    timeout_s: defaults.timeout_s,
    unpinned: unpinned(profile),
    lab: labInfo(options.lab),
    tasks: Object.fromEntries(options.tasks.map((t) => [t.id, hashTree(t.dir)])),
    runner: hashTree(path.join(EVALS_DIR, "src")),
    node: process.version,
    git: version("git"),
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    lmstudio: profile.backend === "local" ? await lmStudioModels(profile.base_url) : null
  };
}

/**
 * What must be the same for a resumed run to be the same experiment: the model,
 * its sampling, the budgets, the task files, the runner's rules and the harness
 * code - its commit and, if it has uncommitted changes, which changes. The
 * endpoint and the wall-clock safety net may differ.
 */
export function fingerprint(conditions: RunConditions, harness: Pick<HarnessInfo, "commit" | "state">): string {
  const { backend, model, sampling, thinking, provider, max_tokens, max_turn_tokens, max_steps, context_window, tasks, runner } = conditions;
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ backend, model, sampling, thinking, provider, max_tokens, max_turn_tokens, max_steps, context_window, tasks, runner, harness: harness.commit, state: harness.state ?? "" }))
    .digest("hex")
    .slice(0, 16);
}

/** The harness compacts the transcript at this share of context_window (its COMPACT_AT default). */
const COMPACT_AT = 0.85;
/** The slowest generation speed the safety net should still cover. */
const SLOWEST_TOK_PER_S = 40;

/**
 * Settings that cannot all be true at once. A wall clock that fires before the
 * token budget drops slow trials instead of grading them; a context the server
 * did not load leaves the model silently truncated or erroring.
 */
export function budgetWarnings(profile: ModelProfile, defaults: Defaults, lmstudio: unknown): string[] {
  const out: string[] = [];
  const needed = Math.ceil(defaults.max_turn_tokens / SLOWEST_TOK_PER_S);
  if (defaults.timeout_s < needed) {
    out.push(
      `timeout_s (${defaults.timeout_s}s) is shorter than max_turn_tokens (${defaults.max_turn_tokens}) at ${SLOWEST_TOK_PER_S} tok/s (${needed}s): ` +
        "the wall clock can kill a trial the token budget would have graded, which drops slow trials from the pass rate and favours fast models. Raise timeout_s or lower max_turn_tokens."
    );
  }
  const loaded = Array.isArray(lmstudio) ? (lmstudio as any[]).find((m) => m?.id === profile.model) : undefined;
  const context = Number(loaded?.loaded_context_length ?? loaded?.max_context_length);
  if (profile.backend === "local" && Number.isFinite(context) && context > 0) {
    if (defaults.context_window > context) {
      out.push(`context_window (${defaults.context_window}) is larger than the context the server reports for ${profile.model} (${context}).`);
    } else if (defaults.context_window * COMPACT_AT + defaults.max_tokens > context) {
      out.push(
        `a prompt of ${Math.round(defaults.context_window * COMPACT_AT)} tokens plus a reply of up to ${defaults.max_tokens} does not fit the ${context}-token context the server reports for ${profile.model}.`
      );
    }
  }
  return out;
}
