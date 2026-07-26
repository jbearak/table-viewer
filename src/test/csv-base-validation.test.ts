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

    // Fail closed on a key that is not a pair of non-negative integers. Without the
    // explicit guard the arithmetic absorbs the garbage instead of rejecting it:
    // Number('') is 0 but Number('a') and a missing half are NaN, `NaN >= count` is
    // false, and `read_raw(NaN, col) ?? ''` then compares '' to the base.
    it.each([
        ['an empty key', ''],
        ['a non-numeric pair', 'a:b'],
        ['a negative row', '-1:0'],
        ['a negative column', '0:-1'],
        ['a fractional row', '1.5:0'],
    ])('rejects %s as a removed row', (_label, key) => {
        const outcome = validate_dirty_bases(
            edits({ [key]: { value: 'X', base: 'a' } }),
            2,
            reader([['a', 'b'], ['c', 'd']]),
        );
        expect(outcome).toEqual({ type: 'removedRows', keys: [key] });
    });

    it('rejects a key with no column even when its row is in range', () => {
        // '4' parses to source_row 4 and col NaN. Deliberately given a file long
        // enough to hold row 4, so the removed-row bound below cannot be what
        // catches it — otherwise this case would pass with no guard at all.
        const outcome = validate_dirty_bases(
            edits({ '4': { value: 'X', base: 'a' } }),
            8,
            reader(Array.from({ length: 8 }, () => ['a', 'b'])),
        );
        expect(outcome).toEqual({ type: 'removedRows', keys: ['4'] });
    });

    it('rejects a malformed key whose base is empty rather than validating it', () => {
        // The dangerous shape, and the reason membership in the removed list is not
        // enough on its own: '' is exactly what `read_raw(NaN, …) ?? ''` produces, so
        // an unguarded reader finds the base "matching" and hands the key to the
        // serializer as a fully valid edit.
        const outcome = validate_dirty_bases(
            edits({ 'a:b': { value: 'X', base: '' } }),
            2,
            reader([['a', 'b'], ['c', 'd']]),
        );
        expect(outcome).toEqual({ type: 'removedRows', keys: ['a:b'] });
    });

    it('rejects a malformed key alongside well-formed ones without losing either verdict', () => {
        const outcome = validate_dirty_bases(
            edits({
                '0:0': { value: 'X', base: 'stale' },
                'a:b': { value: 'Y', base: '' },
            }),
            2,
            reader([['a', 'b'], ['c', 'd']]),
        );
        // removedRows outranks the mismatch, so the malformed key cannot be masked.
        expect(outcome).toEqual({ type: 'removedRows', keys: ['a:b'] });
    });
});
