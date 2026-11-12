import { describe, expect, it } from 'vitest';
import {
    find_matcher,
    is_find_hotkey,
    scan_for_match,
    type FindChunk,
    type FindScanInput,
} from '../webview/find-model';

/** A grid of text, chunked every `chunk_rows` rows, recording loads. */
function grid(rows: string[][], overrides: Partial<FindScanInput> = {}) {
    const loads: FindChunk[] = [];
    const released: FindChunk[] = [];
    const chunk_rows = 2;
    const input: FindScanInput = {
        start: undefined,
        direction: 1,
        inclusive: true,
        row_count: rows.length,
        column_count: rows[0]?.length ?? 0,
        matches: find_matcher('x')!,
        plan_chunk: (row, direction) => direction === 1
            ? { start: row, end: row + chunk_rows - 1 }
            : { start: row - chunk_rows + 1, end: row },
        load_chunk: async (chunk) => {
            loads.push(chunk);
            return () => released.push(chunk);
        },
        text_at: ({ row, column }) => rows[row]![column]!,
        is_stale: () => false,
        yield_to_ui: async () => {},
        ...overrides,
    };
    return { input, loads, released };
}

describe('find_matcher', () => {
    it('matches a case-insensitive substring', () => {
        const matches = find_matcher('ROn')!;
        expect(matches('Toronto')).toBe(true);
        expect(matches('Paris')).toBe(false);
    });

    it('matches nothing for an empty query, and never an empty cell', () => {
        expect(find_matcher('')).toBeUndefined();
        expect(find_matcher(' ')!('')).toBe(false);
        expect(find_matcher(' ')!('a b')).toBe(true);
    });
});

describe('scan_for_match', () => {
    const rows = [
        ['a', 'x1', 'b'],
        ['c', 'd', 'x2'],
        ['x3', 'e', 'f'],
    ];

    it('walks row-major from the start, inclusive when typing', async () => {
        const { input } = grid(rows, { start: { row: 0, column: 1 } });
        expect(await scan_for_match(input)).toEqual({
            kind: 'match',
            position: { row: 0, column: 1 },
        });
    });

    it('starts one cell past the active cell for Enter', async () => {
        const { input } = grid(rows, { start: { row: 0, column: 1 }, inclusive: false });
        expect(await scan_for_match(input)).toEqual({
            kind: 'match',
            position: { row: 1, column: 2 },
        });
    });

    it('wraps forward past the end', async () => {
        const { input } = grid(rows, { start: { row: 2, column: 0 }, inclusive: false });
        expect(await scan_for_match(input)).toEqual({
            kind: 'match',
            position: { row: 0, column: 1 },
        });
    });

    it('walks backward and wraps past the start', async () => {
        const { input } = grid(rows, {
            start: { row: 1, column: 2 },
            inclusive: false,
            direction: -1,
        });
        expect(await scan_for_match(input)).toEqual({
            kind: 'match',
            position: { row: 0, column: 1 },
        });
        const wrap = grid(rows, { start: { row: 0, column: 1 }, inclusive: false, direction: -1 });
        expect(await scan_for_match(wrap.input)).toEqual({
            kind: 'match',
            position: { row: 2, column: 0 },
        });
    });

    it('finds the only match when it is the start cell after a full lap', async () => {
        const only = [['a', 'x'], ['b', 'c']];
        const { input } = grid(only, { start: { row: 0, column: 1 }, inclusive: false });
        expect(await scan_for_match(input)).toEqual({
            kind: 'match',
            position: { row: 0, column: 1 },
        });
    });

    it('starts at the top-left with no active cell or one outside the grid', async () => {
        for (const start of [undefined, { row: 9, column: 0 }]) {
            const { input } = grid(rows, { start, inclusive: false });
            expect(await scan_for_match(input)).toEqual({
                kind: 'match',
                position: { row: 0, column: 1 },
            });
        }
    });

    it('reports none after reading every cell, loading each chunk once and releasing it', async () => {
        const { input, loads, released } = grid(rows, { matches: find_matcher('zzz')! });
        expect(await scan_for_match(input)).toEqual({ kind: 'none' });
        expect(loads).toEqual([{ start: 0, end: 1 }, { start: 2, end: 2 }]);
        expect(released).toEqual(loads);
    });

    it('reports none on an empty grid without loading', async () => {
        const { input, loads } = grid([], { column_count: 3 });
        expect(await scan_for_match(input)).toEqual({ kind: 'none' });
        expect(loads).toEqual([]);
    });

    it('stops without a verdict when a chunk fails to load', async () => {
        const { input } = grid(rows, {
            matches: find_matcher('zzz')!,
            load_chunk: async (chunk) => chunk.start === 0 ? () => {} : false,
        });
        expect(await scan_for_match(input)).toEqual({ kind: 'stopped' });
    });

    it('stops at the next await once stale, loading no further chunk', async () => {
        let stale = false;
        const { input, loads, released } = grid(rows, {
            matches: find_matcher('zzz')!,
            yield_every: 1,
            yield_to_ui: async () => {
                stale = true;
            },
            is_stale: () => stale,
        });
        expect(await scan_for_match(input)).toEqual({ kind: 'stopped' });
        expect(loads).toEqual([{ start: 0, end: 1 }]);
        expect(released).toEqual(loads);
    });

    it('keeps walking when the planner returns a chunk without the row', async () => {
        const { input } = grid(rows, { plan_chunk: () => ({ start: 0, end: 0 }) });
        expect(await scan_for_match(input)).toEqual({
            kind: 'match',
            position: { row: 0, column: 1 },
        });
        const later = grid(rows, {
            plan_chunk: () => ({ start: 0, end: 0 }),
            matches: find_matcher('x3')!,
        });
        expect(await scan_for_match(later.input)).toEqual({
            kind: 'match',
            position: { row: 2, column: 0 },
        });
    });
});

describe('is_find_hotkey', () => {
    const key = (overrides: Partial<Parameters<typeof is_find_hotkey>[0]>) => ({
        key: 'f',
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        ...overrides,
    });

    it('accepts Cmd+F and Ctrl+F', () => {
        expect(is_find_hotkey(key({ metaKey: true }))).toBe(true);
        expect(is_find_hotkey(key({ ctrlKey: true, key: 'F' }))).toBe(true);
    });

    it('rejects other chords', () => {
        expect(is_find_hotkey(key({}))).toBe(false);
        expect(is_find_hotkey(key({ metaKey: true, ctrlKey: true }))).toBe(false);
        expect(is_find_hotkey(key({ metaKey: true, altKey: true }))).toBe(false);
        expect(is_find_hotkey(key({ metaKey: true, shiftKey: true }))).toBe(false);
        expect(is_find_hotkey(key({ metaKey: true, key: 'g' }))).toBe(false);
    });
});
