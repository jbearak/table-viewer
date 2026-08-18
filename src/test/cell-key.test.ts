import { describe, expect, it } from 'vitest';
import { cell_key, is_canonical_cell_key, parse_cell_key } from '../cell-key';

describe('parse_cell_key', () => {
    it('reads the coordinates a canonical key names', () => {
        expect(parse_cell_key('0:0')).toEqual({ sourceRow: 0, sourceColumn: 0 });
        expect(parse_cell_key('12:340')).toEqual({ sourceRow: 12, sourceColumn: 340 });
    });

    it('refuses every non-canonical spelling of a coordinate', () => {
        // Keys are compared as strings, so a second spelling of one coordinate
        // would be a second cell.
        for (const key of ['00:0', '0:01', '+1:2', '1:+2', '-1:2', '1.0:2', ' 1:2', '1:2 ']) {
            expect(parse_cell_key(key), key).toBeUndefined();
        }
    });

    it('refuses a coordinate that cannot round-trip', () => {
        // The pattern bounds the spelling, not the magnitude.
        expect(parse_cell_key('9007199254740993:0')).toBeUndefined();
    });

    it('refuses anything that is not a string', () => {
        for (const key of [undefined, null, 0, {}, ['1:2']]) {
            expect(parse_cell_key(key)).toBeUndefined();
        }
    });
});

describe('is_canonical_cell_key', () => {
    it('agrees with parse_cell_key', () => {
        for (const key of ['0:0', '00:0', '1:2', '-1:2', 'x', '9007199254740993:0']) {
            expect(is_canonical_cell_key(key), key)
                .toBe(parse_cell_key(key) !== undefined);
        }
    });
});

describe('cell_key', () => {
    it('round-trips through parse_cell_key', () => {
        for (const [row, column] of [[0, 0], [7, 3], [1_000, 42]]) {
            expect(parse_cell_key(cell_key(row, column)))
                .toEqual({ sourceRow: row, sourceColumn: column });
        }
    });

    it('throws on a coordinate no cell can have', () => {
        // A sentinel would let a bad coordinate become a key that addresses some
        // other cell; the caller's bug is upstream and should surface there.
        expect(() => cell_key(-1, 0)).toThrow(RangeError);
        expect(() => cell_key(0, 1.5)).toThrow(RangeError);
        expect(() => cell_key(Number.NaN, 0)).toThrow(RangeError);
    });
});
