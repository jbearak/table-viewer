// Row alignment for compare sessions. Pure (no vscode, no host imports):
// operates on DataSource values so it is unit-testable with in-memory fixtures.
//
// Why this module exists: comparing row N against row N reports a moved or
// inserted row as a screenful of changed cells, because every row below the
// insertion point shifts. Aligning the two sides first is what makes
// added/deleted mean what they say.
import {
    read_source_raw_rows_async,
    read_source_raw_rows_indexed_async,
    type DataSource,
    type SheetMeta,
} from '../data-source/interface';
import {
    cells_exactly_equal,
    materialize_cell_comparison_text,
} from '../cell-display';
import type { SheetPairing } from './compare-source';

/** Absent from one side. Exactly one of a row's indexes may be this. */
export const ABSENT = -1;

/**
 * One row of the unified grid. `original`/`modified` are row indexes into each
 * side's projected row space, or {@link ABSENT}. Both being ABSENT is not a
 * representable state any producer here emits.
 */
export interface AlignedRow {
    readonly original: number;
    readonly modified: number;
}

export interface SheetAlignment {
    readonly rows: readonly AlignedRow[];
    /** Rows present only in the modified side. */
    readonly addedRows: number;
    /** Rows present only in the original side. */
    readonly deletedRows: number;
    /**
     * Indexes into `rows` of the paired rows that differ, ascending. Recorded
     * during the same pass that counts the cells, so the "only changed rows"
     * filter costs no extra reads. One-sided rows are not listed here — a
     * consumer wanting every *interesting* row takes these plus the rows with
     * an ABSENT side.
     */
    readonly changedRowIndices: readonly number[];
    /** Differing cells across all paired rows. */
    readonly changedCells: number;
    /**
     * Indexes into `rows` of rows the move pass paired, ascending. These are
     * ordinary two-index rows in every other respect — a moved-and-edited row
     * also appears in `changedRowIndices` — so this is purely the "how did it
     * get paired" annotation the grid needs to band it differently.
     */
    readonly movedRowIndices: readonly number[];
    /**
     * The inexact move phase hit its work cap and left some rows unpaired.
     * Reported rather than silent: the alignment is still correct, but it is
     * not the *whole* answer about moves, and a caller claiming otherwise
     * would be lying about coverage.
     */
    readonly moveSearchTruncated: boolean;
    /**
     * The aligner exceeded its effort cap and returned the positional identity
     * alignment instead. Callers must say so: an all-changed grid produced this
     * way is not a finding about the files.
     */
    readonly degraded: boolean;
}

export interface AlignSheetOptions {
    /**
     * Cap on the diff's edit distance (D in Myers' O(ND)). Exceeding it means
     * the files are too dissimilar to align usefully — two unrelated exports,
     * or one re-sorted — so alignment degrades to positional rather than
     * spending unbounded time proving they do not match. It bounds the
     * *search*: a wholly one-sided run costs nothing to align and is allowed
     * through however long it is.
     */
    readonly maxEditDistance?: number;
    /** Rows hashed between cancellation checks. */
    readonly rowsPerCheckpoint?: number;
    /** Cap on leftover rows per side entering the inexact move phase. See
     *  {@link MOVE_SEARCH_LIMIT}. */
    readonly maxMoveSearchRows?: number;
    readonly isCancelled?: () => boolean;
    /** Reports progress as rows are hashed, for the window's progress state. */
    readonly onProgress?: (scannedRows: number, totalRows: number) => void;
}

export class AlignmentCancelledError extends Error {
    constructor() {
        super('Row alignment was cancelled.');
        this.name = 'AlignmentCancelledError';
    }
}

async function alignment_source_read<T>(read: () => Promise<T>): Promise<T> {
    try {
        return await read();
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            throw new AlignmentCancelledError();
        }
        throw error;
    }
}

const DEFAULT_ROWS_PER_CHECKPOINT = 4096;
/** Divide-and-conquer steps between cancellation checks in the Myers walk. */
const MYERS_STEPS_PER_CHECKPOINT = 256;

/**
 * Yield to a real event-loop turn, not just a microtask.
 *
 * `await Promise.resolve()` drains into the microtask queue, which runs to
 * completion before any I/O or IPC callback — so a `cancelCompare` arriving
 * from the renderer would not be delivered until alignment had already
 * finished. A macrotask is what actually lets the cancel through.
 */
function yield_to_event_loop(): Promise<void> {
    return new Promise((resolve) => { setTimeout(resolve, 0); });
}
/** Rows read from a side in one batched call while hashing. */
const HASH_READ_BATCH = 512;

/**
 * Default effort cap. Myers costs O(ND) with D the edit distance, so this
 * bounds the *work*, not the file size: a million-row file with a thousand
 * changed rows aligns well inside it, while two unrelated files hit it early
 * and degrade instead of grinding.
 *
 * Chosen against the cost of *failing*. Reaching the cap is quadratic in it —
 * two unrelated 50,000-row files degrade in about 0.2 s at 10,000 and about
 * 1.6 s at 40,000 — so the cap is really a budget for the answer "these files
 * do not correspond". 20,000 differing rows is far past any edit someone would
 * still call a revision, and buys that answer in about half a second.
 */
const DEFAULT_MAX_EDIT_DISTANCE = 20_000;

/**
 * Minimum similarity for two leftover rows to be called a move, as a fraction
 * of the longer row's characters.
 *
 * 50% is git's `DEFAULT_RENAME_SCORE` (30000 of MAX_SCORE 60000). Carried over
 * because git is the only fully inspectable pipeline doing this job, not
 * because 50% is derived: git never justified it, and JGit picked 60% for the
 * same task. Fixed rather than exposed as a setting until it misbehaves on a
 * real file.
 */
