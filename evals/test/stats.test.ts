import { test } from "node:test";
import assert from "node:assert/strict";
import { clusteredCI, formatInterval, pairedDifference, t975 } from "../src/stats.js";

const close = (a: number, b: number, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} is not within ${eps} of ${b}`);

test("clusteredCI: mean across tasks with a t-interval, clipped to the range of a rate", () => {
  // The first Qwen run: 4 of 11 tasks passed once. The error comes from the spread across tasks.
  const run = clusteredCI([1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0]);
  close(run.mean, 4 / 11);
  assert.equal(run.n, 11);
  // sd = sqrt(p(1-p) * n/(n-1)) = 0.5045, t(10) = 2.228, half-width = 0.3389
  close(run.low, 4 / 11 - 0.3389);
  close(run.high, 4 / 11 + 0.3389);

  const wide = clusteredCI([1, 0]);
  assert.equal(wide.low, 0, "clipped, not negative");
  assert.equal(wide.high, 1);
});

test("clusteredCI: too few tasks to estimate a spread", () => {
  assert.ok(Number.isNaN(clusteredCI([]).mean));
  const one = clusteredCI([0.5]);
  assert.equal(one.mean, 0.5);
  assert.ok(Number.isNaN(one.low) && Number.isNaN(one.high));
});

test("clusteredCI: tasks that all agree do not make the result certain", () => {
  // 11 of 11 passed. A t-interval has no spread to work with and would say [100, 100]; the truth is that a true
  // pass rate down to about 72% still gives 11 of 11 about one time in forty.
  const allPass = clusteredCI(Array(11).fill(1));
  assert.equal(allPass.mean, 1);
  close(allPass.low, 0.025 ** (1 / 11)); // 0.7151, the exact bound for 11 of 11
  close(allPass.low, 0.7151, 1e-3);
  assert.equal(allPass.high, 1);

  const allFail = clusteredCI(Array(11).fill(0));
  assert.equal(allFail.low, 0);
  close(allFail.high, 0.2849, 1e-3);

  const allHalf = clusteredCI(Array(11).fill(0.5));
  close(allHalf.low, 0.2456, 1e-3);
  close(allHalf.high, 0.7544, 1e-3);

  // no jump where the spread becomes non-zero: 10 of 11 is about as uncertain as 11 of 11
  close(clusteredCI([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0]).low, 0.7065, 1e-3);
  assert.ok(clusteredCI(Array(30).fill(1)).low > allPass.low, "more tasks that all pass is more evidence");
});

test("t975: between tabulated values it takes the wider neighbour, never the narrower", () => {
  assert.equal(t975(10), 2.228);
  assert.equal(t975(30), 2.042);
  assert.equal(t975(35), 2.042, "the true value, 2.030, lies between t(30) and t(40); the larger is used");
  assert.equal(t975(40), 2.021);
  assert.equal(t975(500), 1.98);
  assert.equal(t975(5000), 1.96);
  assert.ok(Number.isNaN(t975(0)));
});

test("pairedDifference: per task, on the tasks both runs cover", () => {
  const base = { a: 0, b: 0, c: 1, d: 0, only_base: 1 };
  const tuned = { a: 1, b: 1, c: 1, d: 0, only_tuned: 0 };
  const diff = pairedDifference(base, tuned);
  assert.deepEqual(diff.shared, ["a", "b", "c", "d"]);
  close(diff.mean, 0.5);
  assert.ok(diff.low > -1 && diff.high <= 1);
  assert.equal(pairedDifference({ a: 1 }, { b: 1 }).n, 0);
});

test("pairedDifference: identical runs cannot rule out a big difference, and a clean sweep is bounded away from zero", () => {
  const ids = [..."abcdefghijk"];
  const all = (v: number) => Object.fromEntries(ids.map((k) => [k, v]));
  const same = pairedDifference(all(1), all(1));
  assert.equal(same.mean, 0);
  close(same.low, -0.5088, 1e-3); // not [0, 0]: 11 tasks cannot show two models are the same
  close(same.high, 0.5088, 1e-3);
  const sweep = pairedDifference(all(0), all(1)); // every one of 11 tasks went from failing to passing
  assert.equal(sweep.high, 1);
  close(sweep.low, 0.4302, 1e-3);
});

test("formatInterval", () => {
  assert.equal(formatInterval({ mean: 0.5, low: 0.25, high: 0.75, n: 4 }), "50.0% [25.0, 75.0]");
  assert.equal(formatInterval({ mean: 0.1, low: -0.2, high: 0.4, n: 4 }, true), "+10.0% [-20.0, +40.0]");
  assert.equal(formatInterval({ mean: 0.5, low: NaN, high: NaN, n: 1 }), "50.0%");
  assert.equal(formatInterval({ mean: NaN, low: NaN, high: NaN, n: 0 }), "-");
});
