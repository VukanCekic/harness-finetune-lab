import { loadConfig } from "./src/config.js";

loadConfig("config.json", (err, config) => {
  if (err) {
    console.error(err.message);
    process.exit(1);
  }
  console.log(`listening on ${config.host}:${config.port}`);
});