function is_at_least_half(part: number, whole: number): boolean {
    // Cross-multiplied rather than divided so the boundary is exact integer
    // arithmetic that cannot land on the wrong side of the threshold.
    return part * 2 >= whole;
}

/** Best candidates retained per destination row, as git's
 *  `NUM_CANDIDATE_PER_DST`. Bounds memory on a file where hundreds of leftover
 *  rows are all plausible matches for each other. */
const MOVE_CANDIDATES_PER_DESTINATION = 4;

/**
 * Cap on leftover rows *per side* entering the inexact phase, mirroring
 * `diff.renameLimit`. The phase is O(n*m) in these counts, so this bounds it at
 * ~10^6 scored pairs. Exact-hash moves are found before the cap applies and are
 * never discarded for being numerous — a re-sorted million-row file is the case
 * that most needs move detection and costs nothing to detect.
 */
const MOVE_SEARCH_LIMIT = 1000;

/** Scored pairs between cancellation checks in the inexact phase. The scoring
 *  loop can run a million comparisons with no read between them, so reads are
 *  not sufficient yield points here. */
const MOVE_SCORES_PER_CHECKPOINT = 20_000;

type ComparisonCell = { raw: string | null } | null | undefined;

/** Visit comparison text synchronously until the first deferred identity, then
 * resume through promises without imposing a microtask on ordinary rows. */
function visit_materialized_comparison_cells(
    cell_count: number,
    cell_at: (index: number) => ComparisonCell,
    is_cancelled: () => boolean,
    visit: (text: string) => void,
): void | Promise<void> {
    const continue_at = (start: number): void | Promise<void> => {
        for (let index = start; index < cell_count; index++) {
            const text = materialize_cell_comparison_text(cell_at(index), is_cancelled);
            if (typeof text === 'string') {
                visit(text);
                continue;
            }
            return text.then((resolved) => {
                visit(resolved);
                return continue_at(index + 1);
            });
        }
    };
    return continue_at(0);
}

/**
 * FNV-1a over the row's raw cell text, length-prefixed per cell so cell
 * boundaries cannot be forged.
 *
 * A separator byte was the obvious encoding and is wrong: a cell whose text
 * contains that byte feeds the hash exactly what two cells split at it would,
 * so `['a\u001fb']` and `['a','b']` collide *deterministically*. Because
 * prefix/suffix trimming pairs rows on hash alone, that is not a near-miss —
 * it silently aligns two structurally different rows. Lengths cannot appear in
 * the text stream, so the encoding is unambiguous.
 *
 * Chance collisions between unrelated rows remain possible at 32 bits and are
 * accepted: confirming a match would mean re-reading both rows' cells, and the
 * cost of being wrong is a mis-paired row in a diff, not corrupted data.
 */
function hash_row(
    cells: readonly ({ raw: string | null } | null)[],
    is_cancelled: () => boolean,
): number | Promise<number> {
    let hash = 0x811c9dc5;
    const mix = (value: number) => {
        hash ^= value;
        hash = Math.imul(hash, 0x01000193);
    };
    const mix_text = (text: string) => {
        mix(text.length);
        for (let position = 0; position < text.length; position++) {
            mix(text.charCodeAt(position));
        }
    };
    mix(cells.length);
    const materialized = visit_materialized_comparison_cells(
        cells.length,
        (index) => cells[index],
        is_cancelled,
        mix_text,
    );
    const finish = () => {
        // >>> 0 so the value is a stable unsigned int rather than a sign-flipped
        // one, since it is stored in a Uint32Array and compared for equality.
        return hash >>> 0;
    };
    return materialized === undefined ? finish() : materialized.then(finish);
}

async function hash_side(
    source: DataSource,
    sheet_index: number,
    row_count: number,
    scanned_before: number,
    total_rows: number,
    options: AlignSheetOptions,
): Promise<Uint32Array> {
    const hashes = new Uint32Array(row_count);
    const checkpoint = options.rowsPerCheckpoint ?? DEFAULT_ROWS_PER_CHECKPOINT;
    let since_checkpoint = 0;
    for (let start = 0; start < row_count; start += HASH_READ_BATCH) {
        const count = Math.min(HASH_READ_BATCH, row_count - start);
        const { rows } = await alignment_source_read(() =>
            read_source_raw_rows_async(
                source,
                sheet_index,
                start,
                count,
                options.isCancelled ?? (() => false),
            ));
        for (let offset = 0; offset < count; offset++) {
            const hash = hash_row(
                rows[offset] ?? [],
                options.isCancelled ?? (() => false),
            );
            hashes[start + offset] = typeof hash === 'number'
                ? hash
                : await alignment_source_read(() => hash);
        }
        since_checkpoint += count;
        if (since_checkpoint >= checkpoint) {
            since_checkpoint = 0;
            options.onProgress?.(scanned_before + start + count, total_rows);
            // Yield so the host stays responsive and a cancel is observed
            // promptly on a file large enough for this to matter.
            await yield_to_event_loop();
            if (options.isCancelled?.()) throw new AlignmentCancelledError();
        }
    }
    return hashes;
}

/** The positional alignment: row N against row N, each side clamped to its own
 *  row count. This is what the compare grid did before alignment existed, and
 *  it remains the degraded fallback. */
export function identity_alignment(
    original_rows: number,
    modified_rows: number,
): AlignedRow[] {
    const rows: AlignedRow[] = [];
    const total = Math.max(original_rows, modified_rows);
    for (let row = 0; row < total; row++) {
        rows.push({
            original: row < original_rows ? row : ABSENT,
            modified: row < modified_rows ? row : ABSENT,
        });
    }
    return rows;
}

