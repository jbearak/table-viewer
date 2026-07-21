import { describe, expect, it } from 'vitest';
import {
    domain_max,
    domain_min,
    snap_to_bin,
    value_to_x,
    x_to_value,
} from '../webview/filter-histogram';

const bins = [
    { lo: 0, hi: 10, count: 1 },
    { lo: 10, hi: 20, count: 2 },
    { lo: 20, hi: 30, count: 3 },
];

describe('filter histogram math', () => {
    it('exposes the domain from the outer bin edges', () => {
        expect(domain_min(bins)).toBe(0);
        expect(domain_max(bins)).toBe(30);
    });

    it('maps values to svg x and back within the domain', () => {
        const x = value_to_x(15, 0, 30);
        expect(x_to_value(x, 0, 30)).toBeCloseTo(15);
        expect(value_to_x(0, 0, 0)).toBeGreaterThan(0);
    });

    it('snaps to the nearest bin edge', () => {
        expect(snap_to_bin(9, bins)).toBe(10);
        expect(snap_to_bin(0.1, bins)).toBe(0);
        expect(snap_to_bin(29.9, bins)).toBe(30);
    });
});
