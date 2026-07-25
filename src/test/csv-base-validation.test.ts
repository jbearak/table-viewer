import { describe, it, expect } from 'vitest';
import { validate_dirty_bases } from '../csv-base-validation';
import type { CsvDirtyMap } from '../types';

/** A raw reader over a dense grid of source text, `undefined` past either edge — the
 *  same contract `viewer-controller`'s harvested `observed_bases` map presents. */
function reader(grid: readonly (readonly string[])[]) {
    return (source_row: number, col: number): string | undefined =>
        grid[source_row]?.[col];
}

function edits(entries: Record<string, { value: string; base: string }>): CsvDirtyMap {
    return entries;
}

describe('validate_dirty_bases', () => {
    it('accepts a map whose every base matches the source', () => {
        const outcome = validate_dirty_bases(
            edits({
                '0:0': { value: 'X', base: 'a' },
                '1:1': { value: 'Y', base: 'd' },
            }),
            2,
            reader([['a', 'b'], ['c', 'd']]),
        );
        expect(outcome).toEqual({ type: 'valid' });
    });

    it('reports exactly the keys whose base drifted, and no others', () => {
        const outcome = validate_dirty_bases(
            edits({
                '0:0': { value: 'X', base: 'a' },
                '0:1': { value: 'Y', base: 'stale' },
                '1:0': { value: 'Z', base: 'c' },
            }),
            2,
            reader([['a', 'b'], ['c', 'd']]),
        );
        expect(outcome).toEqual({ type: 'conflicts', keys: ['0:1'] });
    });

    it('treats an unreadable cell as empty, so filling a blank trailing cell is valid', () => {
        // Row 1 is short: column 1 does not exist, so the reader returns undefined.
        // An edit that *filled* that blank was made against '' and must validate.
        const filled_blank = validate_dirty_bases(
            edits({ '1:1': { value: 'new', base: '' } }),
            2,
            reader([['a', 'b'], ['c']]),
        );
        expect(filled_blank).toEqual({ type: 'valid' });

        // The same cell with a non-empty base is a genuine mismatch: the edit
        // claimed text that the file does not have.
        const claimed_text = validate_dirty_bases(
            edits({ '1:1': { value: 'new', base: 'was-here' } }),
            2,
            reader([['a', 'b'], ['c']]),
        );
        expect(claimed_text).toEqual({ type: 'conflicts', keys: ['1:1'] });
    });

    it('classifies a row past the source row count as removed, not conflicted', () => {
        const outcome = validate_dirty_bases(
            edits({ '5:0': { value: 'X', base: 'a' } }),
            2,
            reader([['a', 'b'], ['c', 'd']]),
        );
        expect(outcome).toEqual({ type: 'removedRows', keys: ['5:0'] });
    });

    it('lets a removed row outrank a base mismatch', () => {
        const outcome = validate_dirty_bases(
            edits({
                '0:0': { value: 'X', base: 'stale' },
                '9:0': { value: 'Y', base: 'a' },
            }),
            2,
            reader([['a', 'b'], ['c', 'd']]),
        );
        expect(outcome).toEqual({ type: 'removedRows', keys: ['9:0'] });
    });

    it('accepts an empty map', () => {
        expect(validate_dirty_bases({}, 0, reader([]))).toEqual({ type: 'valid' });
    });
});