/** A hunk of the middle diff: `count` rows consumed from each side, or from
 *  one side only when the other has none. */
interface EditScript {
    /** Paired runs and one-sided runs, in unified order. */
    readonly ops: readonly { kind: 'equal' | 'delete' | 'insert'; count: number }[];
    readonly degraded: boolean;
}
/**
 * Myers' O(ND) diff over two hash arrays, in O(N+M) memory.
 *
 * The textbook formulation records every frontier so the path can be walked
 * back at the end, which costs O(D^2) memory — at a distance cap of 100,000
 * that is tens of gigabytes, so the process dies long before the cap it was
 * supposed to degrade at. This is instead Myers' linear-space refinement: find
 * the middle snake of the edit path by running the forward and reverse
 * frontiers until they overlap, emit it, and recurse into the two halves. Same
 * O(ND) time and the same edit script; the frontiers are the only large
 * allocation, and there are two of them rather than D.
 *
 * `degraded` is returned when the edit distance exceeds `max_distance`, in
 * which case `ops` is meaningless and the caller falls back to positional.
 *
 * Equality here is hash equality; the caller confirms candidate pairs by
 * comparing actual cell text, so a collision costs an extra read and a
 * spuriously "changed" row, never a wrong row count.
 */
async function myers_diff(
    left: Uint32Array,
    right: Uint32Array,
    max_distance: number,
    options: AlignSheetOptions,
): Promise<EditScript> {
    const builder = new OpBuilder();
    const frontiers = new MiddleSnakeFrontiers(left.length + right.length);
    let steps = 0;

    /**
     * Emit the diff of `left[l0, l1)` against `right[r0, r1)` in order.
     *
     * Iterative over an explicit stack rather than recursive: the recursion
     * depth is O(D), and a deep one on a large diff would overflow the call
     * stack — the same way the 200k-row fixture once did.
     */
    type Work =
        | { kind: 'split'; l0: number; l1: number; r0: number; r1: number }
        /** An op whose position in the script is already decided, held on the
         *  stack so it is emitted between its two halves rather than before
         *  them — the script is ordered, and a snake belongs after everything
         *  to its left. */
        | { kind: 'emit'; op: 'equal' | 'delete' | 'insert'; count: number };
    const stack: Work[] = [
        { kind: 'split', l0: 0, l1: left.length, r0: 0, r1: right.length },
    ];
    while (stack.length > 0) {
        const work = stack.pop()!;
        if (work.kind === 'emit') { builder.emit(work.op, work.count); continue; }
        const { l0, l1, r0, r1 } = work;
        const n = l1 - l0;
        const m = r1 - r0;
        if (n === 0 && m === 0) continue;
        // Deliberately not charged against the cap, even though a one-sided
        // run of 100,000 rows is an edit distance of 100,000. The cap bounds
        // *search*, and there is nothing to search here — the answer is known
        // in constant time. Degrading would replace a correct, free answer
        // with a positional one, which for an empty side is meaningless.
        if (n === 0) { builder.emit('insert', m); continue; }
        if (m === 0) { builder.emit('delete', n); continue; }

        // Myers is the expensive half of alignment and, unlike hashing, has no
        // natural batch boundary. Without a checkpoint a Cancel is not observed
        // until the whole diff finishes, which on the files that make
        // cancelling worth offering is precisely too late.
        if (++steps % MYERS_STEPS_PER_CHECKPOINT === 0) {
            await yield_to_event_loop();
            if (options.isCancelled?.()) throw new AlignmentCancelledError();
        }

        // The bound is handed to the search rather than checked after it
        // returns: the middle-snake search is itself O(ND), so a sub-problem
        // that will blow the cap has to be abandoned while it is running, not
        // once it has finished proving how expensive it was.
        //
        // Each sub-problem is bounded by the *whole* cap, and nothing is
        // deducted for its children. A parent's distance already accounts for
        // every edit its children will find — they are the same edits, seen at
        // finer grain — so subtracting as the recursion descended charged the
        // same work repeatedly and degraded inputs that were comfortably
        // inside the cap.
        const snake = frontiers.find(left, right, l0, l1, r0, r1, max_distance);
        if (snake === undefined) return { ops: [], degraded: true };

        if (snake.distance <= 1) {
            // One edit or none: the halves are a common prefix, a single
            // insert or delete, and a common suffix — cheaper to state
            // directly than to recurse for.
            emit_single_edit(builder, left, right, l0, l1, r0, r1);
            continue;
        }
        // Pushed in reverse of emission order: left half, then the snake the
        // two halves meet on, then the right half.
        stack.push({ kind: 'split', l0: snake.x1, l1, r0: snake.y1, r1 });
        stack.push({ kind: 'emit', op: 'equal', count: snake.x1 - snake.x0 });
        stack.push({ kind: 'split', l0, l1: snake.x0, r0, r1: snake.y0 });
    }
    return { ops: builder.ops(), degraded: false };
}

/**
 * The one-edit case of the divide step.
 *
 * With a common prefix and suffix trimmed off, `n` and `m` differ by at most
 * one and the remainder is a single insert or delete.
 */
function emit_single_edit(
    builder: OpBuilder,
    left: Uint32Array,
    right: Uint32Array,
    l0: number,
    l1: number,
    r0: number,
    r1: number,
): void {
    let prefix = 0;
    while (l0 + prefix < l1 && r0 + prefix < r1 && left[l0 + prefix] === right[r0 + prefix]) {
        prefix++;
    }
    builder.emit('equal', prefix);
    const remaining_left = l1 - l0 - prefix;
    const remaining_right = r1 - r0 - prefix;
    const shared = Math.min(remaining_left, remaining_right);
    if (remaining_left > remaining_right) builder.emit('delete', 1);
    else if (remaining_right > remaining_left) builder.emit('insert', 1);
    builder.emit('equal', shared);
}

