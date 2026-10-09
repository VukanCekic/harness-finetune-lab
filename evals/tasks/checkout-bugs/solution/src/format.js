/** Cents as euros: 1999 -> "€19.99", 5 -> "€0.05", 120000 -> "€1200.00". */
export function formatCents(cents) {
  const euros = Math.floor(cents / 100);
  const rest = String(cents % 100).padStart(2, "0");
  return `€${euros}.${rest}`;
}
