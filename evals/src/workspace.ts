/**
 * Each trial gets a fresh directory in the OS temp folder - never inside this
 * repo, where Node would resolve this repo's node_modules for the task's code.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { Task } from "./config.js";

export function tempWorkspace(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `hfl-${label.replace(/[^\w-]/g, "_")}-`));
}

function copyInto(from: string, to: string): void {
  if (fs.existsSync(from)) fs.cpSync(from, to, { recursive: true, force: true });
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", ["-c", "core.autocrlf=false", "-c", "user.email=eval@local", "-c", "user.name=eval", ...args], {
    cwd,
    encoding: "utf-8"
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`);
}

/** workspace/ into a new git repository, committed - the harness snapshots with git. */
export function seed(task: Task, dir: string): void {
  copyInto(path.join(task.dir, "workspace"), dir);
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--allow-empty", "-m", "task start");
}

/** hidden/ over whatever the agent left - restores any test it edited, adds tests it never saw. */
export function addHidden(task: Task, dir: string): void {
  copyInto(path.join(task.dir, "hidden"), dir);
}

export function addSolution(task: Task, dir: string): boolean {
  const solution = path.join(task.dir, "solution");
  copyInto(solution, dir);
  return fs.existsSync(solution);
}

/** Keep what the agent produced for reading later, minus .git and dependencies. */
export function keep(from: string, to: string): void {
  fs.cpSync(from, to, {
    recursive: true,
    filter: (source) => !path.relative(from, source).split(path.sep).some((part) => part === ".git" || part === "node_modules")
  });
}

export function remove(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // Windows sometimes holds a handle a moment longer; a stray temp dir is harmless
  }
}
