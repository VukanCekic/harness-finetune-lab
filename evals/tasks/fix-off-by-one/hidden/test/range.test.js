import { test } from "node:test";
import assert from "node:assert/strict";
import { range } from "../src/range.js";

test("both ends are included", () => assert.deepEqual(range(1, 3), [1, 2, 3]));
test("a single number", () => assert.deepEqual(range(5, 5), [5]));
test("a step lands on the end", () => assert.deepEqual(range(0, 10, 5), [0, 5, 10]));
test("a step that skips the end", () => assert.deepEqual(range(0, 9, 4), [0, 4, 8]));
test("empty when start is after end", () => assert.deepEqual(range(3, 1), []));
test("a bad step throws", () => assert.throws(() => range(1, 3, 0), RangeError));
