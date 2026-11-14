// Undo and redo across a save.
//
// A save removes the overlays it wrote and leaves the file holding what they
// held, so history recorded before it describes differences from a file that no
// longer exists. These tests drive a small model of a worksheet through edits,
// saves, undos and redos, and check what each cell shows. The model is a file
// and an overlay; the history store and the replay planner are the real ones.
import { describe, expect, it } from 'vitest';

import { cell_key } from '../cell-key';
import type { CellHyperlink } from '../cell-content';
import {
    make_dirty_entry,
    type CsvSaveWorksheetOperation,
    type WorksheetTarget,
} from '../types';
import { saved_history_cells } from '../webview/csv-save-lifecycle';
import {
    absent_overlay,
    build_cell_history_delta,
    combined_overlay,
    history_value,
    hyperlink_only_overlay,
    overlay_state_from_dirty_entry,
    rebase_saved_cell_delta,
    value_only_overlay,
    type CellHistoryDelta,
    type CellOverlayState,
    type HistoryDirection,
    type HistoryDirtyEntry,
} from '../webview/history-cell-state-model';
import { plan_history_replay } from '../webview/history-replay-model';
import {
    peek_history,
    rebase_saved_cell_history,
    type HistoryBounds,
    type SavedHistoryCell,
} from '../webview/history-stack-model';
import { create_history_store } from '../webview/history-store';

const SHEET: WorksheetTarget = { sheetIndex: 0, sheetName: 'Sheet1' };
const LINK: CellHyperlink = { kind: 'external', target: 'https://example.com/a' };
const OTHER_LINK: CellHyperlink = { kind: 'external', target: 'https://example.com/b' };

interface FileCell {
    text: string;
    link: CellHyperlink | null;
}

/**
 * One worksheet: what the file holds, the unsaved overlay over it, and the
 * history of the gestures that got it there.
 */
function worksheet(initial: Record<string, string>) {
    const file = new Map<string, FileCell>(
        Object.entries(initial).map(([key, text]) => [key, { text, link: null }]),
    );
    const overlay = new Map<string, HistoryDirtyEntry>();
    const history = create_history_store();

    const file_cell = (key: string): FileCell => file.get(key) ?? { text: '', link: null };
    const overlay_of = (key: string): CellOverlayState => {
        const entry = overlay.get(key);
        return entry === undefined ? absent_overlay() : overlay_state_from_dirty_entry(entry);
    };
    const coordinates = (key: string) => {
        const [row, column] = key.split(':').map(Number);
        return { sourceRow: row, sourceColumn: column };
    };

    /** Install `entry` (or remove the overlay) as one recorded gesture. */
    const record = (key: string, entry: HistoryDirtyEntry | undefined, label: string) => {
        const before = overlay_of(key);
        if (entry === undefined) overlay.delete(key);
        else overlay.set(key, entry);
        const delta = build_cell_history_delta({
            worksheet: SHEET,
            ...coordinates(key),
            before,
            after: overlay_of(key),
            persistedValue: history_value(file_cell(key).text),
            persistedHyperlink: file_cell(key).link,
        });
        if (delta === undefined) throw new Error('gesture changed nothing');
        history.stage_record({ label, changes: [{ kind: 'cell', delta }] }).commit();
    };

    const replay = (direction: HistoryDirection): 'done' | 'nothing' | 'conflict' | 'unavailable' | 'base-pending' => {
        const peek = peek_history(history.snapshot(), direction);
        if (peek.kind !== 'available') return 'nothing';
        const plan = plan_history_replay(peek.entry.action, direction, (_sheet, row, column) => {
            const key = cell_key(row, column);
            return {
                overlay: overlay_of(key),
                persisted: history_value(file_cell(key).text),
                persistedHyperlink: file_cell(key).link,
            };
        });
        if (plan.kind === 'refused') return plan.reason;
        for (const write of plan.writes) {
            if (write.entry === undefined) overlay.delete(write.key);
            else overlay.set(write.key, write.entry);
        }
        history.stage_move(direction, peek.entry).commit();
        return 'done';
    };

    return {
        history,
        /** Type `text` into a cell, as the editor commits it. */
        edit(key: string, text: string) {
            const base = overlay.get(key)?.base ?? file_cell(key).text;
            const link = overlay.get(key)?.link;
            const base_link = overlay.get(key)?.baseLink;
            record(
                key,
                text === base && link === undefined
                    ? undefined
                    : make_dirty_entry(text, base, undefined, undefined, link, base_link, {
                        formattingKnown: true,
                    }),
                'Edit cell',
            );
        },
        /** Attach, change or clear a cell's hyperlink. */
        set_link(key: string, link: CellHyperlink | null) {
            const current = overlay.get(key);
            record(
                key,
                make_dirty_entry(
                    current?.value ?? file_cell(key).text,
                    current?.base ?? file_cell(key).text,
                    undefined,
                    undefined,
                    link,
                    current?.baseLink ?? file_cell(key).link,
                    current === undefined ? {} : { formattingKnown: true },
                ),
                'Edit link',
            );
        },
        /** Drop every unsaved change, as one undoable gesture. */
        discard(key: string) {
            record(key, undefined, 'Discard');
        },
        /** Write every overlay into the file, the way a successful save settles. */
        save() {
            const edits: Record<string, string> = {};
            const dirty: Record<string, HistoryDirtyEntry> = {};
            for (const [key, entry] of overlay) {
                dirty[key] = entry;
                const written = { ...file_cell(key) };
                if (entry.value !== entry.base || entry.link === undefined) {
                    edits[key] = entry.value;
                    written.text = entry.value;
                }
                if (entry.link !== undefined) written.link = entry.link;
                file.set(key, written);
            }
            overlay.clear();
            const operation: CsvSaveWorksheetOperation = { ...SHEET, edits, dirtyEdits: dirty };
            history.rebase_saved_cells(saved_history_cells(operation, SHEET, undefined));
        },
        undo: () => replay('undo'),
        redo: () => replay('redo'),
        /** What the cell shows: the overlay's value, else the file's. */
        shows: (key: string) => overlay.get(key)?.value ?? file_cell(key).text,
        shows_link: (key: string) => {
            const entry = overlay.get(key);
            return entry?.link !== undefined ? entry.link : file_cell(key).link;
        },
        unsaved: () => overlay.size > 0,
        file_text: (key: string) => file_cell(key).text,
        entry: (key: string) => overlay.get(key),
    };
}

