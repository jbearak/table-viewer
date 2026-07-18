import { describe, expect, it } from 'vitest';
import { transform_schema_for_sheet } from '../types';
import {
    create_column_projection,
    hide_all_columns,
    sanitize_column_visibility_state,
    show_all_columns,
    toggle_source_column,
} from '../webview/column-projection';

const SHEET = {
    name: 'Data',
    rowCount: 2,
    columnCount: 5,
    columnNames: ['A', 'B', 'C', 'D', 'E'],
    merges: [],
    hasFormatting: false,
};
const SCHEMA = transform_schema_for_sheet(SHEET);

describe('column projection helpers', () => {
    it('uses identity mappings when no columns are hidden', () => {
        expect(create_column_projection(4)).toEqual({
            visible_to_source: [0, 1, 2, 3],
            source_to_visible: [0, 1, 2, 3],
        });
        expect(sanitize_column_visibility_state({
            hiddenColumns: [],
            schema: SCHEMA,
        }, 4, SCHEMA)).toBeUndefined();
    });

    it('maps noncontiguous visible columns in both directions', () => {
        const projection = create_column_projection(5, {
            hiddenColumns: [1, 3],
            schema: SCHEMA,
        }, SCHEMA);

        expect(projection.visible_to_source).toEqual([0, 2, 4]);
        expect(projection.source_to_visible).toEqual([
            0,
            undefined,
            1,
            undefined,
            2,
        ]);
        for (const [visible_column, source_column] of projection.visible_to_source.entries()) {
            expect(projection.source_to_visible[source_column]).toBe(visible_column);
        }
    });

    it('keeps an all-hidden projection valid', () => {
        const state = hide_all_columns(3, SCHEMA);

        expect(state).toEqual({
            hiddenColumns: [0, 1, 2],
            schema: SCHEMA,
        });
        expect(create_column_projection(3, state, SCHEMA)).toEqual({
            visible_to_source: [],
            source_to_visible: [undefined, undefined, undefined],
        });
    });

    it('sorts and deduplicates valid columns while dropping malformed entries', () => {
        expect(sanitize_column_visibility_state({
            hiddenColumns: [3, 1, 1, -1, 2.5, 4, Number.NaN, '2', 0],
            schema: SCHEMA,
        }, 4, SCHEMA)).toEqual({
            hiddenColumns: [0, 1, 3],
            schema: SCHEMA,
        });
        expect(sanitize_column_visibility_state(Object.create({
            hiddenColumns: [1],
            schema: SCHEMA,
        }), 4, SCHEMA)).toBeUndefined();
    });

    it('drops stale state when the sheet schema changes', () => {
        const stale_state = {
            hiddenColumns: [1],
            schema: transform_schema_for_sheet({
                ...SHEET,
                columnNames: ['Old A', 'Old B', 'Old C', 'Old D', 'Old E'],
            }),
        };

        expect(sanitize_column_visibility_state(
            stale_state,
            SHEET.columnCount,
            SCHEMA,
        )).toBeUndefined();
        expect(create_column_projection(
            SHEET.columnCount,
            stale_state,
            SCHEMA,
        ).visible_to_source).toEqual([0, 1, 2, 3, 4]);
    });

    it('toggles source columns and normalizes show-all to no descriptor', () => {
        const hidden = toggle_source_column(undefined, 2, 4, SCHEMA);
        expect(hidden).toEqual({
            hiddenColumns: [2],
            schema: SCHEMA,
        });

        expect(toggle_source_column(hidden, 1, 4)).toEqual({
            hiddenColumns: [1, 2],
            schema: SCHEMA,
        });
        expect(toggle_source_column(hidden, 2, 4, SCHEMA)).toBeUndefined();
        expect(show_all_columns()).toBeUndefined();
    });
});
