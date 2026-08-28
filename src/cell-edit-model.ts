/**
 * The edit-space model of a cell: what the Markdown editor field shows, what a
 * committed edit parses back into, and how two edit-space values compare.
 *
 * Two syntaxes, chosen per profile and carried as a snapshot capability:
 *   - 'plain'    — the raw cell text verbatim (CSV/TSV; unchanged behavior).
 *   - 'markdown' — Excel. The editor shows the cell's *effective rich content*
 *     (its runs, or the raw text under the whole-cell font style) serialized by
 *     rich-text-markdown.ts, with literal `\ * ~ < >` backslash-escaped. This
 *     applies to every text cell of the sheet, styled or not, so the syntax is
 *     uniform: what you see in the field is always markup.
 *
 * Markdown never becomes the stored value (see cell-content.ts): a commit
 * parses back to normalized runs, and the dirty entry stores the plain-text
 * projection plus the runs when they carry styles. Equality is semantic —
 * pending-changes.ts's editable_values_equal over normalized runs — so a
 * formatting-only change is a real edit, and retyping a cell's own markup
 * (however spelled) reverts cleanly.
 *
 * Isomorphic on purpose (no DOM/VS Code/Glide imports): the webview derives
 * editor text and conflict bases from loaded cells, the host derives the same
 * bases from the parsed source at save time, and the two must be one function.
 */

import { get_raw_cell_text } from './cell-display';
import { is_xlsx_formula_text } from './xlsx-formula';
import {
    normalize_text_style,
    rich_text_from_plain,
    rich_text_has_styles,
    rich_text_plain_text,
    type CellHyperlink,
    type CellTextStyle,
    type RichText,
} from './cell-content';
import {
    editable_values_equal,
    plain_value,
    rich_value,
    type EditableCellValue,
} from './pending-changes';
import { markdown_to_rich_text, rich_text_to_markdown } from './rich-text-markdown';

/** How a sheet's cells are edited. Projected by the host as a capability. */
export type EditSyntax = 'plain' | 'markdown';

/** The fields this model reads — satisfied by the parser's CellData and the
 *  webview's RenderedCell alike (both extend RichCellFields). */
export interface EditableSourceCell {
    /** Scalar cells stringify — the editor and the dirty map are text-typed. */
    readonly raw: string | number | boolean | null;
    /** Effective XLSX formula, including the leading `=` shown in the editor. */
    readonly formula?: string;
    readonly bold?: boolean;
    readonly italic?: boolean;
    readonly underline?: boolean;
    readonly strikethrough?: boolean;
    readonly richText?: RichText;
    /** The cell's whole-cell link — the base a hyperlink edit is made against. */
    readonly hyperlink?: CellHyperlink;
}

/** The raw value as the text the editor and the dirty map hold — the same
 *  stringification every raw-text consumer applies (cell-display.ts). */
function raw_text(cell: EditableSourceCell): string {
    return get_raw_cell_text(cell.raw ?? null);
}

/** The whole-cell font flags as a sparse style, or undefined when plain. */
export function cell_whole_style(cell: EditableSourceCell): CellTextStyle | undefined {
    return normalize_text_style(cell);
}

/**
 * The cell's effective rich content: its runs when the source string carries
 * them (styles already effective — inheritance resolved by the parser),
 * otherwise the raw text under the whole-cell font style. This is what a
 * formatting edit is an edit *of* — deleting the `**` around a bold cell's
 * text is how the user asks for it to stop being bold.
 */
export function cell_effective_rich_text(cell: EditableSourceCell): RichText {
    return cell.richText ?? rich_text_from_plain(raw_text(cell), cell_whole_style(cell));
}

/** The text the editor field opens with. A blank cell is ''. Derived, not a
 *  second serialization: what a loaded cell opens with must be exactly what
 *  its edit base displays as, or retyping the field's own content would not
 *  read as a revert. */
