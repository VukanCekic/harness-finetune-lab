import { test } from "node:test";
import assert from "node:assert/strict";
import { linePrice } from "../src/pricing.js";
import { formatCents } from "../src/format.js";

test("a discount is rounded to the nearest cent", () => assert.equal(linePrice(999, 1, 33), 669));
test("no discount by default", () => assert.equal(linePrice(120, 3), 360));
test("100% off is free", () => assert.equal(linePrice(4321, 2, 100), 0));
test("formats single-digit cents", () => assert.equal(formatCents(1207), "€12.07"));
test("formats large amounts", () => assert.equal(formatCents(120000), "€1200.00"));
