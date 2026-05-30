import { describe, it, expect } from 'vitest';
import { serialize_csv } from '../serialize-csv';
import type { CellData } from '../types';

function cell(raw: string): CellData {
    return { raw, formatted: raw, bold: false, italic: false };
}

describe('serialize_csv', () => {
    it('serializes simple rows with comma delimiter', () => {
        const rows: (CellData | null)[][] = [
            [cell('a'), cell('b'), cell('c')],
            [cell('1'), cell('2'), cell('3')],
        ];
        expect(serialize_csv(rows, ',')).toBe('a,b,c\n1,2,3\n');
    });

    it('serializes with tab delimiter', () => {
        const rows: (CellData | null)[][] = [
            [cell('a'), cell('b')],
            [cell('1'), cell('2')],
        ];
        expect(serialize_csv(rows, '\t')).toBe('a\tb\n1\t2\n');
    });

    it('quotes fields containing the delimiter', () => {
        const rows: (CellData | null)[][] = [
            [cell('hello, world'), cell('plain')],
        ];
        expect(serialize_csv(rows, ',')).toBe('"hello, world",plain\n');
    });

    it('quotes fields containing newlines', () => {
        const rows: (CellData | null)[][] = [
            [cell('line1\nline2'), cell('ok')],
        ];
        expect(serialize_csv(rows, ',')).toBe('"line1\nline2",ok\n');
    });

    it('escapes double quotes by doubling them', () => {
        const rows: (CellData | null)[][] = [
            [cell('say "hello"'), cell('ok')],
        ];
        expect(serialize_csv(rows, ',')).toBe('"say ""hello""",ok\n');
    });

    it('treats null cells as empty strings', () => {
        const rows: (CellData | null)[][] = [
            [cell('a'), null, cell('c')],
        ];
        expect(serialize_csv(rows, ',')).toBe('a,,c\n');
    });

    it('applies edits map overriding cell values', () => {
        const rows: (CellData | null)[][] = [
            [cell('a'), cell('b')],
            [cell('c'), cell('d')],
        ];
        const edits: Record<string, string> = {
            '0:1': 'B',
            '1:0': 'C',
        };
        expect(serialize_csv(rows, ',', edits)).toBe('a,B\nC,d\n');
    });

    it('applies edits to null cells', () => {
        const rows: (CellData | null)[][] = [
            [null, cell('b')],
        ];
        const edits: Record<string, string> = {
            '0:0': 'filled',
        };
        expect(serialize_csv(rows, ',', edits)).toBe('filled,b\n');
    });

    describe('empty input', () => {
        it('returns an empty string for zero rows and no edits', () => {
            expect(serialize_csv([], ',')).toBe('');
        });

        it('returns an empty string for an empty generator', () => {
            function* none(): Generator<(CellData | null)[]> {}
            expect(serialize_csv(none(), ',')).toBe('');
        });
    });

    describe('edits beyond the source rows (file shrank under a stale edit)', () => {
        it('emits an edit whose row index is past the last source row', () => {
            // One source row (index 0); an edit targets row 2. Rather than
            // silently dropping it (data loss on save), serialize emits the
            // intervening empty row and the edit row.
            const rows: (CellData | null)[][] = [
                [cell('a'), cell('b')],
            ];
            const edits: Record<string, string> = { '2:1': 'X' };
            expect(serialize_csv(rows, ',', edits)).toBe('a,b\n\n,X\n');
        });

        it('emits an edit when the source yields no rows at all', () => {
            const edits: Record<string, string> = { '0:0': 'only' };
            expect(serialize_csv([], ',', edits)).toBe('only\n');
        });

        it('does not append rows when every edit is within the source range', () => {
            const rows: (CellData | null)[][] = [
                [cell('a'), cell('b')],
                [cell('c'), cell('d')],
            ];
            const edits: Record<string, string> = { '1:0': 'C' };
            expect(serialize_csv(rows, ',', edits)).toBe('a,b\nC,d\n');
        });
    });

    describe('windowed (Iterable) serialization', () => {
        // A generator that yields the same rows in fixed-size windows. Proves
        // serialize_csv produces byte-identical output whether fed the whole
        // array at once or row-by-row from windows — the csv-panel save path.
        function* chunked(
            rows: (CellData | null)[][],
            window: number,
        ): Generator<(CellData | null)[]> {
            for (let start = 0; start < rows.length; start += window) {
                const end = Math.min(start + window, rows.length);
                for (let i = start; i < end; i++) yield rows[i];
            }
        }

        it('windowed output equals whole-array output (data, padding, trailing newline)', () => {
            const rows: (CellData | null)[][] = [
                [cell('a'), cell('b'), cell('c')],
                [cell('1')],                       // short row -> padding via originalColumnCounts
                [cell('x'), null, cell('z')],      // null cell
                [cell('m'), cell('n')],
                [cell('say "hi"'), cell('p,q')],   // quoting
            ];
            const originalColumnCounts = [3, 1, 3, 2, 2];
            const edits: Record<string, string> = { '1:2': 'EXT' }; // edit beyond original count
            const whole = serialize_csv(rows, ',', edits, originalColumnCounts, '\r\n');
            const windowed = serialize_csv(chunked(rows, 2), ',', edits, originalColumnCounts, '\r\n');
            expect(windowed).toBe(whole);
        });

        it('applies an edit in a later window at the correct absolute row', () => {
            const rows: (CellData | null)[][] = [
                [cell('a'), cell('b')],
                [cell('c'), cell('d')],
                [cell('e'), cell('f')],
                [cell('g'), cell('h')],
            ];
            // Edit lands in the 3rd window (rows 2 and 3 with window=2 => row 3 col 1).
            const edits: Record<string, string> = { '3:1': 'EDITED' };
            const windowed = serialize_csv(chunked(rows, 2), ',', edits);
            expect(windowed).toBe('a,b\nc,d\ne,f\ng,EDITED\n');
        });
    });
});
