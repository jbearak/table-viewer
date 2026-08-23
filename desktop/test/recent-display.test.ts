// How a Recent entry reads in the launcher's rail.
import { describe, expect, it } from 'vitest';
import type { RecentEntry } from '../main/recent-documents';
import { COMPARISON_SEPARATOR, display_directory, recent_row } from '../shared/recent-display';

const HOME = '/Users/jo';

const file = (file_path: string): RecentEntry =>
    ({ kind: 'file', path: file_path, openedAt: 1 });
const comparison = (original: string, modified: string): RecentEntry =>
    ({ kind: 'comparison', originalPath: original, modifiedPath: modified, openedAt: 1 });

describe('display_directory', () => {
    it('abbreviates the home directory', () => {
        expect(display_directory('/Users/jo/data', HOME)).toBe('~/data');
        expect(display_directory(HOME, HOME)).toBe('~');
    });

    // The separator has to be part of the match, or a home of /Users/jo would
    // abbreviate /Users/jonathan to "~nathan".
    it('does not abbreviate a sibling whose name starts with the home name', () => {
        expect(display_directory('/Users/jonathan/data', HOME)).toBe('/Users/jonathan/data');
    });

    it('leaves a path outside home alone', () => {
        expect(display_directory('/srv/share', HOME)).toBe('/srv/share');
    });

    it('handles windows separators', () => {
        expect(display_directory('C:\\Users\\jo\\data', 'C:\\Users\\jo')).toBe('~\\data');
    });

    it('is empty for no directory, and passes through with no home', () => {
        expect(display_directory('', HOME)).toBe('');
        expect(display_directory('/srv/share', '')).toBe('/srv/share');
    });
});

describe('recent_row for a file', () => {
    it('names the file and its folder', () => {
        expect(recent_row(file('/Users/jo/data/survey.csv'), HOME)).toEqual({
            title: 'survey.csv',
            location: '~/data',
            tooltip: '/Users/jo/data/survey.csv',
            isComparison: false,
        });
    });

    // The list is written by whichever OS opened the file, and a userData
    // directory can be carried between them.
    it('splits windows paths', () => {
        const row = recent_row(file('C:\\data\\survey.csv'), '');
        expect(row.title).toBe('survey.csv');
        expect(row.location).toBe('C:\\data');
    });

    it('has no location line for a file at the filesystem root', () => {
        expect(recent_row(file('/survey.csv'), HOME).location).toBe('');
    });

    // The row is ellipsized in one column of a fixed-width window, so the
    // tooltip is the only place the full path is available.
    it('keeps the untruncated path as the tooltip', () => {
        const deep = '/Users/jo/a/very/deeply/nested/folder/survey.csv';
        expect(recent_row(file(deep), HOME).tooltip).toBe(deep);
    });
});

describe('recent_row for a comparison', () => {
    it('names both files and their shared folder once', () => {
        const row = recent_row(
            comparison('/Users/jo/data/before.csv', '/Users/jo/data/after.csv'),
            HOME,
        );

        expect(row.title).toBe(`before.csv${COMPARISON_SEPARATOR}after.csv`);
        expect(row.location).toBe('~/data');
        expect(row.isComparison).toBe(true);
    });

    // "Which two files" is the whole content of the row, so a single folder
    // name that applied to only one of them would be a lie.
    it('shows both folders when the sides do not share one', () => {
        const row = recent_row(
            comparison('/Users/jo/old/data.csv', '/Users/jo/new/data.csv'),
            HOME,
        );

        expect(row.title).toBe(`data.csv${COMPARISON_SEPARATOR}data.csv`);
        expect(row.location).toBe(`~/old${COMPARISON_SEPARATOR}~/new`);
    });

    it('keeps both untruncated paths as the tooltip', () => {
        const row = recent_row(comparison('/a/before.csv', '/b/after.csv'), HOME);
        expect(row.tooltip).toBe(`/a/before.csv${COMPARISON_SEPARATOR}/b/after.csv`);
    });
});
