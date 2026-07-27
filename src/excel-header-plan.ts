import { migrate_cell_highlight_schema } from './cell-highlights';
import {
    project_excel_header_sheet,
    project_excel_header_workbook,
    type ExcelHeaderPlanningInput,
} from './data-source/excel-header-source';
import type { ExcelHeaderOverride, SheetMeta, WorkbookMeta } from './data-source/interface';
import type {
    PerFileState,
    SheetColumnVisibilityState,
    SheetTransformState,
    StoredPerFileState,
} from './types';
import {
    MAX_PERSISTED_HIDDEN_ROWS,
    sanitize_excel_header_active,
    sanitize_excel_header_overrides,
    transform_has_entries,
    transform_schema_for_sheet,
} from './types';
import { normalize_complete_per_file_state } from './viewer-snapshot';

export interface ExcelCandidateStatePlan {
    state: PerFileState;
    changed: boolean;
    active: Record<string, boolean>;
    overrides: Record<string, ExcelHeaderOverride>;
    meta: WorkbookMeta;
}

export interface ExcelOverrideStatePlan {
    state: PerFileState;
    oldSheet: SheetMeta;
    newSheet: SheetMeta;
}

/** Pure legacy/current state normalization shared by every planning retry. */
export function normalize_host_state(
    stored: StoredPerFileState,
    sheet_names: string[],
): PerFileState {
    return normalize_complete_per_file_state(stored, sheet_names);
}

export function effective_excel_header_map(
    sheets: readonly SheetMeta[],
): Record<string, boolean> {
    const result = Object.create(null) as Record<string, boolean>;
    for (const sheet of sheets) {
        result[sheet.name] = sheet.excelFirstRowHeader?.active ?? false;
    }
    return result;
}

export function excel_header_maps_equal(
    left: Record<string, boolean>,
    right: Record<string, boolean>,
): boolean {
    const left_entries = Object.entries(left);
    return left_entries.length === Object.keys(right).length
        && left_entries.every(([name, active]) => (
            Object.prototype.hasOwnProperty.call(right, name)
            && right[name] === active
        ));
}

/**
 * Plan feature migration or a later detector change from immutable projection
 * facts. Conflict retries need only a new state snapshot; they never query the
 * candidate source or rerun detection.
 */
