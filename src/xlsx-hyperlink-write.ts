/**
 * Surgical hyperlink writes into a worksheet's OOXML and its `.rels` part.
 *
 * Same design constraint as xlsx-cell-write.ts: never deserialize the
 * worksheet into a model. The `<hyperlinks>` section is rebuilt (it is small
 * and wholly ours to manage), but everything outside the spliced ranges —
 * the section's position, every other worksheet feature, and every unrelated
 * relationship in the `.rels` part — is copied through verbatim.
 *
 * The unit of edit is one cell's whole link: set (external or internal) or
 * clear. External links live in two places at once — a `<hyperlink r:id=…>`
 * element in the sheet and a `TargetMode="External"` relationship in the
 * sheet's `.rels` — so a set/clear plans both splices together; the caller
 * commits them atomically with the rest of the save (see xlsx-package.ts).
 *
 * Read-side symmetry: parse-xlsx.ts collapses an external Target plus a
 * worksheet `location` attribute into one `target#fragment` string, so the
 * split is not representable in CellHyperlink. The writer therefore always
 * emits the whole target (fragment included) as the relationship Target and
 * never writes a `location` on an external link — semantically equivalent
 * XML that round-trips exactly through our own reader.
 */

import {
    encode_xml_attr,
    find_tag_end,
    get_attr,
    index_of_markup,
    is_self_closing,
    is_tag_boundary,
    iter_elements,
    iter_elements_markup,
    last_index_of_markup,
} from './ooxml-xml';
import {
    find_element_section as find_worksheet_section,
    find_tag_end as find_worksheet_tag_end,
    index_of_markup as index_of_worksheet_markup,
    is_tag_boundary as is_worksheet_tag_boundary,
    last_index_of_markup as last_index_of_worksheet_markup,
    utf8_text,
} from './ooxml-worksheet-scan';
import { parse_relationships } from './ooxml-relationships';
import type { CellHyperlink } from './cell-content';
import { apply_utf8_splices, col_index_to_letter } from './xlsx-cell-write';

/** One cell's link edit, in canonical source coordinates (0-based). */
export interface XlsxHyperlinkEdit {
    readonly row: number;
    readonly col: number;
    /** The link to write, or null to clear the cell's link. */
    readonly link: CellHyperlink | null;
}

/** The two texts a worksheet's hyperlink edits change. `rels_xml` is null when
 *  the `.rels` part needs no change (internal-only edits against a sheet whose
 *  rels are untouched). Whether a returned part must be ADDED to the package
 *  rather than replaced is not reported here: the caller passed the part in, so
 *  it already knows — a null input with a non-null result is a creation. */
export interface HyperlinkWriteResult<T extends Uint8Array | string = Uint8Array> {
    readonly sheet_xml: T;
    readonly rels_xml: string | null;
}

const HYPERLINK_REL_TYPE
    = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink';
const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';


/** `0,0` → `A1`. */
function cell_ref(row: number, col: number): string {
    return `${col_index_to_letter(col)}${row + 1}`;
}

interface ExistingHyperlink {
    /** The verbatim element text — the whole element, including a close tag
     *  when the source spelled it as a container. An untouched link is
     *  re-emitted byte-for-byte from this, so re-emitting only the open tag
     *  would turn `<hyperlink …></hyperlink>` into an unclosed child. */
    readonly element: string;
    /** The rel this element references, if external. */
    readonly r_id: string | null;
    readonly ref: string;
    /**
     * The element's `display` attribute, which is the cell's *text* when the
     * cell carries no value of its own (see parse-xlsx.ts). A replacement
     * must carry it across: dropping it on a link-only edit would erase the
     * visible text of a cell whose value dimension was never touched.
     */
    readonly display: string | null;
}