export function cell_edit_text(cell: EditableSourceCell, syntax: EditSyntax): string {
    return edit_display_text(cell_edit_base(cell), syntax);
}

/**
 * A committed edit, parsed. `text` is the plain projection — what the save
 * writes for an unstyled value and what every string-typed layer (durable
 * state, base validation, CSV) continues to see. `rich` is present only when
 * the parsed runs carry styles, so plain edits keep their exact legacy shape.
 */
export interface ParsedCellEdit {
    readonly text: string;
    readonly rich?: RichText;
}

export function parse_cell_edit(input: string, syntax: EditSyntax): ParsedCellEdit {
    if (syntax === 'plain') return { text: input };
    // XLSX uses the markdown edit syntax for rich text, but a leading `=` is a
    // formula and its operators are not markdown. In particular, `E5*F5` must
    // not acquire italic runs or lose either asterisk before it reaches the
    // formula writer.
    if (is_xlsx_formula_text(input)) return { text: input };
    const rich = markdown_to_rich_text(input);
    const text = rich_text_plain_text(rich);
    return rich_text_has_styles(rich) ? { text, rich } : { text };
}

/** A ParsedCellEdit as the format-neutral value pending-changes.ts compares. */
export function edit_value(edit: ParsedCellEdit): EditableCellValue {
    return edit.rich ? rich_value(edit.rich) : plain_value(edit.text);
}

/** Semantic equality of two edit-space values (normalized-run comparison; a
 *  formatting-only difference is a difference). */
export function cell_edits_equal(left: ParsedCellEdit, right: ParsedCellEdit): boolean {
    return editable_values_equal(edit_value(left), edit_value(right));
}

/**
 * The run side a committed edit stores. A styled parse keeps its runs. An
 * *unstyled* parse over a styled base also gets runs — explicit plain ones —
 * because deleting the `**` around a bold cell's text is how the user removes
 * the bold: committed as a bare string, the writer would classify it plainly
 * and the cell font would re-style it on the next open, silently undoing the
 * edit. Explicit plain runs make the writer emit a font-replacing `<rPr>`.
 * Empty text stores no runs — there is nothing left to style.
 */
export function committed_value_runs(
    parsed: ParsedCellEdit,
    base: ParsedCellEdit,
): RichText | undefined {
    if (parsed.rich) return parsed.rich;
    if (base.rich && parsed.text !== '') return rich_text_from_plain(parsed.text);
    return undefined;
}

/**
 * The conflict base of a loaded cell, in edit space: the plain raw text plus
 * the effective runs when they carry styles. Symmetric with ParsedCellEdit so
 * base-vs-current comparisons go through {@link cell_edits_equal}.
 */
export function cell_edit_base(cell: EditableSourceCell): ParsedCellEdit {
    if (cell.formula !== undefined) return { text: cell.formula };
    const rich = cell_effective_rich_text(cell);
    return rich_text_has_styles(rich)
        ? { text: raw_text(cell), rich }
        : { text: raw_text(cell) };
}

/** Re-derive the editor/display text of a stored edit (a dirty entry's value
 *  or base) — markdown when the sheet edits as markdown, verbatim otherwise. */
export function edit_display_text(edit: ParsedCellEdit, syntax: EditSyntax): string {
    if (syntax === 'plain') return edit.text;
    if (edit.rich === undefined && is_xlsx_formula_text(edit.text)) {
        return edit.text;
    }
    return rich_text_to_markdown(edit.rich ?? rich_text_from_plain(edit.text));
}

/** The editor text a dirty entry's committed value re-opens with — shared by
 *  the hook's begin_editing and the grid's overlay so the two editor paths
 *  cannot drift. Structural on purpose: takes the entry's fields, not
 *  CsvDirtyEntry itself, to keep this module a leaf. */
export function dirty_value_edit_text(
    entry: { readonly value: string; readonly valueRuns?: RichText },
    syntax: EditSyntax,
): string {
    return edit_display_text({ text: entry.value, rich: entry.valueRuns }, syntax);
}
