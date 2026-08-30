import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * The guided row composer: a `Compose row…` button that mounts into the append
 * dock's action row and the form panel it opens above the dock.
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
 * One composed row per entry, indexed by display column. Ragged rows are
 * legal — a short row stages blank in the columns it does not reach, which is
 * what lets the draft survive a column being revealed while it is held.
 */
export type AppendComposerDraft = readonly (readonly string[])[];

export const EMPTY_APPEND_COMPOSER_DRAFT: AppendComposerDraft = [];

export interface AppendComposerProps {
    /** Visible column titles, indexed by display column. */
    readonly column_labels: readonly string[];
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
    /**
     * Stage the composed rows as one gesture. Resolves `true` once they are in
     * the pending band, `false` if admission refused — a refusal keeps the
     * panel open on the same values.
     */
    readonly on_stage_rows: (rows: AppendComposerDraft) => Promise<boolean>;
}

const blank_row = (width: number): readonly string[] => new Array<string>(width).fill('');

/**
 * The draft as the panel renders it: at least one row, every row as wide as the
 * current visible column count. Normalizing at render rather than on change is
 * what keeps a held draft usable after a column is hidden or revealed.
 */
export function normalize_draft(
    draft: AppendComposerDraft,
    width: number,
): readonly (readonly string[])[] {
    const rows = draft.length === 0 ? [blank_row(width)] : draft;
    return rows.map((row) => Array.from({ length: width }, (_, index) => row[index] ?? ''));
}

export function AppendComposer({
    column_labels,
    draft,
    on_draft_change,
    remaining_capacity,
    busy = false,
    on_stage_rows,
}: AppendComposerProps): React.ReactElement {
    const [open, set_open] = useState(false);
    const [staging, set_staging] = useState(false);
    const launcher_ref = useRef<HTMLButtonElement>(null);
    const first_field_ref = useRef<HTMLInputElement>(null);

    const rows = useMemo(
        () => normalize_draft(draft, column_labels.length),
        [draft, column_labels.length],
    );

    const close = useCallback(() => {
        set_open(false);
        launcher_ref.current?.focus();
    }, []);

    useEffect(() => {
        if (open) first_field_ref.current?.focus();
    }, [open]);

    const set_field = useCallback((row_index: number, column: number, value: string) => {
        on_draft_change(rows.map((row, index) => (index === row_index
            ? row.map((cell, cell_index) => (cell_index === column ? value : cell))
            : row)));
    }, [on_draft_change, rows]);

    const add_another_row = useCallback(() => {
        on_draft_change([...rows, blank_row(column_labels.length)]);
    }, [column_labels.length, on_draft_change, rows]);

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
                set_open(false);
            }
        } finally {
            set_staging(false);
        }
    }, [in_flight, on_draft_change, on_stage_rows, rows, satisfiable]);

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
            <button
                ref={launcher_ref}
                type="button"
                className="append-composer-launcher"
                aria-expanded={open}
                onClick={() => { set_open((was_open) => !was_open); }}
            >
                Compose row…
            </button>
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
                                <legend>{`Row ${row_index + 1}`}</legend>
                                {column_labels.map((label, column) => {
                                    const field_id
                                        = `append-composer-${row_index}-${column}`;
                                    return (
                                        <div className="append-composer-field" key={field_id}>
                                            <label htmlFor={field_id}>{label}</label>
                                            <input
                                                ref={row_index === 0 && column === 0
                                                    ? first_field_ref
                                                    : undefined}
                                                id={field_id}
                                                type="text"
                                                value={row[column] ?? ''}
                                                disabled={in_flight}
                                                onChange={(event) => {
                                                    set_field(
                                                        row_index,
                                                        column,
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
                        <button
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
