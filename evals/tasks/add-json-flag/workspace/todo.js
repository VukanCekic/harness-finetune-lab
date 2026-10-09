import fs from "node:fs";

const FILE = new URL("./todos.json", import.meta.url);
const load = () => JSON.parse(fs.readFileSync(FILE, "utf-8"));

const [command] = process.argv.slice(2);

if (command === "list") {
  for (const todo of load()) {
    console.log(`${todo.done ? "[x]" : "[ ]"} ${todo.id}. ${todo.title}`);
  }
} else {
  console.error("usage: node todo.js list");
  process.exit(1);
}
