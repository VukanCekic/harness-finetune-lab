// Recursive descent: expression = term (("+" | "-") term)*, term = factor (("*" | "/") factor)*,
// factor = number | "(" expression ")" | "-" factor.

function tokenize(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i++;
    } else if ("+-*/()".includes(ch)) {
      tokens.push(ch);
      i++;
    } else {
      const match = /^(\d+(\.\d+)?|\.\d+)/.exec(text.slice(i));
      if (!match) throw new Error(`unexpected character "${ch}"`);
      tokens.push(Number(match[0]));
      i += match[0].length;
    }
  }
  if (tokens.length === 0) throw new Error("empty expression");
  return tokens;
}

export function evaluate(expression) {
  const tokens = tokenize(expression);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function sum() {
    let value = product();
    while (peek() === "+" || peek() === "-") {
      const op = next();
      const right = product();
      value = op === "+" ? value + right : value - right;
    }
    return value;
  }

  function product() {
    let value = factor();
    while (peek() === "*" || peek() === "/") {
      const op = next();
      const right = factor();
      value = op === "*" ? value * right : value / right;
    }
    return value;
  }

  function factor() {
    const token = next();
    if (token === "-") return -factor();
    if (token === "(") {
      const value = sum();
      if (next() !== ")") throw new Error('expected ")"');
      return value;
    }
    if (typeof token === "number") return token;
    throw new Error(`unexpected ${token === undefined ? "end of input" : `"${token}"`}`);
  }

  const value = sum();
  if (pos < tokens.length) throw new Error(`unexpected "${tokens[pos]}"`);
  return value;
}
