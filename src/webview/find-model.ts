/**
 * Find text in cells: the matching rule and the scan over a paged grid.
 *
 * Pure. The grid supplies chunk planning, loading, and each cell's displayed
 * text, so the walk order, wrap, staleness, and load-failure rules are tested
 * here without React or a grid. See
 * docs/superpowers/specs/2026-11-12-find-in-cells-design.md.
 */

/** A grid cell in display coordinates. */
export interface FindPosition {
    readonly row: number;
    readonly column: number;
}

export type FindDirection = 1 | -1;

export type FindScanResult =
    | { readonly kind: 'match'; readonly position: FindPosition }
    /** A full lap read every cell and none matched. */
    | { readonly kind: 'none' }
    /** The scan ended without reading every cell: stale, or rows failed to load. */
    | { readonly kind: 'stopped' };

/**
 * A case-insensitive substring test, folded with `toLocaleLowerCase` like the
 * Contains filter. The query is folded once; an empty query matches nothing.
 */
export function find_matcher(query: string): ((text: string) => boolean) | undefined {
    if (query === '') return undefined;
    const needle = query.toLocaleLowerCase();
    return (text) => text !== '' && text.toLocaleLowerCase().includes(needle);
}

/** Inclusive grid-row range of one chunk. */
export interface FindChunk {
    readonly start: number;
    readonly end: number;
}

export interface FindScanInput {
    /** Where the search starts; undefined starts at the first (or last) cell. */
    readonly start: FindPosition | undefined;
    readonly direction: FindDirection;
    /** Whether `start` itself may match (typing) or the search begins one cell past it (Enter). */
    readonly inclusive: boolean;
    readonly row_count: number;
    readonly column_count: number;
    readonly matches: (text: string) => boolean;
    /** The chunk containing `row`, extending from it in `direction`. */
    readonly plan_chunk: (row: number, direction: FindDirection) => FindChunk;
    /** Make the chunk's rows readable. Resolves a release callback, or false when
     *  the rows could not be loaded (the loader released whatever it held). */
    readonly load_chunk: (chunk: FindChunk) => Promise<(() => void) | false>;
    readonly text_at: (position: FindPosition) => string;
    readonly is_stale: () => boolean;
    /** Lets the UI breathe; called every `yield_every` cells tested. */
    readonly yield_to_ui: () => Promise<void>;
    readonly yield_every?: number;
}

const DEFAULT_YIELD_EVERY = 20_000;

/**
 * Walk every cell once in row-major display order from the start, wrapping at
 * the end, and stop at the first match. Chunks are loaded one at a time and
 * released before the next loads.
 */
export async function scan_for_match(input: FindScanInput): Promise<FindScanResult> {
    const { row_count, column_count, direction } = input;
    const total = row_count * column_count;
    if (total === 0) return { kind: 'none' };
    const yield_every = input.yield_every ?? DEFAULT_YIELD_EVERY;
    const first = first_index(input, total);
    let chunk: FindChunk | undefined;
    let release: (() => void) | undefined;
    let since_yield = 0;
    try {
        for (let step = 0; step < total; step++) {
            const index = mod(first + direction * step, total);
            const row = Math.floor(index / column_count);
            if (chunk === undefined || row < chunk.start || row > chunk.end) {
                release?.();
                release = undefined;
                chunk = clamp_chunk(input.plan_chunk(row, direction), row, row_count);
                const loaded = await input.load_chunk(chunk);
                if (loaded === false) return { kind: 'stopped' };
                release = loaded;
                if (input.is_stale()) return { kind: 'stopped' };
            }
            const position = { row, column: index % column_count };
            if (input.matches(input.text_at(position))) return { kind: 'match', position };
            if (++since_yield >= yield_every) {
                since_yield = 0;
                await input.yield_to_ui();
                if (input.is_stale()) return { kind: 'stopped' };
            }
        }
        return { kind: 'none' };
    } finally {
        release?.();
    }
}

function first_index(input: FindScanInput, total: number): number {
    const { start, direction } = input;
    if (
        start === undefined
        || start.row < 0
        || start.row >= input.row_count
        || start.column < 0
        || start.column >= input.column_count
    ) {
        return direction === 1 ? 0 : total - 1;
    }
    const index = start.row * input.column_count + start.column;
    return input.inclusive ? index : mod(index + direction, total);
}

/** A planner bug must not stall the walk: the chunk always holds `row`. */
function clamp_chunk(chunk: FindChunk, row: number, row_count: number): FindChunk {
    const start = Math.max(0, Math.min(chunk.start, row));
    const end = Math.min(row_count - 1, Math.max(chunk.end, row));
    return { start, end };
}

function mod(value: number, size: number): number {
    return ((value % size) + size) % size;
}

/** Just enough of a keyboard event to classify the Find chord. */
export interface FindHotkey {
    readonly key: string;
    readonly metaKey: boolean;
    readonly ctrlKey: boolean;
    readonly shiftKey: boolean;
    readonly altKey: boolean;
}

/** Cmd+F or Ctrl+F: exactly one of Meta/Ctrl, no Alt, no Shift. Either platform's
 *  chord is accepted, as for undo, because a webview cannot tell reliably. */
export function is_find_hotkey(event: FindHotkey): boolean {
    if (event.altKey || event.shiftKey) return false;
    if (event.metaKey === event.ctrlKey) return false;
    return event.key.toLowerCase() === 'f';
}