describe('undo after a save', () => {
    it('walks a saved edit back as an unsaved change, on the first press', () => {
        const sheet = worksheet({ '0:0': 'Alice' });
        sheet.edit('0:0', 'Hello');
        sheet.save();
        expect(sheet.file_text('0:0')).toBe('Hello');
        expect(sheet.unsaved()).toBe(false);

        expect(sheet.undo()).toBe('done');
        expect(sheet.shows('0:0')).toBe('Alice');
        // An ordinary edit against what the file holds now.
        expect(sheet.entry('0:0')).toMatchObject({ value: 'Alice', base: 'Hello' });
        expect(sheet.file_text('0:0')).toBe('Hello');
    });

    it('refused that undo before history was rebased', () => {
        // The failure this exists for: the recorded state still says the cell
        // holds an overlay, the save removed it, and the swap can never match.
        const sheet = worksheet({ '0:0': 'Alice' });
        sheet.edit('0:0', 'Hello');
        const recorded = peek_history(sheet.history.snapshot(), 'undo');
        if (recorded.kind !== 'available') throw new Error('expected an entry');

        const plan = plan_history_replay(recorded.entry.action, 'undo', () => ({
            overlay: absent_overlay(),
            persisted: history_value('Hello'),
            persistedHyperlink: null,
        }));
        expect(plan).toMatchObject({ kind: 'refused', reason: 'conflict' });
    });

    it('redoes onto the saved content and leaves nothing unsaved', () => {
        const sheet = worksheet({ '0:0': 'Alice' });
        sheet.edit('0:0', 'Hello');
        sheet.save();
        sheet.undo();

        expect(sheet.redo()).toBe('done');
        expect(sheet.shows('0:0')).toBe('Hello');
        expect(sheet.unsaved()).toBe(false);
    });

    it('walks back through two saves and forward again', () => {
        const sheet = worksheet({ '0:0': 'Alice' });
        sheet.edit('0:0', 'One');
        sheet.save();
        sheet.edit('0:0', 'Two');
        sheet.save();

        expect(sheet.undo()).toBe('done');
        expect(sheet.shows('0:0')).toBe('One');
        expect(sheet.undo()).toBe('done');
        expect(sheet.shows('0:0')).toBe('Alice');
        expect(sheet.entry('0:0')).toMatchObject({ value: 'Alice', base: 'Two' });
        expect(sheet.redo()).toBe('done');
        expect(sheet.shows('0:0')).toBe('One');
        expect(sheet.redo()).toBe('done');
        expect(sheet.shows('0:0')).toBe('Two');
        expect(sheet.unsaved()).toBe(false);
    });

    it('walks back through several edits one save wrote', () => {
        const sheet = worksheet({ '0:0': 'Alice' });
        sheet.edit('0:0', 'One');
        sheet.edit('0:0', 'Two');
        sheet.edit('0:0', 'Three');
        sheet.save();

        expect(sheet.undo()).toBe('done');
        expect(sheet.shows('0:0')).toBe('Two');
        expect(sheet.undo()).toBe('done');
        expect(sheet.shows('0:0')).toBe('One');
        expect(sheet.undo()).toBe('done');
        expect(sheet.shows('0:0')).toBe('Alice');
        expect(sheet.undo()).toBe('nothing');
    });

    it('keeps an undo that was saved, and still redoes past it', () => {
        const sheet = worksheet({ '0:0': 'Alice' });
        sheet.edit('0:0', 'Hello');
        sheet.save();
        sheet.undo();
        sheet.save();
        expect(sheet.file_text('0:0')).toBe('Alice');
        expect(sheet.unsaved()).toBe(false);

        expect(sheet.redo()).toBe('done');
        expect(sheet.shows('0:0')).toBe('Hello');
        expect(sheet.entry('0:0')).toMatchObject({ value: 'Hello', base: 'Alice' });
    });

    it('rebases the redo stack an undo left before the save', () => {
        const sheet = worksheet({ '0:0': 'Alice' });
        sheet.edit('0:0', 'One');
        sheet.edit('0:0', 'Two');
        sheet.undo();
        sheet.save();
        expect(sheet.file_text('0:0')).toBe('One');

        expect(sheet.redo()).toBe('done');
        expect(sheet.shows('0:0')).toBe('Two');
        expect(sheet.entry('0:0')).toMatchObject({ value: 'Two', base: 'One' });
        expect(sheet.undo()).toBe('done');
        expect(sheet.unsaved()).toBe(false);
        expect(sheet.undo()).toBe('done');
        expect(sheet.shows('0:0')).toBe('Alice');
    });

    it('undoes each cell a save wrote, independently', () => {
        const sheet = worksheet({ '0:0': 'Alice', '1:0': 'Bob' });
        sheet.edit('0:0', 'A2');
        sheet.edit('1:0', 'B2');
        sheet.save();

        expect(sheet.undo()).toBe('done');
        expect(sheet.shows('1:0')).toBe('Bob');
        expect(sheet.shows('0:0')).toBe('A2');
        expect(sheet.undo()).toBe('done');
        expect(sheet.shows('0:0')).toBe('Alice');
    });

    it('undoes a discard that an edit and a save followed', () => {
        const sheet = worksheet({ '0:0': 'Alice' });
        sheet.edit('0:0', 'Draft');
        sheet.discard('0:0');
        sheet.edit('0:0', 'Final');
        sheet.save();

        expect(sheet.undo()).toBe('done');
        expect(sheet.shows('0:0')).toBe('Alice');
        expect(sheet.undo()).toBe('done');
        expect(sheet.shows('0:0')).toBe('Draft');
        expect(sheet.undo()).toBe('done');
        expect(sheet.shows('0:0')).toBe('Alice');
    });

    it('walks a saved link back without touching the text', () => {
        const sheet = worksheet({ '0:0': 'Alice' });
        sheet.set_link('0:0', LINK);
        sheet.save();
        expect(sheet.shows_link('0:0')).toEqual(LINK);

        expect(sheet.undo()).toBe('done');
        expect(sheet.shows_link('0:0')).toBeNull();
        expect(sheet.shows('0:0')).toBe('Alice');
        // The text was never written, so it is not an edit now either.
        expect(sheet.entry('0:0')).toMatchObject({ value: 'Alice', base: 'Alice', link: null });
        expect(sheet.redo()).toBe('done');
        expect(sheet.shows_link('0:0')).toEqual(LINK);
        expect(sheet.unsaved()).toBe(false);
    });

    it('walks text and link back separately when one save wrote both', () => {
        const sheet = worksheet({ '0:0': 'Alice' });
        sheet.edit('0:0', 'Hello');
        sheet.set_link('0:0', LINK);
        sheet.save();

        expect(sheet.undo()).toBe('done');
        expect(sheet.shows('0:0')).toBe('Hello');
        expect(sheet.shows_link('0:0')).toBeNull();
        expect(sheet.undo()).toBe('done');
        expect(sheet.shows('0:0')).toBe('Alice');
        expect(sheet.shows_link('0:0')).toBeNull();
        expect(sheet.redo()).toBe('done');
        expect(sheet.redo()).toBe('done');
        expect(sheet.shows('0:0')).toBe('Hello');
        expect(sheet.shows_link('0:0')).toEqual(LINK);
        expect(sheet.unsaved()).toBe(false);
    });
});

