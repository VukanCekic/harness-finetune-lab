/**
 * The price of one cart line in cents, after a percentage discount (0-100),
 * with the discount rounded to the nearest cent.
 */
export function linePrice(unitCents, qty, discountPercent = 0) {
  const gross = unitCents * qty;
  return gross - Math.round((gross * discountPercent) / 10);
}
