// Re-runs convert.js on the given CSV and on a second one the agent never saw,
// so a hand-written people.json cannot pass.
import fs from "node:fs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const CSV = "data/people.csv";
const OUT = "data/people.json";
const convert = () => execFileSync(process.execPath, ["convert.js"], { stdio: "inherit" });
const read = () => JSON.parse(fs.readFileSync(OUT, "utf-8"));

convert();
assert.deepEqual(read(), [
  { name: "Ada Lovelace", age: 36, city: "London" },
  { name: "Hopper, Grace", age: 85, city: "New York" },
  { name: "Alan Turing", age: 41, city: "Wilmslow, Cheshire" }
]);

const original = fs.readFileSync(CSV, "utf-8");
try {
  fs.writeFileSync(CSV, 'name,age,city\n"Lamarr, Hedy",85,Vienna\nKatherine Johnson,101,"White Sulphur Springs, WV"\n');
  convert();
  assert.deepEqual(read(), [
    { name: "Lamarr, Hedy", age: 85, city: "Vienna" },
    { name: "Katherine Johnson", age: 101, city: "White Sulphur Springs, WV" }
  ]);
} finally {
  fs.writeFileSync(CSV, original);
}
console.log("ok");