function delta_of(before: CellOverlayState, after: CellOverlayState, persisted = 'A'): CellHistoryDelta {
    const delta = build_cell_history_delta({
        worksheet: SHEET,
        sourceRow: 0,
        sourceColumn: 0,
        before,
        after,
        persistedValue: history_value(persisted),
        persistedHyperlink: null,
    });
    if (delta === undefined) throw new Error('fixture described no change');
    return delta;
}

describe('rebase_saved_cell_delta', () => {
    const edit = delta_of(absent_overlay(), value_only_overlay(history_value('B'), history_value('A')));

    it('turns the saved side into no overlay and the other into an edit over the saved content', () => {
        const rebased = rebase_saved_cell_delta(edit, { value: history_value('B') });
        expect(rebased?.afterOverlay).toEqual(absent_overlay());
        expect(rebased?.beforeOverlay).toEqual(
            value_only_overlay(history_value('A'), history_value('B'), false, undefined, undefined, true),
        );
        expect(rebased?.value).toEqual({
            mode: 'membership',
            expected: { content: history_value('A'), overlay: 'present' },
            desired: { content: history_value('B'), overlay: 'absent' },
        });
    });

    it('is stable when the same save is applied twice', () => {
        const once = rebase_saved_cell_delta(edit, { value: history_value('B') });
        const twice = rebase_saved_cell_delta(once!, { value: history_value('B') });
        expect(twice).toEqual(once);
    });

    it('leaves a delta alone when the save wrote neither dimension', () => {
        expect(rebase_saved_cell_delta(edit, {})).toBe(edit);
    });

    it('leaves the text states alone when the save wrote only a link', () => {
        const rebased = rebase_saved_cell_delta(edit, { hyperlink: { value: LINK, base: null } });
        // The text is still an edit over A, and the cell now also differs from
        // the saved link on both sides.
        expect(rebased?.afterOverlay).toEqual(combined_overlay(
            history_value('B'), history_value('A'), null, LINK,
        ));
        expect(rebased?.beforeOverlay).toEqual(hyperlink_only_overlay(history_value('A'), null, LINK));
    });

    it('drops a change whose sides both show what was saved', () => {
        // A base that moved under an unchanged value: content never changed.
        const recommit = delta_of(
            value_only_overlay(history_value('B'), history_value('A')),
            value_only_overlay(history_value('B'), history_value('C')),
        );
        expect(rebase_saved_cell_delta(recommit, { value: history_value('B') })).toBeUndefined();
    });

    it('rewrites a link change over the saved link', () => {
        const relink = delta_of(
            hyperlink_only_overlay(history_value('A'), LINK, null),
            hyperlink_only_overlay(history_value('A'), OTHER_LINK, null),
        );
        const rebased = rebase_saved_cell_delta(relink, {
            hyperlink: { value: OTHER_LINK, base: null },
        });
        expect(rebased?.afterOverlay).toEqual(absent_overlay());
        expect(rebased?.beforeOverlay).toEqual(
            hyperlink_only_overlay(history_value('A'), LINK, OTHER_LINK),
        );
    });

    it('leaves a cut move exactly as recorded, so undoing it past a save stays refused', () => {
        const moved = delta_of(
            absent_overlay(),
            value_only_overlay(
                history_value('B'), history_value('A'), false, undefined, undefined, true,
                { row: 4, col: 0, order: 1 },
            ),
        );
        expect(rebase_saved_cell_delta(moved, { value: history_value('B') })).toBe(moved);
    });

    it('rewrites an ordinary formula edit, which records an empty list of bases', () => {
        const formula = delta_of(
            absent_overlay(),
            value_only_overlay(
                history_value('=1+1'), history_value('A'), false, undefined, undefined, true,
                undefined, 3, [],
            ),
        );
        const rebased = rebase_saved_cell_delta(formula, { value: history_value('=1+1') });
        expect(rebased?.afterOverlay).toEqual(absent_overlay());
        expect(rebased?.beforeOverlay).toEqual(
            value_only_overlay(history_value('A'), history_value('=1+1'), false, undefined, undefined, true),
        );
    });

    it('keeps the empty list of bases on a formula it rewrites as an edit', () => {
        // Empty and missing are different facts downstream: a missing list makes
        // the pending-row conflict check infer references from coordinates.
        const formula = (text: string) => value_only_overlay(
            history_value(text), history_value('A'), false, undefined, undefined, true,
            undefined, 3, [],
        );
        const rebased = rebase_saved_cell_delta(
            delta_of(formula('=1+1'), formula('=2+2')),
            { value: history_value('=2+2') },
        );
        expect(rebased?.afterOverlay).toEqual(absent_overlay());
        expect(rebased?.beforeOverlay).toEqual(value_only_overlay(
            history_value('=1+1'), history_value('=2+2'), false, undefined, undefined, true,
            undefined, 3, [],
        ));
    });

    it('leaves a formula that names pending rows exactly as recorded', () => {
        const formula = delta_of(
            absent_overlay(),
            value_only_overlay(
                history_value('=A9'), history_value('A'), false, undefined, undefined, true,
                undefined, 3,
                [{ targetSheetIndex: 0, targetSheetName: 'Sheet1', provisionalStartRow: 8, provisionalRowCount: 1 }],
            ),
        );
        expect(rebase_saved_cell_delta(formula, { value: history_value('=A9') })).toBe(formula);
    });

    it('leaves a state whose base was never observed exactly as recorded', () => {
        const pending = delta_of(
            value_only_overlay(history_value('B'), history_value(''), true),
            value_only_overlay(history_value('C'), history_value(''), true),
        );
        expect(rebase_saved_cell_delta(pending, { value: history_value('C') })).toBe(pending);
    });
});