export function plan_excel_candidate_state(
    current: PerFileState,
    input: ExcelHeaderPlanningInput,
): ExcelCandidateStatePlan {
    const overrides = sanitize_excel_header_overrides(current.excelFirstRowHeaders);
    const meta = project_excel_header_workbook(input, overrides);
    const sheets = meta.sheets;
    const previous_active = sanitize_excel_header_active(
        current.excelFirstRowHeaderActive,
    );
    const next_active = effective_excel_header_map(sheets);
    const first_migration = current.excelFirstRowHeaderVersion !== 1;
    /**
     * The one-time reconciliation of `PerFileState.rowHeights` with the canonical
     * source-row key space it is now documented in.
     *
     * Every pre-migration height key is a *display* row. Display and source rows are the
     * same numbers except where the projection differs from the source, and for heights
     * there is exactly one such case: an active first-row-header promotion, which removes
     * the header row from the display space and shifts everything after it up by one. A
     * permutation would be another, but no released version could have written a permuted
     * height — the suppression that replaced the map with `{}` under an active transform
     * shipped in the same commit that added sorting and filtering. So the sheets needing
     * repair are exactly those with an active promotion, and every other sheet's keys are
     * already canonical and are left alone. CSV among them: `rowCount === sourceRowCount`
     * there and no promotion exists, which is why CSV never calls this function and never
     * needs to.
     *
     * For the promoted sheets the keys are *recoverable* rather than lost, and recovering
     * them is worth the care because the alternative discards work the user did by hand.
     * Every promotion *transition* already cleared the map — the projection-changed branch
     * below did, and `plan_excel_override_state` did unconditionally — so a surviving
     * durable map was written in the display space of the promotion last recorded as
     * active for that sheet. Inverting that space is `source = d < h ? d : d + 1` for
     * header row `h`, which for `h === 0` is a shift by one.
     *
     * Per sheet, and decided from what durable state can actually prove about that sheet
     * rather than from what this load is doing — `pre_migration_row_height_space` is where
     * the three cases and their proofs live. The one worth flagging here is that
     * `first_migration` means *canonical*, not promoted: state with no
     * `excelFirstRowHeaderVersion` predates the header feature, so its keys were written
     * before any promotion existed and shifting them would break heights this pass exists
     * to preserve.
     *
     * Lives here rather than in a dedicated migration because this function already runs
     * on every Excel load with the projection facts in hand, and heights only ever need
     * repair on a format that reaches it.
     */
    const row_heights_migration = current.rowHeightsVersion !== 1;
    if (
        !first_migration
        && !row_heights_migration
        && excel_header_maps_equal(previous_active, next_active)
    ) {
        return {
            state: current,
            changed: false,
            active: next_active,
            overrides,
            meta,
        };
    }

    // Ahead of the per-sheet loop below and independent of its `projection_changed` gate.
    // The question the migration asks is not "did this load change the projection?" but
    // "which space are this sheet's stored keys in?", and in the common upgrade — a
    // promotion active and unchanged — the answer is "the promoted one" while
    // `projection_changed` is false. Shared with `plan_excel_override_state`, the other
    // writer of `excelFirstRowHeaderActive`, so the two cannot reach different verdicts
    // about the same state; see `migrate_row_heights_for_file`.
    const rowHeights = row_heights_migration
        ? migrate_row_heights_for_file(current, input)
        : [...(current.rowHeights ?? [])];
    const scrollPosition = [...(current.scrollPosition ?? [])];
    let transforms = current.transforms;
    let columnVisibility = current.columnVisibility;
    let cellHighlights = current.cellHighlights;

    sheets.forEach((sheet, index) => {
        const next_is_active = next_active[sheet.name] ?? false;
        const had_previous = Object.prototype.hasOwnProperty.call(
            previous_active,
            sheet.name,
        );
        const previous_is_active = first_migration
            ? false
            : had_previous
            ? previous_active[sheet.name]
            : false;
        const matched_planning_sheet = input.sheets[index]?.name === sheet.name
            ? input.sheets[index]
            : undefined;
        const projection_changed = first_migration
            ? next_is_active
            : !had_previous
            ? next_is_active
            : previous_is_active !== next_is_active;
        if (!projection_changed) return;

        // `rowHeights` is deliberately *not* cleared here any more. Heights are keyed by
        // canonical source row, so a promotion coming or going renumbers only the display
        // space the projection re-derives, and the stored keys still name the same rows.
        // Clearing them was the old design's only defence against a display-keyed map,
        // and it cost the user every custom height each time they toggled a header.
        //
        // `scrollPosition` still goes, and the asymmetry is real rather than an
        // oversight: a scroll offset is a pixel measurement of a specific row layout, so
        // there is no key space in which it survives the layout changing. It is genuinely
        // invalidated; heights are not.
        scrollPosition[index] = undefined;
        if (!matched_planning_sheet) return;
        const previous = project_excel_header_sheet(
            matched_planning_sheet,
            previous_is_active ? 'on' : 'off',
        );
        transforms = migrate_compatible_sheet_schema(
            transforms,
            index,
            previous,
            sheet,
        );
        columnVisibility = migrate_compatible_sheet_schema(
            columnVisibility,
            index,
            previous,
            sheet,
        );
        cellHighlights = migrate_cell_highlight_schema(
            cellHighlights,
            index,
            previous,
            sheet,
        );
    });

    return {
        changed: true,
        active: next_active,
        overrides,
        meta,
        state: {
            ...current,
            rowHeights,
            scrollPosition,
            transforms,
            columnVisibility,
            cellHighlights,
            excelFirstRowHeaderActive: next_active,
            excelFirstRowHeaderVersion: 1,
            rowHeightsVersion: 1,
        },
    };
}

