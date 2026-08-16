/**
 * Format-neutral pending-change model shared by the webview edit stores, the
 * durable-state codec, and the host save pipeline.
 *
 * A worksheet's unsaved work has two independent dimensions:
 *   - cell VALUE changes — plain text (CSV, and Excel cells without run
 *     formatting) or rich text (Excel cells with runs);
 *   - cell HYPERLINK changes — add/edit/clear of the whole-cell link, which is
 *     relationship metadata, never part of the text.
 *
 * Both are keyed `"<canonical source row>:<source column>"`. Each change
 * carries the `base` it was made against so the webview can tint conflicts and
 * the host can refuse a save whose source moved underneath it.
 */

import { is_plain_record } from './plain-record';
import {
    hyperlinks_equal,
    is_valid_rich_text,
    rich_text_equal,
    rich_text_from_plain,
    rich_text_plain_text,
    type CellHyperlink,
    type RichText,
} from './cell-content';

// Structural rich-text validation lives beside the RichText model in
// cell-content.ts (a leaf), so future codecs can validate without importing
// this higher-level module; re-exported because this is where consumers of the
// *pending-change* validators already look.
export { is_matching_rich_text, is_valid_rich_text } from './cell-content';

/** A value as the editor produces it. `plain` carries exact text (CSV and
 *  typed scalars); `richText` carries normalized runs (Excel text cells). */
export type EditableCellValue =
    | { readonly kind: 'plain'; readonly text: string }
    | { readonly kind: 'richText'; readonly value: RichText };

export interface CellValueChange {
    readonly value: EditableCellValue;
    readonly base: EditableCellValue;
}

/** A whole-cell hyperlink change. `null` = no link. */
export interface HyperlinkChange {
    readonly value: CellHyperlink | null;
    readonly base: CellHyperlink | null;
}

export function plain_value(text: string): EditableCellValue {
    return { kind: 'plain', text };
}

export function rich_value(value: RichText): EditableCellValue {
    return { kind: 'richText', value };
}

/** The plain text a value renders/saves as. */
export function editable_value_text(value: EditableCellValue): string {
    return value.kind === 'plain' ? value.text : rich_text_plain_text(value.value);
}

/**
 * Semantic equality. A plain value and a rich value with the same text are
 * equal only when the rich side carries no styles — a formatting-only edit is
 * a real change.
 */
export function editable_values_equal(
    left: EditableCellValue,
    right: EditableCellValue,
): boolean {
    if (left.kind === 'plain' && right.kind === 'plain') return left.text === right.text;
    if (left.kind === 'richText' && right.kind === 'richText') {
        return rich_text_equal(left.value, right.value);
    }
    const plain = left.kind === 'plain' ? left : (right as Extract<EditableCellValue, { kind: 'plain' }>);
    const rich = left.kind === 'richText' ? left : (right as Extract<EditableCellValue, { kind: 'richText' }>);
    return rich_text_equal(rich.value, rich_text_from_plain(plain.text));
}

export function hyperlink_changes_equal(
    left: HyperlinkChange,
    right: HyperlinkChange,
): boolean {
    return hyperlinks_equal(left.value, right.value) && hyperlinks_equal(left.base, right.base);
}

// --- Validation (durable state and wire payloads are untrusted) ---

export const MAX_HYPERLINK_LENGTH = 8 * 1024;

export function is_valid_editable_value(value: unknown): value is EditableCellValue {
    if (!is_plain_record(value)) return false;
    if (value.kind === 'plain') return typeof value.text === 'string';
    if (value.kind === 'richText') return is_valid_rich_text(value.value);
    return false;
}

export function is_valid_hyperlink(value: unknown): value is CellHyperlink {
    if (!is_plain_record(value)) return false;
    if (value.tooltip !== undefined
        && (typeof value.tooltip !== 'string' || value.tooltip.length > MAX_HYPERLINK_LENGTH)) {
        return false;
    }
    if (value.kind === 'external') {
        return typeof value.target === 'string'
            && value.target.length > 0
            && value.target.length <= MAX_HYPERLINK_LENGTH;
    }
    if (value.kind === 'internal') {
        return typeof value.location === 'string'
            && value.location.length > 0
            && value.location.length <= MAX_HYPERLINK_LENGTH;
    }
    return false;
}

export function is_valid_hyperlink_change(value: unknown): value is HyperlinkChange {
    if (!is_plain_record(value)) return false;
    const ok = (side: unknown): boolean => side === null || is_valid_hyperlink(side);
    return ok(value.value) && ok(value.base);
}
