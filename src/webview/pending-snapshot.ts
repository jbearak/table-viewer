/**
 * The editing session's Pending Changes as one immutable value per registry
 * revision, with the Worksheet Layouts and Formula Anchor workbook derived
 * from them.
 *
 * A render reads Pending Changes through {@link use_pending_snapshot} and
 * keys its memos on the snapshot, or on the part of it the memo reads. The
 * snapshot changes whenever the registry does, so a memo keyed on it cannot
 * miss a change; its parts keep their identity across revisions that leave
 * them alone, so a memo keyed on a part recomputes only when that part moves.
 */
import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { AnchorWorksheetInput, FormulaAnchorWorkbook } from '../formula-anchor-layout';
import type { PendingStructuralChanges } from '../pending-changes';
import type { EditSessionRegistry } from './edit-session-registry';
import type { DirtyEntry } from './edit-session-store';
import {
    webview_anchor_inputs,
    webview_formula_workbook,
    type AnchorSheetMeta,
} from './formula-anchor-model';

/** What the editing session held at one registry revision. */
export interface PendingSnapshot {
    /** The registry revision this snapshot was read at. */
    readonly revision: number;
    /**
     * Each worksheet's Pending Rows, Pending Columns, removals, and moves, with
     * what is derived from them. The same object from one snapshot to the next
     * until a worksheet's structural Pending Changes or the workbook's
     * worksheets change.
     */
    readonly structure: PendingStructure;
    /**
     * Each worksheet's cell edits. The same object from one snapshot to the
     * next until a cell edit changes, link-only and style-only writes included.
     */
    readonly cells: PendingCells;
}

export interface PendingStructure {
    /** A worksheet's structural Pending Changes, or undefined before it has had any. */
    changes_for(sheet_index: number): PendingStructuralChanges | undefined;
    /** Every worksheet that has structural Pending Changes recorded, by sheet index. */
    readonly by_sheet: ReadonlyMap<number, PendingStructuralChanges>;
    /** Each worksheet as anchoring and the rule split read it. Built on the first call. */
    anchor_inputs(): readonly AnchorWorksheetInput[];
    /**
     * The workbook every formula renders against: each worksheet's Worksheet
     * Layout and append band. Built on the first call.
     */
    formula_workbook(): FormulaAnchorWorkbook;
}

export interface PendingCells {
    /** A worksheet's cell edits by `row:column` key; empty when it has none. */
    cells_for(sheet_index: number): ReadonlyMap<string, DirtyEntry>;
}

/** The workbook facts the derived values read: its worksheets, and whether it is `.xlsx`. */
export interface PendingSnapshotWorkbook {
    readonly sheets: readonly AnchorSheetMeta[];
    /** False for CSV and TSV, whose formulas are never anchored or rendered. */
    readonly xlsx: boolean;
}

export interface PendingSnapshots {
    /**
     * The snapshot for the registry's current revision and `workbook`: the
     * same object as the previous read when neither has changed.
     */
    read(workbook: PendingSnapshotWorkbook): PendingSnapshot;
}

type SnapshotRegistry = Pick<EditSessionRegistry, 'revision' | 'entries' | 'pending_entries'>;

const NO_CELLS: ReadonlyMap<string, DirtyEntry> = new Map();

function same_entries<Value>(
    left: ReadonlyMap<number, Value>,
    right: ReadonlyMap<number, Value>,
): boolean {
    if (left.size !== right.size) return false;
    for (const [key, value] of left) {
        if (right.get(key) !== value) return false;
    }
    return true;
}

function pending_structure(
    by_sheet: ReadonlyMap<number, PendingStructuralChanges>,
    workbook: PendingSnapshotWorkbook,
): PendingStructure {
    const changes_for = (sheet_index: number) => by_sheet.get(sheet_index);
    let anchor_inputs: readonly AnchorWorksheetInput[] | undefined;
    let formula_workbook: FormulaAnchorWorkbook | undefined;
    return Object.freeze({
        changes_for,
        by_sheet,
        anchor_inputs: () => anchor_inputs ??= webview_anchor_inputs(workbook.sheets, changes_for),
        formula_workbook: () => formula_workbook ??= webview_formula_workbook(
            workbook.xlsx,
            workbook.sheets,
            changes_for,
        ),
    });
}

function pending_cells(by_sheet: ReadonlyMap<number, ReadonlyMap<string, DirtyEntry>>): PendingCells {
    return Object.freeze({
        cells_for: (sheet_index: number) => by_sheet.get(sheet_index) ?? NO_CELLS,
    });
}

/**
 * Snapshots of `registry`, one per revision and workbook. Reading the stores
 * costs one `snapshot()` call per worksheet store; the stores hand out
 * copy-on-write values, so a part whose stores all return the values they
 * returned last time is the previous snapshot's part, derived values and all.
 */
export function create_pending_snapshots(registry: SnapshotRegistry): PendingSnapshots {
    let last: {
        readonly snapshot: PendingSnapshot;
        readonly workbook: PendingSnapshotWorkbook;
        readonly structure: ReadonlyMap<number, PendingStructuralChanges>;
        readonly cells: ReadonlyMap<number, ReadonlyMap<string, DirtyEntry>>;
    } | undefined;
    return {
        read: (workbook) => {
            const revision = registry.revision();
            const same_workbook = last !== undefined
                && last.workbook.sheets === workbook.sheets
                && last.workbook.xlsx === workbook.xlsx;
            if (last !== undefined && same_workbook && last.snapshot.revision === revision) {
                return last.snapshot;
            }
            const structure = new Map<number, PendingStructuralChanges>();
            for (const [sheet_index, store] of registry.pending_entries()) {
                structure.set(sheet_index, store.snapshot());
            }
            const cells = new Map<number, ReadonlyMap<string, DirtyEntry>>();
            for (const [sheet_index, store] of registry.entries()) {
                cells.set(sheet_index, store.snapshot());
            }
            const snapshot: PendingSnapshot = Object.freeze({
                revision,
                structure: last !== undefined && same_workbook && same_entries(last.structure, structure)
                    ? last.snapshot.structure
                    : pending_structure(structure, workbook),
                cells: last !== undefined && same_entries(last.cells, cells)
                    ? last.snapshot.cells
                    : pending_cells(cells),
            });
            last = { snapshot, workbook, structure, cells };
            return snapshot;
        },
    };
}

const NO_SHEETS: readonly AnchorSheetMeta[] = [];

/**
 * The registry's current snapshot for this render, re-rendering the caller
 * whenever the registry publishes. `sheets` is the loaded workbook's
 * worksheets, undefined before one loads; `xlsx` is false for CSV and TSV.
 * The registry must stay the same object for the component's lifetime.
 */
export function use_pending_snapshot(
    registry: EditSessionRegistry,
    sheets: readonly AnchorSheetMeta[] | undefined,
    xlsx: boolean,
): PendingSnapshot {
    const snapshots_ref = useRef<PendingSnapshots | null>(null);
    if (snapshots_ref.current === null) snapshots_ref.current = create_pending_snapshots(registry);
    const snapshots = snapshots_ref.current;
    const read = useCallback(
        () => snapshots.read({ sheets: sheets ?? NO_SHEETS, xlsx }),
        [snapshots, sheets, xlsx],
    );
    return useSyncExternalStore(registry.subscribe, read, read);
}