/**
 * Run the one-time row-height re-keying over every sheet of a file, for a writer that is
 * about to move `excelFirstRowHeaderActive` without doing the projection planning
 * `plan_excel_candidate_state` does.
 *
 * It exists because there are **two** writers of `excelFirstRowHeaderActive`, and the
 * migration keys off exactly that fact: `pre_migration_row_height_space` reads
 * `previous_active` — with `excelFirstRowHeaders` beside it for *which* promotion was
 * recorded — to decide which row space the stored keys are in. A writer that flips the
 * recorded projection without discharging the migration destroys the evidence the migration
 * needs — a later `plan_excel_candidate_state` would see `previous_active` say "unpromoted",
 * conclude `canonical`, and stamp still-display-keyed heights as canonical, leaving every
 * height on that sheet permanently off by one. So both writers reconcile the heights, and
 * both stamp `rowHeightsVersion`.
 *
 * Every sheet, not only the one being toggled, and that is the load-bearing part: the
 * marker is per *file*, so migrating one sheet and stamping would declare the other
 * sheets' display-keyed maps canonical without ever having touched them.
 *
 * Keyed on the state's *previous* recorded projection throughout, for the reason spelled
 * out at the call site in `plan_excel_candidate_state`: the keys were written under
 * whatever was last effective, so a write that is switching a promotion off still has to
 * invert the promoted space the keys are in.
 */
function migrate_row_heights_for_file(
    current: PerFileState,
    input: ExcelHeaderPlanningInput,
): (Record<number, number> | undefined)[] {
    const first_migration = current.excelFirstRowHeaderVersion !== 1;
    const previous_active = sanitize_excel_header_active(
        current.excelFirstRowHeaderActive,
    );
    // The *mode* the stored keys were written under, alongside the *active* flag that says
    // whether that mode promoted anything. Two durable facts rather than one because the
    // second cannot be recovered from the projection: see
    // `pre_migration_row_height_space`.
    //
    // Read from `current` rather than from `input.sheets[].override`, and the two are not
    // interchangeable. The planning input's override is whatever the live source was built
    // with, which on a CAS retry is the load's own starting point rather than the state
    // being migrated; `current` is the state whose `rowHeights` are about to be re-keyed,
    // and the pair (`excelFirstRowHeaders`, `excelFirstRowHeaderActive`) only ever moves
    // together, host-side, in the two planners here — neither is a `LayoutStatePatch` leaf,
    // so no webview write can separate them.
    const previous_overrides = sanitize_excel_header_overrides(
        current.excelFirstRowHeaders,
    );
    // Built to the workbook's own length rather than copied from `current.rowHeights`,
    // which drops any slot past the last sheet this workbook has — and dropping is the
    // honest answer here rather than the lazy one.
    //
    // The marker this migration stamps is per *file*, so keeping such a slot would
    // declare a still-display-keyed map canonical; if that sheet ever came back, every
    // height on it would be off by one, permanently and with nothing to notice it by.
    // Migrating it instead is not available: the shift needs that sheet's projection facts
    // (`headerSourceRow`, via `project_excel_header_sheet` inside
    // `pre_migration_row_height_space`) and a sheet the workbook does not have supplies
    // none — there is literally nothing to invert the old key space with. So the choice is
    // between a silent off-by-one and losing hand-set heights for a sheet that is not in
    // the file, and the visible loss is the smaller harm.
    //
    // Worth naming the case this does change behaviour for: a sheet absent only
    // *temporarily* — an external write that removes it, a later one that puts it back —
    // loses its custom heights, where before this it kept them (mis-keyed). Accepted, and
    // not a new exposure: durable per-sheet state here is positional, a workbook that lost
    // a sheet has already renumbered every slot after it, and this file already drops
    // trailing state on that same reasoning (`scrollPosition`, and the
    // `excelFirstRowHeaderVersion` migration).
    return input.sheets.map((planning_sheet, index) => (
        migrate_display_keyed_row_heights(
            current.rowHeights?.[index],
            pre_migration_row_height_space(
                first_migration,
                Object.prototype.hasOwnProperty.call(
                    previous_active,
                    planning_sheet.name,
                ),
                first_migration ? false : previous_active[planning_sheet.name],
                Object.prototype.hasOwnProperty.call(
                    previous_overrides,
                    planning_sheet.name,
                ) ? previous_overrides[planning_sheet.name] : undefined,
                planning_sheet,
            ),
        )
    ));
}

