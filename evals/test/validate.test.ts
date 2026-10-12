import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Task } from "../src/config.js";
import { hygieneIssues, validateTask } from "../src/validate.js";

type Layout = { workspace?: Record<string, string>; hidden?: Record<string, string>; solution?: Record<string, string>; fixtures?: Record<string, Record<string, string>> };

function task(layout: Layout, checks: Array<{ name: string; run: string; guard?: boolean }>): Task {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hfl-validate-"));
  const put = (root: string, files: Record<string, string> = {}) => {
    for (const [name, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, root, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, root, name), text);
    }
  };
  put("workspace", { "package.json": '{ "type": "module" }', ...layout.workspace });
  put("hidden", layout.hidden);
  put("solution", layout.solution);
  for (const [name, files] of Object.entries(layout.fixtures ?? {})) put(`fixtures/${name}`, files);
  return {
    id: "demo",
    title: "demo",
    difficulty: "easy",
    tags: [],
    prompt: "p",
    checks: checks.map((c) => ({ type: "command", timeout_s: 20, guard: false, ...c })),
    dir
  } as Task;
}

const answer = { name: "answer is right", run: "grep -q right answer.txt" };

test("a sound task: red fails, green passes every time, wrong answers fail", async () => {
  const t = task({ solution: { "answer.txt": "right" }, fixtures: { wrong: { "answer.txt": "wrong" }, empty: { "answer.txt": "" } } }, [answer]);
  const v = await validateTask(t, 2);
  assert.deepEqual(v.issues, []);
  assert.equal(v.summary, "red 1/1 failing · green 1/1 passing ×2 · fixtures 2/2 failing");
});

test("a check that passes with no work done proves nothing - unless it is marked as a guard", async () => {
  const layout: Layout = { workspace: { "answer.txt": "right" }, solution: { "answer.txt": "right" } };
  const vacuous = await validateTask(task(layout, [{ name: "always true", run: "true" }, { ...answer, name: "answer" }]), 1);
  assert.equal(vacuous.issues.length, 2);
  assert.match(vacuous.issues[0], /"always true" passes with no work done/);

  const guarded = await validateTask(task(layout, [{ name: "output unchanged", run: "grep -q right answer.txt", guard: true }]), 1);
  assert.deepEqual(guarded.issues, [], "a regression guard is supposed to pass on the untouched workspace");

  const brokenGuard = await validateTask(task({ solution: { "answer.txt": "right" } }, [{ ...answer, guard: true }]), 1);
  assert.match(brokenGuard.issues[0], /guard "answer is right" fails on the untouched workspace/);
});

test("a wrong answer that passes every check means the checks are too weak", async () => {
  const t = task({ solution: { "answer.txt": "right" }, fixtures: { "sneaky": { "answer.txt": "almost right" } } }, [answer]);
  const v = await validateTask(t, 1);
  assert.equal(v.issues.length, 1);
  assert.match(v.issues[0], /fixture "sneaky" is a known-wrong attempt but passes every check/);
});

test("a task with no solution, or whose solution fails, is not valid", async () => {
  assert.match((await validateTask(task({}, [answer]), 1)).issues.join("\n"), /no solution\//);
  const bad = await validateTask(task({ solution: { "answer.txt": "wrong" } }, [answer]), 1);
  assert.match(bad.issues[0], /reference solution fails "answer is right"/);
});

test("a check that flips between runs is reported as flaky", async () => {
  const counter = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hfl-flip-")), "n").replace(/\\/g, "/");
  const flip = { name: "flips", run: `n=$(cat ${counter} 2>/dev/null || echo 0); echo $((n+1)) > ${counter}; test $((n % 2)) -eq 1` };
  const v = await validateTask(task({ solution: { "answer.txt": "x" } }, [flip]), 3);
  assert.ok(v.issues.some((i) => /"flips" is flaky: it passed \d of 3 runs/.test(i)), v.issues.join("\n"));
});

test("hygiene: a .env in the workspace and an ES module named .js in hidden/", () => {
  const t = task(
    { workspace: { ".env": "SYSTEM_PROMPT=x" }, hidden: { "eval_tests/a.test.js": 'import { test } from "node:test";', "eval_tests/b.test.mjs": 'import { test } from "node:test";', "eval_tests/c.js": "module.exports = 1" } },
    [answer]
  );
  const issues = hygieneIssues(t);
  assert.equal(issues.length, 2);
  assert.match(issues[0], /\.env.*would change the run/);
  assert.match(issues[1], /a\.test\.js.*rename it to \.mjs/);
});

test("every task in the repo is clean: hidden tests are .mjs, no .env", async () => {
  const { loadTasks } = await import("../src/config.js");
  for (const t of loadTasks()) assert.deepEqual(hygieneIssues(t), [], t.id);
});
