import { describe, it, expect } from 'vitest';
import {
    base_validation_save_rejection,
    validate_dirty_bases,
} from '../csv-base-validation';
import type { CellHyperlink, RichText } from '../cell-content';
import type { CsvDirtyEntry, CsvDirtyMap } from '../types';

/** A raw reader over a dense grid of source text, `undefined` past either edge — the
 *  same contract `viewer-controller`'s harvested `observed_bases` map presents. */
function reader(grid: readonly (readonly string[])[]) {
    return (source_row: number, col: number): string | undefined =>
        grid[source_row]?.[col];
}

function edits(entries: Record<string, CsvDirtyEntry>): CsvDirtyMap {
    return entries;
}

const bold = (text: string): RichText => ({ runs: [{ text, style: { bold: true } }] });
const underlined = (text: string): RichText => ({ runs: [{ text, style: { underline: true } }] });

describe('base_validation_save_rejection', () => {
    it('maps base mismatches with the caller worksheet index', () => {
        expect(base_validation_save_rejection({
            type: 'conflicts',
            keys: ['3:1'],
            observedBases: { '3:1': { value: 'disk' } },
        }, 4)).toStrictEqual({
            reason: 'baseMismatch',
            worksheetOperationIndex: 4,
            keys: ['3:1'],
            observedBases: { '3:1': { value: 'disk' } },
        });
    });

    it('omits changed-cell fields for a removed-row-only rejection', () => {
        expect(base_validation_save_rejection({
            type: 'removedRows',
            keys: ['8:0'],
        }, 1)).toStrictEqual({
            reason: 'rowsRemoved',
            worksheetOperationIndex: 1,
            keys: ['8:0'],
        });
    });

    it('preserves removed and changed subsets with the caller worksheet index', () => {
        expect(base_validation_save_rejection({
            type: 'removedRows',
            keys: ['8:0'],
            changedKeys: ['1:0'],
            observedBases: { '1:0': { value: 'changed' } },
        }, 2)).toStrictEqual({
            reason: 'rowsRemoved',
            worksheetOperationIndex: 2,
            keys: ['8:0', '1:0'],
            removedKeys: ['8:0'],
            observedBases: { '1:0': { value: 'changed' } },
        });
    });
});

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
        expect(outcome).toMatchObject({ type: 'conflicts', keys: ['0:1'] });
        expect(outcome).toMatchObject({
            observedBases: { '0:1': { value: 'b' } },
        });
    });

    it('validates a later save against the latest observed file value', () => {
        const pending = edits({
            '0:1': {
                value: 'my pending edit',
                base: 'value when editing began',
                observedBase: { value: 'value now on disk' },
            },
        });

        expect(validate_dirty_bases(
            pending,
            1,
            reader([['a', 'value now on disk']]),
        )).toEqual({ type: 'valid' });

        expect(validate_dirty_bases(
            pending,
            1,
            reader([['a', 'changed again']]),
        )).toMatchObject({
            type: 'conflicts',
            keys: ['0:1'],
            observedBases: { '0:1': { value: 'changed again' } },
        });
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
        expect(claimed_text).toMatchObject({ type: 'conflicts', keys: ['1:1'] });
    });

    it('classifies a row past the source row count as removed, not conflicted', () => {
        const outcome = validate_dirty_bases(
            edits({ '5:0': { value: 'X', base: 'a' } }),
            2,
            reader([['a', 'b'], ['c', 'd']]),
        );
        expect(outcome).toEqual({ type: 'removedRows', keys: ['5:0'] });
    });

    it('reports a removed row and a base mismatch together', () => {
        const outcome = validate_dirty_bases(
            edits({
                '0:0': { value: 'X', base: 'stale' },
                '9:0': { value: 'Y', base: 'a' },
            }),
            2,
            reader([['a', 'b'], ['c', 'd']]),
        );
        expect(outcome).toEqual({
            type: 'removedRows',
            keys: ['9:0'],
            changedKeys: ['0:0'],
            observedBases: { '0:0': { value: 'a' } },
        });
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
        ['a leading-zero alias', '01:0'],
        ['an unsafe integer', '9007199254740993:0'],
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
        expect(outcome).toEqual({
            type: 'removedRows',
            keys: ['a:b'],
            changedKeys: ['0:0'],
            observedBases: { '0:0': { value: 'a' } },
        });
    });
});

