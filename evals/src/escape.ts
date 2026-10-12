/**
 * Did the agent reach outside its workspace? The harness has no sandbox on
 * Windows and every permission is approved, so a trial can read the reference
 * solutions and hidden tests that sit on the same disk, or another trial's
 * folder. This reads the tool calls (every agent's) and flags paths that point
 * out of the workspace. It is a static check on what the model wrote: a path
 * built at run time inside a script is invisible to it, and a command it cannot
 * parse is not flagged. A flagged trial is not trusted; a clean one is only
 * "nothing found".
 */
import os from "node:os";
import path from "node:path";

export type EscapeKind =
  /** Under the lab repo: reference solutions, hidden tests, earlier results. Contaminates the trial. */
  | "lab"
  /** Another trial's folder (hfl-* in the temp dir). Contaminates the trial. */
  | "other_trial"
  /** A recursive search over the lab's parent, a drive root or the home folder: it prints the lab's files too. Contaminates the trial. */
  | "scan"
  /** The harness's own source, the user's home, anything else outside. Flagged only. */
  | "other";

export interface Escape {
  kind: EscapeKind;
  tool: string;
  /** What was reached: the path as resolved, or the command fragment for a scan. */
  target: string;
}

export const CONTAMINATING: EscapeKind[] = ["lab", "other_trial", "scan"];
export const contaminated = (escapes: Escape[]): boolean => escapes.some((e) => CONTAMINATING.includes(e.kind));

export interface Where {
  workspace: string;
  /** The lab repo's root. */
  lab: string;
  /** The agent's own scratch folders (e.g. its npm prefix): not an escape. */
  allow?: string[];
  /** Overridable for tests. */
  tmp?: string;
  home?: string;
}

/** Tool arguments that are paths, by tool. `grep` searches recursively; the others read one file or list names. */
const PATH_ARGS: Record<string, string[]> = {
  read_file: ["path"],
  write_file: ["path"],
  str_replace: ["path"],
  string_replace: ["path"],
  grep: ["path"],
  glob: ["path"]
};

const norm = (p: string) => path.resolve(p).replace(/\\/g, "/").toLowerCase();
const inside = (child: string, parent: string) => {
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(`${p}/`);
};

const segments = (p: string): string[] => norm(p).split("/").filter(Boolean);

/** One path segment against one of the lab's: equal, matched by a glob (`harness*`), or a Windows 8.3 short name (`HARNES~1`). */
function segmentMatches(pattern: string, actual: string): boolean {
  if (pattern === actual) return true;
  const short = /^(.{1,6})~\d+(\.\w+)?$/.exec(pattern);
  if (short) return actual.replace(/[^a-z0-9]/g, "").startsWith(short[1].replace(/[^a-z0-9]/g, ""));
  if (/[*?]/.test(pattern)) {
    const source = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    return new RegExp(`^${source}$`).test(actual);
  }
  return false;
}

/**
 * Where a (possibly globbed or 8.3-abbreviated) absolute path sits relative to
 * the lab: inside it, above it (an ancestor, which a recursive command will
 * walk down into the lab from), or elsewhere.
 */
export function relationToLab(resolved: string, lab: string): "inside" | "ancestor" | "none" {
  const t = segments(resolved);
  const l = segments(lab);
  const n = Math.min(t.length, l.length);
  for (let i = 0; i < n; i++) if (!segmentMatches(t[i], l[i])) return "none";
  return t.length >= l.length ? "inside" : "ancestor";
}

/**
 * Git Bash spells C:\x as /c/x and the temp dir as /tmp; anything else under /
 * (/usr, /dev/null, /etc) is the shell's own tree, not the user's files.
 */
