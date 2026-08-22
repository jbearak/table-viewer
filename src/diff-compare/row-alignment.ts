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
    /** Paired rows with at least one differing cell. */
    readonly changedRows: number;
    /**
     * Indexes into `rows` of the paired rows that differ, ascending. Recorded
     * during the same comparison that produces `changedRows`, so the
     * "only changed rows" filter costs no extra reads. One-sided rows are not
     * listed here — a consumer wanting every *interesting* row takes these plus
     * the rows with an ABSENT side.
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
     * spending unbounded time proving they do not match.
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
/** Rows read from a side in one batched call while hashing. */
const HASH_READ_BATCH = 512;

/**
 * Default effort cap. Myers costs O(ND) with D the edit distance, so this
 * bounds the *work*, not the file size: a million-row file with a thousand
 * changed rows aligns well inside it, while two unrelated files hit it early
 * and degrade instead of grinding.
 */
export const DEFAULT_MAX_EDIT_DISTANCE = 100_000;

/** FNV-1a over the row's raw cell text, with a unit separator between cells so
 *  `['ab','c']` and `['a','bc']` cannot collide. */
function hash_row(cells: readonly ({ raw: string | null } | null)[]): number {
    let hash = 0x811c9dc5;
    for (let index = 0; index < cells.length; index++) {
        const text = get_raw_cell_text(cells[index]?.raw ?? null);
        for (let position = 0; position < text.length; position++) {
            hash ^= text.charCodeAt(position);
            hash = Math.imul(hash, 0x01000193);
        }
        hash ^= 0x1f;
        hash = Math.imul(hash, 0x01000193);
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
            await Promise.resolve();
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
    readonly editDistance: number;
    readonly degraded: boolean;
}

/**
 * Myers' O(ND) diff over two hash arrays, bounded by `max_distance`. Returns
 * `degraded` when the bound is hit, in which case `ops` is meaningless and the
 * caller falls back to positional.
 *
 * Equality here is hash equality; the caller confirms candidate pairs by
 * comparing actual cell text, so a collision costs an extra read and a
 * spuriously "changed" row, never a wrong row count.
 */
function myers_diff(
    left: Uint32Array,
    right: Uint32Array,
    max_distance: number,
): EditScript {
    const n = left.length;
    const m = right.length;
    if (n === 0 || m === 0) {
        const ops: { kind: 'equal' | 'delete' | 'insert'; count: number }[] = [];
        if (n > 0) ops.push({ kind: 'delete', count: n });
        if (m > 0) ops.push({ kind: 'insert', count: m });
        return { ops, editDistance: n + m, degraded: false };
    }
    const max = Math.min(n + m, max_distance);
    const offset = max;
    const v = new Int32Array(2 * max + 1).fill(-1);
    v[offset + 1] = 0;
    /** One furthest-reaching frontier per edit distance, kept so the path can
     *  be walked back once the end is reached. */
    const trace: Int32Array[] = [];
    for (let d = 0; d <= max; d++) {
        trace.push(v.slice());
        for (let k = -d; k <= d; k += 2) {
            const index = offset + k;
            // Step down (an insert) when that reaches further than stepping
            // right (a delete) — the standard Myers frontier choice.
            let x = (k === -d || (k !== d && v[index - 1] < v[index + 1]))
                ? v[index + 1]
                : v[index - 1] + 1;
            let y = x - k;
            while (x < n && y < m && left[x] === right[y]) {
                x++;
                y++;
            }
            v[index] = x;
            if (x >= n && y >= m) {
                return { ...backtrack(trace, n, m, offset), editDistance: d, degraded: false };
            }
        }
    }
    return { ops: [], editDistance: max, degraded: true };
}

/** Walk the recorded frontiers back to a unified op list. */
function backtrack(
    trace: readonly Int32Array[],
    n: number,
    m: number,
    offset: number,
): { ops: { kind: 'equal' | 'delete' | 'insert'; count: number }[] } {
    const reversed: { kind: 'equal' | 'delete' | 'insert'; count: number }[] = [];
    let x = n;
    let y = m;
    const push = (kind: 'equal' | 'delete' | 'insert', count: number) => {
        if (count <= 0) return;
        const last = reversed[reversed.length - 1];
        if (last?.kind === kind) reversed[reversed.length - 1] = { kind, count: last.count + count };
        else reversed.push({ kind, count });
    };
    for (let d = trace.length - 1; d > 0; d--) {
        const v = trace[d];
        const k = x - y;
        const index = offset + k;
        const down = k === -d || (k !== d && v[index - 1] < v[index + 1]);
        const previous_k = down ? k + 1 : k - 1;
        const previous_x = v[offset + previous_k];
        const previous_y = previous_x - previous_k;
        // The diagonal run this frontier extended, before the single edit.
        push('equal', x - previous_x - (down ? 0 : 1));
        push(down ? 'insert' : 'delete', 1);
        x = previous_x;
        y = previous_y;
    }
    push('equal', x);
    return { ops: reversed.reverse() };
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

    const script = myers_diff(
        original_hashes.subarray(prefix, original_rows - suffix),
        modified_hashes.subarray(prefix, modified_rows - suffix),
        options.maxEditDistance ?? DEFAULT_MAX_EDIT_DISTANCE,
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
    'addedRows' | 'deletedRows' | 'changedRows' | 'changedCells' | 'changedRowIndices'
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
            await Promise.resolve();
            if (options.isCancelled?.()) throw new AlignmentCancelledError();
        }
    }
    return {
        addedRows: added,
        deletedRows: deleted,
        changedRows: changed_row_indices.length,
        changedCells: changed_cells,
        changedRowIndices: changed_row_indices,
    };
}
