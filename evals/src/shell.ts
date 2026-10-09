/**
 * Running processes with a hard timeout that kills the whole tree - an agent
 * run may leave a dev server or a test watcher behind.
 */
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";

export interface Exec {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  ms: number;
}

const MAX_CAPTURE = 2_000_000; // characters kept per stream

/** Git for Windows' bash - the same one the harness uses. Checks are written in bash. */
export function bashPath(): string {
  if (process.platform !== "win32") return "bash";
  const found = [
    process.env.BASH_PATH,
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe"
  ].find((p) => p && fs.existsSync(p));
  if (!found) throw new Error("Git Bash not found. Install Git for Windows or set BASH_PATH.");
  return found;
}

export function killTree(pid: number): void {
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}

export function run(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number }
): Promise<Exec> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"], // closed stdin: an agent's ask_user gets EOF instead of hanging
      detached: process.platform !== "win32",
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout = (stdout + d).slice(-MAX_CAPTURE)));
    child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-MAX_CAPTURE)));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid);
    }, options.timeoutMs);

    const finish = (code: number | null, error?: Error) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr: error ? `${stderr}\n${error.message}` : stderr, timedOut, ms: Date.now() - started });
    };
    child.on("error", (err) => finish(null, err));
    child.on("close", (code) => finish(code));
  });
}

/** One bash command line, run in `cwd`. */
export function bash(line: string, cwd: string, timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<Exec> {
  return run(bashPath(), ["-c", line], { cwd, timeoutMs, env });
}

/** Strip colour codes from captured terminal output. */
export const plain = (text: string): string => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
