/**
 * The adapter: runs the real coding harness on one task, as a subprocess in
 * the trial's workspace, exactly as a user would - `--local` or `--remote`,
 * one prompt, permissions bypassed (the workspace is throwaway).
 *
 * Everything that changes what a run measures is set here, from the config,
 * and read back from the harness's session log afterwards: a setting the
 * runner asked for and the harness did not apply is a runner error, not a
 * result.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import dotenv from "dotenv";
import type { Defaults, ModelProfile, Task } from "./config.js";
import { plain, run } from "./shell.js";

export interface HarnessInfo {
  dir: string;
  commit: string;
  /** Uncommitted changes, untracked files included: results are not reproducible from `commit` alone. */
  dirty: boolean;
  /** Hash of those changes (the diff and the untracked files), "" when clean: two dirty states are not the same code. */
  state?: string;
}

export function harnessInfo(dir: string): HarnessInfo {
  const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf-8" }).stdout.trim();
  const commit = git("rev-parse", "--short", "HEAD");
  if (!commit) throw new Error(`${dir} is not a git checkout of the harness`);
  // Untracked files count: a new module the harness imports is part of what ran.
  const dirty = git("status", "--porcelain").length > 0;
  return { dir, commit, dirty, state: dirty ? workingTreeState(dir) : "" };
}

/** A fingerprint of an uncommitted checkout: the diff against HEAD plus every untracked file's bytes. */
function workingTreeState(dir: string): string {
  const hash = crypto.createHash("sha256");
  const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }).stdout ?? Buffer.alloc(0);
  hash.update(git("diff", "HEAD", "--no-ext-diff"));
  const untracked = git("ls-files", "--others", "--exclude-standard", "-z").toString("utf-8").split(String.fromCharCode(0)).filter(Boolean).sort();
  for (const file of untracked) {
    hash.update(`${String.fromCharCode(0)}${file}${String.fromCharCode(0)}`);
    try {
      hash.update(fs.readFileSync(path.join(dir, file)));
    } catch {
      // unreadable or vanished: the name is already in
    }
  }
  return hash.digest("hex").slice(0, 16);
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

/**
 * What the agent's process may inherit. An allowlist: the shell the runner was
 * started from carries far more than a harness run needs (npm sets INIT_CWD
 * and npm_package_json, which name this repo; any API key lives here too), and
 * a denylist forgets the next variable. Names are matched case-insensitively,
 * as Windows does.
 */
const INHERIT = new Set(
  [
    "PATH", "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "OS",
    "TEMP", "TMP", "TMPDIR",
    "USERPROFILE", "HOME", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "USERNAME", "USERDOMAIN", "COMPUTERNAME",
    "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)", "COMMONPROGRAMW6432",
    "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "PROCESSOR_LEVEL", "PROCESSOR_REVISION", "NUMBER_OF_PROCESSORS",
    "LANG", "LC_ALL", "LC_CTYPE", "TERM", "SHELL", "BASH_PATH",
    // a corporate network may need these to reach OpenRouter at all
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"
  ].map((name) => name.toUpperCase())
);

/** Entries npm adds to PATH for a project: they name this repo and its ancestors. */
const npmPathEntry = (entry: string, lab: string): boolean => {
  const e = entry.replace(/\\/g, "/").toLowerCase();
  return e.endsWith("/node_modules/.bin") || e.includes("node-gyp-bin") || e === lab.replace(/\\/g, "/").toLowerCase() || e.startsWith(`${lab.replace(/\\/g, "/").toLowerCase()}/`);
};

export interface EnvArgs {
  /** The runner's own environment. */
  source: NodeJS.ProcessEnv;
  secrets: Record<string, string>;
  profile: ModelProfile;
  defaults: Defaults;
  task: Task;
  /** 1-based: the seed is base + trial - 1. */
  trial: number;
  sessionDir: string;
  wireLog: string;
  /** Where `npm install -g` lands: a scratch folder away from the lab, thrown away after the run. */
  npmPrefix: string;
  /** The lab repo: kept out of PATH. */
  lab: string;
  /** Extra variables on top, for tests (e.g. a short STALL_MS). */
  extra?: Record<string, string>;
}

/** The sampling a trial runs with, in the harness's camelCase. The seed differs per trial so repeated trials are not copies of one another. */
export function trialSampling(profile: ModelProfile, trial: number) {
  const s = profile.sampling;
  return {
    ...(s.temperature !== undefined ? { temperature: s.temperature } : {}),
    ...(s.top_p !== undefined ? { topP: s.top_p } : {}),
    ...(s.top_k !== undefined ? { topK: s.top_k } : {}),
    ...(s.presence_penalty !== undefined ? { presencePenalty: s.presence_penalty } : {}),
    ...(s.seed !== undefined ? { seed: s.seed + trial - 1 } : {})
  };
}

