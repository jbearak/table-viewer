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
    get_attr,
} from './ooxml-xml';
import {
    direct_child_elements,
    find_first_element_by_local_name,
    find_tag_end as find_worksheet_tag_end,
    opening_tag_text,
    utf8_text,
    type QualifiedElementSpan,
} from './ooxml-worksheet-scan';
import {
    parse_relationships,
    scan_relationships_document,
    STRICT_PACKAGE_RELATIONSHIPS_NS,
    TRANSITIONAL_PACKAGE_RELATIONSHIPS_NS,
} from './ooxml-relationships';
import type { CellHyperlink } from './cell-content';
import {
    apply_utf8_splices,
    col_index_to_letter,
    writable_worksheet_sheet_data,
} from './xlsx-cell-write';

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

const TRANSITIONAL_HYPERLINK_REL_TYPE
    = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink';
const STRICT_HYPERLINK_REL_TYPE
    = 'http://purl.oclc.org/ooxml/officeDocument/relationships/hyperlink';
const OFFICE_R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const STRICT_OFFICE_R_NS = 'http://purl.oclc.org/ooxml/officeDocument/relationships';
const SPREADSHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const STRICT_SPREADSHEET_NS = 'http://purl.oclc.org/ooxml/spreadsheetml/main';

function local_name(name: string): string {
    return name.slice(name.lastIndexOf(':') + 1);
}

function qname_prefix(name: string): string {
    const colon = name.indexOf(':');
    return colon === -1 ? '' : name.slice(0, colon);
}

interface ParsedAttribute {
    readonly name: string;
    readonly value: string;
}

function opening_attributes(open: string): ParsedAttribute[] {
    const out: ParsedAttribute[] = [];
    let cursor = 1;
    while (cursor < open.length && !/[\s/>]/.test(open[cursor])) cursor += 1;
    while (cursor < open.length) {
        while (/\s/.test(open[cursor] ?? '')) cursor += 1;
        if (cursor >= open.length || open[cursor] === '/' || open[cursor] === '>') break;
        const start = cursor;
        while (cursor < open.length && !/[\s=/>]/.test(open[cursor])) cursor += 1;
        const name = open.slice(start, cursor);
        while (/\s/.test(open[cursor] ?? '')) cursor += 1;
        if (open[cursor] !== '=') break;
        cursor += 1;
        while (/\s/.test(open[cursor] ?? '')) cursor += 1;
        const quote = open[cursor];
        if (quote !== '"' && quote !== "'") break;
        const value_start = ++cursor;
        const value_end = open.indexOf(quote, value_start);
        if (value_end === -1) break;
        const encoded_value = open.slice(value_start, value_end);
        out.push({
            name,
            value: get_attr(`<e ${name}=${quote}${encoded_value}${quote}/>`, name) ?? '',
        });
        cursor = value_end + 1;
    }
    return out;
}

function namespace_bindings(
    xml: Uint8Array,
    elements: readonly QualifiedElementSpan[],
): Map<string, string> {
    const bindings = new Map<string, string>();
    for (const element of elements) {
        for (const attr of opening_attributes(opening_tag_text(xml, element.element))) {
            if (attr.name === 'xmlns') bindings.set('', attr.value);
            else if (attr.name.startsWith('xmlns:')) bindings.set(attr.name.slice(6), attr.value);
        }
    }
    return bindings;
}

function element_namespace(
    xml: Uint8Array,
    element: QualifiedElementSpan,
    ancestors: readonly QualifiedElementSpan[],
): string | undefined {
    const prefix = qname_prefix(element.name);
    return namespace_bindings(xml, [...ancestors, element]).get(prefix);
}

function is_spreadsheet_namespace(namespace: string | undefined): boolean {
    return namespace === SPREADSHEET_NS || namespace === STRICT_SPREADSHEET_NS;
}

