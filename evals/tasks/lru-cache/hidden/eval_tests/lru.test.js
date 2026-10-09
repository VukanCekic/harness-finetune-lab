import { test } from "node:test";
import assert from "node:assert/strict";

const mod = await import("../src/lru.js");
const LRUCache = mod.LRUCache ?? mod.default;

test("get and set", () => {
  const cache = new LRUCache(2);
  cache.set("a", 1);
  cache.set("b", 2);
  assert.equal(cache.get("a"), 1);
  assert.equal(cache.get("b"), 2);
  assert.equal(cache.get("missing"), undefined);
});

test("evicts the least recently used key; get counts as a use", () => {
  const cache = new LRUCache(2);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.get("a");
  cache.set("c", 3);
  assert.equal(cache.has("b"), false);
  assert.equal(cache.has("a"), true);
  assert.equal(cache.has("c"), true);
  assert.equal(cache.size, 2);
});

test("updating a key refreshes it and does not grow the cache", () => {
  const cache = new LRUCache(2);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("a", 10);
  assert.equal(cache.size, 2);
  cache.set("c", 3);
  assert.equal(cache.has("b"), false);
  assert.equal(cache.get("a"), 10);
});

test("has does not change recency", () => {
  const cache = new LRUCache(2);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.has("a");
  cache.set("c", 3);
  assert.equal(cache.has("a"), false);
  assert.equal(cache.has("b"), true);
});

test("delete removes a key", () => {
  const cache = new LRUCache(3);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.delete("a");
  assert.equal(cache.has("a"), false);
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.size, 1);
});

test("capacity 1 keeps only the newest key", () => {
  const cache = new LRUCache(1);
  cache.set("a", 1);
  cache.set("b", 2);
  assert.equal(cache.size, 1);
  assert.equal(cache.get("b"), 2);
  assert.equal(cache.has("a"), false);
});

test("falsy values are stored", () => {
  const cache = new LRUCache(3);
  cache.set("zero", 0);
  cache.set("empty", "");
  cache.set("nothing", null);
  assert.equal(cache.get("zero"), 0);
  assert.equal(cache.get("empty"), "");
  assert.equal(cache.get("nothing"), null);
  assert.equal(cache.has("nothing"), true);
});

test("a capacity that is not a positive integer throws RangeError", () => {
  for (const bad of [0, -1, 1.5, "2", undefined]) {
    assert.throws(() => new LRUCache(bad), RangeError, `capacity ${String(bad)}`);
  }
});
