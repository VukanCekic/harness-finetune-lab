/** Shared pieces of the end-to-end tests: a throwaway task and the defaults a scripted run uses. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Defaults, ModelProfile, Task } from "../../src/config.js";
import type { FakeServer } from "./fakeServer.js";

export const defaults: Defaults = { context_window: 40000, timeout_s: 60, max_steps: 40, max_tokens: 4096, max_turn_tokens: 100000, trials: 1 };

export const profileFor = (server: FakeServer, over: Partial<ModelProfile> = {}): ModelProfile => ({
  backend: "local",
  model: "fake-model",
  base_url: server.url,
  sampling: { temperature: 0.6, top_p: 0.95, top_k: 20, seed: 7 },
  thinking: "default",
  ...over
});

/** A task whose only check is that greet.js exists. */
export function makeTask(id: string, over: Partial<Task> = {}): Task {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hfl-e2e-task-${id}-`));
  fs.mkdirSync(path.join(dir, "workspace"));
  fs.writeFileSync(path.join(dir, "workspace", "package.json"), '{ "type": "module" }\n');
  return {
    id,
    title: id,
    difficulty: "easy",
    tags: [],
    prompt: "Create greet.js that prints a greeting.",
    checks: [{ type: "file_exists", name: "greet.js exists", path: "greet.js", guard: false }],
    dir,
    ...over
  } as Task;
}
