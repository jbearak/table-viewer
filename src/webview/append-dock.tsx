import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The append dock: a launcher and the quick-add surface it opens.
 *
 * The launcher renders as a phantom row slot — a strip the width of the
 * row-number gutter, anchored directly below the last display row — so it
 * never covers a real row number the way the earlier fixed bottom-left corner
 * button did (which made the rows under it impossible to select or delete by
 * their markers). The shell measures the anchor from the grid and hands it in
 * as `anchor`; when no geometry is available (headless tests, zero-size
 * layouts) the dock falls back to the old corner placement via CSS defaults.
 *
 * The dock overlays the grid — it is positioned inside `.grid-shell-root` and
 * reserves no space, because reserving space would reflow the virtualized
 * scroller every time it opened.
 *
 * The component owns no append machinery. It clamps a count against the
 * capacity the shell hands it and calls `on_add_rows`; refusal handling,
 * history, and the pending band all stay where they were.
 */

/**
 * Measured placement for the row-anchored launcher, in `.grid-shell-root`
 * coordinates. `left`/`top` position the dock (top-anchored, because rows keep
 * a stable top edge while the window resizes); `width`/`height` size the
 * launcher to the row-number gutter and the last row's height, so it reads as
 * one more row slot rather than a floating control. The quick-add panel opens
 * to the right of the slot, in the phantom row's own line, so it never covers
 * the real rows above.
 */
export interface AppendDockAnchor {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
}

export interface AppendDockProps {
    /** Phantom-row placement; undefined falls back to the corner inset. */
    readonly anchor?: AppendDockAnchor;
    readonly open: boolean;
    readonly on_open_change: (open: boolean) => void;
    /**
     * Rows this gesture may still stage — the smaller of the pending-append cap
     * and the source's row ceiling. The count control clamps to it live, so a
     * refusal is visible before the click rather than as a warning afterwards.
     * The shell unmounts the whole dock when it reaches zero.
     */
    readonly remaining_capacity: number;
    /** An append reservation is outstanding; the dock shows it and waits. */
    readonly busy?: boolean;
    /**
     * Stage `count` blank rows as one gesture. Resolves `true` once the rows
     * are staged and the grid has focus, `false` if admission refused — the
     * dock stays open on refusal so the user can see why and retry.
     */
    readonly on_add_rows: (count: number) => Promise<boolean>;
    /**
     * Rendered beside `Add rows` inside the dock's action row. The guided row
     * composer mounts its `Compose row…` button here.
     */
    readonly secondary_actions?: React.ReactNode;
    /**
     * A secondary surface has taken the dock over, so quick add stands down.
     * Showing both at once puts two unrelated `add` buttons on screen together,
     * which reads as a choice between them rather than as two separate tasks.
     */
    readonly secondary_open?: boolean;
}

const clamp_count = (value: number, capacity: number): number =>
    Math.min(Math.max(1, Math.trunc(value)), Math.max(1, capacity));

export function AppendDock({
    anchor,
    open,
    on_open_change,
    remaining_capacity,
    busy = false,
    on_add_rows,
    secondary_actions,
    secondary_open = false,
}: AppendDockProps): React.ReactElement {
    const [count, set_count] = useState(1);
    const [adding, set_adding] = useState(false);
    const launcher_ref = useRef<HTMLButtonElement>(null);
    const count_ref = useRef<HTMLInputElement>(null);

    // Capacity can shrink under the dock — another gesture stages rows, or an
    // undo restores them — so the count follows it down rather than waiting for
    // the button to refuse.
    useEffect(() => {
        set_count((current) => clamp_count(current, remaining_capacity));
    }, [remaining_capacity]);

    const close = useCallback(() => {
        on_open_change(false);
        launcher_ref.current?.focus();
    }, [on_open_change]);

    const toggle = useCallback(() => {
        on_open_change(!open);
    }, [on_open_change, open]);

    // Keyed on the dock's own opening only. Keying it on `secondary_open` too
    // would steal focus back to the count field the moment the composer closed,
    // instead of leaving it on the button that opened the composer.
    useEffect(() => {
        if (open) count_ref.current?.focus();
    }, [open]);

    const in_flight = busy || adding;
    const satisfiable = count >= 1 && count <= remaining_capacity;

    // A refusal leaves the dock open, but the count input and the add button
    // were disabled for the attempt, and the browser blurs a disabled element —
    // so focus sat on the body and a keyboard user had to tab back in. Recorded
    // here and acted on once the controls re-enable, since focusing a disabled
    // input does nothing.
    const refocus_count_ref = useRef(false);
    const add = useCallback(async () => {
        if (in_flight || !satisfiable) return;
        set_adding(true);
        try {
            // Staging moves focus into the grid, so the dock has nothing left
            // to hold; a refusal keeps it open on the same count.
            if (await on_add_rows(count)) on_open_change(false);
            else refocus_count_ref.current = true;
        } finally {
            set_adding(false);
        }
    }, [count, in_flight, on_add_rows, on_open_change, satisfiable]);

    useEffect(() => {
        if (in_flight || !refocus_count_ref.current) return;
        refocus_count_ref.current = false;
        count_ref.current?.focus();
    }, [in_flight]);

    const add_label = count === 1 ? 'Add row' : `Add ${count} rows`;

    return (
        <div
            className={anchor === undefined ? 'append-dock' : 'append-dock is-row-anchored'}
            style={anchor === undefined
                ? undefined
                : { left: anchor.left, top: anchor.top, bottom: 'auto' }}
            onKeyDown={(event) => {
                if (event.key !== 'Escape' || !open) return;
                event.preventDefault();
                event.stopPropagation();
                close();
            }}
        >
            {open && (
                <div
                    className={secondary_open
                        ? 'append-dock-panel is-secondary-open'
                        : 'append-dock-panel'}
                    role={secondary_open ? undefined : 'group'}
                    aria-label={secondary_open
                        ? undefined
                        : 'Add rows to the end of this worksheet'}
                >
                    {!secondary_open && (
                        <>
                    <label className="append-dock-count-label" htmlFor="append-dock-count">
                        Rows
                    </label>
                    <input
                        ref={count_ref}
                        id="append-dock-count"
                        className="append-dock-count"
                        type="number"
                        min={1}
                        max={remaining_capacity}
                        step={1}
                        value={count}
                        disabled={in_flight}
                        onChange={(event) => {
                            const typed = Number.parseInt(event.target.value, 10);
                            set_count(Number.isNaN(typed)
                                ? 1
                                : clamp_count(typed, remaining_capacity));
                        }}
                    />
                    <button
                        type="button"
                        className="append-dock-add"
                        disabled={in_flight || !satisfiable}
                        onClick={() => { void add(); }}
                    >
                        {in_flight ? 'Adding…' : add_label}
                    </button>
                        </>
                    )}
                    {secondary_actions}
                    {!secondary_open && count >= remaining_capacity && (
                        <span className="append-dock-capacity" role="status">
                            {remaining_capacity === 1
                                ? 'Room for 1 more row.'
                                : `Room for ${remaining_capacity.toLocaleString('en-US')} more rows.`}
                        </span>
                    )}
                </div>
            )}
            {!secondary_open && (
                <button
                    ref={launcher_ref}
                    type="button"
                    className={open ? 'append-dock-launcher is-open' : 'append-dock-launcher'}
                    style={anchor === undefined
                        ? undefined
                        : { width: anchor.width, height: anchor.height }}
                    aria-expanded={open}
                    aria-label={open ? 'Close add rows' : 'Add rows'}
                    onClick={toggle}
                >
                    <span aria-hidden="true">+</span>
                </button>
            )}
        </div>
    );
}
