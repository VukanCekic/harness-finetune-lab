import fs from "node:fs/promises";

/** Reads a JSON config file and fills in the defaults. */
export async function loadConfig(file) {
  const parsed = JSON.parse(await fs.readFile(file, "utf-8"));
  return { port: 3000, host: "localhost", ...parsed };
}
