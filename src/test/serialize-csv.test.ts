import { describe, it, expect } from 'vitest';
import { prepare_csv_serializer, serialize_csv } from '../serialize-csv';
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
        it('does not append rows for an edit past the last source row', () => {
            // One source row (index 0); an edit targets row 2. Padding out to it
            // is the thing we must never do: under source-keyed edits that gap can
            // be ~90,000 rows, and because build_line_index counts a field per LF
            // the blank filler re-parses as real rows, so a 10-row file reopens
            // 90,001 rows long. write_file is a raw fs write (there is no
            // WorkspaceEdit anywhere in src/), so nothing is on the undo stack.
            // Such a save is rejected upstream by validate_dirty_bases'
            // `removedRows` outcome and never reaches here; dropping is only the
            // safe residual for a caller that skipped validation.
            const rows: (CellData | null)[][] = [
                [cell('a'), cell('b')],
            ];
            const edits: Record<string, string> = { '2:1': 'X' };
            expect(serialize_csv(rows, ',', edits)).toBe('a,b\n');
        });

        it('emits nothing when the source yields no rows at all', () => {
            // Same policy at the degenerate end: an edit with no source row to
            // land on does not conjure one, so an empty sheet stays empty output.
            const edits: Record<string, string> = { '0:0': 'only' };
            expect(serialize_csv([], ',', edits)).toBe('');
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
        // array at once or row-by-row from windows — the CSV save path.
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

    describe('prepared window serializer', () => {
        it('uses absolute row offsets across independent calls', () => {
            const edits = {
                '0:0': 'FIRST',
                '10000:0': 'LAST',
                '10000:2': 'EXTENDED',
            };
            const serializer = prepare_csv_serializer({
                delimiter: ',',
                edits,
                lineEnding: '\r\n',
                headerLine: 'Header',
            });

            const first = serializer.serialize_rows([[cell('a')]], 0);
            const last = serializer.serialize_rows([[cell('z')]], 10_000);

            expect(serializer.headerPrefix + first + last)
                .toBe('Header\r\nFIRST\r\nLAST,,EXTENDED\r\n');
        });

        it('keeps no header distinct from a blank physical header', () => {
            expect(prepare_csv_serializer({ delimiter: ',' }).headerPrefix).toBe('');
            expect(prepare_csv_serializer({
                delimiter: ',',
                lineEnding: '\r',
                headerLine: '',
            }).headerPrefix).toBe('\r');
        });

        it('concatenates prepared windows to the compatibility output', () => {
            const rows: (CellData | null)[][] = [
                [cell('café'), cell('plain')],
                [cell('say "hello"'), cell('line 1\nline 2')],
                [cell('😀')],
            ];
            const edits = { '2:2': 'tail, value' };
            const originalColumnCounts = [2, 2, 1];
            const serializer = prepare_csv_serializer({
                delimiter: ',',
                edits,
                originalColumnCounts,
                headerLine: 'Name,Value',
            });
            const prepared = serializer.headerPrefix
                + serializer.serialize_rows(rows.slice(0, 2), 0)
                + serializer.serialize_rows(rows.slice(2), 2);

            expect(prepared).toBe(serialize_csv(
                rows,
                ',',
                edits,
                originalColumnCounts,
                '\n',
                'Name,Value',
            ));
        });
    });

    describe('header_line', () => {
        it('re-prepends a verbatim header line ahead of the data rows', () => {
            const rows: (CellData | null)[][] = [[cell('1'), cell('2')]];
            expect(serialize_csv(rows, ',', undefined, undefined, '\n', 'a,b'))
                .toBe('a,b\n1,2\n');
        });

        it('emits a header-only file when there are no data rows', () => {
            expect(serialize_csv([], ',', undefined, undefined, '\n', 'a,b'))
                .toBe('a,b\n');
        });

        it('uses the given line ending between the header and the body', () => {
            const rows: (CellData | null)[][] = [[cell('1')]];
            expect(serialize_csv(rows, ',', undefined, undefined, '\r\n', 'h'))
                .toBe('h\r\n1\r\n');
        });

        it('preserves an empty header line ("" is a real header row, not "no header")', () => {
            // A source whose first row is blank yields headerLine === '' (distinct
            // from undefined = no header consumed). Dropping it would delete the
            // file's real empty first row, so it must be re-emitted verbatim.
            const rows: (CellData | null)[][] = [[cell('a')]];
            expect(serialize_csv(rows, ',', undefined, undefined, '\n', ''))
                .toBe('\na\n');
        });
    });
});
