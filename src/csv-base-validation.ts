/**
 * Host-side validation of a save's edit bases against the raw, untransformed
 * source. Pure and vscode-free so it can be unit-tested directly.
 *
 * Why this cannot live in the webview alone. The renderer observes file changes
 * through its paged row cache, where `undefined` means the source row is not
 * resident. That is a statement about page residency, not the file: an edited row
 * whose page was evicted or never fetched cannot be checked there. The host reads
 * the parsed source directly, so validation also happens here at save time.
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
 * 3. **Base mismatch**: the cell is readable and differs from the last file side
 *    the renderer observed → `conflicts` (the legacy internal outcome name).
 *
 * A fourth, degenerate case joins (2): a key that does not parse as a pair of
 * non-negative integers. This is the last gate before a raw `write_file`, so it
 * is the strictest reader of a key in the codebase, stricter than
 * `row-loader.ts`'s ingest validation and deliberately so.
 */

import {
    hyperlinks_equal,
    rich_text_equal,
    rich_text_from_plain,
    type CellHyperlink,
    type RichText,
} from './cell-content';
import { parse_cell_key } from './cell-key';
import {
    dirty_entry_base_formatting_unknown,
    dirty_entry_observed_base,
    make_observed_file_base,
    type CsvCellSaveRejection,
    type CsvDirtyMap,
    type CsvObservedFileBase,
} from './types';

export type BaseValidationOutcome =
    | { readonly type: 'valid' }
    | {
        readonly type: 'conflicts';
        readonly keys: readonly string[];
        readonly observedBases: Readonly<Record<string, CsvObservedFileBase>>;
    }
    | {
        readonly type: 'removedRows';
        readonly keys: readonly string[];
        readonly changedKeys?: readonly string[];
        readonly observedBases?: Readonly<Record<string, CsvObservedFileBase>>;
    };

/** Convert one failed base validation into the renderer's save rejection wire shape. */
export function base_validation_save_rejection(
    validation: Exclude<BaseValidationOutcome, { readonly type: 'valid' }>,
    worksheet_operation_index: number,
): CsvCellSaveRejection {
    switch (validation.type) {
        case 'removedRows':
            return {
                reason: 'rowsRemoved',
                worksheetOperationIndex: worksheet_operation_index,
                keys: [...validation.keys, ...(validation.changedKeys ?? [])],
                ...(validation.changedKeys === undefined ? {} : {
                    removedKeys: validation.keys,
                    observedBases: validation.observedBases,
                }),
            };
        case 'conflicts':
            return {
                reason: 'baseMismatch',
                worksheetOperationIndex: worksheet_operation_index,
                keys: validation.keys,
                observedBases: validation.observedBases,
            };
        default: {
            const exhaustive: never = validation;
            return exhaustive;
        }
    }
}

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
    /**
     * The source cell's hyperlink: a link, `null` for an observed linkless
     * cell, `undefined` for a cell that was never observed. Consulted only for
     * entries carrying a link change (`entry.link !== undefined`); a stale
     * `baseLink` — or an unobservable cell — conflicts the key rather than
     * letting the save overwrite a link nobody checked.
     */
    read_link?: (source_row: number, col: number) => CellHyperlink | null | undefined,
): BaseValidationOutcome {
    const removed_keys: string[] = [];
    const conflicted_keys: string[] = [];
    const observed_bases: Record<string, CsvObservedFileBase> = {};

    for (const [key, entry] of Object.entries(dirty_edits)) {
        // Fail closed through the shared canonical parser. Numeric coercion would
        // otherwise accept aliases such as `01:0`; the serializer addresses the
        // same cell as `1:0`, so accepting both spellings can validate one key and
        // silently drop the edit stored under the other. Grouped with `removedRows`
        // because that outcome's message is the closest true statement about a key
        // that names no canonical source row, and because it takes precedence over
        // mismatches so malformed keys cannot be masked.
        const coordinates = parse_cell_key(key);
        if (!coordinates) {
            removed_keys.push(key);
            continue;
        }
        const { sourceRow: source_row, sourceColumn: col } = coordinates;
        if (source_row >= source_row_count) {
            removed_keys.push(key);
            continue;
        }
        // A short row — or a column past that row's field count — reads as
        // undefined; coalesce to '' to match the webview's `get_cell_raw`
        // contract, where a loaded-but-blank cell is ''. Without this every edit
        // that filled a blank trailing cell would validate as a false conflict.
        const current = read_raw(source_row, col) ?? '';
        const current_rich = read_rich?.(source_row, col);
        const current_link = entry.link !== undefined
            ? read_link?.(source_row, col)
            : undefined;
        const expected = dirty_entry_observed_base(entry);
        let changed = current !== expected.value;
        // Text matches; on a rich source, the formatting must too. A cell the
        // text reader could not observe was already conflicted above (`current`
        // is '' only when the base claims ''), so reading rich for it is moot —
        // undefined from either side of an unobserved cell means "plain".
        if (!changed && (
            read_rich
            && (
                entry.observedBase !== undefined
                || !dirty_entry_base_formatting_unknown(entry)
            )
            && !base_formatting_equal(expected.runs, current_rich, current)
        )) changed = true;
        // A link change validates its own base independently: the link the
        // edit was made against must still be the cell's link. Fail closed on
        // both ways of not knowing — an unobserved cell (`undefined` from the
        // reader) and a caller that supplied no reader at all. The latter is
        // not a "text-only contract" case the way `read_rich` is: only a
        // source that carries links can produce a link edit in the first
        // place, so an entry with one and no observer means the two sides
        // disagree about the format, and the safe answer is to refuse rather
        // than write a link nobody checked.
        if (entry.link !== undefined && !changed) {
            if (
                current_link === undefined
                || !hyperlinks_equal(expected.link ?? null, current_link)
            ) {
                changed = true;
            }
        }
        if (!changed) continue;
        conflicted_keys.push(key);
        // A missing link reader cannot establish a safe next compare-and-set
        // base for a pending link edit. Keep the key rejected but omit its
        // observed side, so a later save still fails closed instead of treating
        // an unknown link as linkless.
        if (entry.link !== undefined && current_link === undefined) continue;
        observed_bases[key] = make_observed_file_base(
            current,
            current_rich,
            entry.link !== undefined ? current_link : undefined,
        );
    }

    // Keep both facts from one validation pass. The removed-row message still
    // leads, but readable cells that changed are reviewed at the same time
    // instead of appearing only after the user fixes the removed entries and
    // retries the save.
    if (removed_keys.length > 0) return {
        type: 'removedRows',
        keys: removed_keys,
        ...(conflicted_keys.length > 0 ? {
            changedKeys: conflicted_keys,
            observedBases: observed_bases,
        } : {}),
    };
    if (conflicted_keys.length > 0) {
        return { type: 'conflicts', keys: conflicted_keys, observedBases: observed_bases };
    }
    return { type: 'valid' };
}
