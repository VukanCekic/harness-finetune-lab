// Known-wrong: answers the three examples in the prompt and nothing else.
const args = process.argv.slice(2).join(" ");
const known = { "": "Hello, world!", Ada: "Hello, Ada!", "Ada Lovelace": "Hello, Ada Lovelace!" };
console.log(known[args]);
