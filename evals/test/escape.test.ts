import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { callEscapes, commandEscapes, contaminated, relationToLab, uniqueEscapes, type Where } from "../src/escape.js";

const tmp = path.resolve("C:/Users/test/AppData/Local/Temp");
const where: Where = {
  workspace: path.join(tmp, "hfl-fix-off-by-one-1-abc123"),
  lab: "D:/code/harness-finetune-lab",
  allow: [path.join(tmp, "hfl-npm-xyz")],
  tmp,
  home: path.resolve("C:/Users/test")
};
const kinds = (command: string) => commandEscapes(command, where).map((e) => e.kind);

test("paths inside the workspace, however they are spelled, are fine", () => {
  assert.deepEqual(kinds("node src/main.js && cat ./data/people.csv"), []);
  assert.deepEqual(kinds(`cat ${where.workspace.replace(/\\/g, "/")}/src/a.js`), []);
  assert.deepEqual(kinds("cat /c/Users/test/AppData/Local/Temp/hfl-fix-off-by-one-1-abc123/src/a.js"), [], "Git Bash's /c/... spelling");
  assert.deepEqual(callEscapes("read_file", { path: "src/range.js" }, where), []);
  assert.deepEqual(callEscapes("grep", { pattern: "x" }, where), [], "no path argument");
});

test("the agent's own scratch folder (its npm prefix) is not an escape", () => {
  assert.deepEqual(kinds("ls /c/Users/test/AppData/Local/Temp/hfl-npm-xyz/lib"), []);
  assert.deepEqual(callEscapes("read_file", { path: path.join(tmp, "hfl-npm-xyz", "x.json") }, where), []);
});

test("the lab repo is a contaminating escape however it is reached", () => {
  assert.deepEqual(kinds("cat D:/code/harness-finetune-lab/evals/tasks/x/solution/a.js"), ["lab"]);
  assert.deepEqual(kinds("cat /d/code/harness-finetune-lab/evals/tasks/x/hidden/t.mjs"), ["lab"], "Git Bash's spelling of the same place");
  assert.deepEqual(kinds("ls D:\\code\\harness-finetune-lab"), ["lab"]);
  assert.deepEqual(kinds("cd D:/code && ls harness-finetune-lab/evals"), ["lab"], "built from pieces, the name still gives it away");
  assert.deepEqual(callEscapes("read_file", { path: "D:/code/harness-finetune-lab/package.json" }, where).map((e) => e.kind), ["lab"]);
  assert.equal(contaminated(commandEscapes("cat D:/code/harness-finetune-lab/x", where)), true);
});

test("a glob or a Windows 8.3 short name does not hide the lab", () => {
  assert.deepEqual(kinds("cat /d/code/harness*/evals/tasks/*/hidden/*"), ["lab"], "no lab name in the command at all");
  assert.deepEqual(kinds("cat D:/code/*/package.json"), ["lab"]);
  assert.deepEqual(kinds("cat D:/code/h?rness-finetune-lab/package.json"), ["lab"]);
  assert.deepEqual(kinds("cat D:/code/HARNES~1/evals/eval.config.yaml"), ["lab"]);
  assert.deepEqual(kinds("cat D:/*/package.json"), ["other"], "that glob reaches D:/code/package.json, not the lab: outside, but not contamination");
  assert.deepEqual(kinds("cat D:/code/other-project/*.js"), ["other"]);
  assert.equal(contaminated(commandEscapes("cat D:/code/other-project/*.js", where)), false);
});

test("relationToLab: inside, above (a recursive command will walk down), or elsewhere", () => {
  const lab = "D:/code/harness-finetune-lab";
  assert.equal(relationToLab("D:/code/harness-finetune-lab/evals", lab), "inside");
  assert.equal(relationToLab("D:/code/harness-finetune-lab", lab), "inside");
  assert.equal(relationToLab("D:/code", lab), "ancestor");
  assert.equal(relationToLab("D:/", lab), "ancestor");
  assert.equal(relationToLab("D:/code/harness*", lab), "inside");
  assert.equal(relationToLab("D:/code/other", lab), "none");
  assert.equal(relationToLab("C:/code/harness-finetune-lab", lab), "none");
});

