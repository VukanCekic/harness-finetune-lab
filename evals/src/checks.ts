/** Deterministic graders. No LLM judges: a check either passes or it does not. */
import fs from "node:fs";
import path from "node:path";
import type { Check, Task } from "./config.js";
import { bash, plain } from "./shell.js";

export interface CheckResult {
  name: string;
  passed: boolean;
  /** Why it failed - the tail of the command's output. Empty when it passed. */
  detail: string;
}

/** The start (where errors like SyntaxError are named) and the end (the final verdict) of long output. */
const excerpt = (text: string, head = 500, tail = 300) =>
  text.length > head + tail ? `${text.slice(0, head)}\n…\n${text.slice(-tail)}` : text;

function label(check: Check): string {
  if (check.name) return check.name;
  return check.type === "command" ? check.run.replace(/\s+/g, " ").slice(0, 80) : `${check.path} exists`;
}

export async function runCheck(check: Check, cwd: string): Promise<CheckResult> {
  const name = label(check);
  if (check.type === "file_exists") {
    const passed = fs.existsSync(path.join(cwd, check.path));
    return { name, passed, detail: passed ? "" : `${check.path} does not exist` };
  }

  const result = await bash(check.run, cwd, check.timeout_s * 1000);
  const output = plain(`${result.stdout}\n${result.stderr}`).trim();
  if (result.timedOut) return { name, passed: false, detail: `timed out after ${check.timeout_s}s\n${excerpt(output)}` };
  if (result.code !== 0) return { name, passed: false, detail: `exit ${result.code}\n${excerpt(output)}` };
  if (check.stdout_includes !== undefined && !result.stdout.includes(check.stdout_includes)) {
    return { name, passed: false, detail: `stdout lacks ${JSON.stringify(check.stdout_includes)}\n${excerpt(output)}` };
  }
  return { name, passed: true, detail: "" };
}

/** Every check runs, even after one fails, so a result shows everything that is wrong. */
export async function runChecks(task: Task, cwd: string): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of task.checks) results.push(await runCheck(check, cwd));
  return results;
}
