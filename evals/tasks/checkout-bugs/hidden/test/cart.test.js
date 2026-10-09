import { test } from "node:test";
import assert from "node:assert/strict";
import { cartTotal } from "../src/cart.js";

test("one line", () => assert.equal(cartTotal([{ unitCents: 1999, qty: 1 }]), "€19.99"));
test("a quantity", () => assert.equal(cartTotal([{ unitCents: 250, qty: 4 }]), "€10.00"));
test("a 10% discount", () => assert.equal(cartTotal([{ unitCents: 2000, qty: 2, discountPercent: 10 }]), "€36.00"));
test("small amounts keep two decimals", () => assert.equal(cartTotal([{ unitCents: 5, qty: 1 }]), "€0.05"));
test("a mixed cart", () =>
  assert.equal(cartTotal([{ unitCents: 1999, qty: 2 }, { unitCents: 1000, qty: 1, discountPercent: 25 }]), "€47.48"));
test("an empty cart", () => assert.equal(cartTotal([]), "€0.00"));
