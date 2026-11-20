import {describe, expect, it} from '@jest/globals';
import {errorRate, quantile, summarizeLatencies} from '../src/loadtest-metrics.js';

describe('load-test metrics', () => {
  it('calculates deterministic percentile summaries without mutating input', () => {
    const values = [30, 10, 20, 40];
    expect(quantile(values, 0.5)).toBe(20);
    expect(quantile(values, 0.95)).toBe(40);
    expect(summarizeLatencies(values)).toMatchObject({count: 4, p50Ms: 20, p95Ms: 40, p99Ms: 40, minMs: 10, maxMs: 40});
    expect(values).toEqual([30, 10, 20, 40]);
  });

  it('fails closed for an empty sample and reports error rate', () => {
    expect(summarizeLatencies([])).toMatchObject({count: 0, p50Ms: null, p95Ms: null, p99Ms: null});
    expect(errorRate(1, 4)).toBe(0.25);
    expect(errorRate(0, 0)).toBe(1);
  });
});
