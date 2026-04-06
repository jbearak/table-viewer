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
});
