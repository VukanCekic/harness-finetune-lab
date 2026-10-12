import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { loadConfig, unpinned, type ModelProfile, type Task } from "../src/config.js";
import { budgetWarnings, fingerprint, hashTree, labInfo, type RunConditions } from "../src/conditions.js";
import { buildHarnessEnv, expectedSettings, harnessInfo, settingsMismatch, trialSampling } from "../src/harness.js";

const lab = path.resolve("D:/code/harness-finetune-lab");
const defaults = { context_window: 40000, timeout_s: 900, max_steps: 40, max_tokens: 8192, max_turn_tokens: 100000, trials: 3 };
const task = { id: "t", title: "t", difficulty: "easy", tags: [], prompt: "p", checks: [], dir: "x" } as unknown as Task;
const local: ModelProfile = {
  backend: "local",
  model: "qwen3-8b",
  base_url: "http://localhost:1234/v1",
  sampling: { temperature: 0.6, top_p: 0.95, top_k: 20, seed: 100 },
  thinking: "default"
};
const remote: ModelProfile = { backend: "remote", model: "deepseek/x", sampling: { temperature: 0.3 }, thinking: "default", provider: ["deepinfra"] };

const base = (over: object = {}) => ({
  source: {} as NodeJS.ProcessEnv,
  secrets: {},
  profile: local,
  defaults,
  task,
  trial: 1,
  sessionDir: "S",
  wireLog: "W",
  npmPrefix: path.join(os.tmpdir(), "hfl-npm-test"),
  lab,
  ...over
});

test("the harness inherits an allowlist of the runner's environment, nothing else", () => {
  const env = buildHarnessEnv(
    base({
      source: {
        Path: ["C:\\Windows", "C:\\Program Files\\Git\\bin"].join(path.delimiter),
        SystemRoot: "C:\\Windows",
        TEMP: "C:\\Temp",
        USERPROFILE: "C:\\Users\\me",
        INIT_CWD: "D:\\code\\harness-finetune-lab",
        npm_package_json: "D:\\code\\harness-finetune-lab\\package.json",
        npm_config_local_prefix: "D:\\code\\harness-finetune-lab",
        OPENROUTER_API_KEY: "sk-from-shell",
        ANTHROPIC_API_KEY: "sk-ant",
        GITHUB_TOKEN: "ghp",
        MODEL: "from-shell",
        LLM_TEMPERATURE: "99",
        HTTPS_PROXY: "http://proxy:8080"
      }
    })
  );
  assert.equal(env.SystemRoot, "C:\\Windows", "Windows needs it to start networking");
  assert.equal(env.TEMP, "C:\\Temp");
  assert.equal(env.USERPROFILE, "C:\\Users\\me");
  assert.equal(env.HTTPS_PROXY, "http://proxy:8080");
  for (const leaked of ["INIT_CWD", "npm_package_json", "npm_config_local_prefix", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "GITHUB_TOKEN"]) {
    assert.equal(env[leaked], undefined, `${leaked} must not reach the agent`);
  }
  assert.equal(env.MODEL, undefined, "the shell's MODEL does not select the model");
  assert.equal(env.LLM_TEMPERATURE, "0.6", "the config decides sampling, not the shell");
});

test("the runner's own paths are hidden from the agent's shell, and its npm prefix is a scratch folder", () => {
  const env = buildHarnessEnv(base());
  assert.equal(env.SCRUB_ENV, "SESSION_DIR,WIRE_LOG", "the harness drops these from every command it runs, so `env` does not name the lab's results folder");
  assert.equal(env.npm_config_prefix, path.join(os.tmpdir(), "hfl-npm-test"));
  assert.ok(!String(env.npm_config_prefix).includes("harness-finetune-lab"));
});

test("npm's additions to PATH, which name this repo, are removed", () => {
  const dirty = [`${lab}\\node_modules\\.bin`, "D:\\code\\node_modules\\.bin", "C:\\Users\\me\\AppData\\Roaming\\npm", "C:\\Program Files\\nodejs", "C:\\x\\node-gyp-bin", lab].join(path.delimiter);
  const env = buildHarnessEnv(base({ source: { Path: dirty } }));
  assert.equal(env.Path, ["C:\\Users\\me\\AppData\\Roaming\\npm", "C:\\Program Files\\nodejs"].join(path.delimiter));
});