function is_spreadsheet_element(
    xml: Uint8Array,
    element: QualifiedElementSpan,
    ancestors: readonly QualifiedElementSpan[],
    implicit_namespace?: string,
): boolean {
    const namespace = element_namespace(xml, element, ancestors);
    return is_spreadsheet_namespace(namespace)
        || (namespace === undefined
            && qname_prefix(element.name) === ''
            && is_spreadsheet_namespace(implicit_namespace));
}

interface WorksheetMarkup {
    readonly root: QualifiedElementSpan;
    readonly prefix: string;
    readonly namespace: string;
    readonly implicitNamespace?: string;
}

function worksheet_markup_names(xml: Uint8Array, require_writable = true): WorksheetMarkup {
    if (require_writable) writable_worksheet_sheet_data(xml);
    const root = find_first_element_by_local_name(xml, 'worksheet');
    if (!root) throw new Error('Worksheet has no worksheet element');
    const namespace = element_namespace(xml, root, []);
    // Minimal test fixtures historically omit the namespace entirely. Treat an
    // unqualified namespace-free root as SpreadsheetML, but never do that for a
    // qualified or explicitly foreign root.
    const effective = namespace ?? (qname_prefix(root.name) === '' ? SPREADSHEET_NS : undefined);
    if (!is_spreadsheet_namespace(effective)) throw new Error('Worksheet root is not SpreadsheetML');
    const raw_prefix = qname_prefix(root.name);
    return {
        root,
        prefix: raw_prefix === '' ? '' : `${raw_prefix}:`,
        namespace: effective!,
        ...(namespace === undefined && raw_prefix === ''
            ? { implicitNamespace: effective! }
            : {}),
    };
}


/** `0,0` → `A1`. */
function cell_ref(row: number, col: number): string {
    return `${col_index_to_letter(col)}${row + 1}`;
}

export interface ScannedWorksheetHyperlink {
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
    readonly location: string | null;
    readonly tooltip: string | null;
}

interface HyperlinkSection {
    readonly section: QualifiedElementSpan;
}

function worksheet_hyperlink_section(
    xml: Uint8Array,
    markup: WorksheetMarkup,
): HyperlinkSection | undefined {
    const section = direct_child_elements(xml, markup.root.element).find((candidate) =>
        local_name(candidate.name) === 'hyperlinks'
        && is_spreadsheet_element(
            xml,
            candidate,
            [markup.root],
            markup.implicitNamespace,
        ));
    return section === undefined ? undefined : { section };
}

function namespaced_relationship_id(
    open: string,
    bindings: ReadonlyMap<string, string>,
): string | null {
    for (const attr of opening_attributes(open)) {
        if (local_name(attr.name) !== 'id') continue;
        const prefix = qname_prefix(attr.name);
        if (prefix === '') continue;
        const namespace = bindings.get(prefix);
        if (namespace === OFFICE_R_NS || namespace === STRICT_OFFICE_R_NS) return attr.value;
    }
    return null;
}

/** Reader/writer-shared scan of the authoritative SpreadsheetML hyperlink section. */
export function scan_worksheet_hyperlinks(
    source: Uint8Array | string,
): readonly ScannedWorksheetHyperlink[] {
    const xml = typeof source === 'string' ? Buffer.from(source, 'utf8') : source;
    const markup = worksheet_markup_names(xml, false);
    const located = worksheet_hyperlink_section(xml, markup);
    if (located === undefined) return [];
    return scan_located_worksheet_hyperlinks(xml, markup, located.section);
}

function scan_located_worksheet_hyperlinks(
    xml: Uint8Array,
    markup: WorksheetMarkup,
    section: QualifiedElementSpan,
): readonly ScannedWorksheetHyperlink[] {
    const found: ScannedWorksheetHyperlink[] = [];
    for (const child of direct_child_elements(xml, section.element)) {
        if (local_name(child.name) !== 'hyperlink'
            || !is_spreadsheet_element(
                xml,
                child,
                [markup.root, section],
                markup.implicitNamespace,
            )) continue;
        const open = opening_tag_text(xml, child.element);
        const ref = get_attr(open, 'ref');
        if (!ref) continue;
        const bindings = namespace_bindings(xml, [markup.root, section, child]);
        found.push({
            element: utf8_text(xml, child.element.start, child.element.end),
            r_id: namespaced_relationship_id(open, bindings),
            ref,
            display: get_attr(open, 'display'),
            location: get_attr(open, 'location'),
            tooltip: get_attr(open, 'tooltip'),
        });
    }
    return found;
}

