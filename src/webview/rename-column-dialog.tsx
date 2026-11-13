import React, { useCallback, useEffect, useRef, useState } from 'react';
import { use_dismiss } from './use-dismiss';
import {
    committed_column_name,
    normalized_column_name,
} from '../column-name';

export { normalized_column_name } from '../column-name';

export function column_rename_error(
    value: string,
    column_names: readonly string[],
    source_column: number,
    removed_names: readonly string[] = [],
): string | undefined {
    const normalized = normalized_column_name(value);
    if (normalized === '') return 'Enter a column name.';
    if (/[\r\n]/.test(value)) return 'Column names must fit on one line.';
    if (column_names.some((name, column) => column !== source_column
        && normalized_column_name(name) === normalized)) {
        return 'Another column already has that name.';
    }
    // A Pending Column may not take a column deleted this session: structured
    // references such as `[Price]` follow the name and would rebind to it.
    const removed = removed_names.find((name) => normalized_column_name(name) === normalized);
    if (removed !== undefined) {
        return `A deleted column on this sheet is named ${removed}. Restore it or choose another name.`;
    }
    return undefined;
}

export function RenameColumnDialog(props: {
    initial: string;
    column_names: readonly string[];
    source_column: number;
    /** Names of columns deleted this session, which a new column may not take. */
    removed_names?: readonly string[];
    on_commit: (value: string) => boolean;
    on_cancel: () => void;
}): React.JSX.Element {
    const [value, set_value] = useState(props.initial);
    const dialog_ref = useRef<HTMLDivElement>(null);
    const input_ref = useRef<HTMLInputElement>(null);
    const error = column_rename_error(value, props.column_names, props.source_column, props.removed_names);
    use_dismiss(dialog_ref, props.on_cancel);
    useEffect(() => {
        const timer = window.setTimeout(() => {
            input_ref.current?.focus();
            input_ref.current?.select();
        }, 0);
        return () => window.clearTimeout(timer);
    }, []);
    const commit = useCallback(() => {
        if (error === undefined && props.on_commit(committed_column_name(value))) {
            props.on_cancel();
        }
    }, [error, props, value]);
    return (
        <div
            ref={dialog_ref}
            className="filter-popover hyperlink-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Rename column"
        >
            <div className="filter-popover-header">
                <span className="filter-popover-colname">Rename column</span>
            </div>
            <div className="filter-popover-body">
                <label className="filter-popover-field-label" htmlFor="rename-column-name">
                    Column name
                </label>
                <input
                    id="rename-column-name"
                    ref={input_ref}
                    className="filter-popover-input"
                    value={value}
                    onChange={(event) => set_value(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                            event.preventDefault();
                            commit();
                        }
                    }}
                />
                {error && <div className="hyperlink-dialog-hint">{error}</div>}
            </div>
            <div className="filter-popover-footer">
                <button type="button" className="filter-popover-btn" onClick={props.on_cancel}>
                    Cancel
                </button>
                <button
                    type="button"
                    className="filter-popover-btn filter-popover-btn-primary"
                    disabled={error !== undefined
                        || committed_column_name(value)
                            === committed_column_name(props.initial)}
                    onClick={commit}
                >
                    Rename
                </button>
            </div>
        </div>
    );
}
