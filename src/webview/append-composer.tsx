import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * The guided row composer: a `Compose row…` button that mounts into the append
 * dock's action row and the form panel it opens in the dock's place.
 *
 * Its open state is controlled by the shell rather than held here, because the
 * dock hides its own quick-add controls while the composer is up. Two `add`
 * buttons visible at once — one staging blank rows, one staging the composed
 * values — read as alternatives to each other when they are not related at all.
 *
 * It exists for wide tables. Typing a row directly into the grid means
 * scrolling horizontally and losing sight of the column names; the composer
 * lays the same row out as a vertical list of labeled fields, so every column
 * name is readable at once.
 *
 * It is an input method, not a separate kind of row. Staging goes through the
 * same append gesture quick add uses, the rows land in the same pending band,
 * and one staging gesture is one history entry. The component owns no append
 * machinery of its own — it collects text and hands it to `on_stage_rows`.
 *
 * Fields map to the VISIBLE columns only. Offering source-column entry would
 * re-open the display-row/source-row aliasing this codebase already fought, so
 * hidden columns simply stage blank.
 *
 * There is no validation before staging and no formula-specific field: a value
 * starting with `=` stages exactly as that text typed into a cell would.
 */

/**
 * One composed row per entry, keyed by SOURCE column.
 *
 * Keyed by source rather than display position because a draft outlives the
 * projection it was authored against: hiding or revealing a column shifts every
 * display index, and a positional draft would silently re-pair its values with
 * whatever columns now sit at those positions. A source key survives any
 * projection change — a value returns to the column it was typed for when that
 * column comes back, and is neither shown nor staged while it is hidden.
 */
export type AppendComposerDraft = readonly Readonly<Record<number, string>>[];

export const EMPTY_APPEND_COMPOSER_DRAFT: AppendComposerDraft = [];

export interface AppendComposerProps {
    /** Visible column titles, indexed by display column. */
    readonly column_labels: readonly string[];
    /** Source column each label belongs to, same order — the draft's keys. */
    readonly source_columns: readonly number[];
    /**
     * Worksheet row number the first composed row will take, 1-based. Legends
     * count up from it: a draft's second row is not "Row 2" of anything the
     * user can see, it is the row after the one the first will land on.
     */
    readonly first_row_number: number;
    /**
     * The session's held draft. Lifted above the dock deliberately: closing the
     * composer keeps un-staged values for the session rather than asking for a
     * confirmation on a lightweight input surface, and the dock unmounts the
     * composer when it closes.
     */
    readonly draft: AppendComposerDraft;
    readonly on_draft_change: (draft: AppendComposerDraft) => void;
    /** Rows this gesture may still stage; the composer will not exceed it. */
    readonly remaining_capacity: number;
    /** An append reservation is outstanding; the composer waits it out. */
    readonly busy?: boolean;
    /** Whether the form panel is up. Owned by the shell — see the note above. */
    readonly open: boolean;
    readonly on_open_change: (open: boolean) => void;
    /**
     * Stage the composed rows as one gesture. Resolves `true` once they are in
     * the pending band, `false` if admission refused — a refusal keeps the
     * panel open on the same values.
     */
    readonly on_stage_rows: (rows: AppendComposerDraft) => Promise<boolean>;
    /** Successful staging closes both the composer and its owning dock. */
    readonly on_stage_success: () => void;
}

const blank_row = (): Readonly<Record<number, string>> => ({});

/**
 * The draft as the panel renders it: at least one row, so an untouched composer
 * still offers a row to fill. Values need no reshaping — they are keyed by
 * source column, so they stay attached to their column across any projection
 * change.
 */
export function normalize_draft(
    draft: AppendComposerDraft,
): readonly Readonly<Record<number, string>>[] {
    return draft.length === 0 ? [blank_row()] : draft;
}

