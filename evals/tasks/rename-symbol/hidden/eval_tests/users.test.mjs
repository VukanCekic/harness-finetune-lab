import { test } from "node:test";
import assert from "node:assert/strict";
import * as users from "../src/users.js";

test("getUser is exported and works", () => {
  assert.equal(typeof users.getUser, "function");
  assert.deepEqual(users.getUser(1), { id: 1, name: "Ada" });
  assert.equal(users.getUser(99), null);
});
