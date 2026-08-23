// The launcher's Recent store: what it keeps, in what order, and what it
// refuses to hand back.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    RECENT_DISPLAY_LIMIT,
    RECENT_HISTORY_LIMIT,
    clear_recent_entries,
    read_recent_entries,
    recent_documents_file_path,
    record_recent_entry,
    usable_recent_entries,
    type RecentEntry,
} from '../main/recent-documents';

let user_data: string;

beforeEach(() => {
    user_data = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-recent-'));
});

afterEach(() => {
    fs.rmSync(user_data, { recursive: true, force: true });
});

const file = (file_path: string, opened_at: number): RecentEntry =>
    ({ kind: 'file', path: file_path, openedAt: opened_at });
const comparison = (
    original: string,
    modified: string,
    opened_at: number,
): RecentEntry => ({
    kind: 'comparison', originalPath: original, modifiedPath: modified, openedAt: opened_at,
});

function write_raw(value: unknown): void {
    fs.writeFileSync(recent_documents_file_path(user_data), JSON.stringify(value), 'utf8');
}

describe('record_recent_entry', () => {
    it('returns the list newest first and persists it', () => {
        record_recent_entry(user_data, file('/data/first.csv', 1));
        const returned = record_recent_entry(user_data, file('/data/second.csv', 2));

        expect(returned.map((entry) => entry.kind === 'file' && entry.path))
            .toEqual(['/data/second.csv', '/data/first.csv']);
        expect(read_recent_entries(user_data)).toEqual(returned);
    });

    // Reopening a file is the common case, and a list that grew an entry each
    // time would push everything else out with repeats of one path.
    it('moves a reopened file to the front rather than duplicating it', () => {
        record_recent_entry(user_data, file('/data/a.csv', 1));
        record_recent_entry(user_data, file('/data/b.csv', 2));
        const entries = record_recent_entry(user_data, file('/data/a.csv', 3));

        expect(entries).toEqual([file('/data/a.csv', 3), file('/data/b.csv', 2)]);
    });

    // Which side is "original" decides the direction every difference is
    // reported in, so the swapped pair is a different comparison.
    it('treats a comparison as its ordered pair', () => {
        record_recent_entry(user_data, comparison('/a.csv', '/b.csv', 1));
        const same = record_recent_entry(user_data, comparison('/a.csv', '/b.csv', 2));
        expect(same).toHaveLength(1);

        const swapped = record_recent_entry(user_data, comparison('/b.csv', '/a.csv', 3));
        expect(swapped).toHaveLength(2);
    });

    it('keeps files and comparisons in one list, interleaved by recency', () => {
        record_recent_entry(user_data, file('/a.csv', 1));
        record_recent_entry(user_data, comparison('/b.csv', '/c.csv', 2));
        const entries = record_recent_entry(user_data, file('/d.csv', 3));

        expect(entries.map((entry) => entry.kind)).toEqual(['file', 'comparison', 'file']);
    });

    it('caps the stored history', () => {
        for (let index = 0; index <= RECENT_HISTORY_LIMIT + 5; index += 1) {
            record_recent_entry(user_data, file(`/data/${index}.csv`, index));
        }
        const entries = read_recent_entries(user_data);

        expect(entries).toHaveLength(RECENT_HISTORY_LIMIT);
        // The newest survived and the oldest did not.
        expect(entries[0]).toEqual(file(`/data/${RECENT_HISTORY_LIMIT + 5}.csv`,
            RECENT_HISTORY_LIMIT + 5));
        expect(entries.some((entry) => entry.kind === 'file' && entry.path === '/data/0.csv'))
            .toBe(false);
    });

    // The store writes through a temp file; nothing may be left behind, or the
    // userData directory accumulates one per open.
    it('leaves no temporary file behind', () => {
        record_recent_entry(user_data, file('/data/a.csv', 1));
        expect(fs.readdirSync(user_data)).toEqual(['recent-documents.json']);
    });

    it('creates the userData directory when it does not exist yet', () => {
        const nested = path.join(user_data, 'missing', 'deeper');
        expect(record_recent_entry(nested, file('/a.csv', 1))).toHaveLength(1);
        expect(read_recent_entries(nested)).toHaveLength(1);
    });
});

