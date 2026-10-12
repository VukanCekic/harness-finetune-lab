import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const wc = (...args) => spawnSync(process.execPath, ["wc.js", ...args], { encoding: "utf-8" });

// Written here, not shipped as a file, so its exact bytes cannot drift.
const fixture = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wc-")), "fixture.txt");
fs.writeFileSync(fixture, "héllo wörld\n  second   line here \n\nlast", "utf-8");

test("counts a file with accents, extra spaces, a blank line and no final newline", () => {
  const result = wc(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { lines: 3, words: 6, chars: 39 });
});

test("counts the sample", () => {
  const result = wc("samples/poem.txt");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { lines: 5, words: 14, chars: 72 });
});

test("prints a single line of JSON", () => {
  const result = wc("samples/poem.txt");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim().split("\n").length, 1);
  JSON.parse(result.stdout); // throws unless it is JSON
});

test("a missing file is an error on stderr with exit code 1, and a real file is not", () => {
  // Without this, a script that crashes on every input would pass: any crash exits 1 and writes to stderr.
  assert.equal(wc("samples/poem.txt").status, 0, "a file that exists must work before a missing one can be an error");
  const result = wc("does-not-exist.txt");
  assert.equal(result.status, 1);
  assert.notEqual(result.stderr.trim(), "");
  assert.equal(result.stdout.trim(), "", "nothing on stdout for an error");
});
