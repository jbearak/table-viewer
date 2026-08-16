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
    is_self_closing,
    is_tag_boundary,
    iter_elements,
} from './ooxml-xml';
import { parse_relationships } from './ooxml-relationships';
import type { CellHyperlink } from './cell-content';
import { col_index_to_letter } from './xlsx-cell-write';

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
export interface HyperlinkWriteResult {
    readonly sheet_xml: string;
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
    iter_elements(section_inner, 'hyperlink', (open_tag, inner) => {
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
 * The index of `needle` in `xml` at or after `from`, skipping any occurrence
 * that falls inside a comment, a CDATA section, or a processing instruction.
 *
 * Every scan in this module is a raw substring search, which is what keeps the
 * writer from deserializing the worksheet. That is safe for markup but not for
 * *text*: a sheet carrying `<!-- <hyperlinks> -->` would otherwise have its
 * edit spliced into ignored content — a save that reports success while Excel
 * sees no change at all.
 */
function index_of_markup(xml: string, needle: string, from = 0): number {
    const skips: readonly (readonly [string, string])[] = [
        ['<!--', '-->'],
        ['<![CDATA[', ']]>'],
        ['<?', '?>'],
    ];
    let pos = from;
    while (pos < xml.length) {
        const hit = xml.indexOf(needle, pos);
        if (hit === -1) return -1;
        // The innermost ignored region that starts before the hit and has not
        // closed by it swallows the hit; resume after that region.
        let resume = -1;
        for (const [open, close] of skips) {
            const open_at = xml.lastIndexOf(open, hit);
            if (open_at === -1) continue;
            const close_at = xml.indexOf(close, open_at + open.length);
            if (close_at !== -1 && close_at < hit) continue;
            const after = close_at === -1 ? xml.length : close_at + close.length;
            if (after > resume) resume = after;
        }
        if (resume === -1) return hit;
        pos = resume;
    }
    return -1;
}

/** {@link String.lastIndexOf} with the same ignored-region rule. */
function last_index_of_markup(xml: string, needle: string): number {
    let found = -1;
    let pos = 0;
    while (true) {
        const hit = index_of_markup(xml, needle, pos);
        if (hit === -1) return found;
        found = hit;
        pos = hit + needle.length;
    }
}

/** Locate the `<hyperlinks>` section: [start, end) of the whole element, and
 *  its inner text. Returns null when the sheet has none. */
function find_hyperlinks_section(
    xml: string,
): { start: number; end: number; inner: string } | null {
    const open = '<hyperlinks';
    let pos = 0;
    while (true) {
        const start = index_of_markup(xml, open, pos);
        if (start === -1) return null;
        if (!is_tag_boundary(xml[start + open.length])) {
            pos = start + 1;
            continue;
        }
        const tag_end = find_tag_end(xml, start);
        if (tag_end === -1) return null;
        if (is_self_closing(xml, start, tag_end)) {
            return { start, end: tag_end + 1, inner: '' };
        }
        const close = '</hyperlinks>';
        const close_pos = index_of_markup(xml, close, tag_end);
        if (close_pos === -1) return null;
        return {
            start,
            end: close_pos + close.length,
            inner: xml.substring(tag_end + 1, close_pos),
        };
    }
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

/** The index in `xml` where a new `<hyperlinks>` section belongs. */
function hyperlink_section_insert_pos(xml: string): number {
    for (const tag of AFTER_HYPERLINKS) {
        const open = `<${tag}`;
        let pos = 0;
        while (true) {
            const start = index_of_markup(xml, open, pos);
            if (start === -1) break;
            if (!is_tag_boundary(xml[start + open.length])) {
                pos = start + 1;
                continue;
            }
            return start;
        }
    }
    const close_sheet_data = last_index_of_markup(xml, '</sheetData>');
    if (close_sheet_data !== -1) return close_sheet_data + '</sheetData>'.length;
    // A wholly empty sheet writes <sheetData/>; insert right after it.
    const empty_sheet_data = index_of_markup(xml, '<sheetData/>');
    if (empty_sheet_data !== -1) return empty_sheet_data + '<sheetData/>'.length;
    throw new Error('Worksheet has no sheetData element');
}

/** True when the `<worksheet …>` open tag declares the `r` namespace. */
function worksheet_declares_r_ns(xml: string): boolean {
    const start = index_of_markup(xml, '<worksheet');
    if (start === -1) return false;
    const tag_end = find_tag_end(xml, start);
    if (tag_end === -1) return false;
    return xml.substring(start, tag_end + 1).includes('xmlns:r=');
}

/** Add `xmlns:r` to the `<worksheet>` open tag. */
function add_r_ns(xml: string): string {
    const start = index_of_markup(xml, '<worksheet');
    const tag_end = find_tag_end(xml, start);
    const insert = tag_end !== -1 && xml[tag_end - 1] === '/' ? tag_end - 1 : tag_end;
    if (start === -1 || tag_end === -1) throw new Error('Worksheet has no worksheet element');
    return `${xml.slice(0, insert)} xmlns:r="${OFFICE_R_NS}"${xml.slice(insert)}`;
}

/** All relationship IDs of a `.rels` document (any type — new IDs must avoid
 *  every existing one, not just hyperlinks). */
function all_rel_ids(rels_xml: string): Set<string> {
    const ids = new Set<string>();
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
        const start = out.indexOf(open, pos);
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
            const close_pos = out.indexOf('</Relationship>', tag_end);
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
): HyperlinkWriteResult {
    if (edits.length === 0) {
        return { sheet_xml, rels_xml: null };
    }
    // Last edit wins per cell ref.
    const by_ref = new Map<string, XlsxHyperlinkEdit>();
    for (const edit of edits) {
        if (!Number.isSafeInteger(edit.row) || edit.row < 0
            || !Number.isSafeInteger(edit.col) || edit.col < 0) {
            throw new Error('Invalid hyperlink edit coordinates');
        }
        by_ref.set(cell_ref(edit.row, edit.col), edit);
    }

    const section = find_hyperlinks_section(sheet_xml);
    const current = section ? existing_hyperlinks(section.inner) : [];

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

    // Splice the sheet.
    const elements = [...kept, ...added];
    let updated_sheet: string;
    if (elements.length === 0) {
        updated_sheet = section
            ? sheet_xml.slice(0, section.start) + sheet_xml.slice(section.end)
            : sheet_xml;
    } else {
        const section_text = `<hyperlinks>${elements.join('')}</hyperlinks>`;
        updated_sheet = section
            ? sheet_xml.slice(0, section.start) + section_text + sheet_xml.slice(section.end)
            : (() => {
                const at = hyperlink_section_insert_pos(sheet_xml);
                return sheet_xml.slice(0, at) + section_text + sheet_xml.slice(at);
            })();
    }
    if (new_rel_elements.length > 0 && !worksheet_declares_r_ns(updated_sheet)) {
        updated_sheet = add_r_ns(updated_sheet);
    }

    // Splice the rels.
    let updated_rels: string | null = null;
    if (new_rel_elements.length > 0 || removed_rel_ids.size > 0) {
        const base = rels_xml ?? EMPTY_RELS;
        updated_rels = append_relationships(
            remove_relationships(base, removed_rel_ids),
            new_rel_elements,
        );
    }

    return { sheet_xml: updated_sheet, rels_xml: updated_rels };
}