/** Plan a durable explicit override solely from state plus immutable facts. */
export function plan_excel_override_state(
    current: PerFileState,
    input: ExcelHeaderPlanningInput,
    sheet_index: number,
    sheet_name: string,
    override: ExcelHeaderOverride,
    options?: {
        clearHiddenRows?: boolean;
        headerSourceRow?: number;
        targetInput?: ExcelHeaderPlanningInput;
    },
): ExcelOverrideStatePlan | undefined {
    if (
        (options?.clearHiddenRows && override !== 'off')
        || (options?.headerSourceRow !== undefined && override !== 'on')
        || (options?.clearHiddenRows && options.headerSourceRow !== undefined)
    ) return undefined;
    const planning_sheet = input.sheets[sheet_index];
    if (!planning_sheet || planning_sheet.name !== sheet_name) return undefined;
    const excelFirstRowHeaders = sanitize_excel_header_overrides(
        current.excelFirstRowHeaders,
    );
    const current_override = Object.prototype.hasOwnProperty.call(
        excelFirstRowHeaders,
        sheet_name,
    ) ? excelFirstRowHeaders[sheet_name] : undefined;
    if (
        (current_override === 'on' || override === 'on')
        && Object.prototype.hasOwnProperty.call(
            planning_sheet,
            'manualHeaderSourceRow',
        )
    ) {
        const hidden_rows = current.transforms?.[sheet_index]?.hiddenRows;
        if (
            first_non_hidden_source_row(planning_sheet.sourceRowCount, hidden_rows)
            !== planning_sheet.manualHeaderSourceRow
        ) return undefined;
    }
    const old_sheet = project_excel_header_sheet(planning_sheet, current_override);
    let next_planning_sheet = planning_sheet;
    let transforms = current.transforms;
    if (options?.headerSourceRow !== undefined) {
        const target_sheet = options.targetInput?.sheets[sheet_index];
        if (
            !target_sheet
            || target_sheet.name !== planning_sheet.name
            || target_sheet.rowCount !== planning_sheet.rowCount
            || target_sheet.sourceRowCount !== planning_sheet.sourceRowCount
            || target_sheet.columnCount !== planning_sheet.columnCount
            || target_sheet.manualHeaderSourceRow !== options.headerSourceRow
            || target_sheet.manualHeaderRow === undefined
        ) return undefined;
        const hidden_rows = hidden_rows_before_header(
            current.transforms?.[sheet_index]?.hiddenRows,
            options.headerSourceRow,
            planning_sheet.sourceRowCount,
        );
        if (
            !hidden_rows
            || first_non_hidden_source_row(
                planning_sheet.sourceRowCount,
                hidden_rows,
            ) !== options.headerSourceRow
        ) return undefined;
        if (hidden_rows.length > 0) {
            transforms = [...(transforms ?? [])];
            const retained = transforms[sheet_index] ?? {
                sort: [],
                filters: [],
                schema: transform_schema_for_sheet(old_sheet),
            };
            transforms[sheet_index] = { ...retained, hiddenRows: hidden_rows };
        }
        next_planning_sheet = target_sheet;
    }
    const new_sheet = project_excel_header_sheet(next_planning_sheet, override);
    excelFirstRowHeaders[sheet_name] = override;
    const excelFirstRowHeaderActive = sanitize_excel_header_active(
        current.excelFirstRowHeaderActive,
    );
    excelFirstRowHeaderActive[sheet_name] = (
        new_sheet.excelFirstRowHeader?.active ?? false
    );
    // Once the migration is discharged, `rowHeights` needs nothing from this toggle:
    // source-keyed heights name the same rows whichever way it goes, and the display-keyed
    // projection is re-derived from the new projection on the next delivery. That is a
    // statement about the *post*-migration regime, though, and this function is the second
    // writer of `excelFirstRowHeaderActive` — the fact the migration reads to decide which
    // row space the stored keys are in. So while the migration is still owed, it is
    // discharged here rather than deferred: see `migrate_row_heights_for_file` for what
    // goes wrong if the two writers disagree. Untouched afterwards, when
    // `rowHeightsVersion` is already 1.
    //
    // `scrollPosition`, by contrast, is genuinely invalidated in every regime — it is a
    // pixel offset into a row layout this override changes. See the same asymmetry in
    // `plan_excel_candidate_state`.
    const row_heights_migration = current.rowHeightsVersion !== 1;
    const rowHeights = row_heights_migration
        ? migrate_row_heights_for_file(current, input)
        : undefined;
    const scrollPosition = [...(current.scrollPosition ?? [])];
    scrollPosition[sheet_index] = undefined;
    if (options?.clearHiddenRows && transforms?.[sheet_index]?.hiddenRows) {
        transforms = [...transforms];
        const { hiddenRows: _hidden_rows, ...retained } = transforms[sheet_index]!;
        transforms[sheet_index] = transform_has_entries(retained) ? retained : undefined;
    }

    return {
        oldSheet: old_sheet,
        newSheet: new_sheet,
        state: {
            ...current,
            excelFirstRowHeaders,
            excelFirstRowHeaderActive,
            excelFirstRowHeaderVersion: 1,
            ...(rowHeights === undefined ? {} : { rowHeights }),
            rowHeightsVersion: 1,
            scrollPosition,
            transforms: migrate_compatible_sheet_schema(
                transforms,
                sheet_index,
                old_sheet,
                new_sheet,
            ),
            columnVisibility: migrate_compatible_sheet_schema(
                current.columnVisibility,
                sheet_index,
                old_sheet,
                new_sheet,
            ),
            cellHighlights: migrate_cell_highlight_schema(
                current.cellHighlights,
                sheet_index,
                old_sheet,
                new_sheet,
            ),
        },
    };
}