/**
 * Accumulates ops in emission order, coalescing adjacent runs of a kind.
 *
 * The divide-and-conquer walk produces the script in fragments — a snake here,
 * a single edit there — and consumers downstream reason about runs, so the
 * joining has to happen somewhere. Doing it on the way in keeps the op list
 * proportional to the number of hunks rather than to the number of rows.
 */
class OpBuilder {
    private readonly emitted: { kind: 'equal' | 'delete' | 'insert'; count: number }[] = [];

    emit(kind: 'equal' | 'delete' | 'insert', count: number): void {
        if (count <= 0) return;
        const last = this.emitted[this.emitted.length - 1];
        if (last?.kind === kind) last.count += count;
        else this.emitted.push({ kind, count });
    }

    ops(): { kind: 'equal' | 'delete' | 'insert'; count: number }[] {
        return this.emitted;
    }
}

/** Where the forward and reverse frontiers met, and what it cost to get there. */
interface MiddleSnake {
    /** Start of the shared run, in each side's coordinates. */
    readonly x0: number;
    readonly y0: number;
    /** End of the shared run, exclusive. */
    readonly x1: number;
    readonly y1: number;
    /** Edit distance of the whole sub-problem this snake splits. */
    readonly distance: number;
}

/**
 * The two frontier buffers the middle-snake search needs, allocated once.
 *
 * Reused across every step of the divide-and-conquer walk: the sub-problems
 * only ever shrink, so buffers sized for the whole input fit all of them, and
 * allocating per step would put the garbage collector in the inner loop.
 */
class MiddleSnakeFrontiers {
    private readonly forward: Int32Array;
    private readonly reverse: Int32Array;

    constructor(max_distance: number) {
        const width = 2 * max_distance + 3;
        this.forward = new Int32Array(width);
        this.reverse = new Int32Array(width);
    }

    /**
     * Find the middle snake of `left[l0, l1)` against `right[r0, r1)`.
     *
     * Runs the forward frontier from the top-left and the reverse frontier from
     * the bottom-right one step at a time; the first time they overlap on a
     * diagonal, that overlap is on a shortest edit path, and its snake splits
     * the problem into two strictly smaller ones. Returns undefined only if the
     * frontiers could not meet within `budget`, which is the caller's signal
     * to degrade to a positional alignment.
     */
    find(
        left: Uint32Array,
        right: Uint32Array,
        l0: number,
        l1: number,
        r0: number,
        r1: number,
        /** Edit distance still affordable; searching past it is wasted work
         *  because the caller degrades either way. */
        budget: number,
    ): MiddleSnake | undefined {
        const n = l1 - l0;
        const m = r1 - r0;
        const delta = n - m;
        const odd = (delta & 1) !== 0;
        // Each search step d resolves an edit distance of about 2d, so a
        // budget of B is exhausted by the time d reaches B/2. The `+ 1` keeps
        // the odd-delta case reachable, where step d proves a distance of
        // 2d - 1; the exact distance is re-checked at each return site.
        const half = Math.min(Math.ceil((n + m) / 2), Math.floor(budget / 2) + 1);
        const offset = Math.ceil((n + m) / 2) + 1;
        const forward = this.forward;
        const reverse = this.reverse;
        forward[offset + 1] = 0;
        reverse[offset + 1] = 0;

        for (let d = 0; d <= half; d++) {
            for (let k = -d; k <= d; k += 2) {
                const index = offset + k;
                let x = (k === -d || (k !== d && forward[index - 1] < forward[index + 1]))
                    ? forward[index + 1]
                    : forward[index - 1] + 1;
                let y = x - k;
                const snake_start_x = x;
                const snake_start_y = y;
                while (x < n && y < m && left[l0 + x] === right[r0 + y]) { x++; y++; }
                forward[index] = x;
                // On an odd delta the forward frontier is the one that can
                // overtake a reverse path already laid down at d-1.
                if (odd && k >= delta - (d - 1) && k <= delta + (d - 1)) {
                    if (x + reverse[offset + delta - k] >= n) {
                        // d only grows, so a distance over budget here means
                        // every later overlap is over budget too: give up now.
                        if (2 * d - 1 > budget) return undefined;
                        return {
                            x0: l0 + snake_start_x,
                            y0: r0 + snake_start_y,
                            x1: l0 + x,
                            y1: r0 + y,
                            distance: 2 * d - 1,
                        };
                    }
                }
            }
            for (let k = -d; k <= d; k += 2) {
                const index = offset + k;
                let x = (k === -d || (k !== d && reverse[index - 1] < reverse[index + 1]))
                    ? reverse[index + 1]
                    : reverse[index - 1] + 1;
                let y = x - k;
                const snake_start_x = x;
                const snake_start_y = y;
                while (
                    x < n && y < m
                    && left[l1 - 1 - x] === right[r1 - 1 - y]
                ) { x++; y++; }
                reverse[index] = x;
                if (!odd && k >= delta - d && k <= delta + d) {
                    if (x + forward[offset + delta - k] >= n) {
                        if (2 * d > budget) return undefined;
                        // Reverse coordinates count from the end; flip them
                        // back so the caller only ever sees forward ones.
                        return {
                            x0: l1 - x,
                            y0: r1 - y,
                            x1: l1 - snake_start_x,
                            y1: r1 - snake_start_y,
                            distance: 2 * d,
                        };
                    }
                }
            }
        }
        return undefined;
    }
}