/** Every `<hyperlink>` element of the current section, in document order. */
function existing_hyperlinks(section_inner: string): ExistingHyperlink[] {
    const found: ExistingHyperlink[] = [];
    // Markup-aware: a commented-out `<hyperlink>` is not an element the sheet
    // declares, so it must not be re-emitted as live markup. Ignored content
    // *inside* a live element still comes through verbatim in `inner` — an
    // untouched link's vendor `extLst` CDATA has to survive the rebuild.
    iter_elements_markup(section_inner, 'hyperlink', (open_tag, inner) => {
        const ref = get_attr(open_tag, 'ref');
        if (!ref) return;
        found.push({
            element: is_self_closing(open_tag, 0, open_tag.length - 1)
                ? open_tag
                : `${open_tag}${inner}</hyperlink>`,
            r_id: get_attr(open_tag, 'r:id'),
            ref,
            display: get_attr(open_tag, 'display'),
        });
    });
    return found;
}

/**
 * CT_Worksheet elements that FOLLOW `hyperlinks` in the schema sequence. A new
 * section is inserted immediately before the first of these present (all are
 * optional), and after `</sheetData>` at the latest — every element between
 * sheetData and hyperlinks is optional too, so "before the first follower" is
 * the one correct position whatever subset the sheet carries.
 */
const AFTER_HYPERLINKS = [
    'printOptions', 'pageMargins', 'pageSetup', 'headerFooter', 'rowBreaks',
    'colBreaks', 'customProperties', 'cellWatches', 'ignoredErrors',
    'smartTags', 'drawing', 'legacyDrawing', 'legacyDrawingHF', 'picture',
    'oleObjects', 'controls', 'webPublishItems', 'tableParts', 'extLst',
] as const;

/** The byte offset in `xml` where a new `<hyperlinks>` section belongs. */
function hyperlink_section_insert_pos(xml: Uint8Array): number {
    for (const tag of AFTER_HYPERLINKS) {
        const open = `<${tag}`;
        let pos = 0;
        while (true) {
            const start = index_of_worksheet_markup(xml, open, pos);
            if (start === -1) break;
            if (!is_worksheet_tag_boundary(xml[start + open.length])) {
                pos = start + 1;
                continue;
            }
            return start;
        }
    }
    const close_sheet_data = last_index_of_worksheet_markup(xml, '</sheetData>');
    if (close_sheet_data !== -1) return close_sheet_data + '</sheetData>'.length;
    // A wholly empty sheet writes <sheetData/>; insert right after it.
    const empty_sheet_data = index_of_worksheet_markup(xml, '<sheetData/>');
    if (empty_sheet_data !== -1) return empty_sheet_data + '<sheetData/>'.length;
    throw new Error('Worksheet has no sheetData element');
}

/** Namespace insertion point, or null when the worksheet already declares it. */
function r_namespace_insert_pos(xml: Uint8Array): number | null {
    const start = index_of_worksheet_markup(xml, '<worksheet');
    if (start === -1) throw new Error('Worksheet has no worksheet element');
    const tag_end = find_worksheet_tag_end(xml, start);
    if (tag_end === -1) throw new Error('Worksheet has no worksheet element');
    if (utf8_text(xml, start, tag_end + 1).includes('xmlns:r=')) return null;
    return xml[tag_end - 1] === 0x2f ? tag_end - 1 : tag_end;
}

/** All relationship IDs of a `.rels` document (any type — new IDs must avoid
 *  every existing one, not just hyperlinks). */
function all_rel_ids(rels_xml: string): Set<string> {
    const ids = new Set<string>();
    // Deliberately NOT markup-aware, unlike parse_relationships: this set only
    // says which ids a new one must avoid, and steering clear of an id that
    // exists solely in a comment costs nothing while colliding with one could
    // resurrect it if the comment is ever restored.
    iter_elements(rels_xml, 'Relationship', (open_tag) => {
        const id = get_attr(open_tag, 'Id');
        if (id) ids.add(id);
    });
    return ids;
}

/** A fresh `rId<n>` not colliding with any existing ID. */
function fresh_rel_id(used: Set<string>): string {
    let n = 1;
    while (used.has(`rId${n}`)) n += 1;
    const id = `rId${n}`;
    used.add(id);
    return id;
}

const EMPTY_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${RELS_NS}"/>`;

/** Append `<Relationship>` elements to a `.rels` document, self-closing-root
 *  aware. `additions` are pre-serialized elements. */
