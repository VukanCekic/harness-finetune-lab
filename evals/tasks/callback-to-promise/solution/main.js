import { loadConfig } from "./src/config.js";

try {
  const config = await loadConfig("config.json");
  console.log(`listening on ${config.host}:${config.port}`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
