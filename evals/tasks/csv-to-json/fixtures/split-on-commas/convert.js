// Known-wrong: splits on every comma, so a quoted field that contains one is torn in two.
import fs from "node:fs";

const [header, ...rows] = fs.readFileSync("data/people.csv", "utf-8").trim().split("\n");
const keys = header.split(",");
const people = rows.map((row) => {
  const cells = row.split(",").map((c) => c.replace(/^"|"$/g, ""));
  return Object.fromEntries(keys.map((key, i) => [key, key === "age" ? Number(cells[i]) : cells[i]]));
});
fs.writeFileSync("data/people.json", JSON.stringify(people, null, 2));
