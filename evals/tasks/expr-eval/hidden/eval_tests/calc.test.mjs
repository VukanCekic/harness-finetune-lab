import { test } from "node:test";
import assert from "node:assert/strict";

const mod = await import("../src/calc.js");
const evaluate = mod.evaluate ?? mod.default;

const values = [
  ["1 + 2", 3],
  ["2 + 3 * 4", 14],
  ["(2 + 3) * 4", 20],
  ["10 / 4", 2.5],
  ["8 - 3 - 2", 3],
  ["100 / 10 / 5", 2],
  ["2 * 3 / 4", 1.5],
  ["-3 + 5", 2],
  ["-(2 + 3)", -5],
  ["2 * -3", -6],
  ["3 - -2", 5],
  ["  7  ", 7],
  ["1.5 + 2.25", 3.75],
  ["((1))", 1],
  ["2*(3+4)-5/(1+1)", 11.5]
];
for (const [expression, expected] of values) {
  test(`${expression} = ${expected}`, () => assert.equal(evaluate(expression), expected));
}

for (const bad of ["2 +", "(1", "1)", "2 3", "abc", "", "* 2", "1 + (2 * )"]) {
  test(`${JSON.stringify(bad)} throws`, () => assert.throws(() => evaluate(bad), Error));
}
