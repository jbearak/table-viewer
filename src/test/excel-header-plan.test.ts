import { describe, expect, it } from 'vitest';
import { ExcelHeaderDataSource } from '../data-source/excel-header-source';
import type {
    DataSource,
    RenderedCell,
    RowWindow,
    SheetMeta,
    WorkbookMeta,
} from '../data-source/interface';
import {
    migrate_compatible_sheet_schema,
    plan_excel_candidate_state,
    plan_excel_override_state,
} from '../excel-header-plan';
import { transform_schema_for_sheet, type PerFileState } from '../types';

const text = (raw: string): RenderedCell => ({
    raw, formatted: raw, bold: false, italic: false, rawType: 'string',
});
const number = (raw: number): RenderedCell => ({
    raw: String(raw), formatted: String(raw), bold: false, italic: false, rawType: 'number',
});

class PhysicalSource implements DataSource {
    constructor(
        private readonly rows: (RenderedCell | null)[][] = [
            [text('Name'), text('Age')],
            [text('Alice'), number(30)],
        ],
        private readonly name = 'People',
    ) {}
    meta(): WorkbookMeta {
        return {
            hasFormatting: false,
            sheets: [{
                name: this.name,
                rowCount: this.rows.length,
                sourceRowCount: this.rows.length,
                columnCount: 2,
                merges: [],
                hasFormatting: false,
            }],
        };
    }
    read_rows(_sheet: number, start: number, count: number): RowWindow {
        return { startRow: start, rows: this.rows.slice(start, start + count) };
    }
    close(): void {}
}

function source(
    override?: 'on' | 'off',
    rows?: (RenderedCell | null)[][],
    hidden_rows?: readonly (readonly number[] | undefined)[],
) {
    return new ExcelHeaderDataSource(
        new PhysicalSource(rows),
        override ? { People: override } : undefined,
        hidden_rows,
    );
}