/**
 * CT_Worksheet schema order. A new section is inserted after the last present
 * predecessor or before the first present successor.
 */
const WORKSHEET_CHILD_ORDER = [
    'sheetPr', 'dimension', 'sheetViews', 'sheetFormatPr', 'cols', 'sheetData',
    'sheetCalcPr', 'sheetProtection', 'protectedRanges', 'scenarios', 'autoFilter',
    'sortState', 'dataConsolidate', 'customSheetViews', 'mergeCells', 'phoneticPr',
    'conditionalFormatting', 'dataValidations', 'hyperlinks',
    'printOptions', 'pageMargins', 'pageSetup', 'headerFooter', 'rowBreaks',
    'colBreaks', 'customProperties', 'cellWatches', 'ignoredErrors',
    'smartTags', 'drawing', 'legacyDrawing', 'legacyDrawingHF', 'picture',
    'oleObjects', 'controls', 'webPublishItems', 'tableParts', 'extLst',
] as const;

/** The byte offset in `xml` where a new `<hyperlinks>` section belongs. */
function hyperlink_section_insert_pos(
    xml: Uint8Array,
    markup: WorksheetMarkup,
): number {
    const hyperlink_index = WORKSHEET_CHILD_ORDER.indexOf('hyperlinks');
    let after_predecessor: number | undefined;
    for (const child of direct_child_elements(xml, markup.root.element)) {
        if (!is_spreadsheet_element(
            xml,
            child,
            [markup.root],
            markup.implicitNamespace,
        )) continue;
        const index = WORKSHEET_CHILD_ORDER.indexOf(
            local_name(child.name) as typeof WORKSHEET_CHILD_ORDER[number],
        );
        if (index === -1) continue;
        if (index > hyperlink_index) return child.element.start;
        if (index < hyperlink_index) after_predecessor = child.element.end;
    }
    if (after_predecessor === undefined) throw new Error('Worksheet has no sheetData element');
    return after_predecessor;
}

function relationship_prefix(
    xml: Uint8Array,
    root: QualifiedElementSpan,
    section: QualifiedElementSpan | undefined,
    spreadsheet_namespace: string,
): { readonly prefix: string; readonly declaration?: { at: number; text: string } } {
    const bindings = namespace_bindings(xml, section === undefined ? [root] : [root, section]);
    for (const [prefix, namespace] of bindings) {
        if (prefix !== '' && (namespace === OFFICE_R_NS || namespace === STRICT_OFFICE_R_NS)) {
            return { prefix };
        }
    }
    let prefix = 'r';
    let suffix = 1;
    while (bindings.has(prefix)) prefix = `r${suffix++}`;
    const tag_end = find_worksheet_tag_end(xml, root.element.start, root.element.inner_start);
    if (tag_end === -1) throw new Error('Worksheet has no worksheet element');
    const namespace = spreadsheet_namespace === STRICT_SPREADSHEET_NS
        ? STRICT_OFFICE_R_NS : OFFICE_R_NS;
    return {
        prefix,
        declaration: {
            at: xml[tag_end - 1] === 0x2f ? tag_end - 1 : tag_end,
            text: ` xmlns:${prefix}="${namespace}"`,
        },
    };
}

/** All relationship IDs of a `.rels` document (any type — new IDs must avoid
 *  every existing one, not just hyperlinks). */
