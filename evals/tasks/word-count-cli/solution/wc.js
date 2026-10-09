import fs from "node:fs";

const file = process.argv[2];
let text;
try {
  text = fs.readFileSync(file, "utf-8");
} catch (err) {
  console.error(`wc: ${file}: ${err.code === "ENOENT" ? "no such file" : err.message}`);
  process.exit(1);
}
const lines = (text.match(/\n/g) ?? []).length;
const words = (text.match(/\S+/g) ?? []).length;
const chars = [...text].length;
console.log(JSON.stringify({ lines, words, chars }));
