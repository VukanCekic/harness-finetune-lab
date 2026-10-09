/**
 * Loading and validating the eval config (eval.config.yaml) and the tasks
 * (tasks/<id>/task.yaml). A bad file fails here, before any model is called.
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";

export const EVALS_DIR = path.resolve(import.meta.dirname, "..");
export const TASKS_DIR = path.join(EVALS_DIR, "tasks");
export const RESULTS_DIR = path.join(EVALS_DIR, "results");
export const TOOL_SCHEMAS_FILE = path.join(EVALS_DIR, "tool-schemas.json");

// ------------------------------------------------------------------ config

const ModelProfile = z
  .object({
    backend: z.enum(["remote", "local"]),
    model: z.string().min(1),
    base_url: z.string().min(1).optional(),
    notes: z.string().optional()
  })
  .strict();
export type ModelProfile = z.infer<typeof ModelProfile>;

const Defaults = z
  .object({
    context_window: z.number().int().positive(),
    timeout_s: z.number().int().positive(),
    max_steps: z.number().int().positive(),
    trials: z.number().int().positive()
  })
  .strict();
export type Defaults = z.infer<typeof Defaults>;

const EvalConfig = z
  .object({
    harness: z.object({ dir: z.string().min(1) }).strict(),
    defaults: Defaults,
    models: z.record(z.string(), ModelProfile)
  })
  .strict();
export type EvalConfig = z.infer<typeof EvalConfig>;

export function loadConfig(file = path.join(EVALS_DIR, "eval.config.yaml")): EvalConfig {
  const parsed = EvalConfig.safeParse(YAML.parse(fs.readFileSync(file, "utf-8")));
  if (!parsed.success) throw new Error(`${file}:\n${z.prettifyError(parsed.error)}`);
  const config = parsed.data;
  if (process.env.HARNESS_DIR) config.harness.dir = process.env.HARNESS_DIR;
  return config;
}

// ------------------------------------------------------------------- tasks

const name = z.string().min(1).optional();

const Check = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("command"),
      name,
      /** Run with bash in the workspace. Exit code 0 = pass. */
      run: z.string().min(1),
      /** Also require this text in stdout. */
      stdout_includes: z.string().optional(),
      timeout_s: z.number().int().positive().default(60)
    })
    .strict(),
  z.object({ type: z.literal("file_exists"), name, path: z.string().min(1) }).strict()
]);
export type Check = z.infer<typeof Check>;

const TaskSpec = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and hyphens"),
    title: z.string().min(1),
    difficulty: z.enum(["easy", "medium", "hard"]),
    tags: z.array(z.string()).default([]),
    /** Exactly what the agent is told. Nothing else about the task reaches it. */
    prompt: z.string().min(1),
    timeout_s: z.number().int().positive().optional(),
    max_steps: z.number().int().positive().optional(),
    checks: z.array(Check).min(1)
  })
  .strict();

export type Task = z.infer<typeof TaskSpec> & {
  /** tasks/<id>/ */
  dir: string;
};

/**
 * Every tasks/<id>/task.yaml. Next to it:
 *   workspace/  copied in before the run - the agent sees it
 *   hidden/     copied in after the run, over the agent's files - the agent never sees it
 *   solution/   a reference solution, used only by `validate`
 */
export function loadTasks(filter?: string[]): Task[] {
  const errors: string[] = [];
  const tasks: Task[] = [];
  for (const entry of fs.readdirSync(TASKS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(TASKS_DIR, entry.name);
    const file = path.join(dir, "task.yaml");
    if (!fs.existsSync(file)) {
      errors.push(`${entry.name}: no task.yaml`);
      continue;
    }
    const parsed = TaskSpec.safeParse(YAML.parse(fs.readFileSync(file, "utf-8")));
    if (!parsed.success) {
      errors.push(`${entry.name}/task.yaml:\n${z.prettifyError(parsed.error)}`);
      continue;
    }
    if (parsed.data.id !== entry.name) {
      errors.push(`${entry.name}/task.yaml: id "${parsed.data.id}" must match its folder name`);
      continue;
    }
    tasks.push({ ...parsed.data, dir });
  }
  if (errors.length > 0) throw new Error(`Invalid tasks:\n${errors.join("\n")}`);

  if (filter && filter.length > 0) {
    const unknown = filter.filter((id) => !tasks.some((t) => t.id === id));
    if (unknown.length > 0) throw new Error(`Unknown task(s): ${unknown.join(", ")}`);
    return tasks.filter((t) => filter.includes(t.id)).sort((a, b) => a.id.localeCompare(b.id));
  }
  return tasks.sort((a, b) => a.id.localeCompare(b.id));
}