describe('pure Excel header state planning', () => {
    it.each([
        ['off', 'on'],
        ['on', 'off'],
    ] as const)('migrates an explicit toggle from %s to %s', (from, to) => {
        const ds = source(from);
        const old_sheet = ds.meta().sheets[0];
        const old_schema = transform_schema_for_sheet(old_sheet);
        const current: PerFileState = {
            excelFirstRowHeaders: { People: from },
            excelFirstRowHeaderActive: { People: from === 'on' },
            excelFirstRowHeaderVersion: 1,
            // Post-migration state, which is the regime this case is about: heights are
            // already canonical, so the toggle has nothing to re-key. The migration-owed
            // regime is a separate case below — this path is the *second* writer of
            // `excelFirstRowHeaderActive` and has to discharge the migration too.
            rowHeightsVersion: 1,
            columnWidths: [{ 0: 120 }],
            rowHeights: [{ 0: 40 }],
            scrollPosition: [{ top: 80, left: 10 }],
            transforms: [{
                sort: [{ colIndex: 1, direction: 'asc' }],
                filters: [],
                schema: old_schema,
            }],
            columnVisibility: [{ hiddenColumns: [1], schema: old_schema }],
            cellHighlights: {
                sourceDigest: 'digest',
                sheets: [{
                    schema: old_schema,
                    cells: {
                        '0:0': 'green',
                        '1:1': 'yellow',
                        '4:0': 'pink',
                    },
                }],
            },
        };

        const plan = plan_excel_override_state(current, ds.planning_input(), 0, 'People', to)!;

        expect(ds.meta().sheets[0]).toBe(old_sheet);
        expect(plan.state.excelFirstRowHeaders).toEqual({ People: to });
        expect(plan.state.excelFirstRowHeaderActive).toEqual({ People: to === 'on' });
        // Heights survive the toggle now that they are keyed by canonical source row:
        // promoting or demoting a header renumbers only the display space the projection
        // re-derives, so there is nothing here to invalidate. The scroll offset is a pixel
        // measurement of the layout this toggle changes, so it still goes.
        expect(plan.state.rowHeights).toEqual([{ 0: 40 }]);
        expect(plan.state.rowHeightsVersion).toBe(1);
        expect(plan.state.scrollPosition).toEqual([undefined]);
        expect(plan.state.columnWidths).toEqual([{ 0: 120 }]);
        const new_schema = transform_schema_for_sheet(plan.newSheet);
        expect(plan.state.transforms?.[0]?.schema).toBe(new_schema);
        expect(plan.state.columnVisibility?.[0]?.schema).toBe(new_schema);
        expect(plan.state.cellHighlights?.sheets[0]).toEqual({
            schema: new_schema,
            cells: {
                '0:0': 'green',
                '1:1': 'yellow',
                '4:0': 'pink',
            },
        });
    });

    it('performs the first feature migration and preserves widths', () => {
        const ds = source();
        const physical = ds.plan_override('People', 'off')!.sheet;
        const physical_schema = transform_schema_for_sheet(physical);
        const current: PerFileState = {
            columnWidths: [{ 0: 99 }],
            rowHeights: [{ 1: 50 }],
            scrollPosition: [{ top: 12, left: 4 }],
            transforms: [{ sort: [], filters: [], schema: physical_schema }],
            columnVisibility: [{ hiddenColumns: [0], schema: physical_schema }],
        };

        const plan = plan_excel_candidate_state(current, ds.planning_input());

        expect(plan.changed).toBe(true);
        expect(plan.state.excelFirstRowHeaderVersion).toBe(1);
        expect(plan.state.excelFirstRowHeaderActive).toEqual({ People: true });
        // Preserved, not shifted, and not dropped. State with no
        // `excelFirstRowHeaderVersion` has never been read by a header-aware version, so
        // no promotion was ever effective for it and its height keys are already canonical
        // — the promotion this load is applying came after them. Shifting here would be
        // the migration corrupting exactly the data it exists to rescue.
        expect(plan.state.rowHeights).toEqual([{ 1: 50 }]);
        expect(plan.state.rowHeightsVersion).toBe(1);
        expect(plan.state.scrollPosition).toEqual([undefined]);
        expect(plan.state.columnWidths).toEqual([{ 0: 99 }]);
        const projected_schema = transform_schema_for_sheet(ds.meta().sheets[0]);
        expect(plan.state.transforms?.[0]?.schema).toBe(projected_schema);
        expect(plan.state.columnVisibility?.[0]?.schema).toBe(projected_schema);
    });

    it('migrates compatible schemas after a later detector change', () => {
        const ds = source();
        const old_sheet = ds.plan_override('People', 'off')!.sheet;
        const old_schema = transform_schema_for_sheet(old_sheet);
        const plan = plan_excel_candidate_state({
            excelFirstRowHeaderVersion: 1,
            excelFirstRowHeaderActive: { People: false },
            rowHeights: [{ 0: 31 }],
            scrollPosition: [{ top: 8, left: 2 }],
            transforms: [{ sort: [], filters: [], schema: old_schema }],
            columnVisibility: [{ visibleColumns: [0], schema: old_schema }],
        }, ds.planning_input());

        const next_schema = transform_schema_for_sheet(ds.meta().sheets[0]);
        expect(plan.changed).toBe(true);
        expect(plan.state.transforms?.[0]?.schema).toBe(next_schema);
        expect(plan.state.columnVisibility?.[0]?.schema).toBe(next_schema);
        // The recorded projection for this sheet was *unpromoted*, so its height keys were
        // written in the source space and are already canonical. The detector turning the
        // promotion on renumbers the display space, which the delivered projection
        // re-derives; it does not renumber the stored keys.
        expect(plan.state.rowHeights).toEqual([{ 0: 31 }]);
        expect(plan.state.scrollPosition).toEqual([undefined]);
    });

    /**
     * The one-time re-keying of `PerFileState.rowHeights` from display rows to canonical
     * source rows. The only case with any arithmetic in it is a promotion that was
     * *already recorded as active* when the state was written — every other case either
     * leaves the keys alone or drops them — and it is the case the two tests above both
     * miss: `first_migration` and a recorded `previous_active` of `false` are both proofs
     * that the keys are already canonical.
     */
    describe('the one-time row-height re-keying', () => {
        /** State whose heights were written under a promotion recorded as active. */
        const previously_promoted = (
            rowHeights: PerFileState['rowHeights'],
            overrides?: Record<string, 'on' | 'off'>,
        ): PerFileState => ({
            excelFirstRowHeaderVersion: 1,
            excelFirstRowHeaderActive: { People: true },
            ...(overrides ? { excelFirstRowHeaders: overrides } : {}),
            rowHeights,
        });

        it('shifts the keys of a previously auto-promoted sheet by exactly one', () => {
            const ds = source();
            // Auto-detected: the header takes source row 0 out of the display space, so
            // display d was source d + 1. Nothing else in the state changes — the
            // promotion was active before and is active now, which is exactly why this
            // load reaches the migration through the `rowHeightsVersion` marker rather
            // than through a projection change.
            const plan = plan_excel_candidate_state(
                previously_promoted([{ 0: 40, 3: 60 }]),
                ds.planning_input(),
            );

            expect(plan.state.rowHeights).toEqual([{ 1: 40, 4: 60 }]);
            // The pass ran at all despite an unchanged header map, and marked itself
            // done so the next load cannot shift the same keys a second time.
            expect(plan.changed).toBe(true);
            expect(plan.state.rowHeightsVersion).toBe(1);
            expect(plan.state.excelFirstRowHeaderActive).toEqual({ People: true });
        });

        it('drops non-canonical keys and unusable heights instead of coercing them', () => {
            const ds = source();
            const plan = plan_excel_candidate_state(
                previously_promoted([{
                    0: 40,
                    '01': 30,
                    '1.5': 22,
                    '-1': 21,
                    // Durable state is JSON somebody else wrote, so `null` is reachable
                    // where `NaN` is not. Carried through the shift it becomes a height
                    // the projection would hand to Glide, collapsing the row and every
                    // total scroll height computed over it.
                    3: null,
                } as unknown as Record<number, number>]),
                ds.planning_input(),
            );

            // '01' would shift to 2 if it were read as a number, silently resizing a row
            // no writer ever named; the same for a fractional or negative key.
            expect(plan.state.rowHeights).toEqual([{ 1: 40 }]);
        });

        it('shifts an auto-promoted sheet whose first source row is hidden', () => {
            // The auto-detected promotion always takes *projected row 0* out of the display
            // space, and over a physical XLS/XLSX source that is source row 0 — hiding rows
            // does not move it, because `active_header_row` reads `manualHeaderRow` only
            // under an explicit `'on'`. So these keys are recoverable by the ordinary shift.
            //
            // What made this worth a test of its own is that the sheet's *manual* candidate
            // does move: with source row 0 hidden, `manualHeaderSourceRow` is 1. Deriving the
            // old header row by forcing `'on'` through the projection therefore read 1 here,
            // concluded "manual promotion, not reconstructible", and dropped the whole map —
            // permanent loss of heights that a `+1` recovers exactly.
            const ds = source(undefined, undefined, [[0]]);
            expect(ds.meta().sheets[0].excelFirstRowHeader)
                .toMatchObject({ mode: 'auto', active: true });
            expect(ds.planning_input().sheets[0].manualHeaderSourceRow).toBe(1);

            const plan = plan_excel_candidate_state(
                {
                    ...previously_promoted([{ 0: 40, 3: 60 }]),
                    // How the state gets here: the hidden-row transform is durable, so the
                    // projection is built with it, but a resize saved before that transform
                    // installed was written in the un-permuted, header-promoted display
                    // space.
                    transforms: [{
                        sort: [],
                        filters: [],
                        hiddenRows: [0],
                        schema: transform_schema_for_sheet(ds.meta().sheets[0]),
                    }],
                },
                ds.planning_input(),
            );

            expect(plan.state.rowHeights).toEqual([{ 1: 40, 4: 60 }]);
            expect(plan.state.rowHeightsVersion).toBe(1);
        });

        it('drops the keys when the previous promotion had a manual header row', () => {
            const rows = [
                [text('Report'), text('')],
                [text('Notes'), text('')],
                [text('Name'), text('Age')],
                [text('Alice'), number(30)],
            ];
            // Header on source row 2, the rows above it hidden. `excelFirstRowHeaderActive`
            // is a boolean, so a manual header row that moved while the promotion stayed
            // active leaves no trace — the shift would be silently wrong, and wrong
            // heights are indistinguishable from right ones.
            const ds = source('on', rows, [[0, 1]]);
            expect(ds.meta().sheets[0].excelFirstRowHeader)
                .toMatchObject({ active: true, sourceRow: 2 });

            const plan = plan_excel_candidate_state(
                previously_promoted([{ 0: 40, 1: 60 }], { People: 'on' }),
                ds.planning_input(),
            );

            expect(plan.state.rowHeights).toEqual([undefined]);
            expect(plan.state.rowHeightsVersion).toBe(1);
        });

        it('reads the recorded mode from durable state, not from the live source', () => {
            // The same manual-header fixture, with the source built *without* the override
            // the state records. That is the CAS-retry shape: the projection facts come from
            // whatever the load built its source with, while the state being migrated has
            // moved on — and it is the state's own heights that are being re-keyed, so it is
            // the state's own mode that says which space they are in. Taking the mode off the
            // planning input instead reads "auto" here and shifts a manually-promoted map by
            // one, which is the silent off-by-one this whole pass is trying to avoid.
            const rows = [
                [text('Report'), text('')],
                [text('Notes'), text('')],
                [text('Name'), text('Age')],
                [text('Alice'), number(30)],
            ];
            const ds = source(undefined, rows, [[0, 1]]);
            expect(ds.planning_input().sheets[0].override).toBeUndefined();
            expect(ds.planning_input().sheets[0].manualHeaderSourceRow).toBe(2);

            const plan = plan_excel_candidate_state(
                previously_promoted([{ 0: 40, 1: 60 }], { People: 'on' }),
                ds.planning_input(),
            );

            expect(plan.state.rowHeights).toEqual([undefined]);
            expect(plan.state.rowHeightsVersion).toBe(1);
        });

        it('drops the keys when the recorded mode cannot have promoted anything', () => {
            // `'off'` never promotes, so a state recording it beside an active promotion is
            // self-contradictory: one of the two facts is wrong and nothing here says which.
            // Guessing "manual" would shift these keys by one on the strength of a projection
            // query, which is a silent off-by-one bought with no evidence at all.
            const plan = plan_excel_candidate_state(
                previously_promoted([{ 0: 40 }], { People: 'off' }),
                source('off').planning_input(),
            );

            expect(plan.state.rowHeights).toEqual([undefined]);
            expect(plan.state.rowHeightsVersion).toBe(1);
        });

        it('drops the keys when durable state records no projection for the sheet', () => {
            const ds = source();
            // Neither proof is available: the state has been read by a header-aware
            // version (so `first_migration` says nothing) but names no projection for
            // this sheet, so which space the keys are in is simply unknown.
            const plan = plan_excel_candidate_state({
                excelFirstRowHeaderVersion: 1,
                excelFirstRowHeaderActive: {},
                rowHeights: [{ 0: 40 }],
            }, ds.planning_input());

            expect(plan.state.rowHeights).toEqual([undefined]);
        });

        it('runs once: a marked state is left alone even as the promotion goes off', () => {
            const ds = source('off');
            // Everything the shift case has — a promotion recorded active, an
            // auto-detected header row — plus the marker. The load also switches the
            // promotion off, which is the transition that used to *clear* the map, so
            // this pins both halves: no second shift, and no clearing.
            const plan = plan_excel_candidate_state({
                ...previously_promoted([{ 0: 40, 3: 60 }], { People: 'off' }),
                rowHeightsVersion: 1,
            }, ds.planning_input());

            expect(plan.changed).toBe(true);
            expect(plan.state.excelFirstRowHeaderActive).toEqual({ People: false });
            expect(plan.state.rowHeights).toEqual([{ 0: 40, 3: 60 }]);
            // The scroll offset still goes: it is a pixel measurement of the layout this
            // transition changes, and no key space preserves it.
            expect(plan.state.scrollPosition).toEqual([undefined]);
        });

        it('leaves a marked, unchanged state untouched entirely', () => {
            const ds = source();
            const current: PerFileState = {
                ...previously_promoted([{ 1: 40 }]),
                rowHeightsVersion: 1,
            };

            const plan = plan_excel_candidate_state(current, ds.planning_input());

            expect(plan.changed).toBe(false);
            expect(plan.state).toBe(current);
        });

        it('is discharged by an explicit override too, not only by a candidate load', () => {
            // The migration reads `excelFirstRowHeaderActive` to decide which row space the
            // stored keys are in, and this path is the *second* writer of that fact. Left
            // to move it without reconciling the heights, it destroys the evidence: a
            // later `plan_excel_candidate_state` would read the newly-recorded
            // `false`, conclude the keys were already canonical, and stamp
            // `rowHeightsVersion` over a still-display-keyed map — every height on the
            // sheet permanently off by one, with nothing left to detect it.
            //
            // Same fixture and same expected shift as the candidate case above, put
            // through the override planner instead: display 0 and 3 under a row-0
            // promotion are source 1 and 4.
            const ds = source();
            const plan = plan_excel_override_state(
                previously_promoted([{ 0: 40, 3: 60 }]),
                ds.planning_input(),
                0,
                'People',
                'off',
            )!;

            expect(plan.state.rowHeights).toEqual([{ 1: 40, 4: 60 }]);
            expect(plan.state.rowHeightsVersion).toBe(1);
            // Keyed on the *previous* projection, which this toggle is switching off — the
            // keys were written under the promotion, so inverting the unpromoted space
            // (i.e. not shifting) is the wrong answer even though that is what the state
            // will record a moment from now.
            expect(plan.state.excelFirstRowHeaderActive).toEqual({ People: false });
        });

        it('migrates every sheet when an override discharges the marker', () => {
            // The marker is per *file*. Reconciling only the sheet being toggled and then
            // stamping would declare every other sheet's display-keyed map canonical
            // without having touched it — the same permanent off-by-one, on the sheets the
            // user was not even looking at.
            const base = source().planning_input();
            const two_sheets = {
                ...base,
                sheets: [base.sheets[0], { ...base.sheets[0], name: 'Other' }],
            };

            const plan = plan_excel_override_state(
                {
                    excelFirstRowHeaderVersion: 1,
                    excelFirstRowHeaderActive: { People: true, Other: true },
                    rowHeights: [{ 0: 40 }, { 2: 70 }],
                },
                two_sheets,
                0,
                'People',
                'off',
            )!;

            expect(plan.state.rowHeights).toEqual([{ 1: 40 }, { 3: 70 }]);
            expect(plan.state.rowHeightsVersion).toBe(1);
        });

        it('drops trailing slots for sheets the workbook no longer has', () => {
            // The other end of "the marker is per file". A slot past the last sheet belongs
            // to a sheet this workbook does not have, so there are no projection facts to
            // invert its keys with — and copying it through while stamping
            // `rowHeightsVersion: 1` would declare a still-display-keyed map canonical, so
            // if that sheet ever came back every height on it would be off by one for good.
            // Dropped instead: a visible loss of hand-set heights for a sheet that is not
            // in the file beats a silent mis-attribution to rows in one that is.
            const plan = plan_excel_candidate_state(
                previously_promoted([{ 0: 40 }, { 2: 70 }, { 5: 90 }]),
                source().planning_input(),
            );

            // Sheet 0 shifted; slots 1 and 2, which name nothing this one-sheet workbook
            // has, are gone rather than carried forward unmigrated.
            expect(plan.state.rowHeights).toEqual([{ 1: 40 }]);
            expect(plan.state.rowHeightsVersion).toBe(1);
        });

        it('keeps trailing slots on a state the migration does not touch', () => {
            // The truncation belongs to the migration and to nothing else, which is what
            // keeps it from being a drive-by change of behaviour: an already-marked state
            // takes the non-migrating branch and keeps every slot it had, exactly as this
            // file's other per-sheet state does.
            const plan = plan_excel_candidate_state({
                ...previously_promoted([{ 1: 40 }, { 2: 70 }], { People: 'off' }),
                rowHeightsVersion: 1,
            }, source('off').planning_input());

            expect(plan.changed).toBe(true);
            expect(plan.state.rowHeights).toEqual([{ 1: 40 }, { 2: 70 }]);
        });
    });

    it("treats absent authoritative state as auto when the DTO captured 'off'", () => {
        const ds = source('off');
        const plan = plan_excel_candidate_state({
            excelFirstRowHeaderVersion: 1,
            excelFirstRowHeaderActive: { People: false },
        }, ds.planning_input());

        expect(plan.overrides).toEqual({});
        expect(plan.active).toEqual({ People: true });
        expect(plan.meta.sheets[0].excelFirstRowHeader).toMatchObject({
            mode: 'auto', detected: true, active: true,
        });
        ds.replace_overrides(plan.overrides);
        expect(ds.meta()).toEqual(plan.meta);
    });

    it("treats absent authoritative state as auto when the DTO captured 'on'", () => {
        const ds = source('on', [
            [text('Name'), text('City')],
            [text('Alice'), text('London')],
            [text('Bob'), text('Paris')],
        ]);
        const plan = plan_excel_candidate_state({
            excelFirstRowHeaderVersion: 1,
            excelFirstRowHeaderActive: { People: true },
        }, ds.planning_input());

        expect(plan.overrides).toEqual({});
        expect(plan.active).toEqual({ People: false });
        expect(plan.meta.sheets[0].excelFirstRowHeader).toMatchObject({
            mode: 'auto', detected: false, active: false,
        });
        ds.replace_overrides(plan.overrides);
        expect(ds.meta()).toEqual(plan.meta);
    });

    it('rebases an explicit plan from the override in a conflicting state', () => {
        const ds = source('off');
        const input = ds.planning_input();
        const current_sheet = ds.plan_override('People', 'on')!.sheet;
        const current_schema = transform_schema_for_sheet(current_sheet);
        const plan = plan_excel_override_state({
            excelFirstRowHeaders: { People: 'on' },
            excelFirstRowHeaderActive: { People: true },
            excelFirstRowHeaderVersion: 1,
            transforms: [{ sort: [], filters: [], schema: current_schema }],
            columnVisibility: [{ hiddenColumns: [1], schema: current_schema }],
        }, input, 0, 'People', 'off')!;
        const off_schema = transform_schema_for_sheet(plan.newSheet);

        expect(plan.oldSheet.excelFirstRowHeader?.active).toBe(true);
        expect(plan.newSheet.excelFirstRowHeader?.active).toBe(false);
        expect(plan.state.transforms?.[0]?.schema).toBe(off_schema);
        expect(plan.state.columnVisibility?.[0]?.schema).toBe(off_schema);
    });

    it('keeps planning stable after the source is reconfigured', () => {
        const ds = source('off');
        const input = ds.planning_input();
        const current: PerFileState = {
            excelFirstRowHeaderVersion: 1,
            excelFirstRowHeaderActive: { People: false },
        };
        const before = plan_excel_override_state(current, input, 0, 'People', 'on');

        ds.set_override('People', 'on');
        const after = plan_excel_override_state(current, input, 0, 'People', 'on');

        expect(after).toEqual(before);
        expect(Object.isFrozen(input)).toBe(true);
        expect(Object.isFrozen(input.sheets)).toBe(true);
        expect(Object.isFrozen(input.sheets[0].columnNames)).toBe(true);
        expect(Object.isFrozen(input.sheets[0].merges)).toBe(true);
    });

    it('plans a non-hidden manual header and preserves its hidden prefix', () => {
        const rows = [
            [text('Report'), text('')],
            [text('Notes'), text('')],
            [text('Name'), text('Age')],
            [text('Alice'), number(30)],
        ];
        const ds = source('off', rows, [[0, 1]]);
        const old_sheet = ds.meta().sheets[0];
        const plan = plan_excel_override_state({
            excelFirstRowHeaders: { People: 'off' },
            transforms: [{
                sort: [],
                filters: [],
                hiddenRows: [0, 1],
                schema: transform_schema_for_sheet(old_sheet),
            }],
        }, ds.planning_input(), 0, 'People', 'on')!;

        expect(plan.newSheet).toMatchObject({
            columnNames: ['Name', 'Age'],
            excelFirstRowHeader: { active: true, sourceRow: 2 },
        });
        expect(plan.state.transforms?.[0]?.hiddenRows).toEqual([0, 1]);
        expect(plan.state.transforms?.[0]?.schema)
            .toBe(transform_schema_for_sheet(plan.newSheet));
    });

    it('atomically hides the prefix and promotes a selected source row', () => {
        const rows = [
            [text('Report'), text('')],
            [text('Notes'), text('')],
            [text('Name'), text('Age')],
            [text('Alice'), number(30)],
            [text('Archived'), number(99)],
        ];
        const ds = source('off', rows);
        const old_sheet = ds.meta().sheets[0];
        const plan = plan_excel_override_state({
            excelFirstRowHeaders: { People: 'off' },
            transforms: [{
                sort: [{ colIndex: 1, direction: 'asc' }],
                filters: [],
                hiddenRows: [4],
                schema: transform_schema_for_sheet(old_sheet),
            }],
        }, ds.planning_input(), 0, 'People', 'on', {
            headerSourceRow: 2,
            targetInput: ds.planning_input_for_header_source('People', 2),
        })!;

        expect(plan.newSheet).toMatchObject({
            columnNames: ['Name', 'Age'],
            excelFirstRowHeader: { mode: 'on', active: true, sourceRow: 2 },
        });
        expect(plan.state.transforms?.[0]).toMatchObject({
            sort: [{ colIndex: 1, direction: 'asc' }],
            hiddenRows: [0, 1, 4],
            schema: transform_schema_for_sheet(plan.newSheet),
        });
    });

    it('rejects promotion when the selected source row became hidden', () => {
        const ds = source('off', undefined, [[0]]);
        expect(plan_excel_override_state({
            excelFirstRowHeaders: { People: 'off' },
            transforms: [{ sort: [], filters: [], hiddenRows: [0, 1] }],
        }, ds.planning_input(), 0, 'People', 'on', {
            headerSourceRow: 1,
            targetInput: ds.planning_input_for_header_source('People', 1),
        })).toBeUndefined();
    });

    it('atomically disables a nonzero header and unhides rows without clearing sort', () => {
        const rows = [
            [text('Report'), text('')],
            [text('Notes'), text('')],
            [text('Name'), text('Age')],
            [text('Alice'), number(30)],
        ];
        const ds = source('on', rows, [[0, 1]]);
        const old_sheet = ds.meta().sheets[0];
        const plan = plan_excel_override_state({
            excelFirstRowHeaders: { People: 'on' },
            transforms: [{
                sort: [{ colIndex: 1, direction: 'asc' }],
                filters: [],
                hiddenRows: [0, 1],
                schema: transform_schema_for_sheet(old_sheet),
            }],
        }, ds.planning_input(), 0, 'People', 'off', {
            clearHiddenRows: true,
        })!;

        expect(plan.newSheet.excelFirstRowHeader?.active).toBe(false);
        expect(plan.state.excelFirstRowHeaders).toEqual({ People: 'off' });
        expect(plan.state.transforms?.[0]).toEqual({
            sort: [{ colIndex: 1, direction: 'asc' }],
            filters: [],
            schema: transform_schema_for_sheet(plan.newSheet),
        });
    });

    it('rejects a stale manual candidate after hidden rows change', () => {
        const ds = source('off', undefined, [[0]]);
        expect(plan_excel_override_state({
            excelFirstRowHeaders: { People: 'off' },
            transforms: [{ sort: [], filters: [], hiddenRows: [] }],
        }, ds.planning_input(), 0, 'People', 'on')).toBeUndefined();
    });

    it('does not migrate descriptors when sheet identity or count differs', () => {
        const old_sheet: SheetMeta = {
            name: 'People', rowCount: 2, sourceRowCount: 2,
            columnCount: 2, merges: [], hasFormatting: false,
        };
        const entry = [{ sort: [], filters: [], schema: transform_schema_for_sheet(old_sheet) }];
        const renamed = { ...old_sheet, name: 'Renamed' };
        const resized = { ...old_sheet, columnCount: 3 };

        expect(migrate_compatible_sheet_schema(entry, 0, old_sheet, renamed)).toBe(entry);
        expect(migrate_compatible_sheet_schema(entry, 0, old_sheet, resized)).toBe(entry);
    });
});
