import { linePrice } from "./pricing.js";
import { formatCents } from "./format.js";

/**
 * The formatted total of a cart. Each line is
 * { unitCents, qty, discountPercent? } with discountPercent from 0 to 100.
 */
export function cartTotal(lines) {
  const cents = lines.reduce((sum, line) => sum + linePrice(line.unitCents, line.qty, line.discountPercent), 0);
  return formatCents(cents);
}