/**
 * Which row space one sheet's pre-migration `rowHeights` keys are in.
 *
 * `canonical` is a *proof*, not a default, and there are two of them. The stronger one is
 * `first_migration`: no `excelFirstRowHeaderVersion` means this state has never been read
 * by a header-aware version, so no promotion can ever have been effective for it and the
 * display space it was written in was the source space. (This is also why the pass must
 * not shift there — the promotion this very load is about to apply came after the keys,
 * not before them.) The weaker one is a recorded `previous_active` of `false`: the last
 * effective projection for this sheet was unpromoted, so the same equality held.
 *
 * `promoted` is the recorded-active case. Every promotion *transition* cleared the map
 * before this PR, so a map that survived was written under the promotion still recorded
 * as active, and `headerSourceRow` is that promotion's own header row — the previous
 * projection's, not the incoming one's, because a load that is switching the promotion off
 * still has to invert the space the keys are in.
 *
 * Which row that was is decided from the recorded *mode*, and deriving it from the
 * projection instead is the mistake this signature exists to make unwritable. The two
 * promotions put their header in different places: an auto-detected one always takes
 * *projected row 0*, which over a physical XLS/XLSX source is source row 0 (the only
 * sources header authority is ever built over — see `first_non_hidden_source_row`),
 * while an explicit `'on'` takes the sheet's manual candidate,
 * `manualHeaderSourceRow`. Asking the projection for "the header row if this were `'on'`"
 * answers the *manual* question for both, and that answer is wrong for an auto promotion
 * the moment the manual candidate is not row 0 — which durable `hiddenRows` alone is
 * enough to arrange, because hiding source row 0 moves the manual candidate to row 1 and
 * moves the auto promotion not at all. The keys were then dropped as "manual, not
 * reconstructible" when they were an ordinary `+1` away from correct: permanent loss of
 * hand-set heights, on the upgrade this whole pass exists to get right.
 *
 * `'off'` cannot have been the mode that promoted anything, so a state recording it
 * *alongside* an active promotion is self-contradictory. The keys are dropped rather than
 * arbitrated: one of the two facts is wrong and there is nothing here to say which.
 *
 * `unknown` is likewise the honest answer when `excelFirstRowHeaderActive` has no entry for
 * the sheet, or the planning input no longer lines up with it by name. No proof is
 * available, so the keys are dropped rather than guessed at.
 */
type PreMigrationRowHeightSpace =
    | { readonly kind: 'canonical' }
    | { readonly kind: 'promoted'; readonly headerSourceRow: number | undefined }
    | { readonly kind: 'unknown' };

function pre_migration_row_height_space(
    first_migration: boolean,
    had_previous: boolean,
    previous_is_active: boolean,
    previous_mode: ExcelHeaderOverride | undefined,
    matched_planning_sheet: ExcelHeaderPlanningInput['sheets'][number] | undefined,
): PreMigrationRowHeightSpace {
    if (first_migration) return { kind: 'canonical' };
    if (!had_previous || !matched_planning_sheet) return { kind: 'unknown' };
    if (!previous_is_active) return { kind: 'canonical' };
    if (previous_mode === 'off') return { kind: 'unknown' };
    // The auto-detected promotion, which is essentially all of it in the field: the header
    // is projected row 0, so the shift is by one and no projection query is needed to know
    // that. Querying one would in fact answer a different question; see above.
    if (previous_mode === undefined) return { kind: 'promoted', headerSourceRow: 0 };
    return {
        kind: 'promoted',
        headerSourceRow: project_excel_header_sheet(matched_planning_sheet, 'on')
            .excelFirstRowHeader?.sourceRow,
    };
}

