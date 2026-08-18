import { describe, expect, it } from 'vitest';
import type { CellHyperlink, RichText } from '../cell-content';
import type { WorksheetTarget } from '../types';
import {
    discard_history_source,
    type DiscardedWorksheet,
} from '../webview/history-discard-model';
import {
    absent_overlay,
    history_value,
    overlay_for_direction,
    overlay_state_from_dirty_entry,
    type CellHistoryDelta,
    type HistoryDirtyEntry,
} from '../webview/history-cell-state-model';
import { create_history_store } from '../webview/history-store';
import {
    DEFAULT_HISTORY_BOUNDS,
    empty_history_stack,
    peek_history,
    record_history_action,
} from '../webview/history-stack-model';
import { plan_history_replay } from '../webview/history-replay-model';
import type { HistoryChange } from '../webview/history-stack-model';

const SHEET: WorksheetTarget = { sheetIndex: 0, sheetName: 'Data', worksheetId: 'rId1' };
const OTHER: WorksheetTarget = { sheetIndex: 2, sheetName: 'Notes', worksheetId: 'rId2' };
const LINK: CellHyperlink = { kind: 'external', target: 'https://example.com/' };

function worksheet(
    target: WorksheetTarget,
    entries: Record<string, HistoryDirtyEntry>,
): DiscardedWorksheet {
    return { target, entries: new Map(Object.entries(entries)) };
}

function deltas(worksheets: readonly DiscardedWorksheet[]): CellHistoryDelta[] {
    return [...discard_history_source(worksheets)].map((change: HistoryChange) => {
        if (change.kind !== 'cell') throw new Error('a discard records only cell changes');
        return change.delta;
    });
}

describe('discard_history_source', () => {
    it('records one removal per entry, across every worksheet', () => {
        const changes = deltas([
            worksheet(SHEET, {
                '0:0': { value: 'a', base: 'A' },
                '3:4': { value: 'b', base: 'B' },
            }),
            worksheet(OTHER, { '7:1': { value: 'c', base: 'C' } }),
        ]);
        expect(changes.map((delta) => [
            delta.worksheet.sheetIndex,
            delta.sourceRow,
            delta.sourceColumn,
        ])).toEqual([[0, 0, 0], [0, 3, 4], [2, 7, 1]]);
    });

    it('records the whole worksheet target, never a bare index', () => {
        const [delta] = deltas([worksheet(OTHER, { '0:0': { value: 'a', base: 'A' } })]);
        expect(delta.worksheet).toEqual(OTHER);
    });

    it('leaves the cell with no overlay, which is what a discard does', () => {
        const [delta] = deltas([worksheet(SHEET, { '0:0': { value: 'a', base: 'A' } })]);
        expect(overlay_for_direction(delta, 'undo').kind).toBe('present');
        expect(overlay_for_direction(delta, 'redo').kind).toBe('absent');
    });

    it('makes every transition membership, so no content is written back', () => {
        // The load-bearing property. A `semantic` redo would write the historical
        // persisted text over whatever is on disk now; `membership` removes the
        // overlay instead. It is also why the persisted side this module supplies
        // without page residency is never compared.
        const [delta] = deltas([
            worksheet(SHEET, { '0:0': { value: 'a', base: 'A', link: LINK, baseLink: null } }),
        ]);
        expect(delta.value?.mode).toBe('membership');
        expect(delta.hyperlink?.mode).toBe('membership');
    });

    it('takes the absent side from the entry\'s own base, never an invented empty', () => {
        // The persisted side cannot be read without page residency, and a
        // `membership` transition never compares it. Supplying the base the
        // overlay was made against — rather than `''` — means a later builder
        // that did start consulting persisted content would see a stale base, not
        // an empty cell it would then write over the user's data.
        const [delta] = deltas([
            worksheet(SHEET, {
                '0:0': { value: 'a', base: 'A', link: LINK, baseLink: null },
            }),
        ]);
        expect(delta.value?.desired.content).toEqual(history_value('A'));
        expect(delta.hyperlink?.desired.content).toBeNull();
    });

    it('captures every entry shape the store can hold, all as membership', () => {
        // The persisted side now comes from the entry's own base, so a shape whose
        // base carries runs or a link runs through content comparison that the
        // fabricated empty never exercised. A shape that compared EQUAL would be
        // dropped from the discard's history — the cell would silently not be
        // undoable — and one that came out `semantic` would make redo write
        // historical text back over disk.
        const RUNS: RichText = { runs: [{ text: 'a', style: { bold: true } }] };
        const shapes: Record<string, HistoryDirtyEntry> = {
            plain: { value: 'a', base: 'A' },
            unchanged_text: { value: 'a', base: 'a' },
            link_only: { value: 'a', base: 'a', link: LINK, baseLink: null },
            link_cleared: { value: 'a', base: 'a', link: null, baseLink: LINK },
            base_pending: { value: 'a', base: '', base_pending: true },
            base_runs: { value: 'a', base: 'A', baseRuns: RUNS },
            both_runs: { value: 'a', base: 'a', valueRuns: RUNS, baseRuns: RUNS },
            empty: { value: '', base: '' },
            combined: {
                value: 'b',
                base: 'A',
                link: LINK,
                baseLink: LINK,
                valueRuns: RUNS,
                baseRuns: RUNS,
            },
        };
        for (const [name, entry] of Object.entries(shapes)) {
            const captured = deltas([worksheet(SHEET, { '0:0': entry })]);
            expect(captured, name).toHaveLength(1);
            expect(captured[0]!.value?.mode ?? 'membership', name).toBe('membership');
            expect(captured[0]!.hyperlink?.mode ?? 'membership', name).toBe('membership');
        }
    });

    it('records a link-only entry through its hyperlink dimension alone', () => {
        // Its value fields are the unedited anchor, not a value change, so a
        // value transition here would make undo rewrite the cell's text.
        const [delta] = deltas([
            worksheet(SHEET, { '0:0': { value: 'a', base: 'a', link: LINK, baseLink: null } }),
        ]);
        expect(delta.value).toBeUndefined();
        expect(delta.hyperlink?.mode).toBe('membership');
    });

    it('carries a pending base into the recorded overlay', () => {
        // Undoing the discard has to restore the entry with its base still
        // unobserved; promoting the placeholder would admit a save against it.
        const [delta] = deltas([
            worksheet(SHEET, { '0:0': { value: 'a', base: '', base_pending: true } }),
        ]);
        const before = overlay_for_direction(delta, 'undo');
        expect(before.kind === 'present' && before.value.kind === 'present'
            && before.value.basePending).toBe(true);
    });

    it('skips a malformed key rather than guessing a coordinate', () => {
        // One cell not undoable, versus an undo writing over a cell the user
        // never edited.
        expect(deltas([worksheet(SHEET, {
            'not-a-key': { value: 'a', base: 'A' },
            '1:-2': { value: 'b', base: 'B' },
            '01:2': { value: 'c', base: 'C' },
            '5:6': { value: 'd', base: 'D' },
        })]).map((delta) => [delta.sourceRow, delta.sourceColumn])).toEqual([[5, 6]]);
    });

    it('yields nothing for a session with no edits', () => {
        expect(deltas([worksheet(SHEET, {})])).toEqual([]);
    });

    it('yields lazily, so an oversized discard is never fully materialized', () => {
        // The recorder walks with a budget that stops mid-walk. A source that
        // built every sheet's changes first would allocate exactly the peak the
        // budget exists to avoid.
        let visited = 0;
        const entries: Iterable<[string, HistoryDirtyEntry]> = {
            *[Symbol.iterator]() {
                for (let row = 0; row < 1000; row += 1) {
                    visited += 1;
                    yield [`${row}:0`, { value: 'a', base: 'A' }] as [string, HistoryDirtyEntry];
                }
            },
        };
        const source = discard_history_source([{
            target: SHEET,
            entries: entries as ReadonlyMap<string, HistoryDirtyEntry>,
        }]);
        source.next();
        source.next();
        expect(visited).toBe(2);
    });
});

