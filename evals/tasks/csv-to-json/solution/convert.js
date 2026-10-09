import fs from "node:fs";

function parseLine(line) {
  const fields = [];
  let field = "";
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) {
      fields.push(field);
      field = "";
    } else field += ch;
  }
  fields.push(field);
  return fields;
}

const [header, ...rows] = fs
  .readFileSync("data/people.csv", "utf-8")
  .split(/\r?\n/)
  .filter((line) => line.trim());
const keys = parseLine(header);
const people = rows.map((row) => {
  const values = parseLine(row);
  const person = Object.fromEntries(keys.map((key, i) => [key, values[i]]));
  person.age = Number(person.age);
  return person;
});
fs.writeFileSync("data/people.json", JSON.stringify(people, null, 2));
