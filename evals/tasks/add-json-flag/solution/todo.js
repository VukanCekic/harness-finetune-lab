import fs from "node:fs";

const FILE = new URL("./todos.json", import.meta.url);
const load = () => JSON.parse(fs.readFileSync(FILE, "utf-8"));

const [command, ...flags] = process.argv.slice(2);

if (command === "list") {
  const todos = load();
  if (flags.includes("--json")) {
    console.log(JSON.stringify(todos.map(({ id, title, done }) => ({ id, title, done }))));
  } else {
    for (const todo of todos) {
      console.log(`${todo.done ? "[x]" : "[ ]"} ${todo.id}. ${todo.title}`);
    }
  }
} else {
  console.error("usage: node todo.js list");
  process.exit(1);
}