/**
 * Align a matched sheet pair by content.
 *
 * Hashes both sides, trims the common prefix and suffix (which on an ordinary
 * edit removes nearly everything before the expensive step), then Myers-diffs
 * the remaining middle. Cost scales with the number of differences, not the
 * file size, so two similar million-row files align quickly and two unrelated
 * ones hit the effort cap and degrade to positional.
 */
export async function align_sheet(
    original: DataSource,
    modified: DataSource,
    pairing: SheetPairing,
    options: AlignSheetOptions = {},
): Promise<SheetAlignment> {
    if (pairing.status !== 'matched') {
        throw new Error('align_sheet requires a matched sheet pairing.');
    }
    const original_sheet = original.meta().sheets[pairing.originalIndex];
    const modified_sheet = modified.meta().sheets[pairing.modifiedIndex];
    if (!original_sheet || !modified_sheet) {
        throw new RangeError('sheet pairing indexes a missing sheet');
    }
    // Before any work, not only at checkpoints. A sheet small enough to hash
    // without reaching one — an empty side, or a handful of rows — otherwise
    // ran to completion after the user had already cancelled, and a workbook
    // of such sheets ignored Cancel entirely.
    if (options.isCancelled?.()) throw new AlignmentCancelledError();
    const original_rows = original_sheet.rowCount;
    const modified_rows = modified_sheet.rowCount;
    const total_rows = original_rows + modified_rows;
    const original_hashes = await hash_side(
        original, pairing.originalIndex, original_rows, 0, total_rows, options);
    const modified_hashes = await hash_side(
        modified, pairing.modifiedIndex, modified_rows, original_rows, total_rows, options);

    // Trim matching ends. Cheap, and on a normal edit it leaves the Myers step
    // a handful of rows regardless of how large the file is.
    let prefix = 0;
    const shortest = Math.min(original_rows, modified_rows);
    while (prefix < shortest && original_hashes[prefix] === modified_hashes[prefix]) prefix++;
    let suffix = 0;
    while (
        suffix < shortest - prefix
        && original_hashes[original_rows - 1 - suffix] === modified_hashes[modified_rows - 1 - suffix]
    ) suffix++;

    const script = await myers_diff(
        original_hashes.subarray(prefix, original_rows - suffix),
        modified_hashes.subarray(prefix, modified_rows - suffix),
        options.maxEditDistance ?? DEFAULT_MAX_EDIT_DISTANCE,
        options,
    );

    // A degraded alignment is positional and means "these files do not
    // correspond". Hunting moves inside it would spend real time decorating an
    // answer already known to be meaningless, and would produce a misleading
    // hybrid where some rows are move-eligible and the positional body is not.
    if (script.degraded) {
        const rows = identity_alignment(original_rows, modified_rows);
        return {
            rows,
            degraded: true,
            movedRowIndices: [],
            moveSearchTruncated: false,
            ...await count_changes(
                original, modified, pairing, original_sheet, modified_sheet, rows, options),
        };
    }

    const { rows, movedRowIndices, moveSearchTruncated } = await detect_moves(
        original,
        modified,
        pairing,
        build_rows(script, prefix, suffix, original_rows, modified_rows),
        original_hashes,
        modified_hashes,
        options,
    );

    return {
        rows,
        degraded: false,
        movedRowIndices,
        moveSearchTruncated,
        ...await count_changes(
            original, modified, pairing, original_sheet, modified_sheet, rows, options),
    };
}

/**
 * Expand a trimmed edit script back into full-file aligned rows.
 *
 * A Myers script has no concept of a *modified* row: editing a cell in place is
 * a delete of the old row immediately followed by an insert of the new one. So
 * adjacent delete/insert runs are paired up here, which is what turns them back
 * into one changed row rather than a deletion and an addition sitting on top of
 * each other. Only adjacent runs pair — a row deleted here and a similar row
 * inserted far below is a move, and stays a delete plus an add.
 */
function build_rows(
    script: EditScript,
    prefix: number,
    suffix: number,
    original_rows: number,
    modified_rows: number,
): AlignedRow[] {
    const rows: AlignedRow[] = [];
    for (let row = 0; row < prefix; row++) rows.push({ original: row, modified: row });
    let original_row = prefix;
    let modified_row = prefix;
    const ops = script.ops;
    for (let index = 0; index < ops.length; index++) {
        const op = ops[index];
        if (op.kind === 'equal') {
            for (let step = 0; step < op.count; step++) {
                rows.push({ original: original_row++, modified: modified_row++ });
            }
            continue;
        }
        // Collect the whole delete/insert cluster at this point, in either
        // order, so `a→b` and its mirror both read as one changed row.
        let deletes = 0;
        let inserts = 0;
        let scan = index;
        while (scan < ops.length && ops[scan].kind !== 'equal') {
            if (ops[scan].kind === 'delete') deletes += ops[scan].count;
            else inserts += ops[scan].count;
            scan++;
        }
        index = scan - 1;
        const paired = Math.min(deletes, inserts);
        for (let step = 0; step < paired; step++) {
            rows.push({ original: original_row++, modified: modified_row++ });
        }
        for (let step = paired; step < deletes; step++) {
            rows.push({ original: original_row++, modified: ABSENT });
        }
        for (let step = paired; step < inserts; step++) {
            rows.push({ original: ABSENT, modified: modified_row++ });
        }
    }
    for (let step = 0; step < suffix; step++) {
        rows.push({
            original: original_rows - suffix + step,
            modified: modified_rows - suffix + step,
        });
    }
    return rows;
}