test("only the key of the backend in use is passed on", () => {
  const secrets = { OPENROUTER_API_KEY: "sk-or", LOCAL_API_KEY: "local" };
  assert.deepEqual([buildHarnessEnv(base({ secrets })).LOCAL_API_KEY, buildHarnessEnv(base({ secrets })).OPENROUTER_API_KEY], ["local", undefined]);
  const r = buildHarnessEnv(base({ secrets, profile: remote }));
  assert.deepEqual([r.OPENROUTER_API_KEY, r.LOCAL_API_KEY], ["sk-or", undefined]);
});

test("a local trial's settings come from the config, with the seed moving per trial", () => {
  const one = buildHarnessEnv(base());
  assert.deepEqual(
    [one.LLM_BACKEND, one.LOCAL_MODEL, one.LOCAL_BASE_URL, one.LOCAL_THINKING, one.LLM_TEMPERATURE, one.LLM_TOP_P, one.LLM_TOP_K, one.LLM_SEED],
    ["local", "qwen3-8b", "http://localhost:1234/v1", "default", "0.6", "0.95", "20", "100"]
  );
  assert.deepEqual([one.CONTEXT_WINDOW, one.MAX_STEPS, one.MAX_OUTPUT_TOKENS, one.MAX_TURN_TOKENS], ["40000", "40", "8192", "100000"]);
  assert.deepEqual([one.SESSION_DIR, one.WIRE_LOG, one.BYPASS_PERMISSIONS, one.STREAM], ["S", "W", "1", "0"]);
  assert.equal(one.LLM_PRESENCE_PENALTY, undefined, "unset stays unset");
  assert.equal(buildHarnessEnv(base({ trial: 3 })).LLM_SEED, "102", "trials of one task must differ");
  assert.equal(buildHarnessEnv(base({ task: { ...task, max_steps: 7 } })).MAX_STEPS, "7");
  assert.equal(buildHarnessEnv(base({ profile: { ...local, thinking: "off" } })).LOCAL_THINKING, "off");
  assert.equal(buildHarnessEnv(base({ extra: { STALL_MS: "1500" } })).STALL_MS, "1500");
});

test("a remote trial pins the provider and sends no local settings", () => {
  const env = buildHarnessEnv(base({ profile: remote }));
  assert.deepEqual([env.LLM_BACKEND, env.MODEL, env.PROVIDER_ONLY, env.LLM_TEMPERATURE], ["remote", "deepseek/x", "deepinfra", "0.3"]);
  assert.equal(env.LOCAL_MODEL, undefined);
  assert.equal(env.LOCAL_THINKING, undefined);
  assert.equal(buildHarnessEnv(base({ profile: { ...remote, provider: undefined } })).PROVIDER_ONLY, undefined);
});

test("settingsMismatch: what the harness says it ran with must be what was asked", () => {
  const asked = expectedSettings(local, defaults, task, 2);
  assert.deepEqual(asked.sampling, trialSampling(local, 2));
  const ran = { backend: "local", model: "qwen3-8b", base_url: "x", sampling: { temperature: 0.6, topP: 0.95, topK: 20, seed: 101 }, thinking: "default", max_output_tokens: 8192, max_turn_tokens: 100000, max_steps: 40, context_window: 40000, provider: null, reasoning_roundtrip: true };
  assert.equal(settingsMismatch(asked, ran), null);
  assert.equal(settingsMismatch(asked, { ...ran, sampling: { ...ran.sampling, seed: 100 } }), "the harness did not apply the requested settings - sampling: asked {\"seed\":101,\"temperature\":0.6,\"topK\":20,\"topP\":0.95}, ran with {\"seed\":100,\"temperature\":0.6,\"topK\":20,\"topP\":0.95}");
  assert.match(settingsMismatch(asked, { ...ran, max_output_tokens: null })!, /max_output_tokens: asked 8192, ran with null/);
  assert.match(settingsMismatch(asked, { ...ran, thinking: "off" })!, /thinking/);
  assert.match(settingsMismatch(asked, undefined)!, /no settings record/);

  const remoteAsked = expectedSettings(remote, defaults, task, 1);
  assert.equal(settingsMismatch(remoteAsked, { ...ran, backend: "remote", model: "deepseek/x", sampling: { temperature: 0.3 }, provider: { only: ["deepinfra"], allowFallbacks: false } }), null);
  assert.match(settingsMismatch(remoteAsked, { ...ran, backend: "remote", model: "deepseek/x", sampling: { temperature: 0.3 }, provider: null })!, /provider/);
});