describe('rebase_saved_cell_history', () => {
    const saved = (row: number, text: string, target: WorksheetTarget = SHEET): SavedHistoryCell => ({
        worksheet: target,
        sourceRow: row,
        sourceColumn: 0,
        value: history_value(text),
    });

    it('keeps entries that name no saved cell, by identity', () => {
        const sheet = worksheet({ '0:0': 'Alice', '1:0': 'Bob' });
        sheet.edit('0:0', 'A2');
        sheet.edit('1:0', 'B2');
        const before = sheet.history.snapshot();

        const after = rebase_saved_cell_history(before, [saved(1, 'B2')]);
        expect(after.undoStack[0]).toBe(before.undoStack[0]);
        expect(after.undoStack[1]).not.toBe(before.undoStack[1]);
        // Identity and move count survive, so a replay or menu projection that
        // names the entry still names it.
        expect(after.undoStack[1].id).toBe(before.undoStack[1].id);
        expect(after.undoStack[1].moves).toBe(before.undoStack[1].moves);
    });

    it('returns the same state when nothing it holds was saved', () => {
        const sheet = worksheet({ '0:0': 'Alice' });
        sheet.edit('0:0', 'A2');
        const before = sheet.history.snapshot();
        expect(rebase_saved_cell_history(before, [])).toBe(before);
        expect(rebase_saved_cell_history(before, [saved(7, 'x')])).toBe(before);
    });

    it('does not touch the same coordinates on another worksheet', () => {
        const sheet = worksheet({ '0:0': 'Alice' });
        sheet.edit('0:0', 'A2');
        const before = sheet.history.snapshot();
        const elsewhere = { sheetIndex: 1, sheetName: 'Sheet2' };
        expect(rebase_saved_cell_history(before, [saved(0, 'A2', elsewhere)])).toBe(before);
    });

    it('matches a recorded target by the identity it captured', () => {
        // The save names the sheet with an id the recorded target never had.
        const sheet = worksheet({ '0:0': 'Alice' });
        sheet.edit('0:0', 'A2');
        const before = sheet.history.snapshot();
        const richer = { ...SHEET, worksheetId: 'ws-1' };
        expect(rebase_saved_cell_history(before, [saved(0, 'A2', richer)])).not.toBe(before);
    });

    it('drops an entry the save left with nothing to replay', () => {
        const store = create_history_store();
        store.stage_record({
            label: 'Recommit',
            changes: [{
                kind: 'cell',
                delta: delta_of(
                    value_only_overlay(history_value('B'), history_value('A')),
                    value_only_overlay(history_value('B'), history_value('C')),
                ),
            }],
        }).commit();
        const after = rebase_saved_cell_history(store.snapshot(), [saved(0, 'B')]);
        expect(after.undoStack).toHaveLength(0);
    });

    it('installs the barrier when a rebased entry cannot be retained', () => {
        const tiny: HistoryBounds = {
            maxActions: 100,
            maxCells: 1_000_000,
            softMaxBytes: 1,
            hardMaxBytes: 1,
        };
        const sheet = worksheet({ '0:0': 'Alice' });
        sheet.edit('0:0', 'A2');
        expect(sheet.history.rebase_saved_cells([saved(0, 'A2')], tiny)).toMatchObject({
            kind: 'unrecordable',
            reason: 'action-too-large',
        });
        expect(sheet.history.snapshot().barrier?.reason).toBe('action-too-large');
    });

    it('notifies subscribers only when history actually changed', () => {
        const sheet = worksheet({ '0:0': 'Alice' });
        sheet.edit('0:0', 'A2');
        let notified = 0;
        sheet.history.subscribe(() => { notified += 1; });

        expect(sheet.history.rebase_saved_cells([saved(7, 'x')])).toEqual({ kind: 'rekeyed', changed: false });
        expect(notified).toBe(0);
        expect(sheet.history.rebase_saved_cells([saved(0, 'A2')])).toEqual({ kind: 'rekeyed', changed: true });
        expect(notified).toBe(1);
    });
});

