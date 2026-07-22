import { describe, expect, it } from 'vitest';
import type { SheetMeta, WorkbookMeta } from '../data-source/interface';
import {
    MAX_HIGHLIGHTED_CELLS_PER_FILE,
    apply_cell_highlight_patch,
    cell_highlight_key,
    cell_highlight_states_equal,
    count_cell_highlights,
    migrate_cell_highlight_schema,
    parse_cell_highlight_key,
    rebase_cell_highlight_digest,
    reconcile_physical_cell_highlights,
    sanitize_cell_highlight_color,
    sanitize_cell_highlight_state,
    sanitize_sheet_cell_highlights,
} from '../cell-highlights';
import {
    CELL_HIGHLIGHT_COLORS,
    transform_schema_for_sheet,
    type CellHighlightState,
} from '../types';

function sheet(overrides: Partial<SheetMeta> = {}): SheetMeta {
    return {
        name: 'People',
        rowCount: 3,
        sourceRowCount: 3,
        columnCount: 3,
        merges: [],
        hasFormatting: false,
        columnNames: ['Name', 'Age', 'City'],
        ...overrides,
    };
}

function meta(sheet_meta: SheetMeta = sheet()): WorkbookMeta {
    return { sheets: [sheet_meta], hasFormatting: false };
}

function state(
    cells: Record<string, unknown>,
    sheet_meta: SheetMeta = sheet(),
    digest = 'digest-1',
): unknown {
    return {
        sourceDigest: digest,
        sheets: [{
            schema: transform_schema_for_sheet(sheet_meta),
            cells,
        }],
    };
}

