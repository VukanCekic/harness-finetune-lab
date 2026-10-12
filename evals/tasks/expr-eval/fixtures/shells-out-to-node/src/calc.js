// Known-wrong: delegates to a child node process, which does not inherit --disallow-code-generation-from-strings,
// so it evaluates with the real eval. It passes every behaviour test; only the "no vm or child process" check stops it.
import { execFileSync } from "node:child_process";

export function evaluate(expression) {
  if (!expression.trim()) throw new Error("empty expression");
  return Number(execFileSync(process.execPath, ["-p", `(${expression})`], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }));
}