describe('saved_history_cells', () => {
    const operation = (
        edits: Record<string, string>,
        dirty: CsvSaveWorksheetOperation['dirtyEdits'],
    ): CsvSaveWorksheetOperation => ({ ...SHEET, edits, dirtyEdits: dirty });

    it('names the text a save wrote', () => {
        expect(saved_history_cells(
            operation({ '2:1': 'B' }, { '2:1': make_dirty_entry('B', 'A') }),
            SHEET,
            undefined,
        )).toEqual([{ worksheet: SHEET, sourceRow: 2, sourceColumn: 1, value: history_value('B') }]);
    });

    it('names only the link for an entry whose text was not written', () => {
        expect(saved_history_cells(
            operation({}, { '0:0': make_dirty_entry('A', 'A', undefined, undefined, LINK, null) }),
            SHEET,
            undefined,
        )).toEqual([{
            worksheet: SHEET,
            sourceRow: 0,
            sourceColumn: 0,
            hyperlink: { value: LINK, base: null },
        }]);
    });

    it('leaves out a cell that still holds a newer edit', () => {
        expect(saved_history_cells(
            operation({ '0:0': 'B', '1:0': 'D' }, {
                '0:0': make_dirty_entry('B', 'A'),
                '1:0': make_dirty_entry('D', 'C'),
            }),
            SHEET,
            { '1:0': make_dirty_entry('E', 'C') },
        ).map((cell) => cell.sourceRow)).toEqual([0]);
    });

    it('ignores keys and entries it cannot read', () => {
        expect(saved_history_cells(
            operation({ 'x': 'B', '0:0': 'B' }, {
                x: make_dirty_entry('B', 'A'),
                '0:0': { value: 1 } as never,
            }),
            SHEET,
            undefined,
        )).toEqual([]);
    });
});