function append_relationships(rels_xml: string, additions: readonly string[]): string {
    if (additions.length === 0) return rels_xml;
    const close = '</Relationships>';
    const close_pos = last_index_of_markup(rels_xml, close);
    if (close_pos !== -1) {
        return rels_xml.slice(0, close_pos) + additions.join('') + rels_xml.slice(close_pos);
    }
    // Self-closing root: <Relationships …/>
    const start = index_of_markup(rels_xml, '<Relationships');
    const tag_end = start === -1 ? -1 : find_tag_end(rels_xml, start);
    if (start === -1 || tag_end === -1 || rels_xml[tag_end - 1] !== '/') {
        throw new Error('Malformed relationships part');
    }
    return `${rels_xml.slice(0, tag_end - 1)}>${additions.join('')}${close}${rels_xml.slice(tag_end + 1)}`;
}

/** Remove the `<Relationship>` elements whose Id is in `ids`, verbatim
 *  otherwise. */
function remove_relationships(rels_xml: string, ids: ReadonlySet<string>): string {
    if (ids.size === 0) return rels_xml;
    let out = rels_xml;
    // Right-to-left splices so earlier ranges stay valid.
    const ranges: Array<{ start: number; end: number }> = [];
    const open = '<Relationship';
    let pos = 0;
    while (true) {
        // Markup-aware: a `<Relationship>` that only exists inside a comment
        // must not be spliced. Editing ignored content would leave the live
        // rel in place, so the sheet would point at a target we believe we
        // retired. Scanning a stripped copy is not an option here — these are
        // offsets into the text we return, and stripping would also delete the
        // part's `<?xml …?>` declaration.
        const start = index_of_markup(out, open, pos);
        if (start === -1) break;
        if (!is_tag_boundary(out[start + open.length])) {
            pos = start + 1;
            continue;
        }
        const tag_end = find_tag_end(out, start);
        if (tag_end === -1) break;
        const open_tag = out.substring(start, tag_end + 1);
        const id = get_attr(open_tag, 'Id');
        let end = tag_end + 1;
        if (!is_self_closing(out, start, tag_end)) {
            const close_pos = index_of_markup(out, '</Relationship>', tag_end);
            if (close_pos === -1) break;
            end = close_pos + '</Relationship>'.length;
        }
        if (id && ids.has(id)) ranges.push({ start, end });
        pos = end;
    }
    for (let i = ranges.length - 1; i >= 0; i--) {
        out = out.slice(0, ranges[i].start) + out.slice(ranges[i].end);
    }
    return out;
}

/** The `display` text a clear edit is about to delete along with its element. */
export interface ClearedDisplay {
    readonly row: number;
    readonly col: number;
    readonly text: string;
}

/**
 * The `display` texts that *clear* edits would delete along with their elements.
 *
 * `display` is the cell's text when the sheet has no `<c>` for that coordinate
 * (see parse-xlsx.ts), so a clear that removes the element can remove the only
 * copy of the text and the cell reads back blank. A *replacement* is already
 * safe — `apply_hyperlink_edits` carries `displaced_display` onto the new
 * element — so only clears are reported.
 *
 * Deliberately NOT called "orphaned": this layer can see that a text is about
 * to be deleted, but not whether anything else still supplies it. Whether the
 * cell actually depends on it is the worksheet-body question the caller
 * answers, since only it knows whether a `<c>` exists — or is about to, from a
 * value edit in the same save.
 */