/**
 * Count added/deleted/changed over the aligned rows, confirming paired rows by
 * actual cell text. This is also what catches a hash collision: two rows the
 * aligner paired on equal hashes are compared here like any other pair, so a
 * collision shows up as a changed row, never as a wrong total.
 */
async function count_changes(
    original: DataSource,
    modified: DataSource,
    pairing: Extract<SheetPairing, { status: 'matched' }>,
    original_sheet: SheetMeta,
    modified_sheet: SheetMeta,
    rows: readonly AlignedRow[],
    options: AlignSheetOptions,
): Promise<Pick<
    SheetAlignment,
    'addedRows' | 'deletedRows' | 'changedCells' | 'changedRowIndices'
>> {
    let added = 0;
    let deleted = 0;
    let changed_cells = 0;
    const changed_row_indices: number[] = [];
    const column_count = Math.max(original_sheet.columnCount, modified_sheet.columnCount);
    const checkpoint = options.rowsPerCheckpoint ?? DEFAULT_ROWS_PER_CHECKPOINT;
    /** Paired rows with the grid row each came from, so a difference can be
     *  reported against its position in the unified grid. */
    const paired: { row: AlignedRow; gridRow: number }[] = [];
    rows.forEach((row, grid_row) => {
        if (row.modified === ABSENT) deleted++;
        else if (row.original === ABSENT) added++;
        else paired.push({ row, gridRow: grid_row });
    });
    for (let start = 0; start < paired.length; start += HASH_READ_BATCH) {
        const batch = paired.slice(start, start + HASH_READ_BATCH);
        const original_batch = (await alignment_source_read(() =>
            read_source_raw_rows_indexed_async(
                original,
                pairing.originalIndex,
                batch.map((entry) => entry.row.original),
                options.isCancelled ?? (() => false),
            ))).rows;
        const modified_batch = (await alignment_source_read(() =>
            read_source_raw_rows_indexed_async(
                modified,
                pairing.modifiedIndex,
                batch.map((entry) => entry.row.modified),
                options.isCancelled ?? (() => false),
            ))).rows;
        for (let offset = 0; offset < batch.length; offset++) {
            const original_row = original_batch[offset] ?? [];
            const modified_row = modified_batch[offset] ?? [];
            let row_changed = false;
            for (let col = 0; col < column_count; col++) {
                const equal = cells_exactly_equal(
                    original_row[col],
                    modified_row[col],
                    options.isCancelled ?? (() => false),
                );
                const exactly_equal = typeof equal === 'boolean'
                    ? equal
                    : await alignment_source_read(() => equal);
                if (!exactly_equal) {
                    changed_cells++;
                    row_changed = true;
                }
            }
            if (row_changed) changed_row_indices.push(batch[offset].gridRow);
        }
        if (start % checkpoint === 0) {
            await yield_to_event_loop();
            if (options.isCancelled?.()) throw new AlignmentCancelledError();
        }
    }
    return {
        addedRows: added,
        deletedRows: deleted,
        changedCells: changed_cells,
        changedRowIndices: changed_row_indices,
    };
}

/** One side's unpaired row, with where it sits in the unified grid. */
interface Leftover {
    /** Row index into its own side's row space. */
    readonly row: number;
    /** Index into the aligned `rows` array. */
    readonly gridRow: number;
}

/**
 * A candidate row normalized once: its cells' raw text, and their total length.
 *
 * Scoring is quadratic in the candidate count, so normalizing inside the
 * comparison would re-derive the same row's text once per row it is scored
 * against — O(n*m*columns) string extraction for O(n+m) distinct rows.
 */
interface CandidateRow {
    readonly texts: readonly string[];
    /** Total characters, the similarity denominator. Not an integer risk: a
     *  sum over cells could exceed 2^32 on a pathological row, and JS numbers
     *  carry that exactly where a Uint32 would wrap. */
    readonly length: number;
}

function normalize_candidate(
    cells: readonly ({ raw: string | null } | null)[] | undefined,
    column_count: number,
    is_cancelled: () => boolean,
): CandidateRow | Promise<CandidateRow> {
    const texts: string[] = [];
    let length = 0;
    const materialized = visit_materialized_comparison_cells(
        column_count,
        (column) => cells?.[column],
        is_cancelled,
        (text) => {
            texts.push(text);
            length += text.length;
        },
    );
    const finish = (): CandidateRow => ({ texts, length });
    return materialized === undefined ? finish() : materialized.then(finish);
}

async function normalize_candidates(
    rows: readonly (readonly ({ raw: string | null } | null)[])[],
    column_count: number,
    is_cancelled: () => boolean,
): Promise<CandidateRow[]> {
    const normalized: CandidateRow[] = [];
    for (const cells of rows) {
        const candidate = normalize_candidate(cells, column_count, is_cancelled);
        normalized.push(typeof candidate === 'object' && 'texts' in candidate
            ? candidate
            : await alignment_source_read(() => candidate));
    }
    return normalized;
}

/**
 * How strongly two rows resemble each other, or 0 if not enough to call one a
 * move of the other.
 *
 * Length-weighted after git's `src_copied / max_size`: the matched characters
 * must be at least half the longer row's. The ratio is returned rather than a
 * verdict because it also ranks candidates against one another.
 *
 * Matching is *whole-cell* — a cell contributes its length only when both
 * sides' text is exactly equal. Cell *counts* (what xlCompare uses) were
 * rejected because a 3-column row could then only score 0, 33, 67 or 100%, a
 * cliff sitting right on the threshold. The cost is that a row whose content
 * lives in one large edited cell scores near zero and is not detected as a
 * move. That fails safely: an undetected move stays a delete plus an add,
 * exactly the behavior before this pass existed, never a wrong pairing.
 * Catching it would need intra-cell chunk matching — a second diff algorithm
 * with its own effort cap.
 */