describe('undoing a captured discard', () => {
    /** Plan the undo of a discard of these worksheets, against emptied stores. */
    function undo_plan(worksheets: readonly DiscardedWorksheet[]) {
        const store = create_history_store();
        const record = store.stage_record({
            label: 'Discard edits',
            changes: discard_history_source(worksheets),
        });
        record.commit();
        record.notify();
        const peek = peek_history(store.snapshot(), 'undo');
        if (peek.kind !== 'available') throw new Error('the discard recorded nothing');
        // Every cell is now unedited, which is what the discard left behind, and
        // the persisted content is whatever is on disk NOW.
        return plan_history_replay(peek.entry.action, 'undo', () => ({
            overlay: absent_overlay(),
            persisted: history_value('disk'),
        }));
    }

    it('restores every entry the discard removed', () => {
        const result = undo_plan([
            worksheet(SHEET, { '0:0': { value: 'a', base: 'A' } }),
            worksheet(OTHER, { '3:4': { value: 'b', base: 'B' } }),
        ]);
        if (result.kind !== 'plan') throw new Error(`refused: ${result.reason}`);
        expect(result.writes.map((write) => [write.key, write.entry])).toEqual([
            // Backwards: undo walks the gesture in reverse, so the discard's last
            // removal is the first restoration.
            ['3:4', { value: 'b', base: 'B' }],
            ['0:0', { value: 'a', base: 'A' }],
        ]);
    });

    it('restores the recorded base, not the content on disk now', () => {
        // The conflict base is session state the discard threw away; taking the
        // current disk content instead would silently bless an external change as
        // the base the next save is validated against.
        const result = undo_plan([worksheet(SHEET, { '0:0': { value: 'a', base: 'A' } })]);
        if (result.kind !== 'plan') throw new Error(`refused: ${result.reason}`);
        expect(result.writes[0].entry?.base).toBe('A');
    });

    it('restores an entry whose base was never observed, still unobserved', () => {
        const result = undo_plan([
            worksheet(SHEET, { '0:0': { value: 'a', base: '', base_pending: true } }),
        ]);
        if (result.kind !== 'plan') throw new Error(`refused: ${result.reason}`);
        expect(result.writes[0].entry).toEqual({ value: 'a', base: '', base_pending: true });
    });

    it('restores a link-only entry onto the content that is there now', () => {
        // Its value fields are the unedited anchor, and the recorded one was the
        // disk content at capture time — which an intervening save may have moved.
        const result = undo_plan([
            worksheet(SHEET, { '0:0': { value: 'a', base: 'a', link: LINK, baseLink: null } }),
        ]);
        if (result.kind !== 'plan') throw new Error(`refused: ${result.reason}`);
        expect(result.writes[0].entry)
            .toEqual({ value: 'disk', base: 'disk', link: LINK, baseLink: null });
    });

    it('refuses when a cell was edited again after the discard', () => {
        // Replaying over it would silently throw away whatever the user typed
        // since.
        const store = create_history_store();
        const record = store.stage_record({
            label: 'Discard edits',
            changes: discard_history_source([
                worksheet(SHEET, { '0:0': { value: 'a', base: 'A' } }),
            ]),
        });
        record.commit();
        record.notify();
        const peek = peek_history(store.snapshot(), 'undo');
        if (peek.kind !== 'available') throw new Error('the discard recorded nothing');

        const result = plan_history_replay(peek.entry.action, 'undo', () => ({
            overlay: overlay_state_from_dirty_entry({ value: 'retyped', base: 'disk' }),
            persisted: history_value('disk'),
        }));

        expect(result).toMatchObject({ kind: 'refused', reason: 'conflict' });
    });

    it('redoes the discard by removing the overlay, writing nothing back', () => {
        // The membership transition's whole point: a `semantic` redo would write
        // the historical persisted text over whatever is on disk now.
        const store = create_history_store();
        const record = store.stage_record({
            label: 'Discard edits',
            changes: discard_history_source([
                worksheet(SHEET, { '0:0': { value: 'a', base: 'A' } }),
            ]),
        });
        record.commit();
        record.notify();
        const peek = peek_history(store.snapshot(), 'undo');
        if (peek.kind !== 'available') throw new Error('the discard recorded nothing');

        const result = plan_history_replay(peek.entry.action, 'redo', () => ({
            overlay: overlay_state_from_dirty_entry({ value: 'a', base: 'A' }),
            persisted: history_value('disk'),
        }));

        if (result.kind !== 'plan') throw new Error(`refused: ${result.reason}`);
        expect(result.writes.map((write) => write.entry)).toEqual([undefined]);
    });
});