export function cleared_display_texts(
    source: Uint8Array | string,
    edits: readonly XlsxHyperlinkEdit[],
): ClearedDisplay[] {
    const sheet_xml = typeof source === 'string' ? Buffer.from(source, 'utf8') : source;
    // Same last-wins canonicalization the splice uses, so the two cannot
    // disagree about which edit governs a cell: a clear followed by a set keeps
    // its display on the replacement and needs no promotion.
    const by_ref = canonical_link_edits(edits, () => undefined);
    let any_clear = false;
    for (const edit of by_ref.values()) if (edit.link === null) { any_clear = true; break; }
    // A set-only batch can never delete a display, so it never pays for the
    // section scan below.
    if (!any_clear) return [];
    const section = find_worksheet_section(sheet_xml, 'hyperlinks');
    if (!section) return [];
    const section_inner = utf8_text(sheet_xml, section.inner_start, section.inner_end);
    const out: ClearedDisplay[] = [];
    // FIRST element per ref wins, because that is the one whose text the reader
    // shows: parse-xlsx synthesizes the cell from the first `<hyperlink>` it
    // meets for a coordinate and a later duplicate only overwrites the cell's
    // `.hyperlink`, never its text. Taking the last instead changed a cell
    // reading `first` into `second` on a clear, and invented `second` outright
    // when the first element carried no display at all. Nothing forbids two
    // elements naming one ref, so this is not a hypothetical shape.
    const seen = new Set<string>();
    for (const link of existing_hyperlinks(section_inner)) {
        if (seen.has(link.ref)) continue;
        seen.add(link.ref);
        const edit = by_ref.get(link.ref);
        if (!edit || edit.link !== null) continue;
        if (link.display === null || link.display === '') continue;
        out.push({ row: edit.row, col: edit.col, text: link.display });
    }
    return out;
}

/**
 * Collapse edits to one per cell ref, last write winning.
 *
 * Shared by the splice and the display preflight so a duplicate coordinate
 * cannot resolve to one edit in one and a different edit in the other — the
 * preflight would then preserve the text for an edit that never ran.
 *
 * `on_invalid` decides what an out-of-range coordinate means to the caller:
 * the splice throws, while the preflight is only reporting and lets the splice
 * be the one to refuse.
 */
function canonical_link_edits(
    edits: readonly XlsxHyperlinkEdit[],
    on_invalid: (edit: XlsxHyperlinkEdit) => void,
): Map<string, XlsxHyperlinkEdit> {
    const by_ref = new Map<string, XlsxHyperlinkEdit>();
    for (const edit of edits) {
        if (!Number.isSafeInteger(edit.row) || edit.row < 0
            || !Number.isSafeInteger(edit.col) || edit.col < 0) {
            on_invalid(edit);
            continue;
        }
        by_ref.set(cell_ref(edit.row, edit.col), edit);
    }
    return by_ref;
}

/**
 * Apply a worksheet's hyperlink edits to its XML and `.rels` text.
 *
 * `rels_xml` is the current `.rels` part text, or null when the sheet has
 * none. Pure: returns the replacement texts, mutates nothing. Duplicate
 * coordinates resolve last-edit-wins, matching apply_cell_edits.
 */
