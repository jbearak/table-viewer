import type { Direction } from './selection';

export type SequentialNavigation = 'next' | 'previous' | 'below';

export type GridNavigationDecision =
    | { kind: 'direction'; direction: Direction }
    | { kind: 'sequential'; navigation: SequentialNavigation };

/**
 * Move through displayed cells. Tab order is row-major and retains the current
 * cell at the outer boundaries; hidden source columns are absent from
 * `column_count`, so they never consume a stop.
 */
export function move_sequential_cell(
    cell: readonly [number, number],
    navigation: SequentialNavigation,
    row_count: number,
    column_count: number,
    is_covered: (row: number, col: number) => boolean = () => false,
): readonly [number, number] {
    if (row_count <= 0 || column_count <= 0) return cell;
    const [col, row] = cell;
    if (navigation === 'below') {
        // Skip covered rows so Enter from a vertical merge lands below the
        // block instead of on a covered member (which selection
        // canonicalization would snap straight back to the anchor).
        for (let next = row + 1; next < row_count; next++) {
            if (!is_covered(next, col)) return [col, next];
        }
        return cell;
    }

    const current = row * column_count + col;
    const last = row_count * column_count - 1;
    const step = navigation === 'next' ? 1 : -1;
    for (let index = current + step; index >= 0 && index <= last; index += step) {
        const next_row = Math.floor(index / column_count);
        const next_col = index % column_count;
        if (!is_covered(next_row, next_col)) return [next_col, next_row];
    }
    return cell;
}

export interface NavInput {
    /** The pressed key (KeyboardEvent.key). */
    key: string;
    shift: boolean;
    ctrl: boolean;
    meta: boolean;
    alt: boolean;
    /** True when cells are editable (edit mode) — keep type-to-edit working. */
    editable: boolean;
}

const VIM_DIRECTIONS: Record<string, Direction> = {
    k: 'up',
    j: 'down',
    h: 'left',
    l: 'right',
};

/**
 * Decides whether GridShell should intercept a key press and drive a
 * controlled move itself (or return null to defer to Glide).
 *
 * Glide's native keyboard handling is rich (range extension, Ctrl+A, Home/End,
 * paging) and merge-aware (the vendored grid steps past merged blocks itself),
 * so we intercept as little as possible:
 *
 * - Tab/Shift+Tab use application-owned row-major traversal with wrapping.
 * - Other modifier combos defer — copy, select-all, and range extension stay
 *   native.
 * - hjkl (vim nav) is intercepted in view mode, but never while editing, so
 *   typing a letter into an editable cell still works.
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

export function resolve_nav(input: NavInput): GridNavigationDecision | null {
    if (input.ctrl || input.meta || input.alt) return null;
    if (input.key === 'Tab') {
        return {
            kind: 'sequential',
            navigation: input.shift ? 'previous' : 'next',
        };
    }
    if (input.shift) return null;

    const vim = VIM_DIRECTIONS[input.key];
    if (vim) {
        return input.editable ? null : { kind: 'direction', direction: vim };
    }

    return null;
}