describe('a discard too large to keep', () => {
    it('is refused behind a barrier, so undo can explain itself', () => {
        // A workbook-wide discard is the gesture most likely to exceed the bounds,
        // and it is the one whose loss matters most: the edits are gone either way,
        // so history that silently dropped it would leave them unrecoverable with
        // nothing saying why.
        const entries = new Map<string, HistoryDirtyEntry>();
        for (let row = 0; row < 200; row += 1) {
            entries.set(`${row}:0`, { value: 'x'.repeat(64), base: 'y'.repeat(64) });
        }
        const outcome = record_history_action(
            empty_history_stack(),
            {
                label: 'Discard edits',
                changes: discard_history_source([{ target: SHEET, entries }]),
            },
            { ...DEFAULT_HISTORY_BOUNDS, hardMaxBytes: 1024 },
        );

        expect(outcome.kind).toBe('refused');
        expect(outcome.state.barrier)
            .toEqual({ reason: 'action-too-large', label: 'Discard edits' });
    });

    it('stops walking the discard at the bound rather than materializing it', () => {
        // The reason the source is a generator. A drain-first recorder would
        // allocate every sheet's changes before the budget could refuse them,
        // which is exactly the peak the budget exists to avoid.
        let visited = 0;
        const entries: Iterable<[string, HistoryDirtyEntry]> = {
            *[Symbol.iterator]() {
                for (let row = 0; row < 100000; row += 1) {
                    visited += 1;
                    yield [`${row}:0`, {
                        value: 'x'.repeat(64),
                        base: 'y'.repeat(64),
                    }] as [string, HistoryDirtyEntry];
                }
            },
        };
        record_history_action(
            empty_history_stack(),
            {
                label: 'Discard edits',
                changes: discard_history_source([{
                    target: SHEET,
                    entries: entries as ReadonlyMap<string, HistoryDirtyEntry>,
                }]),
            },
            { ...DEFAULT_HISTORY_BOUNDS, hardMaxBytes: 1024 },
        );

        expect(visited).toBeLessThan(100);
    });
});
