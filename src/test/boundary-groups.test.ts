// @vitest-environment jsdom

import { describe, it, expect } from 'vitest';
import { build_boundary_groups } from '../webview/boundary-groups';
import type { MergeRange } from '../types';

describe('build_boundary_groups', () => {
    it('returns all rows for each boundary in a simple 3x3 table', () => {
        const { col_boundary_groups, row_boundary_groups } =
            build_boundary_groups(3, 3, []);

        expect(col_boundary_groups.get(0)).toEqual(new Set([0, 1, 2]));
        expect(col_boundary_groups.get(1)).toEqual(new Set([0, 1, 2]));
        expect(col_boundary_groups.get(2)).toEqual(new Set([0, 1, 2]));

        expect(row_boundary_groups.get(0)).toEqual(new Set([0, 1, 2]));
        expect(row_boundary_groups.get(1)).toEqual(new Set([0, 1, 2]));
        expect(row_boundary_groups.get(2)).toEqual(new Set([0, 1, 2]));
    });

    it('excludes interior colspan boundaries', () => {
        const merges: MergeRange[] = [
            { startRow: 1, startCol: 0, endRow: 1, endCol: 1 },
        ];
        const { col_boundary_groups } =
            build_boundary_groups(3, 3, merges);

        expect(col_boundary_groups.get(0)).toEqual(new Set([0, 2]));
        expect(col_boundary_groups.get(1)).toEqual(new Set([0, 1, 2]));
        expect(col_boundary_groups.get(2)).toEqual(new Set([0, 1, 2]));
    });

    it('excludes interior rowspan boundaries', () => {
        const merges: MergeRange[] = [
            { startRow: 0, startCol: 1, endRow: 1, endCol: 1 },
        ];
        const { row_boundary_groups } =
            build_boundary_groups(3, 3, merges);

        expect(row_boundary_groups.get(0)).toEqual(new Set([0, 2]));
        expect(row_boundary_groups.get(1)).toEqual(new Set([0, 1, 2]));
    });

    it('handles a cell with both colspan and rowspan', () => {
        const merges: MergeRange[] = [
            { startRow: 0, startCol: 0, endRow: 1, endCol: 1 },
        ];
        const { col_boundary_groups, row_boundary_groups } =
            build_boundary_groups(3, 3, merges);

        expect(col_boundary_groups.get(0)).toEqual(new Set([2]));
        expect(col_boundary_groups.get(1)).toEqual(new Set([0, 1, 2]));

        expect(row_boundary_groups.get(0)).toEqual(new Set([2]));
        expect(row_boundary_groups.get(1)).toEqual(new Set([0, 1, 2]));
    });

    it('handles fully merged row (one cell spans all columns)', () => {
        const merges: MergeRange[] = [
            { startRow: 0, startCol: 0, endRow: 0, endCol: 2 },
        ];
        const { col_boundary_groups } =
            build_boundary_groups(2, 3, merges);

        expect(col_boundary_groups.get(0)).toEqual(new Set([1]));
        expect(col_boundary_groups.get(1)).toEqual(new Set([1]));
        expect(col_boundary_groups.get(2)).toEqual(new Set([0, 1]));
    });

    it('returns maps with the single cell right and bottom boundaries', () => {
        const { col_boundary_groups, row_boundary_groups } =
            build_boundary_groups(1, 1, []);

        expect(col_boundary_groups.get(0)).toEqual(new Set([0]));
        expect(row_boundary_groups.get(0)).toEqual(new Set([0]));
    });
});