function resolveFrom(raw: string, where: Where): string | null {
  const tmp = where.tmp ?? os.tmpdir();
  const home = where.home ?? os.homedir();
  const p = raw.trim().replace(/^["']|["']$/g, "");
  if (!p) return null;
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) return path.join(home, p.slice(1));
  const msys = /^\/([a-zA-Z])(?:\/(.*))?$/.exec(p);
  if (msys) return `${msys[1].toUpperCase()}:/${msys[2] ?? ""}`;
  if (p === "/tmp" || p.startsWith("/tmp/")) return path.join(tmp, p.slice(4));
  if (p.startsWith("/")) return null;
  return path.resolve(where.workspace, p); // relative, or a Windows drive path
}

type Reach = EscapeKind | "ancestor" | null;

function reach(resolved: string, where: Where): Reach {
  const tmp = where.tmp ?? os.tmpdir();
  if (inside(resolved, where.workspace)) return null;
  if ((where.allow ?? []).some((root) => inside(resolved, root))) return null;
  const lab = relationToLab(resolved, where.lab);
  if (lab === "inside") return "lab";
  if (lab === "ancestor") return "ancestor";
  if (inside(resolved, tmp)) {
    const first = path.relative(tmp, resolved).split(/[\\/]/)[0];
    if (first.startsWith("hfl-")) return "other_trial";
    if (first.startsWith("customharness-tool-")) return null; // the harness's own file of spilled long output
  }
  return "other";
}

// Looking through everything: find / , ls ~ , grep -r x C:\ ...
const SCAN = /\b(?:find|ls|dir|tree|grep|rg|du)\b[^|;&\n]*?\s(?:\/[a-zA-Z]?|~|[A-Za-z]:[\\/]?)(?=\s|$)/;
// A command that walks directories or prints many files at once.
const RECURSIVE = /\b(?:find|rg|tree|du)\b|\bgrep\b[^|;&\n]*\s-\S*[rR]|\bgrep\b[^|;&\n]*--recursive|\bls\b[^|;&\n]*\s-\S*R|\bdir\b[^|;&\n]*\s\/s\b/i;

/** Pieces of a command line that may be paths. Quoting is not interpreted, so a path with a space is split. */
const tokens = (command: string): string[] => command.split(/[\s"'`|;&<>()=,]+/).filter(Boolean);

/** Tokens that are paths leaving the workspace's own relative tree: a drive path, /c/..., /tmp/..., ~/..., or one with a .. segment. */
const PATHISH = [/^[A-Za-z]:[\\/]/, /^\/[a-zA-Z](?:\/|$)/, /^\/tmp(?:\/|$)/, /^~(?:[\\/]|$)/, /(?:^|[\\/])\.\.(?:[\\/]|$)/];
const ABSOLUTE = /^(?:[A-Za-z]:|[\\/]|~)/;
const climbs = (token: string): number => (token.match(/(?:^|[\\/])\.\.(?=[\\/]|$)/g) ?? []).length;

export function commandEscapes(command: string, where: Where, tool = "bash"): Escape[] {
  const out: Escape[] = [];
  const recursive = RECURSIVE.test(command);
  const scan = SCAN.exec(command);
  if (scan) out.push({ kind: "scan", tool, target: scan[0].trim().slice(0, 120) });
  for (const token of tokens(command)) {
    if (!PATHISH.some((re) => re.test(token))) continue;
    const resolved = resolveFrom(token, where);
    if (!resolved) continue;
    let kind = reach(resolved, where);
    // The lab's parent is harmless to name or list, but a recursive command from there prints the lab's files.
    if (kind === "ancestor") kind = recursive ? "scan" : null;
    // The shell may have cd'd into a subfolder first, so a single `..` proves nothing; two are out of any normal project.
    if (kind === "other" && !ABSOLUTE.test(token) && climbs(token) < 2) continue;
    if (kind) out.push({ kind, tool, target: resolved.replace(/\\/g, "/") });
  }
  // The lab's name in a command is a giveaway even when the path is built from pieces.
  if (/harness-finetune-lab/i.test(command) && !out.some((e) => e.kind === "lab")) out.push({ kind: "lab", tool, target: "harness-finetune-lab" });
  return out;
}

/** A file: URL, as the browser tool would open it, as a path. */
function fileUrlPath(url: string): string | null {
  const m = /^file:\/\/\/?(.*)$/i.exec(url.trim());
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

export function callEscapes(tool: string, args: any, where: Where): Escape[] {
  if (tool === "bash") return commandEscapes(String(args?.command ?? ""), where, tool);
  const out: Escape[] = [];
  if (tool === "browser") {
    // It can open file:// URLs and run page scripts; read both like a command.
    const file = typeof args?.url === "string" ? fileUrlPath(args.url) : null;
    if (file) out.push(...commandEscapes(file.replace(/\s/g, "_"), where, tool));
    for (const key of ["js", "command", "text"]) if (typeof args?.[key] === "string") out.push(...commandEscapes(args[key], where, tool));
    return out;
  }
  for (const key of PATH_ARGS[tool] ?? []) {
    const value = args?.[key];
    if (typeof value !== "string" || !value) continue;
    const resolved = resolveFrom(value, where);
    let kind = resolved ? reach(resolved, where) : null;
    // The grep tool searches recursively: from the lab's parent it reads the lab's files.
    if (kind === "ancestor") kind = tool === "grep" ? "scan" : null;
    if (kind) out.push({ kind, tool, target: (resolved as string).replace(/\\/g, "/") });
  }
  return out;
}

/** Each distinct (kind, target) once, contaminating kinds first. */
export function uniqueEscapes(escapes: Escape[]): Escape[] {
  const seen = new Set<string>();
  const out = escapes.filter((e) => !seen.has(`${e.kind}|${e.target}`) && seen.add(`${e.kind}|${e.target}`));
  return out.sort((a, b) => Number(CONTAMINATING.includes(b.kind)) - Number(CONTAMINATING.includes(a.kind)));
}
