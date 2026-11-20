export interface LatencySummary {
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  minMs: number | null;
  maxMs: number | null;
}

export function quantile(values: number[], percentile: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(percentile * sorted.length) - 1);
  return sorted[index];
}

export function summarizeLatencies(values: number[]): LatencySummary {
  return {
    count: values.length,
    p50Ms: quantile(values, 0.5),
    p95Ms: quantile(values, 0.95),
    p99Ms: quantile(values, 0.99),
    minMs: values.length ? Math.min(...values) : null,
    maxMs: values.length ? Math.max(...values) : null,
  };
}

export function errorRate(errors: number, attempted: number): number {
  return attempted === 0 ? 1 : errors / attempted;
}
