/**
 * Host-side validation of a save's edit bases against the raw, untransformed
 * source. Pure and vscode-free so it can be unit-tested directly.
 *
 * Why this cannot live in the webview alone. `is_entry_conflicted`
 * (webview/edit-session-store.ts) compares an entry's `base` against
 * `get_cell_raw` and treats `undefined` — "the page holding this source row is
 * not resident" — as unknown rather than as a conflict. That is a statement about
 * page *residency*, not about the file: an edit whose page was evicted, never
 * fetched, or which lies past the current row count can never be flagged there.
 * The host has no residency problem, because it reads the source it parsed, so
 * validation has to happen here as well, at save time, independent of whatever
 * the grid happens to be holding.
 *
 * Three cases, deliberately kept distinct:
 *
 * 1. **Absent from the filtered view is VALID**, and never even reaches this
 *    function as a problem. The host validates against the untransformed source,
 *    so a row hidden by a sort or filter is fully readable through `read_raw`;
 *    only the webview could not see it. That is the entire reason validation
 *    moved host-side, and the reason a hidden row must never be mistaken for a
 *    removed one.
 * 2. **Removed by a real file shrink** (`source_row >= source_row_count`): the
 *    row is gone from the file rather than merely out of view → `removedRows`.
 * 3. **Base mismatch**: the cell is readable and its text is not what the edit
 *    was made against → `conflicts`.
 *
 * A fourth, degenerate case joins (2): a key that does not parse as a pair of
 * non-negative integers. This is the last gate before a raw `write_file`, so it
 * is the strictest reader of a key in the codebase, stricter than
 * `row-loader.ts`'s ingest validation and deliberately so.
 */

import {
    rich_text_equal,
    rich_text_from_plain,
    type RichText,
} from './cell-content';
import type { CsvDirtyMap } from './types';

export type BaseValidationOutcome =
    | { readonly type: 'valid' }
    | { readonly type: 'conflicts'; readonly keys: readonly string[] }
    | { readonly type: 'removedRows'; readonly keys: readonly string[] };

/** Formatting halves of a base comparison, texts already known equal. An
 *  absent side means "plain", so a plain-vs-plain cell is equal without
 *  materializing runs, and a one-sided absence compares against explicit
 *  plain runs of the shared text rather than failing on mere sparseness. */
function base_formatting_equal(
    left: RichText | undefined,
    right: RichText | undefined,
    text: string,
): boolean {
    if (left === undefined && right === undefined) return true;
    return rich_text_equal(
        left ?? rich_text_from_plain(text),
        right ?? rich_text_from_plain(text),
    );
}

export function validate_dirty_bases(
    dirty_edits: CsvDirtyMap,
    source_row_count: number,
    read_raw: (source_row: number, col: number) => string | undefined,
    /**
     * The source cell's *effective* rich content (cell-edit-model.ts's
     * `cell_edit_base(...).rich`), or undefined for a plain cell. When the
     * caller supplies this reader, a base whose text still matches but whose
     * formatting drifted is a conflict too — otherwise a stale formatting-only
     * edit would silently overwrite newer formatting. Callers with no rich
     * source (CSV) omit it, keeping their text-only contract intact.
     */
    read_rich?: (source_row: number, col: number) => RichText | undefined,
): BaseValidationOutcome {
    const removed_keys: string[] = [];
    const conflicted_keys: string[] = [];

    for (const [key, entry] of Object.entries(dirty_edits)) {
        const [source_row, col] = key.split(':').map(Number);
        // Fail closed on a key that is not a pair of non-negative integers. Without
        // this the arithmetic silently absorbs the garbage rather than rejecting it:
        // `''`, `'a:b'` and `'4'` all yield NaN, `NaN >= source_row_count` is
        // **false** so the removed-row branch below misses them, and then
        // `read_raw(NaN, col) ?? ''` compares '' against the entry's base — so any
        // malformed key whose base happens to be '' would pass validation outright
        // and be handed to the serializer. Grouped with `removedRows` because that
        // is the outcome whose message ("edited rows no longer exist") is the
        // closest true statement about a key that names no row at all, and because
        // it takes precedence, so one such key cannot be masked by a mismatch.
        if (
            !Number.isInteger(source_row)
            || !Number.isInteger(col)
            || source_row < 0
            || col < 0
        ) {
            removed_keys.push(key);
            continue;
        }
        if (source_row >= source_row_count) {
            removed_keys.push(key);
            continue;
        }
        // A short row — or a column past that row's field count — reads as
        // undefined; coalesce to '' to match the webview's `get_cell_raw`
        // contract, where a loaded-but-blank cell is ''. Without this every edit
        // that filled a blank trailing cell would validate as a false conflict.
        const current = read_raw(source_row, col) ?? '';
        if (current !== entry.base) {
            conflicted_keys.push(key);
            continue;
        }
        // Text matches; on a rich source, the formatting must too. A cell the
        // text reader could not observe was already conflicted above (`current`
        // is '' only when the base claims ''), so reading rich for it is moot —
        // undefined from either side of an unobserved cell means "plain".
        if (
            read_rich
            && !base_formatting_equal(entry.baseRuns, read_rich(source_row, col), current)
        ) {
            conflicted_keys.push(key);
        }
    }

    // A removed row outranks a mismatch: it is the more destructive fact, and its
    // message is the one that tells the user what actually happened to the file.
    if (removed_keys.length > 0) return { type: 'removedRows', keys: removed_keys };
    if (conflicted_keys.length > 0) return { type: 'conflicts', keys: conflicted_keys };
    return { type: 'valid' };
}
