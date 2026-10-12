import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

// A todo list the agent never saw, so hard-coded output cannot pass.
const TODOS = [
  { id: 7, title: "Read the paper", done: false },
  { id: 8, title: "Ship it", done: true }
];
let original;
before(() => {
  original = fs.readFileSync("todos.json", "utf-8");
  fs.writeFileSync("todos.json", JSON.stringify(TODOS));
});
after(() => fs.writeFileSync("todos.json", original));

const todo = (...args) => spawnSync(process.execPath, ["todo.js", ...args], { encoding: "utf-8" });

test("list --json prints the todos as JSON", () => {
  const result = todo("list", "--json");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), TODOS);
});

test("list without the flag is unchanged", () => {
  assert.equal(todo("list").stdout, "[ ] 7. Read the paper\n[x] 8. Ship it\n");
});

test("an unknown command still fails", () => {
  assert.equal(todo("frobnicate").status, 1);
});