test("a recursive command over a folder above the lab reads the lab's files: contamination", () => {
  assert.deepEqual(kinds("grep -rn slugify /d/code"), ["scan"], "prints lines from the reference solutions");
  assert.deepEqual(kinds("find /d/code -name '*.mjs' -exec cat {} +"), ["scan"]);
  assert.deepEqual(kinds("grep -rn slugify /d"), ["scan", "scan"], "the root of the drive, found twice: as a scan and as an ancestor");
  assert.deepEqual(kinds("rg slugify D:/code"), ["scan"]);
  assert.deepEqual(kinds("ls /d/code"), [], "naming or listing the parent reveals nothing to read");
  assert.deepEqual(kinds("cd /d/code && ls"), []);
  assert.deepEqual(callEscapes("grep", { pattern: "slugify", path: "D:/code" }, where).map((e) => e.kind), ["scan"], "the grep tool is recursive");
  assert.deepEqual(callEscapes("read_file", { path: "D:/code/notes.txt" }, where).map((e) => e.kind), ["other"], "one file in the parent is only flagged");
});

test("another trial's folder contaminates; the harness's own spill files and other temp files do not", () => {
  assert.deepEqual(kinds("ls /tmp/hfl-slugify-2-zzz"), ["other_trial"]);
  assert.deepEqual(kinds("cat /tmp/customharness-tool-1760000000000-abc123.txt"), [], "the harness points the agent at these itself");
  assert.deepEqual(kinds("cat /tmp/notes.txt"), ["other"]);
  assert.deepEqual(callEscapes("read_file", { path: path.join(tmp, "hfl-slugify-2-zzz", "src", "slugify.js") }, where).map((e) => e.kind), ["other_trial"]);
  assert.equal(contaminated(commandEscapes("ls /tmp/hfl-slugify-2-zzz", where)), true);
  assert.equal(contaminated(commandEscapes("cat /tmp/notes.txt", where)), false, "flagged, but it does not invalidate the trial");
});

test("the shell's own tree and ordinary text are not paths", () => {
  assert.deepEqual(kinds("node -e \"console.log(1/2)\" > /dev/null"), []);
  assert.deepEqual(kinds("/usr/bin/env node src/main.js"), []);
  assert.deepEqual(kinds("echo 'read and/or write' && curl http://localhost:1234/v1/models"), [], "and/or and URLs are not drive paths");
  assert.deepEqual(kinds("npm test -- --reporter=spec"), []);
  assert.deepEqual(kinds("git log --oneline -n 3"), []);
});

test("climbing out with .. is judged by depth, because the shell may have cd'd first", () => {
  assert.deepEqual(kinds("cd src && node ../main.js"), [], "one .. is normal");
  assert.deepEqual(kinds("cat ../../../etc/hosts"), ["other"]);
  assert.deepEqual(callEscapes("read_file", { path: "../other.txt" }, where).map((e) => e.kind), ["other"], "a path argument has a known base: one .. already leaves");
  assert.deepEqual(kinds("cat ../hfl-slugify-2-zzz/src/a.js"), ["other_trial"], "but a sibling trial is caught at any depth");
});

test("a search from the root or the home folder is contamination: it walks over the lab", () => {
  assert.deepEqual(kinds("find / -name '*.mjs'"), ["scan"]);
  assert.deepEqual(kinds("ls ~"), ["scan", "other"]);
  assert.equal(contaminated(commandEscapes("find / -name solution", where)), true);
  assert.deepEqual(kinds("find . -name '*.js'"), []);
  assert.deepEqual(kinds("grep -rn foo src"), []);
});

test("the browser tool can open files and run scripts: both are read", () => {
  const open = (url: string) => callEscapes("browser", { action: "open", url }, where).map((e) => e.kind);
  assert.deepEqual(open("file:///D:/code/harness-finetune-lab/evals/tasks/x/solution/a.js"), ["lab"]);
  assert.deepEqual(open("file:///C:/Users/test/AppData/Local/Temp/hfl-fix-off-by-one-1-abc123/index.html"), []);
  assert.deepEqual(open("http://localhost:3000/"), []);
  const script = (js: string) => callEscapes("browser", { action: "eval", js }, where).map((e) => e.kind);
  assert.deepEqual(script("readFile('D:/code/harness-finetune-lab/package.json')"), ["lab"]);
  assert.deepEqual(script("readFile('D:/code/*/package.json')"), ["lab"], "a glob in a page script");
  assert.deepEqual(script("document.title"), []);
});

test("uniqueEscapes: each place once, the serious ones first", () => {
  const list = uniqueEscapes([
    { kind: "other", tool: "bash", target: "c:/x" },
    { kind: "lab", tool: "bash", target: "d:/lab" },
    { kind: "other", tool: "read_file", target: "c:/x" },
    { kind: "lab", tool: "grep", target: "d:/lab" }
  ]);
  assert.deepEqual(list.map((e) => [e.kind, e.target]), [["lab", "d:/lab"], ["other", "c:/x"]]);
});
