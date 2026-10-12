import fs from "node:fs";

/** Reads a JSON config file and fills in the defaults. */
export async function loadConfig(file) {
  try {
    const data = await fs.promises.readFile(file, 'utf-8');
    const parsed = JSON.parse(data);
    return { ...parsed, port: 3000, host: "localhost" };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { port: 3000, host: "localhost" };
    }
    throw err;
  }
}