/**
 * Re-key one sheet's pre-migration display-keyed heights into canonical source rows, drop
 * them when the old key space cannot be inverted, or leave them alone when they are
 * already canonical. See `pre_migration_row_height_space` and the argument at
 * `row_heights_migration` in `plan_excel_candidate_state`.
 *
 * The shift is `source = display + 1`, and it is applied only for `headerSourceRow === 0`
 * — the auto-detected promotion, where the header took source row 0 out of the display
 * space and everything after it moved up one. A manual header row is dropped instead, not
 * because the arithmetic differs but because `h` is not trustworthy there: the recorded
 * projection is a boolean, so a manual header row that moved while the promotion stayed
 * active leaves no trace, and a wrong shift is silently wrong heights indistinguishable
 * from right ones.
 *
 * Non-canonical keys are dropped rather than coerced, matching the numeric-key test the
 * layout patcher applies to the same maps: a key no writer could have produced names no
 * row, and guessing which row it meant is how an off-by-one becomes permanent.
 */
function migrate_display_keyed_row_heights(
    stored: Record<number, number> | undefined,
    space: PreMigrationRowHeightSpace,
): Record<number, number> | undefined {
    if (!stored) return undefined;
    if (space.kind === 'canonical') return stored;
    if (space.kind === 'unknown' || space.headerSourceRow !== 0) return undefined;
    let migrated: Record<number, number> | undefined;
    for (const [key, height] of Object.entries(stored)) {
        const display_row = Number(key);
        if (
            !Number.isSafeInteger(display_row)
            || display_row < 0
            || String(display_row) !== key
            || !Number.isFinite(height)
        ) continue;
        migrated ??= {};
        migrated[display_row + 1] = height;
    }
    return migrated;
}

function hidden_rows_before_header(
    current: readonly number[] | undefined,
    header_source_row: number,
    source_row_count: number,
): number[] | undefined {
    if (
        !Number.isInteger(header_source_row)
        || header_source_row < 0
        || header_source_row >= source_row_count
    ) return undefined;
    const suffix: number[] = [];
    let previous = -1;
    for (const row of current ?? []) {
        if (!Number.isInteger(row) || row < 0 || row >= source_row_count) continue;
        if (row === header_source_row) return undefined;
        if (row > header_source_row && row !== previous) suffix.push(row);
        previous = row;
    }
    if (header_source_row + suffix.length > MAX_PERSISTED_HIDDEN_ROWS) {
        return undefined;
    }
    const hidden_rows = Array.from(
        { length: header_source_row },
        (_, row) => row,
    );
    for (const row of suffix) hidden_rows.push(row);
    return hidden_rows;
}

function first_non_hidden_source_row(
    source_row_count: number,
    hidden_rows: readonly number[] | undefined,
): number | undefined {
    // Header authority is only constructed over the physical XLS/XLSX sources,
    // whose canonical source IDs are their zero-based physical row positions.
    if (!Array.isArray(hidden_rows)) return source_row_count > 0 ? 0 : undefined;
    let candidate = 0;
    for (const row of hidden_rows) {
        if (!Number.isInteger(row) || row < candidate) continue;
        if (row !== candidate) break;
        candidate += 1;
    }
    return candidate < source_row_count ? candidate : undefined;
}

function compatible_sheet(left: SheetMeta, right: SheetMeta): boolean {
    return left.name === right.name && left.columnCount === right.columnCount;
}

export function migrate_compatible_sheet_schema<T extends SheetTransformState | SheetColumnVisibilityState>(
    entries: (T | undefined)[] | undefined,
    sheet_index: number,
    old_sheet: SheetMeta,
    new_sheet: SheetMeta,
): (T | undefined)[] | undefined {
    if (!compatible_sheet(old_sheet, new_sheet)) return entries;
    const entry = entries?.[sheet_index];
    const old_schema = transform_schema_for_sheet(old_sheet);
    if (!entries || !entry || entry.schema !== old_schema) return entries;
    const next = [...entries];
    next[sheet_index] = {
        ...entry,
        schema: transform_schema_for_sheet(new_sheet),
    };
    return next;
}
