/**
 * Uncertainty for pass rates. The independent units are the TASKS: the trials
 * of one task share its difficulty, so treating all trials as independent
 * (Wilson on 4/11, or on 12/33) understates the error. Per Miller, "Adding
 * Error Bars to Evals" (arXiv 2411.00640): average within each task, then take
 * the standard error across tasks; compare two models on the same tasks with a
 * paired per-task difference.
 */

/** Two-sided 95% t quantiles by degrees of freedom. */
const T975 = [
  NaN, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074,
  2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042
];

/**
 * Beyond the table, the quantile of the nearest tabulated df at or below: the t
 * quantile falls as df grows, so this is never narrower than the truth.
 */
export function t975(df: number): number {
  if (df < 1) return NaN;
  if (df < T975.length) return T975[df];
  if (df < 40) return 2.042; // t(30)
  if (df < 60) return 2.021; // t(40)
  if (df < 120) return 2.0; // t(60)
  if (df < 1000) return 1.98; // t(120)
  return 1.96;
}

export interface Interval {
  mean: number;
  low: number;
  high: number;
  /** Number of independent units (tasks). */
  n: number;
}

/**
 * Mean of per-task values with a 95% t-interval across tasks. With fewer than
 * two tasks there is no spread to estimate, so the bounds are NaN. A pass rate
 * cannot leave [0, 1] (a difference, [-1, 1]), so the interval is clipped to
 * `bounds`; with few tasks the t-interval is wide, and honestly so.
 */
export function clusteredCI(values: number[], bounds: [number, number] = [0, 1]): Interval {
  const n = values.length;
  if (n === 0) return { mean: NaN, low: NaN, high: NaN, n };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { mean, low: NaN, high: NaN, n };
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1);
  if (variance === 0) return { ...zeroSpread(mean, n, bounds), mean, n };
  const half = (t975(n - 1) * Math.sqrt(variance)) / Math.sqrt(n);
  return { mean, low: Math.max(bounds[0], mean - half), high: Math.min(bounds[1], mean + half), n };
}

/**
 * Every task came out the same (all passed, all failed, or all equal), so the
 * sample has no spread and a t-interval collapses to a point - which would
 * claim certainty from n tasks. It is the opposite of certain: n tasks that all
 * pass are also what a task set with a pass rate somewhere above ~70% usually
 * gives. So here the tasks are treated as n yes/no draws:
 *   - all at one end of the range: the exact (Clopper-Pearson) 95% bound, 0.025^(1/n) from the far end;
 *   - all equal somewhere in the middle: the Wilson interval.
 * With several trials per task this is only an approximation, and a cautious one.
 */
function zeroSpread(mean: number, n: number, [lo, hi]: [number, number]): { low: number; high: number } {
  const u = (mean - lo) / (hi - lo); // position within the range, 0..1
  const z = 1.96;
  let low: number;
  let high: number;
  if (u >= 1) [low, high] = [0.025 ** (1 / n), 1];
  else if (u <= 0) [low, high] = [0, 1 - 0.025 ** (1 / n)];
  else {
    const centre = (u + (z * z) / (2 * n)) / (1 + (z * z) / n);
    const half = (z * Math.sqrt((u * (1 - u)) / n + (z * z) / (4 * n * n))) / (1 + (z * z) / n);
    [low, high] = [centre - half, centre + half];
  }
  return { low: lo + (hi - lo) * low, high: lo + (hi - lo) * high };
}

/** Per-task pass rates of two runs, matched by task id, and the interval of their difference (b - a). */
export function pairedDifference(a: Record<string, number>, b: Record<string, number>): Interval & { shared: string[] } {
  const shared = Object.keys(a).filter((id) => id in b).sort();
  return { ...clusteredCI(shared.map((id) => b[id] - a[id]), [-1, 1]), shared };
}

/** "36.4% [6.4, 66.4]", or just the mean when no interval can be formed. */
export function formatInterval(interval: Interval, signed = false): string {
  const pct = (v: number) => `${signed && v > 0 ? "+" : ""}${(v * 100).toFixed(1)}`;
  if (Number.isNaN(interval.mean)) return "-";
  const point = `${pct(interval.mean)}%`;
  return Number.isNaN(interval.low) ? point : `${point} [${pct(interval.low)}, ${pct(interval.high)}]`;
}