export function apply_hyperlink_edits(
    sheet_xml: string,
    rels_xml: string | null,
    edits: readonly XlsxHyperlinkEdit[],
): HyperlinkWriteResult<string>;
export function apply_hyperlink_edits(
    sheet_xml: Uint8Array,
    rels_xml: string | null,
    edits: readonly XlsxHyperlinkEdit[],
): HyperlinkWriteResult<Uint8Array>;
export function apply_hyperlink_edits(
    source: Uint8Array | string,
    rels_xml: string | null,
    edits: readonly XlsxHyperlinkEdit[],
): HyperlinkWriteResult<Uint8Array | string> {
    if (edits.length === 0) {
        return { sheet_xml: source, rels_xml: null };
    }
    const return_text = typeof source === 'string';
    const sheet_xml = return_text ? Buffer.from(source, 'utf8') : source;
    // Last edit wins per cell ref.
    const by_ref = canonical_link_edits(edits, () => {
        throw new Error('Invalid hyperlink edit coordinates');
    });

    // Same locator the reader uses, so the two cannot disagree about which
    // `<hyperlinks>` section is the live one.
    const section = find_worksheet_section(sheet_xml, 'hyperlinks');
    const current = section
        ? existing_hyperlinks(utf8_text(sheet_xml, section.inner_start, section.inner_end))
        : [];

    // Relationship bookkeeping. Only *hyperlink* rels may ever be removed, and
    // only when no surviving element still references them — a drawing rel
    // sharing the file must never be collateral.
    const rels = rels_xml === null ? new Map() : parse_relationships(rels_xml);
    const used_ids = rels_xml === null ? new Set<string>() : all_rel_ids(rels_xml);

    // Build the new element list: untouched elements verbatim (order kept),
    // replaced/added ones serialized fresh in edit order after them.
    const kept: string[] = [];
    const kept_r_ids = new Set<string>();
    const displaced_r_ids = new Set<string>();
    /** `display` of the element an edit replaces, so it survives the rebuild. */
    const displaced_display = new Map<string, string>();
    for (const link of current) {
        if (by_ref.has(link.ref)) {
            if (link.r_id) displaced_r_ids.add(link.r_id);
            if (link.display !== null && link.display !== '') {
                displaced_display.set(link.ref, link.display);
            }
        } else {
            kept.push(link.element);
            if (link.r_id) kept_r_ids.add(link.r_id);
        }
    }

    const added: string[] = [];
    const new_rel_elements: string[] = [];
    for (const [ref, edit] of by_ref) {
        if (edit.link === null) continue;
        const previous_display = displaced_display.get(ref);
        const display = previous_display !== undefined
            ? ` display="${encode_xml_attr(previous_display)}"` : '';
        if (edit.link.kind === 'internal') {
            const tooltip = edit.link.tooltip !== undefined
                ? ` tooltip="${encode_xml_attr(edit.link.tooltip)}"` : '';
            added.push(
                `<hyperlink ref="${ref}" location="${encode_xml_attr(edit.link.location)}"`
                + `${display}${tooltip}/>`,
            );
        } else {
            const r_id = fresh_rel_id(used_ids);
            const tooltip = edit.link.tooltip !== undefined
                ? ` tooltip="${encode_xml_attr(edit.link.tooltip)}"` : '';
            added.push(`<hyperlink ref="${ref}" r:id="${r_id}"${display}${tooltip}/>`);
            new_rel_elements.push(
                `<Relationship Id="${r_id}" Type="${HYPERLINK_REL_TYPE}" `
                + `Target="${encode_xml_attr(edit.link.target)}" TargetMode="External"/>`,
            );
            kept_r_ids.add(r_id);
        }
    }

    // Orphaned hyperlink rels: displaced by an edit AND not referenced by any
    // surviving element AND actually a hyperlink relationship.
    const removed_rel_ids = new Set<string>();
    for (const r_id of displaced_r_ids) {
        if (kept_r_ids.has(r_id)) continue;
        const rel = rels.get(r_id);
        if (rel && rel.type === HYPERLINK_REL_TYPE) removed_rel_ids.add(r_id);
    }

    // Splice the worksheet once, even when adding both a section and `xmlns:r`.
    const elements = [...kept, ...added];
    const sheet_splices: Array<{ start: number; end: number; text: string }> = [];
    if (elements.length === 0) {
        if (section) sheet_splices.push({ start: section.start, end: section.end, text: '' });
    } else {
        const section_text = `<hyperlinks>${elements.join('')}</hyperlinks>`;
        if (section) {
            sheet_splices.push({ start: section.start, end: section.end, text: section_text });
        } else {
            const at = hyperlink_section_insert_pos(sheet_xml);
            sheet_splices.push({ start: at, end: at, text: section_text });
        }
    }
    if (new_rel_elements.length > 0) {
        const at = r_namespace_insert_pos(sheet_xml);
        if (at !== null) {
            sheet_splices.push({ start: at, end: at, text: ` xmlns:r="${OFFICE_R_NS}"` });
        }
    }
    const updated_sheet = apply_utf8_splices(sheet_xml, sheet_splices);

    // Splice the rels.
    let updated_rels: string | null = null;
    if (new_rel_elements.length > 0 || removed_rel_ids.size > 0) {
        const base = rels_xml ?? EMPTY_RELS;
        updated_rels = append_relationships(
            remove_relationships(base, removed_rel_ids),
            new_rel_elements,
        );
    }

    return {
        sheet_xml: return_text ? utf8_text(updated_sheet) : updated_sheet,
        rels_xml: updated_rels,
    };
}
