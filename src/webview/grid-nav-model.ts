import type { Direction } from './selection';

export interface NavInput {
    /** The pressed key (KeyboardEvent.key). */
    key: string;
    shift: boolean;
    ctrl: boolean;
    meta: boolean;
    alt: boolean;
    /** True when cells are editable (edit mode) — keep type-to-edit working. */
    editable: boolean;
    /** True when the sheet has merge ranges (vertical/2D merges need merge-aware
     *  nav; plain sheets keep Glide's native, fully-featured arrow handling). */
    has_merges: boolean;
}

const ARROW_DIRECTIONS: Record<string, Direction> = {
    ArrowUp: 'up',
    ArrowDown: 'down',
    ArrowLeft: 'left',
    ArrowRight: 'right',
};

const VIM_DIRECTIONS: Record<string, Direction> = {
    k: 'up',
    j: 'down',
    h: 'left',
    l: 'right',
};

/**
 * Decides whether GridShell should intercept a key press and drive a
 * merge-aware move itself, returning the direction (or null to defer to Glide).
 *
 * Glide's native keyboard handling is rich (range extension, Tab wrap, Ctrl+A,
 * Home/End, paging), so we intercept as little as possible:
 *
 * - Modifier combos (ctrl/meta/alt) and shift always defer — copy, select-all,
 *   and range extension stay native.
 * - Plain arrows are intercepted **only** when the sheet has merges, where
 *   Glide otherwise gets stuck stepping into overlay-covered cells that snap
 *   back to the same anchor. On plain sheets, native arrow nav is correct.
 * - hjkl (vim nav) is intercepted in view mode regardless of merges, but never
 *   while editing, so typing a letter into an editable cell still works.
 */
/**
 * True for the copy shortcut (Ctrl+C / Cmd+C, no Shift/Alt). GridShell
 * intercepts it so copy always runs through the guarded `copy_rect` path
 * (which caps the selection and warns on non-resident rows) instead of Glide's
 * native copy, which reads each cell via getCellContent and would silently emit
 * blank cells for rows whose page isn't loaded.
 */
export function is_copy_key(
    input: Pick<NavInput, 'key' | 'ctrl' | 'meta' | 'shift' | 'alt'>,
): boolean {
    if (!(input.ctrl || input.meta)) return false;
    if (input.shift || input.alt) return false;
    return input.key === 'c' || input.key === 'C';
}

export function resolve_nav(input: NavInput): { direction: Direction } | null {
    if (input.ctrl || input.meta || input.alt || input.shift) return null;

    const arrow = ARROW_DIRECTIONS[input.key];
    if (arrow) {
        return input.has_merges ? { direction: arrow } : null;
    }

    const vim = VIM_DIRECTIONS[input.key];
    if (vim) {
        return input.editable ? null : { direction: vim };
    }

    return null;
}