test("the config: pinned values are required for a publishable run, and nonsense is refused", () => {
  const config = loadConfig();
  assert.equal(config.models["qwen3-8b"].sampling.temperature, 0.6);
  assert.equal(config.models["qwen3-8b"].thinking, "default");
  assert.deepEqual(unpinned(config.models["qwen3-8b"]), []);
  assert.deepEqual(unpinned(config.models["deepseek-v4.1-flash"]), [], "temperature and provider are pinned");
  assert.deepEqual(config.models["deepseek-v4.1-flash"].provider, ["gmicloud"], "not DeepSeek's own endpoint: the account's data policy forbids it");
  assert.deepEqual(config.models["deepseek-v4.1-flash"].sampling, { temperature: 0.6, seed: 20261009 }, "top_k is not sent: the pinned endpoint does not list it");
  const nothink = config.models["qwen3-8b-nothink"];
  assert.equal(nothink.thinking, "off");
  assert.equal(nothink.model, config.models["qwen3-8b"].model, "the same LM Studio model: nothing to reload");
  assert.deepEqual(nothink.sampling, { temperature: 0.7, top_p: 0.8, top_k: 20, seed: 20261009 }, "the model card's non-thinking values");
  assert.deepEqual(unpinned(nothink), []);
  assert.deepEqual(unpinned({ backend: "local", model: "m", sampling: { temperature: 0.6 }, thinking: "default" }), ["sampling.top_p", "sampling.top_k"]);

  const write = (models: unknown) => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hfl-cfg-")), "c.yaml");
    fs.writeFileSync(file, YAML.stringify({ harness: { dir: "h" }, defaults, models }));
    return file;
  };
  assert.throws(() => loadConfig(write({ x: { backend: "remote", model: "m", thinking: "off" } })), /thinking switch is for local models/);
  assert.throws(() => loadConfig(write({ x: { backend: "local", model: "m", provider: ["p"] } })), /provider routing is an OpenRouter setting/);
  assert.throws(() => loadConfig(write({ x: { backend: "local", model: "m", sampling: { temperature: 5 } } })), /temperature/);
  assert.throws(() => loadConfig(write({ x: { backend: "local", model: "m", sampling: { min_p: 0 } } })), /min_p/, "an option LM Studio cannot take is not silently accepted");
});

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hfl-git-"));
  const git = (...args: string[]) => spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: dir, encoding: "utf-8" });
  git("init", "-q");
  fs.writeFileSync(path.join(dir, "a.txt"), "a");
  git("add", "-A");
  git("commit", "-qm", "init");
  return dir;
}

test("the harness counts as dirty with an untracked file, which the old check missed", () => {
  const dir = repo();
  assert.equal(harnessInfo(dir).dirty, false);
  fs.writeFileSync(path.join(dir, "new-module.ts"), "export {}");
  assert.equal(harnessInfo(dir).dirty, true);
});

test("the lab counts as dirty for its runner and tasks, not for results or docs", () => {
  const dir = repo();
  fs.mkdirSync(path.join(dir, "evals", "results"), { recursive: true });
  fs.mkdirSync(path.join(dir, "docs"));
  fs.writeFileSync(path.join(dir, "evals", "results", "r.json"), "{}");
  fs.writeFileSync(path.join(dir, "docs", "note.md"), "x");
  assert.equal(labInfo(dir).dirty, false);
  fs.mkdirSync(path.join(dir, "evals", "tasks", "t"), { recursive: true });
  fs.writeFileSync(path.join(dir, "evals", "tasks", "t", "task.yaml"), "id: t");
  assert.equal(labInfo(dir).dirty, true, "an edited or new task changes what a row measures");
});

