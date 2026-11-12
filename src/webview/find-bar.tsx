import { forwardRef, useImperativeHandle, useRef } from 'react';

export type FindStatus = 'idle' | 'searching' | 'none';

export interface FindBarHandle {
    /** Focus the input and select its text, so typing replaces the query. */
    focus_and_select(): void;
}

interface FindBarProps {
    readonly query: string;
    readonly status: FindStatus;
    readonly on_query_change: (query: string) => void;
    readonly on_next: () => void;
    readonly on_previous: () => void;
    readonly on_close: () => void;
}

const STATUS_TEXT: Record<FindStatus, string> = {
    idle: '',
    searching: 'Searching…',
    none: 'No matches',
};

/** The find bar floating over the grid's top-right corner. */
export const FindBar = forwardRef<FindBarHandle, FindBarProps>(function FindBar(
    { query, status, on_query_change, on_next, on_previous, on_close },
    ref,
) {
    const input_ref = useRef<HTMLInputElement>(null);
    useImperativeHandle(ref, () => ({
        focus_and_select() {
            input_ref.current?.focus();
            input_ref.current?.select();
        },
    }), []);
    return (
        <div className="find-bar" role="search">
            <input
                ref={input_ref}
                className="find-bar-input"
                type="text"
                aria-label="Find"
                placeholder="Find"
                spellCheck={false}
                autoComplete="off"
                value={query}
                onChange={(event) => on_query_change(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                        event.preventDefault();
                        if (event.shiftKey) on_previous();
                        else on_next();
                    } else if (event.key === 'Escape') {
                        event.preventDefault();
                        event.stopPropagation();
                        on_close();
                    }
                }}
            />
            <span className="find-bar-status" role="status" aria-live="polite">
                {STATUS_TEXT[status]}
            </span>
            <button
                type="button"
                className="find-bar-button"
                aria-label="Previous match"
                title="Previous match (Shift+Enter)"
                onClick={on_previous}
            >
                ↑
            </button>
            <button
                type="button"
                className="find-bar-button"
                aria-label="Next match"
                title="Next match (Enter)"
                onClick={on_next}
            >
                ↓
            </button>
            <button
                type="button"
                className="find-bar-button"
                aria-label="Close find"
                title="Close (Escape)"
                onClick={on_close}
            >
                ×
            </button>
        </div>
    );
});
