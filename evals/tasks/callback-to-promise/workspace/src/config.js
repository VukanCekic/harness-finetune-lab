import fs from "node:fs";

/** Reads a JSON config file and fills in the defaults. */
export function loadConfig(file, callback) {
  fs.readFile(file, "utf-8", (err, text) => {
    if (err) return callback(err);
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (parseError) {
      return callback(parseError);
    }
    callback(null, { port: 3000, host: "localhost", ...parsed });
  });
}