function similarity_of(left: CandidateRow, right: CandidateRow): number {
    const max_total = Math.max(left.length, right.length);
    // Two empty rows are identical, not undefined. Returning 0 here would
    // leave a moved blank separator row as a delete plus an add.
    if (max_total === 0) return 1;
    let matched = 0;
    for (let col = 0; col < left.texts.length; col++) {
        if (left.texts[col] !== right.texts[col]) continue;
        matched += left.texts[col].length;
    }
    // Every column is scored, with no early exit once the threshold is
    // cleared: the score also ranks candidates against each other, so
    // stopping at the verdict would flatten every survivor to "at least
    // half" and leave only displacement to choose between a 50% match and a
    // 95% one.
    return is_at_least_half(matched, max_total) ? matched / max_total : 0;
}

/**
 * Re-pair one-sided rows that are the same row in a new position.
 *
 * Myers has no move operation, so a row that changed position comes out of
 * `build_rows` as a deletion plus an unrelated insertion — and because only
 * *adjacent* delete/insert runs pair there, a moved row that was also edited
 * loses its cell-level diff entirely. This pass gets it back.
 *
 * Runs after `build_rows` and *before* `count_changes`, which matters: those
 * counts are derived by scanning for ABSENT, so pairing here makes
 * added/deleted self-adjust with no special-casing, and routes a moved row
 * through the ordinary cell-by-cell comparison that surfaces its edits.
 *
 * Structure follows git's rename detection: exact matches first, then a size
 * prefilter, best-N candidates per destination, a global ranking, and
 * one-to-one assignment.
 */
async function detect_moves(
    original: DataSource,
    modified: DataSource,
    pairing: Extract<SheetPairing, { status: 'matched' }>,
    rows: readonly AlignedRow[],
    original_hashes: Uint32Array,
    modified_hashes: Uint32Array,
    options: AlignSheetOptions,
): Promise<{
    rows: readonly AlignedRow[];
    movedRowIndices: number[];
    moveSearchTruncated: boolean;
}> {
    if (options.isCancelled?.()) throw new AlignmentCancelledError();
    const deleted: Leftover[] = [];
    const added: Leftover[] = [];
    rows.forEach((row, grid_row) => {
        if (row.modified === ABSENT) deleted.push({ row: row.original, gridRow: grid_row });
        else if (row.original === ABSENT) added.push({ row: row.modified, gridRow: grid_row });
    });
    if (deleted.length === 0 || added.length === 0) {
        // Returned as-is, not copied: the caller treats it as readonly, and on
        // a million-row sheet with nothing one-sided the copy was the largest
        // allocation the pass made, to hand back what it was given.
        return { rows, movedRowIndices: [], moveSearchTruncated: false };
    }

    // The pass's verdict, held both ways round. Both directions are needed —
    // forward to decide which original rows to drop, backward to find each
    // destination's origin during the rebuild — and a single map plus separate
    // "claimed" sets was the same information in more places to keep in step.
    const original_to_modified = new Map<number, number>();
    const modified_to_original = new Map<number, number>();
    const claim = (original_row: number, modified_row: number) => {
        original_to_modified.set(original_row, modified_row);
        modified_to_original.set(modified_row, original_row);
    };

    // Exact-hash pass. The hashes are already computed, so an identical moved
    // row pairs with no cell reads at all — this is the whole-file re-sort
    // case, and it is why the work cap below does not gate this phase.
    const by_hash = new Map<number, { entries: Leftover[]; next: number }>();
    for (const entry of deleted) {
        const bucket = by_hash.get(original_hashes[entry.row]);
        if (bucket) bucket.entries.push(entry);
        else by_hash.set(original_hashes[entry.row], { entries: [entry], next: 0 });
    }
    for (const entry of added) {
        // Consumed front to back so duplicate identical rows pair in ascending
        // order on both sides, which is what makes repeated runs produce
        // identical output. A read cursor rather than shift(), which is
        // O(bucket) per call: measured no slower at 10,000 duplicates in one
        // bucket, so this is about not resting on that, not a fix for an
        // observed cost.
        const bucket = by_hash.get(modified_hashes[entry.row]);
        if (bucket === undefined || bucket.next >= bucket.entries.length) continue;
        claim(bucket.entries[bucket.next++].row, entry.row);
    }

    const unmatched_deleted = deleted.filter((entry) => !original_to_modified.has(entry.row));
    const unmatched_added = added.filter((entry) => !modified_to_original.has(entry.row));
    let truncated = false;
    if (unmatched_deleted.length > 0 && unmatched_added.length > 0) {
        const limit = options.maxMoveSearchRows ?? MOVE_SEARCH_LIMIT;
        if (unmatched_deleted.length > limit || unmatched_added.length > limit) {
            // Skipped wholesale rather than sampled. Scoring an arbitrary
            // subset would make the result depend on row order in a way no
            // user could predict, and "some moves, we won't say which" is
            // worse than the honest delete-plus-add they already understand.
            truncated = true;
        } else {
            await score_moves(
                original, modified, pairing, unmatched_deleted, unmatched_added, claim, options);
        }
    }

    if (original_to_modified.size === 0) {
        return { rows, movedRowIndices: [], moveSearchTruncated: truncated };
    }

    // Rebuild. A moved row is emitted once, at its modified-side slot, with
    // both indexes set; the vacated original-side slot is dropped. Everything
    // downstream keys off `modified !== ABSENT`, so a two-index row needs no
    // further handling to read, project, or diff correctly.
    const rebuilt: AlignedRow[] = [];
    const moved_row_indices: number[] = [];
    for (const row of rows) {
        if (row.modified === ABSENT && original_to_modified.has(row.original)) continue;
        const origin = row.original === ABSENT
            ? modified_to_original.get(row.modified)
            : undefined;
        if (origin !== undefined) {
            moved_row_indices.push(rebuilt.length);
            rebuilt.push({ original: origin, modified: row.modified });
            continue;
        }
        rebuilt.push(row);
    }
    return { rows: rebuilt, movedRowIndices: moved_row_indices, moveSearchTruncated: truncated };
}

