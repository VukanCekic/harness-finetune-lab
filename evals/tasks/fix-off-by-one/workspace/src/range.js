/**
 * The integers from `start` to `end`, both inclusive, counting up by `step`.
 * range(1, 3) -> [1, 2, 3]; range(0, 10, 5) -> [0, 5, 10]; range(3, 1) -> []
 */
export function range(start, end, step = 1) {
  if (step <= 0) throw new RangeError("step must be positive");
  const out = [];
  for (let i = start; i < end; i += step) out.push(i);
  return out;
}