describe('validate_dirty_bases formatting', () => {
    /** A rich reader over sparse per-cell runs, undefined = plain. */
    function rich_reader(cells: Record<string, RichText>) {
        return (source_row: number, col: number): RichText | undefined =>
            cells[`${source_row}:${col}`];
    }
    const grid = reader([['a', 'b'], ['c', 'd']]);

    it('conflicts a text-equal base whose source formatting drifted', () => {
        // The finding's exact scenario: the edit was based on bold 'a', an
        // acknowledged refresh changed the cell to underlined 'a'. Text-only
        // validation accepted this and overwrote the newer underline.
        const outcome = validate_dirty_bases(
            edits({ '0:0': { value: 'X', base: 'a', baseRuns: bold('a') } }),
            2,
            grid,
            rich_reader({ '0:0': underlined('a') }),
        );
        expect(outcome).toMatchObject({ type: 'conflicts', keys: ['0:0'] });
        expect(outcome).toMatchObject({
            observedBases: { '0:0': { value: 'a', runs: underlined('a') } },
        });
    });

    it('conflicts a plain-based edit when the source gained formatting, and vice versa', () => {
        const source_gained = validate_dirty_bases(
            edits({ '0:0': { value: 'X', base: 'a', formattingKnown: true } }),
            2,
            grid,
            rich_reader({ '0:0': bold('a') }),
        );
        expect(source_gained).toMatchObject({ type: 'conflicts', keys: ['0:0'] });

        const source_lost = validate_dirty_bases(
            edits({ '0:0': { value: 'X', base: 'a', baseRuns: bold('a') } }),
            2,
            grid,
            rich_reader({}),
        );
        expect(source_lost).toMatchObject({ type: 'conflicts', keys: ['0:0'] });
    });

    it('does not invent a formatting base for an older resolved equal-value draft', () => {
        const outcome = validate_dirty_bases(
            edits({ '0:0': { value: 'a', base: 'a' } }),
            2,
            grid,
            rich_reader({ '0:0': bold('a') }),
        );
        expect(outcome).toEqual({ type: 'valid' });
    });

    it('does not treat same-value formula move metadata as a formatting edit', () => {
        const outcome = validate_dirty_bases(
            edits({
                '0:0': {
                    value: 'a',
                    base: 'a',
                    movedFrom: { row: 1, col: 0, order: 7 },
                    valueEditOrder: 7,
                },
            }),
            2,
            grid,
            rich_reader({ '0:0': bold('a') }),
        );
        expect(outcome).toEqual({ type: 'valid' });
    });

    it('does not invent a formatting base for an older changed-text draft', () => {
        const outcome = validate_dirty_bases(
            edits({ '0:0': { value: 'B', base: 'a' } }),
            2,
            grid,
            rich_reader({ '0:0': bold('a') }),
        );
        expect(outcome).toEqual({ type: 'valid' });
    });

    it('does not treat pending runs as proof that a legacy formatting base was captured', () => {
        const outcome = validate_dirty_bases(
            edits({
                '0:0': {
                    value: 'B',
                    base: 'a',
                    valueRuns: { runs: [{ text: 'B' }] },
                    writeValue: true,
                },
            }),
            2,
            grid,
            rich_reader({ '0:0': bold('a') }),
        );
        expect(outcome).toEqual({ type: 'valid' });
    });

    it('checks formatting after an older draft has acquired an observed side', () => {
        const outcome = validate_dirty_bases(
            edits({
                '0:0': {
                    value: 'B',
                    base: 'a',
                    observedBase: { value: 'c', runs: bold('c') },
                },
            }),
            2,
            reader([['c']]),
            rich_reader({ '0:0': underlined('c') }),
        );
        expect(outcome).toMatchObject({
            type: 'conflicts',
            keys: ['0:0'],
            observedBases: { '0:0': { value: 'c', runs: underlined('c') } },
        });
    });

    it('does not hide formatting drift from an explicit equal-value write', () => {
        const outcome = validate_dirty_bases(
            edits({
                '0:0': {
                    value: 'a',
                    base: 'a',
                    observedBase: { value: 'c' },
                    writeValue: true,
                    formattingKnown: true,
                },
            }),
            2,
            grid,
            rich_reader({ '0:0': bold('a') }),
        );
        expect(outcome).toMatchObject({
            type: 'conflicts',
            keys: ['0:0'],
            observedBases: { '0:0': { value: 'a', runs: bold('a') } },
        });
    });

    it('accepts matching formatting, including a formally-rich but style-free side', () => {
        const equal_rich = validate_dirty_bases(
            edits({ '0:0': { value: 'X', base: 'a', baseRuns: bold('a') } }),
            2,
            grid,
            rich_reader({ '0:0': bold('a') }),
        );
        expect(equal_rich).toEqual({ type: 'valid' });

        // baseRuns present but carrying no styles is semantically plain: it must
        // equal an absent rich side rather than conflict on sparseness alone.
        const plain_runs = validate_dirty_bases(
            edits({ '0:0': { value: 'X', base: 'a', baseRuns: { runs: [{ text: 'a' }] } } }),
            2,
            grid,
            rich_reader({}),
        );
        expect(plain_runs).toEqual({ type: 'valid' });
    });

    it('keeps the text-only contract when no rich reader is supplied', () => {
        const outcome = validate_dirty_bases(
            edits({ '0:0': { value: 'X', base: 'a', baseRuns: bold('a') } }),
            2,
            grid,
        );
        expect(outcome).toEqual({ type: 'valid' });
    });

    it('does not double-report a key that already conflicted on text', () => {
        const outcome = validate_dirty_bases(
            edits({ '0:0': { value: 'X', base: 'stale', baseRuns: bold('stale') } }),
            2,
            grid,
            rich_reader({ '0:0': underlined('a') }),
        );
        expect(outcome).toMatchObject({ type: 'conflicts', keys: ['0:0'] });
    });
});

