// Row alignment for compare sessions. Pure (no vscode, no host imports):
// operates on DataSource values so it is unit-testable with in-memory fixtures.
//
// Why this module exists: comparing row N against row N reports a moved or
// inserted row as a screenful of changed cells, because every row below the
// insertion point shifts. Aligning the two sides first is what makes
// added/deleted mean what they say.
import {
    read_source_rows_indexed,
    type DataSource,
    type SheetMeta,
} from '../data-source/interface';
import { get_raw_cell_text } from '../cell-display';
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
function hash_row(cells: readonly ({ raw: string | null } | null)[]): number {
    let hash = 0x811c9dc5;
    const mix = (value: number) => {
        hash ^= value;
        hash = Math.imul(hash, 0x01000193);
    };
    mix(cells.length);
    for (let index = 0; index < cells.length; index++) {
        const text = get_raw_cell_text(cells[index]?.raw ?? null);
        mix(text.length);
        for (let position = 0; position < text.length; position++) {
            mix(text.charCodeAt(position));
        }
    }
    // >>> 0 so the value is a stable unsigned int rather than a sign-flipped
    // one, since it is stored in a Uint32Array and compared for equality.
    return hash >>> 0;
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
        const { rows } = source.read_rows(sheet_index, start, count);
        for (let offset = 0; offset < count; offset++) {
            hashes[start + offset] = hash_row(rows[offset] ?? []);
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

    const rows: AlignedRow[] = script.degraded
        ? identity_alignment(original_rows, modified_rows)
        : build_rows(script, prefix, suffix, original_rows, modified_rows);

    return {
        rows,
        degraded: script.degraded,
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
        const original_batch = read_source_rows_indexed(
            original, pairing.originalIndex, batch.map((entry) => entry.row.original)).rows;
        const modified_batch = read_source_rows_indexed(
            modified, pairing.modifiedIndex, batch.map((entry) => entry.row.modified)).rows;
        for (let offset = 0; offset < batch.length; offset++) {
            const original_row = original_batch[offset] ?? [];
            const modified_row = modified_batch[offset] ?? [];
            let row_changed = false;
            for (let col = 0; col < column_count; col++) {
                if (
                    get_raw_cell_text(original_row[col]?.raw ?? null)
                    !== get_raw_cell_text(modified_row[col]?.raw ?? null)
                ) {
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
