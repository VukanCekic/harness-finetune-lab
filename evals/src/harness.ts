/**
 * The adapter: runs the real coding harness on one task, as a subprocess in
 * the trial's workspace, exactly as a user would - `--local` or `--remote`,
 * one prompt, permissions bypassed (the workspace is throwaway).
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import dotenv from "dotenv";
import type { Defaults, ModelProfile, Task } from "./config.js";
import { plain, run } from "./shell.js";

export interface HarnessInfo {
  dir: string;
  commit: string;
  /** Uncommitted changes in the harness: results are not reproducible from `commit` alone. */
  dirty: boolean;
}

export function harnessInfo(dir: string): HarnessInfo {
  const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf-8" }).stdout.trim();
  const commit = git("rev-parse", "--short", "HEAD");
  if (!commit) throw new Error(`${dir} is not a git checkout of the harness`);
  return { dir, commit, dirty: git("status", "--porcelain", "--untracked-files=no").length > 0 };
}

/** Only the credentials from the harness's .env - none of its other settings, which would change the run. */
function secrets(dir: string): Record<string, string> {
  const file = path.join(dir, ".env");
  if (!fs.existsSync(file)) return {};
  const parsed = dotenv.parse(fs.readFileSync(file));
  const out: Record<string, string> = {};
  for (const key of ["OPENROUTER_API_KEY", "LOCAL_API_KEY"]) if (parsed[key]) out[key] = parsed[key];
  return out;
}

/** Settings from the caller's shell that would silently change a run. */
const INHERITED = /^(LLM_BACKEND|MODEL|LOCAL_\w+|OPENROUTER_\w+|PROVIDER_ONLY|CONTEXT_WINDOW|COMPACT_\w+|MAX_STEPS|MAX_OUTPUT_TOKENS|SESSION_DIR|SYSTEM_PROMPT|BYPASS_PERMISSIONS|REASONING_ROUNDTRIP|STREAM)$/i;

export interface HarnessRun {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** The harness's session log for this run: every message as it happened, then a turn record. */
  sessionDir: string;
}

export async function runHarness(options: {
  harness: HarnessInfo;
  profile: ModelProfile;
  defaults: Defaults;
  task: Task;
  workspace: string;
  trialDir: string;
}): Promise<HarnessRun> {
  const { harness, profile, defaults, task, workspace, trialDir } = options;
  const sessionDir = path.join(trialDir, "session");
  const tsx = path.join(harness.dir, "node_modules", "tsx", "dist", "cli.mjs");
  if (!fs.existsSync(tsx)) throw new Error(`${tsx} not found - run npm install in the harness`);

  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!INHERITED.test(key)) env[key] = value;
  Object.assign(env, secrets(harness.dir), {
    LLM_BACKEND: profile.backend,
    ...(profile.backend === "local"
      ? { LOCAL_MODEL: profile.model, LOCAL_BASE_URL: profile.base_url ?? "http://localhost:1234/v1" }
      : { MODEL: profile.model }),
    CONTEXT_WINDOW: String(defaults.context_window),
    MAX_STEPS: String(task.max_steps ?? defaults.max_steps),
    SESSION_DIR: sessionDir,
    BYPASS_PERMISSIONS: "1",
    STREAM: "0",
    NO_COLOR: "1",
    // `npm install -g` lands in the trial folder instead of on this machine (and is counted, see score.ts).
    npm_config_prefix: path.join(trialDir, "npm-global")
  });

  const timeoutMs = (task.timeout_s ?? defaults.timeout_s) * 1000;
  const result = await run(
    process.execPath,
    [tsx, path.join(harness.dir, "src", "index.ts"), `--${profile.backend}`, task.prompt],
    { cwd: workspace, env, timeoutMs }
  );
  fs.writeFileSync(
    path.join(trialDir, "harness.log"),
    plain(`${result.stdout}${result.stderr ? `\n--- stderr ---\n${result.stderr}` : ""}`)
  );
  return { exitCode: result.code, timedOut: result.timedOut, durationMs: result.ms, sessionDir };
}

/** Is the local server up and serving the model? Checked once, before any trial. */
export async function preflight(profile: ModelProfile): Promise<string | null> {
  if (profile.backend !== "local") return null;
  const base = (profile.base_url ?? "http://localhost:1234/v1").replace(/\/+$/, "");
  try {
    const response = await fetch(`${base}/models`, { signal: AbortSignal.timeout(4000) });
    const json: any = await response.json();
    const ids: string[] = (json?.data ?? []).map((m: any) => String(m.id));
    if (ids.length > 0 && !ids.includes(profile.model)) return `${base} has no model "${profile.model}" (has: ${ids.join(", ")})`;
    return null;
  } catch {
    return `Cannot reach ${base}. Start the server (LM Studio: Developer tab, Status: Running).`;
  }
}
