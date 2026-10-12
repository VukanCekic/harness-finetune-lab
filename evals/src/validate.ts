/**
 * A task is only useful if its checks can fail and can pass, and fail for the
 * right reasons. For each task, `validate` shows:
 *
 *   red       untouched workspace + hidden tests: every check must FAIL, except
 *             a guard (a regression check that passes by design, e.g. "output unchanged")
 *   green     reference solution, run several times: every check must pass, every time
 *   fixtures  known-wrong attempts (tasks/<id>/fixtures/<name>/): at least one check must fail.
 *             They are mutation tests - if a wrong answer gets through, the checks are too weak.
 *   hygiene   no .env in the workspace (the harness would load it), no ESM hidden test as .js
 *             (it stops loading if the agent edits package.json's "type")
 */
import fs from "node:fs";
import path from "node:path";
import { runChecks, type CheckResult } from "./checks.js";
import type { Task } from "./config.js";
import { addFixture, addHidden, addSolution, fixtureNames, remove, seed, tempWorkspace } from "./workspace.js";

export interface Validation {
  task: string;
  issues: string[];
  /** e.g. "red 2/3 failing · green 3/3 passing ×3 · fixtures 4/4 failing". */
  summary: string;
}

const short = (c: CheckResult) => c.detail.split("\n").slice(0, 6).join(" | ");

/** Every file under a directory, relative. */
function files(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(path.relative(dir, e.parentPath), e.name));
}

/** Static checks on a task's own files. */
export function hygieneIssues(task: Task): string[] {
  const issues: string[] = [];
  for (const file of files(path.join(task.dir, "workspace"))) {
    if (path.basename(file) === ".env") issues.push(`workspace/${file}: the harness loads a .env from its working directory, which would change the run`);
  }
  for (const file of files(path.join(task.dir, "hidden")).filter((f) => f.endsWith(".js"))) {
    const text = fs.readFileSync(path.join(task.dir, "hidden", file), "utf-8");
    if (/^\s*(import\s|export\s)/m.test(text)) issues.push(`hidden/${file}: an ES module named .js loads only while package.json says "type": "module", which the agent can edit - rename it to .mjs`);
  }
  return issues;
}

export async function validateTask(task: Task, greenRuns = 3): Promise<Validation> {
  const issues = hygieneIssues(task);
  const checkNames = (results: CheckResult[]) => results.map((c) => c.name);

  // red
  const red = tempWorkspace(`${task.id}-red`);
  let redChecks: CheckResult[] = [];
  try {
    seed(task, red);
    addHidden(task, red);
    redChecks = await runChecks(task, red);
  } finally {
    remove(red);
  }
  task.checks.forEach((check, i) => {
    const result = redChecks[i];
    if (check.guard && !result.passed) issues.push(`guard "${result.name}" fails on the untouched workspace: ${short(result)}`);
    if (!check.guard && result.passed) issues.push(`"${result.name}" passes with no work done - it proves nothing (mark it guard: true if it is a regression check)`);
  });

  // green, several times: a check that flips is flaky
  const hasSolution = fs.existsSync(path.join(task.dir, "solution"));
  const green: CheckResult[][] = [];
  if (!hasSolution) issues.push("no solution/ - cannot show the task is solvable");
  else {
    for (let i = 0; i < greenRuns; i++) {
      const dir = tempWorkspace(`${task.id}-green`);
      try {
        seed(task, dir);
        addSolution(task, dir);
        addHidden(task, dir);
        green.push(await runChecks(task, dir));
      } finally {
        remove(dir);
      }
    }
    for (const name of checkNames(green[0])) {
      const outcomes = green.map((run) => run.find((c) => c.name === name)!);
      const passes = outcomes.filter((c) => c.passed).length;
      if (passes === 0) issues.push(`reference solution fails "${name}": ${short(outcomes[0])}`);
      else if (passes < outcomes.length) issues.push(`"${name}" is flaky: it passed ${passes} of ${outcomes.length} runs on the reference solution`);
    }
  }

  // fixtures: wrong answers must not pass
  const fixtures = fixtureNames(task);
  let fixturesFailing = 0;
  for (const name of fixtures) {
    const dir = tempWorkspace(`${task.id}-fx`);
    try {
      seed(task, dir);
      addFixture(task, name, dir);
      addHidden(task, dir);
      const results = await runChecks(task, dir);
      if (results.some((c) => !c.passed)) fixturesFailing++;
      else issues.push(`fixture "${name}" is a known-wrong attempt but passes every check - the checks are too weak`);
    } finally {
      remove(dir);
    }
  }

  const redFailing = redChecks.filter((c) => !c.passed).length;
  const greenPassing = green.length ? green[0].filter((c) => c.passed).length : 0;
  return {
    task: task.id,
    issues,
    summary:
      `red ${redFailing}/${redChecks.length} failing · green ${greenPassing}/${task.checks.length} passing${green.length ? ` ×${green.length}` : ""}` +
      `${fixtures.length ? ` · fixtures ${fixturesFailing}/${fixtures.length} failing` : " · no fixtures"}`
  };
}