test("hashTree: stable, sensitive to any edit, blind to line endings", () => {
  const make = (files: Record<string, string>) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hfl-hash-"));
    for (const [name, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), text);
    }
    return dir;
  };
  const a = hashTree(make({ "task.yaml": "id: t\nprompt: p\n", "hidden/x.mjs": "export {}\n" }));
  assert.equal(a, hashTree(make({ "task.yaml": "id: t\nprompt: p\n", "hidden/x.mjs": "export {}\n" })));
  assert.equal(a, hashTree(make({ "task.yaml": "id: t\r\nprompt: p\r\n", "hidden/x.mjs": "export {}\r\n" })));
  assert.notEqual(a, hashTree(make({ "task.yaml": "id: t\nprompt: q\n", "hidden/x.mjs": "export {}\n" })));
  assert.notEqual(a, hashTree(make({ "task.yaml": "id: t\nprompt: p\n", "hidden/y.mjs": "export {}\n" })), "a renamed file is a change");
});

test("fingerprint: what must match for a resumed run to be the same experiment", () => {
  const conditions = {
    backend: "local", model: "qwen3-8b", sampling: { temperature: 0.6 }, thinking: "default", provider: null,
    max_tokens: 1, max_turn_tokens: 2, max_steps: 3, context_window: 4, tasks: { a: "h" }, runner: "r1", timeout_s: 900
  } as unknown as RunConditions;
  const harness = { commit: "abc", state: "" };
  const f = fingerprint(conditions, harness);
  assert.equal(f, fingerprint({ ...conditions, timeout_s: 60 } as RunConditions, harness), "the safety net may change on resume");
  for (const [what, changed] of Object.entries({
    sampling: { ...conditions, sampling: { temperature: 0.7 } },
    tasks: { ...conditions, tasks: { a: "other" } },
    model: { ...conditions, model: "qwen3-8b-ft" },
    "the runner's own code": { ...conditions, runner: "r2" }
  })) {
    assert.notEqual(f, fingerprint(changed as unknown as RunConditions, harness), what);
  }
  assert.notEqual(f, fingerprint(conditions, { commit: "def", state: "" }), "the harness commit");
  assert.notEqual(f, fingerprint(conditions, { commit: "abc", state: "1f2e3d" }), "uncommitted harness changes are part of the code that ran");
});

test("the harness's uncommitted state is fingerprinted: two different dirty trees are not the same code", () => {
  const dir = repo();
  assert.equal(harnessInfo(dir).state, "");
  fs.writeFileSync(path.join(dir, "a.txt"), "changed");
  const one = harnessInfo(dir).state;
  assert.match(one!, /^[0-9a-f]{16}$/);
  assert.equal(harnessInfo(dir).state, one, "stable");
  fs.writeFileSync(path.join(dir, "a.txt"), "changed differently");
  assert.notEqual(harnessInfo(dir).state, one);
  const two = harnessInfo(dir).state;
  fs.writeFileSync(path.join(dir, "new.ts"), "export {}");
  assert.notEqual(harnessInfo(dir).state, two, "an untracked file counts");
});

test("budgetWarnings: settings that cannot all be true at once", () => {
  const d = { context_window: 32768, timeout_s: 1800, max_steps: 40, max_tokens: 8192, max_turn_tokens: 60000, trials: 3 };
  const served = (n: number) => [{ id: "qwen3-8b", loaded_context_length: n }];
  assert.deepEqual(budgetWarnings(local, d, served(40960)), [], "the shipped config is consistent");

  const slowClock = budgetWarnings(local, { ...d, timeout_s: 900 }, served(40960));
  assert.equal(slowClock.length, 1);
  assert.match(slowClock[0], /timeout_s \(900s\) is shorter than max_turn_tokens \(60000\) at 40 tok\/s \(1500s\).*favours fast models/);

  assert.match(budgetWarnings(local, { ...d, context_window: 40000 }, served(40960))[0], /34000 tokens plus a reply of up to 8192 does not fit the 40960-token context/, "the earlier 40000 / 8192 pair");
  assert.match(budgetWarnings(local, { ...d, context_window: 50000 }, served(40960))[0], /larger than the context the server reports/);
  assert.deepEqual(budgetWarnings(local, d, { error: "HTTP 404" }), [], "no information is not a warning");
  assert.deepEqual(budgetWarnings(remote, d, null), []);
});