describe('read_recent_entries', () => {
    it('is empty when nothing has been recorded', () => {
        expect(read_recent_entries(user_data)).toEqual([]);
    });

    // A Recent list is a convenience; a corrupt one must not be a startup
    // failure or a row that cannot be opened.
    it('survives an unparseable file', () => {
        fs.writeFileSync(recent_documents_file_path(user_data), '{ not json', 'utf8');
        expect(read_recent_entries(user_data)).toEqual([]);
    });

    it('survives a file that is not an array', () => {
        write_raw({ kind: 'file', path: '/a.csv', openedAt: 1 });
        expect(read_recent_entries(user_data)).toEqual([]);
    });

    it('drops malformed entries and keeps the rest', () => {
        write_raw([
            file('/good.csv', 3),
            { kind: 'file', openedAt: 2 },
            { kind: 'file', path: '/bad.csv' },
            { kind: 'file', path: '', openedAt: 1 },
            { kind: 'comparison', originalPath: '/a.csv', openedAt: 1 },
            { kind: 'invented', path: '/x.csv', openedAt: 1 },
            'not an entry',
            null,
            comparison('/a.csv', '/b.csv', 1),
        ]);

        expect(read_recent_entries(user_data)).toEqual([
            file('/good.csv', 3),
            comparison('/a.csv', '/b.csv', 1),
        ]);
    });

    it('rejects a non-finite timestamp', () => {
        write_raw([{ kind: 'file', path: '/a.csv', openedAt: 'yesterday' }]);
        expect(read_recent_entries(user_data)).toEqual([]);
    });

    // A hand-edited file can be out of order; the rail's whole claim is recency.
    it('sorts by recency regardless of stored order', () => {
        write_raw([file('/old.csv', 1), file('/new.csv', 9), file('/middle.csv', 5)]);

        expect(read_recent_entries(user_data).map((entry) => entry.openedAt))
            .toEqual([9, 5, 1]);
    });

    it('keeps only the first of a duplicated entry', () => {
        write_raw([file('/a.csv', 9), file('/a.csv', 1)]);
        expect(read_recent_entries(user_data)).toEqual([file('/a.csv', 9)]);
    });
});

describe('usable_recent_entries', () => {
    const always = () => true;

    it('caps at the display limit', () => {
        const entries = Array.from(
            { length: RECENT_DISPLAY_LIMIT + 4 },
            (_value, index) => file(`/data/${index}.csv`, index),
        );
        expect(usable_recent_entries(entries, always)).toHaveLength(RECENT_DISPLAY_LIMIT);
    });

    // The reason the stored history is deeper than the display limit: a moved
    // file must not cost the rail a row.
    it('skips unusable entries and fills from further down the list', () => {
        const entries = [file('/gone.csv', 3), file('/here.csv', 2), file('/also.csv', 1)];
        const usable = usable_recent_entries(
            entries,
            (file_path) => file_path !== '/gone.csv',
            2,
        );

        expect(usable).toEqual([file('/here.csv', 2), file('/also.csv', 1)]);
    });

    it('needs both sides of a comparison', () => {
        const entries = [
            comparison('/here.csv', '/gone.csv', 2),
            comparison('/here.csv', '/also.csv', 1),
        ];
        const usable = usable_recent_entries(
            entries,
            (file_path) => file_path !== '/gone.csv',
        );

        expect(usable).toEqual([comparison('/here.csv', '/also.csv', 1)]);
    });

    // Skipped is not forgotten: the file may be on a volume that is merely not
    // mounted right now.
    it('does not delete what it skips', () => {
        record_recent_entry(user_data, file('/gone.csv', 1));
        usable_recent_entries(read_recent_entries(user_data), () => false);

        expect(read_recent_entries(user_data)).toEqual([file('/gone.csv', 1)]);
    });
});

describe('clear_recent_entries', () => {
    it('forgets everything', () => {
        record_recent_entry(user_data, file('/a.csv', 1));
        clear_recent_entries(user_data);

        expect(read_recent_entries(user_data)).toEqual([]);
    });

    it('is silent when there is nothing to clear', () => {
        expect(() => clear_recent_entries(user_data)).not.toThrow();
    });
});