describe('validate_dirty_bases hyperlinks', () => {
    const grid = reader([['a', 'b'], ['c', 'd']]);
    const site: CellHyperlink = { kind: 'external', target: 'https://site.test/' };
    const other: CellHyperlink = { kind: 'external', target: 'https://other.test/' };

    /** A link reader over a dense record of observed cells: `null` is a real
     *  observation (the cell has no link), `undefined` means unobserved — the
     *  same contract harvest_source_bases' links map presents. */
    function link_reader(cells: Record<string, CellHyperlink | null>) {
        return (source_row: number, col: number): CellHyperlink | null | undefined =>
            cells[`${source_row}:${col}`];
    }

    function link_edits(
        entries: Record<string, { value: string; base: string;
            link?: CellHyperlink | null; baseLink?: CellHyperlink | null }>,
    ): CsvDirtyMap {
        return entries as CsvDirtyMap;
    }

    it('accepts a link edit whose recorded base still matches the source', () => {
        const outcome = validate_dirty_bases(
            link_edits({ '0:0': { value: 'a', base: 'a', link: other, baseLink: site } }),
            2,
            grid,
            undefined,
            link_reader({ '0:0': site }),
        );
        expect(outcome).toEqual({ type: 'valid' });
    });

    it('conflicts when the source link changed under a pending link edit', () => {
        const outcome = validate_dirty_bases(
            link_edits({ '0:0': { value: 'a', base: 'a', link: other, baseLink: site } }),
            2,
            grid,
            undefined,
            link_reader({ '0:0': other }),
        );
        expect(outcome).toMatchObject({ type: 'conflicts', keys: ['0:0'] });
        expect(outcome).toMatchObject({
            observedBases: { '0:0': { value: 'a', link: other } },
        });
    });

    it('conflicts on a link gained or lost under a text-equal base', () => {
        const source_gained = validate_dirty_bases(
            link_edits({ '0:0': { value: 'a', base: 'a', link: site, baseLink: null } }),
            2,
            grid,
            undefined,
            link_reader({ '0:0': other }),
        );
        expect(source_gained).toMatchObject({ type: 'conflicts', keys: ['0:0'] });

        const source_lost = validate_dirty_bases(
            link_edits({ '0:0': { value: 'a', base: 'a', link: null, baseLink: site } }),
            2,
            grid,
            undefined,
            link_reader({ '0:0': null }),
        );
        expect(source_lost).toMatchObject({ type: 'conflicts', keys: ['0:0'] });
    });

    it('fails closed when the cell was never observed', () => {
        // `undefined` is "unobserved", not "no link": accepting it would let a
        // save overwrite whatever link the file actually holds.
        const outcome = validate_dirty_bases(
            link_edits({ '0:0': { value: 'a', base: 'a', link: site, baseLink: null } }),
            2,
            grid,
            undefined,
            link_reader({}),
        );
        expect(outcome).toEqual({
            type: 'conflicts',
            keys: ['0:0'],
            observedBases: {},
        });
    });

    it('ignores the link reader for entries carrying no link dimension', () => {
        const outcome = validate_dirty_bases(
            edits({ '0:0': { value: 'X', base: 'a' } }),
            2,
            grid,
            undefined,
            link_reader({ '0:0': site }),
        );
        expect(outcome).toEqual({ type: 'valid' });
    });

    it('fails closed when the caller supplied no link reader at all', () => {
        // Unlike the rich reader, whose absence means "this source has no
        // formatting", a link-bearing entry with no link observer means the
        // two sides disagree about the format — refuse rather than write it.
        const outcome = validate_dirty_bases(
            link_edits({ '0:0': { value: 'a', base: 'a', link: site, baseLink: null } }),
            2,
            grid,
        );
        expect(outcome).toEqual({
            type: 'conflicts',
            keys: ['0:0'],
            observedBases: {},
        });
    });

    it('does not double-report a key that already conflicted on text', () => {
        const outcome = validate_dirty_bases(
            link_edits({ '0:0': { value: 'X', base: 'stale', link: site, baseLink: null } }),
            2,
            grid,
            undefined,
            link_reader({ '0:0': other }),
        );
        expect(outcome).toMatchObject({ type: 'conflicts', keys: ['0:0'] });
    });
});
