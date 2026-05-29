import { describe, it, expect } from 'vitest';
import { get_raw_cell_text } from '../cell-display';
import { working_has_formatting, type WorkingSet } from '../data-source/cell-fill';
import type { CellData } from '../types';

function cell(raw: CellData['raw'], formatted: string, bold = false, italic = false): CellData {
    return { raw, formatted, bold, italic };
}

// Build a single-sheet working set from a dense list of cells laid out in one row.
function working(cells: CellData[]): WorkingSet {
    const map = new Map<string, CellData>();
    cells.forEach((c, i) => map.set(`0:${i}`, c));
    return {
        cells: map,
        merged_cells: new Set<string>(),
        row_count: 1,
        col_count: cells.length,
    };
}

describe('get_raw_cell_text', () => {
    it('matches the raw display text for boolean cells', () => {
        expect(get_raw_cell_text(true)).toBe('true');
        expect(get_raw_cell_text(false)).toBe('false');
    });
});

describe('working_has_formatting', () => {
    it('treats uppercase formatted booleans as formatting differences', () => {
        expect(working_has_formatting([working([cell(true, 'TRUE'), cell(false, 'FALSE')])])).toBe(true);
    });

    it('ignores cells whose formatted values already match raw display text', () => {
        expect(working_has_formatting([working([cell(true, 'true'), cell(42, '42')])])).toBe(false);
    });

    it('detects bold cells as having formatting', () => {
        expect(working_has_formatting([working([cell('text', 'text', true, false)])])).toBe(true);
    });

    it('detects italic cells as having formatting', () => {
        expect(working_has_formatting([working([cell('text', 'text', false, true)])])).toBe(true);
    });
});
