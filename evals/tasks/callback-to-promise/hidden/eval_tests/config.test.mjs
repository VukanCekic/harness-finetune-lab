import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
const file = (name, text) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, text);
  return p;
};

test("returns a promise of the config with the defaults filled in", async () => {
  const pending = loadConfig(file("a.json", '{ "host": "0.0.0.0" }'));
  assert.ok(pending instanceof Promise, "loadConfig(file) must return a Promise");
  assert.deepEqual(await pending, { port: 3000, host: "0.0.0.0" });
});

test("rejects on a missing file", async () => {
  await assert.rejects(loadConfig(path.join(dir, "missing.json")));
});

test("rejects on invalid JSON", async () => {
  await assert.rejects(loadConfig(file("bad.json", "{ nope")));
});