describe('cell highlight domain', () => {
    it('accepts only the four semantic colors', () => {
        expect(CELL_HIGHLIGHT_COLORS.map(sanitize_cell_highlight_color))
            .toEqual(CELL_HIGHLIGHT_COLORS);
        expect(sanitize_cell_highlight_color('orange')).toBeUndefined();
        expect(sanitize_cell_highlight_color(null)).toBeUndefined();
    });

    it('round-trips canonical safe-integer keys and rejects aliases', () => {
        expect(cell_highlight_key(12, 4)).toBe('12:4');
        expect(parse_cell_highlight_key('12:4')).toEqual({
            sourceRow: 12,
            sourceColumn: 4,
        });
        for (const key of ['01:2', '1:02', '-1:2', '1.5:2', '1:2:3', '1e2:3']) {
            expect(parse_cell_highlight_key(key)).toBeUndefined();
        }
        expect(parse_cell_highlight_key(`${Number.MAX_SAFE_INTEGER + 1}:0`))
            .toBeUndefined();
        expect(() => cell_highlight_key(-1, 0)).toThrow(RangeError);
    });

    it('sanitizes schema, bounds, colors, and deterministic key order', () => {
        const sheet_meta = sheet();
        const sanitized = sanitize_sheet_cell_highlights({
            schema: transform_schema_for_sheet(sheet_meta),
            cells: {
                '2:1': 'pink',
                '0:2': 'blue',
                '0:0': 'yellow',
                '3:0': 'green',
                '0:3': 'green',
                bad: 'yellow',
                '1:1': 'orange',
            },
        }, sheet_meta, transform_schema_for_sheet(sheet_meta));

        expect(sanitized).toEqual({
            schema: transform_schema_for_sheet(sheet_meta),
            cells: {
                '0:0': 'yellow',
                '0:2': 'blue',
                '2:1': 'pink',
            },
        });
        expect(Object.keys(sanitized!.cells)).toEqual(['0:0', '0:2', '2:1']);
        expect(sanitize_sheet_cell_highlights(
            { schema: 'stale', cells: { '0:0': 'yellow' } },
            sheet_meta,
            transform_schema_for_sheet(sheet_meta),
        )).toBeUndefined();
    });

    it('uses canonical sourceRowCount rather than projected rowCount', () => {
        const projected = sheet({ rowCount: 2, sourceRowCount: 3 });
        expect(sanitize_cell_highlight_state(
            state({ '2:0': 'green', '3:0': 'blue' }, projected),
            meta(projected),
            'digest-1',
        )).toEqual({
            sourceDigest: 'digest-1',
            sheets: [{
                schema: transform_schema_for_sheet(projected),
                cells: { '2:0': 'green' },
            }],
        });
    });

    it('rejects stale digests and collapses empty sheets and workbooks', () => {
        expect(sanitize_cell_highlight_state(
            state({ '0:0': 'yellow' }),
            meta(),
            'digest-2',
        )).toBeUndefined();
        expect(sanitize_cell_highlight_state(
            state({ '9:9': 'yellow' }),
            meta(),
            'digest-1',
        )).toBeUndefined();
    });

    it('accepts null-prototype records but rejects inherited-property containers', () => {
        const sheet_meta = sheet();
        const cells = Object.create(null) as Record<string, unknown>;
        cells['0:0'] = 'yellow';
        expect(sanitize_cell_highlight_state(
            state(cells, sheet_meta),
            meta(sheet_meta),
            'digest-1',
        )).toBeDefined();

        const inherited_cells = Object.create({ '0:0': 'yellow' }) as Record<string, unknown>;
        expect(sanitize_cell_highlight_state(
            state(inherited_cells, sheet_meta),
            meta(sheet_meta),
            'digest-1',
        )).toBeUndefined();
    });

    it('applies sparse set/clear patches without mutating the current state', () => {
        const sheet_meta = sheet();
        const current = sanitize_cell_highlight_state(
            state({ '0:0': 'yellow', '1:1': 'green' }, sheet_meta),
            meta(sheet_meta),
            'digest-1',
        );
        const next = apply_cell_highlight_patch(current, {
            sheetIndex: 0,
            cells: {
                '0:0': 'blue',
                '1:1': null,
                '2:2': 'pink',
            },
        }, meta(sheet_meta), 'digest-1');

        expect(next?.sheets[0]?.cells).toEqual({
            '0:0': 'blue',
            '2:2': 'pink',
        });
        expect(current?.sheets[0]?.cells).toEqual({
            '0:0': 'yellow',
            '1:1': 'green',
        });
        expect(count_cell_highlights(next)).toBe(2);
    });

    it('rejects an over-limit result atomically', () => {
        const large_sheet = sheet({
            rowCount: MAX_HIGHLIGHTED_CELLS_PER_FILE + 1,
            sourceRowCount: MAX_HIGHLIGHTED_CELLS_PER_FILE + 1,
            columnCount: 1,
            columnNames: ['Value'],
        });
        const cells: Record<string, 'yellow'> = {};
        for (let row = 0; row < MAX_HIGHLIGHTED_CELLS_PER_FILE; row++) {
            cells[`${row}:0`] = 'yellow';
        }
        const current: CellHighlightState = {
            sourceDigest: 'digest-1',
            sheets: [{
                schema: transform_schema_for_sheet(large_sheet),
                cells,
            }],
        };

        expect(() => apply_cell_highlight_patch(current, {
            sheetIndex: 0,
            cells: { [`${MAX_HIGHLIGHTED_CELLS_PER_FILE}:0`]: 'blue' },
        }, meta(large_sheet), 'digest-1')).toThrow(RangeError);
        expect(count_cell_highlights(current)).toBe(MAX_HIGHLIGHTED_CELLS_PER_FILE);

        cells[`${MAX_HIGHLIGHTED_CELLS_PER_FILE}:0`] = 'yellow';
        expect(sanitize_cell_highlight_state(
            current,
            meta(large_sheet),
            'digest-1',
        )).toBeUndefined();
    });

    it('stops sanitizing later sheets as soon as the file cap is exceeded', () => {
        const large_sheet = sheet({
            name: 'Large',
            rowCount: MAX_HIGHLIGHTED_CELLS_PER_FILE + 1,
            sourceRowCount: MAX_HIGHLIGHTED_CELLS_PER_FILE + 1,
            columnCount: 1,
            columnNames: ['Value'],
        });
        const later_sheet = sheet({ name: 'Later' });
        const cells: Record<string, 'yellow'> = {};
        for (let row = 0; row <= MAX_HIGHLIGHTED_CELLS_PER_FILE; row++) {
            cells[`${row}:0`] = 'yellow';
        }
        const stored_sheets: unknown[] = [{
            schema: transform_schema_for_sheet(large_sheet),
            cells,
        }];
        Object.defineProperty(stored_sheets, 1, {
            get: () => { throw new Error('later sheet should not be read'); },
        });

        expect(sanitize_cell_highlight_state({
            sourceDigest: 'digest-1',
            sheets: stored_sheets,
        }, {
            sheets: [large_sheet, later_sheet],
            hasFormatting: false,
        }, 'digest-1')).toBeUndefined();
    });

    it('rejects patch sheet indices outside the workbook', () => {
        expect(() => apply_cell_highlight_patch(undefined, {
            sheetIndex: 1,
            cells: { '0:0': 'yellow' },
        }, meta(), 'digest-1')).toThrow(RangeError);
    });

    it('rebases digests and migrates only compatible sheet schemas', () => {
        const old_sheet = sheet({ columnNames: ['A', 'B', 'C'] });
        const new_sheet = sheet({
            rowCount: 2,
            sourceRowCount: 2,
            columnNames: ['Name', 'Age', 'City'],
        });
        const current = sanitize_cell_highlight_state(
            state({ '0:0': 'yellow', '2:0': 'green' }, old_sheet),
            meta(old_sheet),
            'digest-1',
        );
        const migrated = migrate_cell_highlight_schema(
            current,
            0,
            old_sheet,
            new_sheet,
        );
        expect(migrated).toEqual({
            sourceDigest: 'digest-1',
            sheets: [{
                schema: transform_schema_for_sheet(new_sheet),
                cells: { '0:0': 'yellow' },
            }],
        });
        expect(rebase_cell_highlight_digest(
            migrated,
            'digest-2',
            meta(new_sheet),
        )?.sourceDigest).toBe('digest-2');
        expect(migrate_cell_highlight_schema(
            current,
            0,
            old_sheet,
            { ...new_sheet, name: 'Renamed' },
        )).toBe(current);
    });

    it('sanitizes same-digest physical refreshes, clears external changes, and rebases controlled saves', () => {
        const current = sanitize_cell_highlight_state(
            state({ '0:0': 'yellow', '9:0': 'green' }),
            meta(sheet({ sourceRowCount: 10, rowCount: 10 })),
            'digest-1',
        );
        expect(reconcile_physical_cell_highlights(
            current,
            meta(),
            'digest-1',
        )?.sheets[0]?.cells).toEqual({ '0:0': 'yellow' });
        expect(reconcile_physical_cell_highlights(
            current,
            meta(),
            'external-digest',
        )).toBeUndefined();
        expect(reconcile_physical_cell_highlights(
            current,
            meta(),
            'saved-digest',
            'digest-1',
        )).toMatchObject({
            sourceDigest: 'saved-digest',
            sheets: [{ cells: { '0:0': 'yellow' } }],
        });
    });

    it('compares semantically equal states independent of record insertion order', () => {
        const left = sanitize_cell_highlight_state(
            state({ '0:0': 'yellow', '1:1': 'green' }),
            meta(),
            'digest-1',
        );
        const right = sanitize_cell_highlight_state(
            state({ '1:1': 'green', '0:0': 'yellow' }),
            meta(),
            'digest-1',
        );
        expect(cell_highlight_states_equal(left, right)).toBe(true);
        expect(cell_highlight_states_equal(left, undefined)).toBe(false);
    });
});
