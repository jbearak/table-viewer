import { describe, expect, it } from 'vitest';
import {
    dialog_state,
    path_error,
    path_state,
} from '../shared/compare-dialog-model';
import type { ComparePathCheck } from '../shared/ipc';

const check = (partial: Partial<ComparePathCheck> = {}): ComparePathCheck => ({
    exists: true,
    supported: true,
    extension: 'xlsx',
    ...partial,
});

const ok = (path: string, extension = 'xlsx') =>
    path_state(path, check({ extension }));

describe('path_state', () => {
    it('treats blank input as empty rather than missing', () => {
        expect(path_state('   ', check())).toEqual({ kind: 'empty' });
    });

    it('reports an unchecked path as empty, so a field cannot error before its check lands', () => {
        expect(path_state('/tmp/a.xlsx', undefined)).toEqual({ kind: 'empty' });
    });

    it('distinguishes missing from unsupported', () => {
        expect(path_state('/tmp/a.xlsx', check({ exists: false })).kind).toBe('missing');
        expect(path_state('/tmp/a.pdf', check({ supported: false })).kind).toBe('unsupported');
    });

    it('reports the path as typed, so a padded filename survives', () => {
        // Trimming here rewrote legal filenames: ' leading.csv' is a real file
        // whose name starts with a space, and the dialog would check and open
        // 'leading.csv' instead. Whitespace still only decides emptiness.
        expect(path_state('  /tmp/a.xlsx  ', check())).toMatchObject({ path: '  /tmp/a.xlsx  ' });
        expect(path_state('   ', check())).toEqual({ kind: 'empty' });
    });
});

describe('path_state, unfinished paths', () => {
    it('does not call a folder a missing file', () => {
        // Typing `~/repos` names somewhere the user is going, not a file that
        // is not there.
        expect(path_state('/Users/jmb/repos', check({ exists: false, isDirectory: true })))
            .toEqual({ kind: 'incomplete', path: '/Users/jmb/repos' });
    });

    it('does not call a completable prefix a missing file', () => {
        expect(path_state('/path/to/me', check({
            exists: false,
            completion: '/path/to/merp.xlsx',
        }))).toEqual({
            kind: 'incomplete',
            path: '/path/to/me',
            completion: '/path/to/merp.xlsx',
        });
    });

    it('still reports a path that is neither a folder nor completable', () => {
        expect(path_state('/path/to/nope.xlsx', check({ exists: false })).kind)
            .toBe('missing');
    });
});

describe('path_error', () => {
    it('says nothing about a path that is merely unfinished', () => {
        expect(path_error({ kind: 'incomplete', path: '/x' })).toBeUndefined();
        expect(path_error({ kind: 'incomplete', path: '/x', completion: '/xy.csv' }))
            .toBeUndefined();
    });

    it('explains only the states the user must fix', () => {
        expect(path_error({ kind: 'empty' })).toBeUndefined();
        expect(path_error(ok('/tmp/a.xlsx'))).toBeUndefined();
        expect(path_error({ kind: 'missing', path: '/x' })).toMatch(/does not exist/u);
        expect(path_error({ kind: 'unsupported', path: '/x' })).toMatch(/cannot open/u);
    });
});

describe('dialog_state, unfinished paths', () => {
    it('will not compare a folder, which has nowhere further to go', () => {
        expect(dialog_state({ kind: 'incomplete', path: '/d' }, ok('/b.xlsx')).canCompare)
            .toBe(false);
    });

    it('offers Compare when a side has a completion, since the click applies it', () => {
        // Dead until the last letter meant the click that was supposed to
        // finish the path could never be made.
        const half = { kind: 'incomplete', path: '/p/me', completion: '/p/merp.csv' } as const;
        expect(dialog_state(half, ok('/b.xlsx')).canCompare).toBe(true);
        // But not when the *other* side is still unusable on its own.
        expect(dialog_state(half, { kind: 'missing', path: '/gone' }).canCompare).toBe(false);
        expect(dialog_state(half, { kind: 'empty' }).canCompare).toBe(false);
    });
});

describe('dialog_state', () => {
    it('refuses until both sides are readable', () => {
        expect(dialog_state({ kind: 'empty' }, ok('/b.xlsx')).canCompare).toBe(false);
        expect(dialog_state(ok('/a.xlsx'), { kind: 'empty' }).canCompare).toBe(false);
        expect(dialog_state(
            { kind: 'missing', path: '/a.xlsx' }, ok('/b.xlsx')).canCompare).toBe(false);
    });

    it('offers a plain Compare for two files of the same format', () => {
        expect(dialog_state(ok('/a.xlsx'), ok('/b.xlsx'))).toEqual({
            canCompare: true,
            compareLabel: 'Compare',
        });
    });

    it('warns about comparing a file with itself, but allows it', () => {
        // Confirming a tool changed nothing is a real use; only an unreadable
        // path blocks.
        const state = dialog_state(ok('/a.xlsx'), ok('/a.xlsx'));
        expect(state.canCompare).toBe(true);
        expect(state.compareLabel).toBe('Compare Anyway');
        expect(state.warning).toMatch(/same file/u);
    });

    it('says which way unmatched sheets will read, per direction', () => {
        // A delimited original means the workbook is the modified side, so its
        // extra sheets are additions; the mirror makes them deletions.
        expect(dialog_state(ok('/a.csv', 'csv'), ok('/b.xlsx')).warning)
            .toMatch(/show as added/u);
        expect(dialog_state(ok('/a.xlsx'), ok('/b.csv', 'csv')).warning)
            .toMatch(/show as deleted/u);
    });

    it('warns but allows a delimited-vs-workbook pair', () => {
        const state = dialog_state(ok('/a.csv', 'csv'), ok('/b.xlsx', 'xlsx'));
        expect(state.canCompare).toBe(true);
        expect(state.compareLabel).toBe('Compare Anyway');
        expect(state.warning).toMatch(/single sheet/u);
    });

    it('warns more generically for two workbook formats', () => {
        const state = dialog_state(ok('/a.xls', 'xls'), ok('/b.xlsx', 'xlsx'));
        expect(state.canCompare).toBe(true);
        expect(state.warning).toMatch(/different formats/u);
        expect(state.warning).not.toMatch(/single sheet/u);
    });

    it('does not warn about pairs of single-table formats beyond the format note', () => {
        // Neither side can have unmatched worksheets, so the sheet caveat is wrong.
        expect(dialog_state(ok('/a.csv', 'csv'), ok('/b.tsv', 'tsv')).warning)
            .not.toMatch(/single sheet/u);
    });
});