/** A source row proposed as the origin of a destination row. */
interface MoveCandidate {
    readonly originalRow: number;
    readonly modifiedRow: number;
    /** Matched characters over the longer row's, as git ranks renames. */
    readonly similarity: number;
    readonly displacement: number;
}

/** Order candidates best-first: strongest match, then least movement. Every tie
 *  is broken down to the row indexes, so the result never depends on sort
 *  stability and two runs agree exactly. */
function compare_candidates(left: MoveCandidate, right: MoveCandidate): number {
    return right.similarity - left.similarity
        || left.displacement - right.displacement
        || left.originalRow - right.originalRow
        || left.modifiedRow - right.modifiedRow;
}

/**
 * The inexact phase: score surviving leftovers and assign one-to-one.
 *
 * Reports its verdicts through `claim`, so the exact-hash pass's pairings stay
 * authoritative and are never reconsidered here.
 */
async function score_moves(
    original: DataSource,
    modified: DataSource,
    pairing: Extract<SheetPairing, { status: 'matched' }>,
    unmatched_deleted: readonly Leftover[],
    unmatched_added: readonly Leftover[],
    claim: (original_row: number, modified_row: number) => void,
    options: AlignSheetOptions,
): Promise<void> {
    // Read and normalize once up front. Both sides are capped at
    // MOVE_SEARCH_LIMIT rows, so this is bounded, and it is far cheaper than
    // re-deriving a row's text for each of the up-to-1000 rows it is scored
    // against.
    const column_count = Math.max(
        original.meta().sheets[pairing.originalIndex].columnCount,
        modified.meta().sheets[pairing.modifiedIndex].columnCount,
    );
    const is_cancelled = options.isCancelled ?? (() => false);
    const sources = await normalize_candidates(
        (await alignment_source_read(() =>
            read_source_raw_rows_indexed_async(
                original,
                pairing.originalIndex,
                unmatched_deleted.map((entry) => entry.row),
                is_cancelled,
            ))).rows,
        column_count,
        is_cancelled,
    );
    const destinations = await normalize_candidates(
        (await alignment_source_read(() =>
            read_source_raw_rows_indexed_async(
                modified,
                pairing.modifiedIndex,
                unmatched_added.map((entry) => entry.row),
                is_cancelled,
            ))).rows,
        column_count,
        is_cancelled,
    );

    const candidates: MoveCandidate[] = [];
    let scored = 0;
    for (let added_index = 0; added_index < unmatched_added.length; added_index++) {
        const destination = unmatched_added[added_index];
        const destination_row = destinations[added_index];
        // Kept ordered and bounded as it is built. Collecting every match and
        // sorting afterwards would allocate and sort up to 1000 entries per
        // destination to keep 4 of them.
        const best: MoveCandidate[] = [];
        for (let deleted_index = 0; deleted_index < unmatched_deleted.length; deleted_index++) {
            // Counted before the prefilter, not after. Counting only the pairs
            // that survive it means a run where every pair is rejected on
            // length never reaches a checkpoint, so the loop cannot be
            // cancelled — and rejection is the cheap-per-pair case, which is
            // exactly where the iteration count runs highest.
            scored++;
            if (scored % MOVE_SCORES_PER_CHECKPOINT === 0) {
                // The loop can run a million iterations with no read between
                // them, so reads are not sufficient yield points here.
                await yield_to_event_loop();
                if (options.isCancelled?.()) throw new AlignmentCancelledError();
            }
            const source = unmatched_deleted[deleted_index];
            const source_row = sources[deleted_index];
            const max_length = Math.max(source_row.length, destination_row.length);
            // git's size prefilter, restated: the length difference alone
            // already puts the pair under the threshold, so scoring it would
            // compare cells to reach a conclusion arithmetic already reached.
            const delta = Math.abs(source_row.length - destination_row.length);
            if (max_length > 0 && !is_at_least_half(max_length - delta, max_length)) continue;
            const similarity = similarity_of(source_row, destination_row);
            if (similarity === 0) continue;
            // Displacement only separates equally strong matches: of two
            // sources that resemble the destination alike, the one that moved
            // less is the likelier origin.
            const candidate: MoveCandidate = {
                originalRow: source.row,
                modifiedRow: destination.row,
                similarity,
                displacement: Math.abs(source.gridRow - destination.gridRow),
            };
            // Sorted on every insert, which is free at this size and avoids
            // hand-rolling an ordered container: `best` never exceeds five
            // entries, so this is a handful of comparisons.
            best.push(candidate);
            best.sort(compare_candidates);
            if (best.length > MOVE_CANDIDATES_PER_DESTINATION) best.pop();
        }
        candidates.push(...best);
    }

    // Global ranking, then a greedy one-to-one walk.
    candidates.sort(compare_candidates);
    const claimed_original = new Set<number>();
    const claimed_modified = new Set<number>();
    for (const candidate of candidates) {
        if (claimed_original.has(candidate.originalRow)) continue;
        if (claimed_modified.has(candidate.modifiedRow)) continue;
        claimed_original.add(candidate.originalRow);
        claimed_modified.add(candidate.modifiedRow);
        claim(candidate.originalRow, candidate.modifiedRow);
    }
}
