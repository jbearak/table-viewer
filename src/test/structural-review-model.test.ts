import { describe, expect, it } from 'vitest';
import {
    divergence_cell_label,
    divergence_summary_text,
    formula_impact_text,
    short_rows_note,
    structure_counts_text,
} from '../webview/structural-review-model';
import type { ColumnLayout } from '../worksheet-layout';

const swapped: ColumnLayout = {
    columns: [
        { kind: 'source', sourceColumn: 0 },
        { kind: 'source', sourceColumn: 2 },
        { kind: 'source', sourceColumn: 1 },
    ],
    removedSourceColumns: [],
    discardedPendingColumns: [],
};

describe('structure_counts_text', () => {
    it('leaves out zero counts and separates rows from columns', () => {
        expect(structure_counts_text({
            rows: { inserted: 2, deleted: 1, moved: 0 },
            columns: { inserted: 0, deleted: 0, moved: 0, renamed: 1 },
        })).toBe('2 rows inserted, 1 row deleted; 1 column renamed.');
        expect(structure_counts_text({
            rows: { inserted: 0, deleted: 0, moved: 0 },
            columns: { inserted: 0, deleted: 0, moved: 0, renamed: 0 },
        })).toBe('No row or column changes.');
    });
});

describe('divergence text', () => {
    it("follows the spec's summary wording and the flagged axes", () => {
        expect(divergence_summary_text(3, new Set(['row'])))
            .toBe('3 formulas have a range whose first or last row was moved or deleted; check them before saving.');
        expect(divergence_summary_text(1, new Set(['row', 'column'])))
            .toBe('1 formula has a range whose first or last row or column was moved or deleted; check it before saving.');
    });

    it('labels a prospective cell with a quoted sheet name when needed', () => {
        expect(divergence_cell_label('Summary', 3, 1)).toBe('Summary!B4');
        expect(divergence_cell_label("Bob's sheet", 0, 27)).toBe("'Bob''s sheet'!AB1");
    });
});

describe('formula_impact_text', () => {
    it('counts #REF! formulas and formulas pointing at different rows', () => {
        expect(formula_impact_text({ ref: 4, moved: 12 }))
            .toBe('4 formulas will show #REF! and 12 will point at different rows.');
        expect(formula_impact_text({ ref: 1, moved: 0 })).toBe('1 formula will show #REF!.');
        expect(formula_impact_text({ ref: 0, moved: 1 })).toBe('1 formula will point at different rows.');
        expect(formula_impact_text({ ref: 0, moved: 0 })).toBeUndefined();
    });
});

describe('short_rows_note', () => {
    it('notes padding only for a live column change with a shorter record', () => {
        expect(short_rows_note({ columnLayout: swapped }, 2)).toBe('Short rows will be padded to 3 columns.');
        expect(short_rows_note({ columnLayout: swapped }, 3)).toBeUndefined();
        expect(short_rows_note({ columnLayout: swapped }, undefined)).toBeUndefined();
        expect(short_rows_note({ columnLayout: undefined }, 1)).toBeUndefined();
        const unchanged: ColumnLayout = { ...swapped, columns: [0, 1, 2].map((sourceColumn) => ({ kind: 'source' as const, sourceColumn })) };
        expect(short_rows_note({ columnLayout: unchanged }, 1)).toBeUndefined();
    });

    it('pads to the prospective width after a deletion', () => {
        expect(short_rows_note({ columnLayout: { ...swapped, removedSourceColumns: [0] } }, 1))
            .toBe('Short rows will be padded to 2 columns.');
    });
});
