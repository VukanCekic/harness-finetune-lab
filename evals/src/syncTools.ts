/**
 * Snapshot the harness's tool schemas into tool-schemas.json, so the validity
 * scorer checks calls against exactly what the model was offered. Re-run it
 * whenever the harness's tools change: npm run eval:sync-tools
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, TOOL_SCHEMAS_FILE } from "./config.js";
import { harnessInfo } from "./harness.js";
import type { ToolSchemas } from "./score.js";

const config = loadConfig();
const harness = harnessInfo(config.harness.dir);
const registry = await import(pathToFileURL(path.join(harness.dir, "src", "tools", "index.ts")).href);

// Main-agent tools, pipeline tools and every subagent role's tools: one flat list.
const all: any[] = [
  ...registry.registeredTools,
  ...registry.PIPELINE_TOOLS,
  ...(registry.SUBAGENT_TOOLS ?? []),
  ...Object.values(registry.ROLE_TOOLS ?? {}).flat()
];
const tools: Record<string, any> = {};
for (const tool of all) {
  if (tool?.schema?.function?.name) tools[tool.schema.function.name] = tool.schema.function.parameters ?? {};
}
const aliases: Record<string, string> = {};
for (const [name, tool] of Object.entries<any>(registry.TOOLS_BY_NAME)) {
  const canonical = tool?.schema?.function?.name;
  if (canonical && canonical !== name) aliases[name] = canonical;
}

const snapshot: ToolSchemas = { harness_commit: harness.commit, tools, aliases };
fs.writeFileSync(TOOL_SCHEMAS_FILE, `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(`${Object.keys(tools).length} tools from harness ${harness.commit}${harness.dirty ? " (dirty)" : ""} -> ${path.relative(process.cwd(), TOOL_SCHEMAS_FILE)}`);
console.log(Object.keys(tools).sort().join(", "));
process.exit(0); // the harness's modules may leave handles open