export function buildHarnessEnv(args: EnvArgs): NodeJS.ProcessEnv {
  const { source, profile, defaults, task, trial } = args;
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || !INHERIT.has(key.toUpperCase())) continue;
    env[key] = key.toUpperCase() === "PATH" ? value.split(path.delimiter).filter((e) => e && !npmPathEntry(e, args.lab)).join(path.delimiter) : value;
  }
  // Only the key of the backend in use.
  const keyName = profile.backend === "local" ? "LOCAL_API_KEY" : "OPENROUTER_API_KEY";
  if (args.secrets[keyName]) env[keyName] = args.secrets[keyName];

  const sampling = trialSampling(profile, trial);
  Object.assign(env, {
    LLM_BACKEND: profile.backend,
    ...(profile.backend === "local"
      ? { LOCAL_MODEL: profile.model, LOCAL_BASE_URL: profile.base_url ?? "http://localhost:1234/v1", LOCAL_THINKING: profile.thinking }
      : { MODEL: profile.model, ...(profile.provider ? { PROVIDER_ONLY: profile.provider.join(",") } : {}) }),
    CONTEXT_WINDOW: String(defaults.context_window),
    MAX_STEPS: String(task.max_steps ?? defaults.max_steps),
    MAX_OUTPUT_TOKENS: String(defaults.max_tokens),
    MAX_TURN_TOKENS: String(defaults.max_turn_tokens),
    ...(sampling.temperature !== undefined ? { LLM_TEMPERATURE: String(sampling.temperature) } : {}),
    ...(sampling.topP !== undefined ? { LLM_TOP_P: String(sampling.topP) } : {}),
    ...(sampling.topK !== undefined ? { LLM_TOP_K: String(sampling.topK) } : {}),
    ...(sampling.presencePenalty !== undefined ? { LLM_PRESENCE_PENALTY: String(sampling.presencePenalty) } : {}),
    ...(sampling.seed !== undefined ? { LLM_SEED: String(sampling.seed) } : {}),
    SESSION_DIR: args.sessionDir,
    WIRE_LOG: args.wireLog,
    // The harness reads these itself; its shell commands must not see them, or `env` names the lab's results folder.
    SCRUB_ENV: "SESSION_DIR,WIRE_LOG",
    BYPASS_PERMISSIONS: "1",
    STREAM: "0",
    NO_COLOR: "1",
    // `npm install -g` lands in a scratch folder instead of on this machine (and is counted, see score.ts).
    npm_config_prefix: args.npmPrefix,
    ...args.extra
  });
  return env;
}

// ---------------------------------------------------------------- settings

/** What the harness's session log should say it ran with (describeSettings() in the harness). */
export function expectedSettings(profile: ModelProfile, defaults: Defaults, task: Task, trial: number) {
  return {
    backend: profile.backend,
    model: profile.model,
    sampling: trialSampling(profile, trial),
    thinking: profile.thinking,
    max_output_tokens: defaults.max_tokens,
    max_turn_tokens: defaults.max_turn_tokens,
    max_steps: task.max_steps ?? defaults.max_steps,
    context_window: defaults.context_window,
    ...(profile.backend === "remote" ? { provider: profile.provider ? { only: profile.provider, allowFallbacks: false } : null } : {})
  };
}

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b))) : v
  );

/** Null when the harness ran with what was asked; otherwise what differs. */
export function settingsMismatch(expected: Record<string, unknown>, actual: any): string | null {
  if (!actual || typeof actual !== "object") {
    return "the session log has no settings record: the harness is older than this runner expects (it needs describeSettings, harness commit after the sampling change)";
  }
  const diffs = Object.entries(expected)
    .filter(([key, want]) => canonical(want) !== canonical(actual[key] ?? (key === "provider" ? null : undefined)))
    .map(([key, want]) => `${key}: asked ${canonical(want)}, ran with ${canonical(actual[key])}`);
  return diffs.length > 0 ? `the harness did not apply the requested settings - ${diffs.join("; ")}` : null;
}

// --------------------------------------------------------------------- run

export interface HarnessRun {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** When the process was started (epoch ms). */
  startedMs: number;
  /** The harness's session log for this run: every message as it happened, then a turn record. */
  sessionDir: string;
  /** Every model call, subagents included. */
  wireLog: string;
  /** The agent's npm prefix (already removed): its own scratch space, not an escape if it names it. */
  npmPrefix: string;
}

export async function runHarness(options: {
  harness: HarnessInfo;
  profile: ModelProfile;
  defaults: Defaults;
  task: Task;
  trial: number;
  workspace: string;
  trialDir: string;
  lab: string;
  extraEnv?: Record<string, string>;
}): Promise<HarnessRun> {
  const { harness, profile, defaults, task, workspace, trialDir } = options;
  const sessionDir = path.join(trialDir, "session");
  const wireLog = path.join(trialDir, "wire.jsonl");
  const npmPrefix = fs.mkdtempSync(path.join(os.tmpdir(), "hfl-npm-"));
  const tsx = path.join(harness.dir, "node_modules", "tsx", "dist", "cli.mjs");
  if (!fs.existsSync(tsx)) throw new Error(`${tsx} not found - run npm install in the harness`);

  const env = buildHarnessEnv({
    source: process.env,
    secrets: secrets(harness.dir),
    profile,
    defaults,
    task,
    trial: options.trial,
    sessionDir,
    wireLog,
    npmPrefix,
    lab: options.lab,
    extra: options.extraEnv
  });

  const timeoutMs = (task.timeout_s ?? defaults.timeout_s) * 1000;
  const startedMs = Date.now();
  let result;
  try {
    result = await run(process.execPath, [tsx, path.join(harness.dir, "src", "index.ts"), `--${profile.backend}`, task.prompt], { cwd: workspace, env, timeoutMs });
  } finally {
    fs.rmSync(npmPrefix, { recursive: true, force: true });
  }
  fs.writeFileSync(
    path.join(trialDir, "harness.log"),
    plain(`${result.stdout}${result.stderr ? `\n--- stderr ---\n${result.stderr}` : ""}`)
  );
  return { exitCode: result.code, timedOut: result.timedOut, durationMs: result.ms, startedMs, sessionDir, wireLog, npmPrefix };
}

/** Does the harness checkout have the settings and wire-log support this runner relies on? Checked once, before any trial. */
export function harnessSupportsSettings(dir: string): boolean {
  try {
    return (
      fs.readFileSync(path.join(dir, "src", "config.ts"), "utf-8").includes("describeSettings") &&
      fs.readFileSync(path.join(dir, "src", "llm.ts"), "utf-8").includes("WIRE_LOG")
    );
  } catch {
    return false;
  }
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
