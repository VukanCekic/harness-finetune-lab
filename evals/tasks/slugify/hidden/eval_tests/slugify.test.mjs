import { test } from "node:test";
import assert from "node:assert/strict";

const mod = await import("../src/slugify.js");
const slugify = mod.slugify ?? mod.default;

const cases = [
  ["Hello, World!", "hello-world"],
  ["  Crème Brûlée  ", "creme-brulee"],
  ["already-a-slug", "already-a-slug"],
  ["a--b__c  d", "a-b-c-d"],
  ["Ünïcödé 2026", "unicode-2026"],
  ["ÀÉÎÕÜ", "aeiou"],
  ["Façade Niño", "facade-nino"],
  ["Çà et là, Señor Piñata", "ca-et-la-senor-pinata"],
  ["---", ""],
  ["", ""],
  ["C++ & Rust: a 10x guide?", "c-rust-a-10x-guide"]
];

for (const [input, expected] of cases) {
  test(JSON.stringify(input), () => assert.equal(slugify(input), expected));
}