function all_rel_ids(rels_xml: string): Set<string> {
    const ids = new Set<string>();
    const document = scan_relationships_document(rels_xml);
    for (const relationship of document?.relationships ?? []) {
        const id = get_attr(relationship.openTag, 'Id');
        if (id) ids.add(id);
    }
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

function empty_relationships(namespace: string): string {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
        + `<Relationships xmlns="${namespace}"/>`;
}

function relationship_element_name(rels_xml: string): string {
    const document = scan_relationships_document(rels_xml);
    if (document === undefined) throw new Error('Malformed relationships part');
    const existing = document.relationships[0]?.name;
    if (existing !== undefined) {
        const prefix = qname_prefix(existing);
        const declaration = prefix === '' ? 'xmlns' : `xmlns:${prefix}`;
        return get_attr(document.rootOpenTag, declaration) === document.namespace
            ? existing
            : `${existing} ${declaration}="${document.namespace}"`;
    }
    const prefix = qname_prefix(document.root.name);
    return prefix === '' ? 'Relationship' : `${prefix}:Relationship`;
}

/** Append `<Relationship>` elements to a `.rels` document, self-closing-root
 *  aware. `additions` are pre-serialized elements. */
function append_relationships(rels_xml: string, additions: readonly string[]): string {
    if (additions.length === 0) return rels_xml;
    const document = scan_relationships_document(rels_xml);
    if (document === undefined) throw new Error('Malformed relationships part');
    const bytes = Buffer.from(rels_xml, 'utf8');
    const text = additions.join('');
    if (document.root.element.inner_start !== document.root.element.end) {
        return utf8_text(apply_utf8_splices(bytes, [{
            start: document.root.element.inner_end,
            end: document.root.element.inner_end,
            text,
        }]));
    }
    const expanded = document.rootOpenTag.replace(/\/\s*>$/, '>');
    return utf8_text(apply_utf8_splices(bytes, [{
        start: document.root.element.start,
        end: document.root.element.end,
        text: `${expanded}${text}</${document.root.name}>`,
    }]));
}

/** Remove the `<Relationship>` elements whose Id is in `ids`, verbatim
 *  otherwise. */
function remove_relationships(rels_xml: string, ids: ReadonlySet<string>): string {
    if (ids.size === 0) return rels_xml;
    const document = scan_relationships_document(rels_xml);
    if (document === undefined) return rels_xml;
    return utf8_text(apply_utf8_splices(
        Buffer.from(rels_xml, 'utf8'),
        document.relationships.flatMap((relationship) => {
            const id = get_attr(relationship.openTag, 'Id');
            return id !== null && ids.has(id) ? [{
                start: relationship.element.start,
                end: relationship.element.end,
                text: '',
            }] : [];
        }),
    ));
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
    const out: ClearedDisplay[] = [];
    // FIRST element per ref wins, because that is the one whose text the reader
    // shows: parse-xlsx synthesizes the cell from the first `<hyperlink>` it
    // meets for a coordinate and a later duplicate only overwrites the cell's
    // `.hyperlink`, never its text. Taking the last instead changed a cell
    // reading `first` into `second` on a clear, and invented `second` outright
    // when the first element carried no display at all. Nothing forbids two
    // elements naming one ref, so this is not a hypothetical shape.
    const seen = new Set<string>();
    for (const link of scan_worksheet_hyperlinks(sheet_xml)) {
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
    const markup = worksheet_markup_names(sheet_xml);
    const q = (name: string): string => `${markup.prefix}${name}`;
    // Last edit wins per cell ref.
    const by_ref = canonical_link_edits(edits, () => {
        throw new Error('Invalid hyperlink edit coordinates');
    });

    // Same locator the reader uses, so the two cannot disagree about which
    // `<hyperlinks>` section is the live one.
    const located_section = worksheet_hyperlink_section(sheet_xml, markup);
    const section = located_section?.section;
    const current = section === undefined
        ? []
        : scan_located_worksheet_hyperlinks(sheet_xml, markup, section);
    const section_prefix = section === undefined
        ? markup.prefix
        : qname_prefix(section.name) === '' ? '' : `${qname_prefix(section.name)}:`;
    const hyperlink_name = `${section_prefix}hyperlink`;
    const relationship_name = relationship_prefix(
        sheet_xml,
        markup.root,
        section,
        markup.namespace,
    );

    // Relationship bookkeeping. Only *hyperlink* rels may ever be removed, and
    // only when no surviving element still references them — a drawing rel
    // sharing the file must never be collateral.
    const rels = rels_xml === null ? new Map() : parse_relationships(rels_xml);
    const used_ids = rels_xml === null ? new Set<string>() : all_rel_ids(rels_xml);
    const base_rels = rels_xml ?? empty_relationships(
        markup.namespace === STRICT_SPREADSHEET_NS
            ? STRICT_PACKAGE_RELATIONSHIPS_NS
            : TRANSITIONAL_PACKAGE_RELATIONSHIPS_NS,
    );
    const relationship_element = [...by_ref.values()].some(
        (edit) => edit.link?.kind === 'external',
    ) ? relationship_element_name(base_rels) : 'Relationship';
    const hyperlink_relationship_type = markup.namespace === STRICT_SPREADSHEET_NS
        ? STRICT_HYPERLINK_REL_TYPE
        : TRANSITIONAL_HYPERLINK_REL_TYPE;

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
                `<${hyperlink_name} ref="${ref}" location="${encode_xml_attr(edit.link.location)}"`
                + `${display}${tooltip}/>`,
            );
        } else {
            const r_id = fresh_rel_id(used_ids);
            const tooltip = edit.link.tooltip !== undefined
                ? ` tooltip="${encode_xml_attr(edit.link.tooltip)}"` : '';
            added.push(
                `<${hyperlink_name} ref="${ref}" ${relationship_name.prefix}:id="${r_id}"`
                + `${display}${tooltip}/>`,
            );
            new_rel_elements.push(
                `<${relationship_element} Id="${r_id}" Type="${hyperlink_relationship_type}" `
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
        if (rel && (
            rel.type === TRANSITIONAL_HYPERLINK_REL_TYPE
            || rel.type === STRICT_HYPERLINK_REL_TYPE
        )) removed_rel_ids.add(r_id);
    }

    // Splice the worksheet once, even when adding both a section and `xmlns:r`.
    const elements = [...kept, ...added];
    const sheet_splices: Array<{ start: number; end: number; text: string }> = [];
    if (elements.length === 0) {
        if (section) sheet_splices.push({
            start: section.element.start,
            end: section.element.end,
            text: '',
        });
    } else {
        if (section) {
            const opening = opening_tag_text(sheet_xml, section.element);
            const expanded = opening.replace(/\/\s*>$/, '>');
            const closing = section.element.inner_start === section.element.end
                ? `</${section.name}>`
                : utf8_text(sheet_xml, section.element.inner_end, section.element.end);
            sheet_splices.push({
                start: section.element.start,
                end: section.element.end,
                text: `${expanded}${elements.join('')}${closing}`,
            });
        } else {
            const section_text = `<${q('hyperlinks')}>${elements.join('')}</${q('hyperlinks')}>`;
            const at = hyperlink_section_insert_pos(sheet_xml, markup);
            sheet_splices.push({ start: at, end: at, text: section_text });
        }
    }
    if (new_rel_elements.length > 0 && relationship_name.declaration !== undefined) {
        sheet_splices.push({
            start: relationship_name.declaration.at,
            end: relationship_name.declaration.at,
            text: relationship_name.declaration.text,
        });
    }
    const updated_sheet = apply_utf8_splices(sheet_xml, sheet_splices);

    // Splice the rels.
    let updated_rels: string | null = null;
    if (new_rel_elements.length > 0 || removed_rel_ids.size > 0) {
        updated_rels = append_relationships(
            remove_relationships(base_rels, removed_rel_ids),
            new_rel_elements,
        );
    }

    return {
        sheet_xml: return_text ? utf8_text(updated_sheet) : updated_sheet,
        rels_xml: updated_rels,
    };
}