export function AppendComposer({
    column_labels,
    source_columns,
    first_row_number,
    draft,
    on_draft_change,
    remaining_capacity,
    busy = false,
    open,
    on_open_change,
    on_stage_rows,
    on_stage_success,
}: AppendComposerProps): React.ReactElement {
    const [staging, set_staging] = useState(false);
    const launcher_ref = useRef<HTMLButtonElement>(null);
    const first_field_ref = useRef<HTMLInputElement>(null);
    const stage_ref = useRef<HTMLButtonElement>(null);
    const refocus_launcher_ref = useRef(false);
    const refocus_stage_ref = useRef(false);

    const rows = useMemo(() => normalize_draft(draft), [draft]);

    const close = useCallback(() => {
        refocus_launcher_ref.current = true;
        on_open_change(false);
    }, [on_open_change]);

    useEffect(() => {
        if (open) {
            first_field_ref.current?.focus();
            return;
        }
        if (!refocus_launcher_ref.current) return;
        refocus_launcher_ref.current = false;
        launcher_ref.current?.focus();
    }, [open]);

    const set_field = useCallback((
        row_index: number,
        source_column: number,
        value: string,
    ) => {
        on_draft_change(rows.map((row, index) => (index === row_index
            ? { ...row, [source_column]: value }
            : row)));
    }, [on_draft_change, rows]);

    const add_another_row = useCallback(() => {
        on_draft_change([...rows, blank_row()]);
    }, [on_draft_change, rows]);

    const remove_last_row = useCallback(() => {
        if (rows.length <= 1) return;
        if (rows.length === 2) refocus_stage_ref.current = true;
        on_draft_change(rows.slice(0, -1));
    }, [on_draft_change, rows]);

    const in_flight = busy || staging;
    const satisfiable = rows.length >= 1 && rows.length <= remaining_capacity;

    const stage = useCallback(async () => {
        if (in_flight || !satisfiable) return;
        set_staging(true);
        try {
            if (await on_stage_rows(rows)) {
                // Staging consumes the draft and moves focus into the grid, so
                // the composer has nothing left to hold.
                on_draft_change(EMPTY_APPEND_COMPOSER_DRAFT);
                on_stage_success();
            } else {
                refocus_stage_ref.current = true;
            }
        } finally {
            set_staging(false);
        }
    }, [in_flight, on_draft_change, on_stage_rows, on_stage_success, rows, satisfiable]);

    useEffect(() => {
        if (in_flight || !refocus_stage_ref.current) return;
        refocus_stage_ref.current = false;
        stage_ref.current?.focus();
    }, [in_flight, rows.length]);

    const stage_label = rows.length === 1 ? 'Stage row' : `Stage ${rows.length} rows`;

    return (
        <div
            className="append-composer"
            onKeyDown={(event) => {
                if (event.key !== 'Escape' || !open) return;
                event.preventDefault();
                event.stopPropagation();
                close();
            }}
        >
            {!open && (
                <button
                    ref={launcher_ref}
                    type="button"
                    className="append-composer-launcher"
                    aria-expanded="false"
                    onClick={() => { on_open_change(true); }}
                >
                    Compose row…
                </button>
            )}
            {open && (
                <div
                    className="append-composer-panel"
                    role="dialog"
                    aria-label="Compose a row from the visible columns"
                >
                    <div className="append-composer-fields">
                        {rows.map((row, row_index) => (
                            // Draft rows have no identity beyond their position:
                            // they are only ever appended to, and reordering them
                            // is not an affordance the composer offers.
                            // eslint-disable-next-line react/no-array-index-key
                            <fieldset className="append-composer-row" key={row_index}>
                                <legend>
                                    {`Row ${(first_row_number + row_index).toLocaleString('en-US')}`}
                                </legend>
                                {column_labels.map((label, column) => {
                                    const field_id
                                        = `append-composer-${row_index}-${column}`;
                                    const source_column = source_columns[column];
                                    if (source_column === undefined) return null;
                                    return (
                                        <div className="append-composer-field" key={field_id}>
                                            <label htmlFor={field_id}>{label}</label>
                                            <input
                                                ref={row_index === 0 && column === 0
                                                    ? first_field_ref
                                                    : undefined}
                                                id={field_id}
                                                type="text"
                                                value={row[source_column] ?? ''}
                                                disabled={in_flight}
                                                onChange={(event) => {
                                                    set_field(
                                                        row_index,
                                                        source_column,
                                                        event.target.value,
                                                    );
                                                }}
                                            />
                                        </div>
                                    );
                                })}
                            </fieldset>
                        ))}
                    </div>
                    <div className="append-composer-actions">
                        <button
                            type="button"
                            className="append-composer-add-row"
                            disabled={in_flight || rows.length >= remaining_capacity}
                            onClick={add_another_row}
                        >
                            Add another row
                        </button>
                        {rows.length > 1 && (
                            <button
                                type="button"
                                className="append-composer-remove-row"
                                disabled={in_flight}
                                onClick={remove_last_row}
                            >
                                Remove last row
                            </button>
                        )}
                        <button
                            ref={stage_ref}
                            type="button"
                            className="append-composer-stage"
                            disabled={in_flight || !satisfiable}
                            onClick={() => { void stage(); }}
                        >
                            {in_flight ? 'Staging…' : stage_label}
                        </button>
                        <button
                            type="button"
                            className="append-composer-close"
                            disabled={in_flight}
                            onClick={close}
                        >
                            Close
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
