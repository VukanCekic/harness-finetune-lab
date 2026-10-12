import fs from "node:fs";

const FILE = new URL("./todos.json", import.meta.url);
const load = () => JSON.parse(fs.readFileSync(FILE, "utf-8"));

const [command] = process.argv.slice(2);

const args = process.argv.slice(2);
let command = args[0];
let otherArgs = args.slice(1);

if (command === "list") {
  const jsonFlag = otherArgs.includes("--json");
  if (jsonFlag) {
    console.log(JSON.stringify(todos.map(todo => ({
      id: todo.id,
      title: todo.title,
      done: todo.done
    }))));
  } else {
  for (const todo of load()) {
    console.log(`${todo.done ? "[x]" : "[ ]"} ${todo.id}. ${todo.title}`);
  }
} else {
  console.error("usage: node todo.js list");
  process.exit(1);
}
