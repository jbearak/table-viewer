import {
    decode_xml,
    get_attr,
    ignorable_ranges as string_ignorable_ranges,
    remove_attr,
    replace_attr_value,
    strip_illegal_xml_chars,
} from './ooxml-xml';
import {
    find_first_element,
    find_tag_end,
    get_tag_attr,
    ignorable_ranges,
    index_of_bytes,
    indexOf_live,
    is_self_closing,
    is_tag_boundary,
    letter_to_index,
    live_tags,
    opening_tag_text,
    scan_cells,
    scan_rows,
    starts_with_bytes,
    utf8_text,
    type ScanRowsOptions,
    type Span,
} from './ooxml-worksheet-scan';
import { OoxmlRefusalError, type OoxmlRefusalCode } from './ooxml-refusal';
import { text_styles_equal, type CellTextStyle, type RichTextRun } from './cell-content';
import {
    compile_workbook_formula_graph,
} from './formula-dependencies';
import {
    is_xlsx_formula_text,
    translate_a1_formula,
    workbook_a1_formula_references,
} from './xlsx-formula';
import {
    classify_xlsx_cell_value,
    xlsx_runs_require_inline_string,
} from './xlsx-cell-value';

export { iso_to_serial } from './xlsx-cell-value';

/**
 * Surgical, `putexcel`-style cell writes into a worksheet's OOXML.
 *
 * The design constraint that shapes this whole file: **we never deserialize the
 * worksheet into a model and re-serialize it.** A round-trip through any object
 * model — ours or a library's — can only preserve the features that model knows
 * about, so every unmodelled feature (conditional formatting, data validation,
 * sparklines, pivot caches, drawing anchors, autofilter state, protection,
 * custom XML) is silently dropped on save. Here, an untouched byte range of the
 * worksheet XML is copied through verbatim, so preservation is a property of the
 * algorithm rather than a checklist we have to keep up to date. Package-level
 * planning may inspect formula structures on other sheets, but it replaces only
 * edited worksheets and worksheets whose formula caches became stale.
 *
 * The unit of an explicit edit is one `<c>` element. For each edited cell we
 * either splice a replacement `<c>` over the existing one, or synthesize a new
 * `<c>` and, if needed, a new `<row>` at the correct sorted position. Formula
 * dependents get one narrower change: their stale cached `<v>` is removed while
 * the formula, style, and surrounding XML stay byte-for-byte intact. Everything
 * between those splices is untouched original text.
 */

/** A single cell edit, in canonical source coordinates (0-based, unprojected). */
export interface XlsxCellEdit {
    readonly row: number;
    readonly col: number;
    /** The raw text the user typed. Empty string clears the cell's value. */
    readonly value: string;
    /**
     * Styled runs of `value`, present when the edit carries character-level
     * formatting. Concatenated run text must equal `value`. When every run's
     * style equals the cell's own font style the writer reduces to the plain
     * string form (the runs carry no information beyond the `s=` style, and a
     * plain form keeps number/date/boolean classification working); otherwise
     * the cell is written as a rich inline string.
     */
    readonly runs?: readonly RichTextRun[];
    /**
     * Store `value` as text verbatim, skipping number/date/boolean inference.
     *
     * For a value that was never typed by a user and is already known to be a
     * string. Type inference exists to turn what someone typed into what they
     * meant, and applying it to text the file already held is not a
     * translation but a change: a hyperlink `display` of `1e3` is the string
     * `1e3` to the reader, and inferring it wrote `<v>1e3</v>`, which reads
     * back as the number 1000. Absent (the ordinary case) infers as before.
     */
    readonly force_text?: boolean;
}

/** Strings written to the workbook go inline, so the writer never needs the shared string table. */
export interface XlsxWriteOptions {
    /** 0 = 1900 date system, 1 = 1904. Governs date → serial conversion. */
    readonly datemode: 0 | 1;
    /**
     * True when the existing style at this cell renders as a date. The writer
     * consults this to decide whether a date-looking input should become a
     * serial (keeping the cell's date format) or a plain string.
     */
    readonly is_date_style: (xf_index: number, serial: number) => boolean;
    /**
     * The four style flags of the cell font behind an `s=` index, as the reader
     * resolves them. Rich edits consult this for the uniform-style reduction
     * above. Absent (legacy callers) reads as "no cell font style", which only
     * forgoes the reduction — rich output stays correct, just less minimal.
     */
    readonly cell_font_style?: (xf_index: number) => CellTextStyle | undefined;
    /**
     * The cell font's non-flag properties (name, size, color, family, scheme…)
     * as raw `<rPr>`-ready inner XML, for the `s=` index. OOXML run properties
     * REPLACE the cell font rather than merging with it, so an `<rPr>` that
     * carried only our four flags would silently reset a Cambria-14 cell's
     * styled runs to the default font. Every emitted `<rPr>` starts from this
     * base. Absent reads as '' — correct for default-font workbooks.
     */
    readonly run_font_base?: (xf_index: number) => string;
    /** Worksheet name used to recognize explicit same-sheet A1 qualifiers. */
    readonly sheet_name?: string;
    /** Workbook-planned formula cells whose cached `<v>` result is stale. */
    readonly formula_result_invalidations?: readonly {
        readonly row: number;
        readonly column: number;
    }[];
    /** Trustworthy numeric results for invalidated or newly edited formulas. */
    readonly formula_result_updates?: readonly {
        readonly row: number;
        readonly column: number;
        readonly value: string;
    }[];
}

function encode_xml(s: string): string {
    return strip_illegal_xml_chars(
        s
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            // XML parsers normalize literal CRs before the application sees them;
            // a character reference is the only spelling that round-trips.
            .replace(/\r/g, '&#13;'),
    );
}

/** A user-entered XLSX formula. CSV/TSV never call this writer. */
function is_formula_edit(edit: XlsxCellEdit): boolean {
    return edit.force_text !== true
        && edit.runs === undefined
        && is_xlsx_formula_text(edit.value);
}

/** Convert a 0-based column index to its letter form (0 → A, 26 → AA). */
export function col_index_to_letter(index: number): string {
    let n = index + 1;
    let out = '';
    while (n > 0) {
        const rem = (n - 1) % 26;
        out = String.fromCharCode(65 + rem) + out;
        n = Math.floor((n - 1) / 26);
    }
    return out;
}

/** The two standardized default namespaces for SpreadsheetML worksheet elements. */
const SPREADSHEETML_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const STRICT_SPREADSHEETML_NS = 'http://purl.oclc.org/ooxml/spreadsheetml/main';

function is_spreadsheetml_namespace(namespace: string): boolean {
    return namespace === SPREADSHEETML_NS || namespace === STRICT_SPREADSHEETML_NS;
}

/**
 * One `<r>` run of a rich inline string.
 *
 * A present `<rPr>` REPLACES the referencing cell's font (OOXML inheritance
 * rule, mirrored by the reader's `resolve_rich_text_runs`), so:
 *  - a run whose style equals the cell font's own flags is written with *no*
 *    `<rPr>` and inherits everything, including name/size/color;
 *  - any other run gets `<rPr>` = the cell font's non-flag properties
 *    (`font_base`, so a Cambria-14 cell's styled runs stay Cambria-14) plus a
 *    tag per flag that is on. Off flags are simply absent — replacement
 *    semantics make absence mean off, which is exactly how
 *    `parse_font_properties` reads it back.
 */
function build_run_xml(
    run: RichTextRun,
    cell_style: CellTextStyle | undefined,
    font_base: string,
): string {
    const text = `<t xml:space="preserve">${encode_xml(run.text)}</t>`;
    if (text_styles_equal(run.style, cell_style)) return `<r>${text}</r>`;
    const props = font_base
        + (run.style?.bold ? '<b/>' : '')
        + (run.style?.italic ? '<i/>' : '')
        + (run.style?.strikethrough ? '<strike/>' : '')
        + (run.style?.underline ? '<u/>' : '');
    return `<r><rPr>${props}</rPr>${text}</r>`;
}

/**
 * Build the replacement `<c>` element for one cell.
 *
 * Strings are written as `t="inlineStr"` rather than appended to
 * `xl/sharedStrings.xml`. That keeps the edit local to a single part: touching
 * the SST would mean rewriting it, bumping its `count`/`uniqueCount`, and — since
 * every other sheet's `t="s"` cells index into it — accepting that a mistake
 * there corrupts sheets the user never opened. `inlineStr` is fully standard,
 * Excel writes it itself, and it confines the blast radius of an edit to the one
 * worksheet being saved.
 */
function build_cell_xml(
    row: number,
    col: number,
    edit: XlsxCellEdit,
    xf_index: number | null,
    options: XlsxWriteOptions,
    was_boolean = false,
    was_iso_date = false,
    formula_result?: string,
): string {
    const { value } = edit;
    const ref = `${col_index_to_letter(col)}${row + 1}`;
    const style_attr = xf_index !== null && xf_index !== 0 ? ` s="${xf_index}"` : '';
    if (is_formula_edit(edit)) {
        const cached = formula_result === undefined ? '' : `<v>${encode_xml(formula_result)}</v>`;
        return `<c r="${ref}"${style_attr}><f>${encode_xml(value.slice(1))}</f>${cached}</c>`;
    }
    // A rich edit whose runs still carry styling beyond the cell's own font is
    // written as a rich inline string — checked ahead of the scalar paths
    // because styled text is text: `**2024-01-15**` must not become a serial.
    // Runs that all match the cell font carry nothing the `s=` style doesn't
    // already say, so they reduce to `value` and fall through to the ordinary
    // classification below (string, number, date, boolean — unchanged).
    if (edit.runs !== undefined && edit.runs.length > 0) {
        const cell_style = options.cell_font_style?.(xf_index ?? 0);
        if (xlsx_runs_require_inline_string(edit.runs, cell_style)) {
            const font_base = options.run_font_base?.(xf_index ?? 0) ?? '';
            const runs = edit.runs
                .map((run) => build_run_xml(run, cell_style, font_base))
                .join('');
            return `<c r="${ref}"${style_attr} t="inlineStr"><is>${runs}</is></c>`;
        }
    }
    // Text the file already held, not something a user typed: stored as-is,
    // ahead of every inference path below. See `force_text`. An empty value
    // still clears the cell rather than writing an empty string, which is what
    // the classification would have done with it anyway.
    if (edit.force_text && value !== '') {
        return `<c r="${ref}"${style_attr} t="inlineStr"><is><t xml:space="preserve">${encode_xml(value)}</t></is></c>`;
    }
    const classified = classify_xlsx_cell_value(value, {
        datemode: options.datemode,
        is_date_style: (serial) => options.is_date_style(xf_index ?? 0, serial),
        was_boolean,
        was_iso_date,
    });
    switch (classified.kind) {
        case 'empty':
            // Retain a styled-but-valueless `<c>` so clearing a value does not
            // clear the cell's formatting, borders, or fill.
            return `<c r="${ref}"${style_attr}/>`;
        case 'number':
            return `<c r="${ref}"${style_attr}><v>${classified.text}</v></c>`;
        case 'boolean':
            return `<c r="${ref}"${style_attr} t="b"><v>${classified.text}</v></c>`;
        case 'iso-date':
            return `<c r="${ref}"${style_attr} t="d"><v>${encode_xml(classified.text)}</v></c>`;
        case 'string':
            return `<c r="${ref}"${style_attr} t="inlineStr"><is><t xml:space="preserve">${encode_xml(classified.text)}</t></is></c>`;
    }
}

/**
 * The `[start, end)` of the `</name>` closing the element whose opening tag runs
 * to `inner_start`, plus its inner text with comments and processing instructions
 * blanked out. Null if the element is unterminated.
 *
 * Exported for the package layer's element removal, which located its closing tag
 * with a raw `indexOf`. `</Override>` written inside a comment is text, so a
 * comment mentioning one ended the element early: the removal then saw
 * non-whitespace "content", declined to touch it, and the package kept a content
 * type and a relationship naming a part it no longer contains. Whitespace before
 * the `>` is handled for the same reason `scan_cells` handles it.
 *
 * Comments and PIs are blanked because a caller asking "is this element empty?"
 * means empty of *content*, and neither is content — an element holding only a
 * comment is an empty element with a note attached, and removing it takes the note
 * with it. CDATA is left in place: that genuinely is character data.
 */
function string_index_of_live(
    xml: string,
    needle: string,
    from: number,
    ranges: ReadonlyArray<[number, number]>,
): number {
    let pos = from;
    while (true) {
        const at = xml.indexOf(needle, pos);
        if (at === -1) return -1;
        let skip_to: number | undefined;
        for (const [start, end] of ranges) {
            if (at < start) break;
            if (at < end) { skip_to = end; break; }
        }
        if (skip_to === undefined) return at;
        pos = skip_to;
    }
}

function string_end_tag_after(
    xml: string,
    name: string,
    from: number,
    ranges: ReadonlyArray<[number, number]>,
): [number, number] | null {
    let pos = from;
    while (true) {
        const at = string_index_of_live(xml, `</${name}`, pos, ranges);
        if (at === -1) return null;
        const after = at + name.length + 2;
        if (xml[after] === '>') return [at, after + 1];
        const gt = xml.indexOf('>', after);
        if (gt !== -1 && after < gt && !/\S/.test(xml.slice(after, gt))) return [at, gt + 1];
        pos = at + 1;
    }
}

export function element_close(
    xml: string,
    name: string,
    inner_start: number,
): { inner: string; end: number } | null {
    const ranges = string_ignorable_ranges(xml, 0, xml.length);
    const end_tag = string_end_tag_after(xml, name, inner_start, ranges);
    if (end_tag === null) return null;
    let inner = xml.slice(inner_start, end_tag[0]);
    for (const [start, end] of ranges) {
        if (end <= inner_start || start >= end_tag[0]) continue;
        if (xml.startsWith('<![CDATA[', start)) continue;
        const from = Math.max(start, inner_start) - inner_start;
        const to = Math.min(end, end_tag[0]) - inner_start;
        inner = inner.slice(0, from) + ' '.repeat(to - from) + inner.slice(to);
    }
    return { inner, end: end_tag[1] };
}

/** Formula kinds whose `<f>` can govern cells other than its own. */
type GroupedFormulaKind = 'shared' | 'array' | 'dataTable';

function is_grouped_formula_kind(value: string | null): value is GroupedFormulaKind {
    return value === 'shared' || value === 'array' || value === 'dataTable';
}

/** A grouped formula's `ref` range, half-inclusive of nothing — both corners count. */
interface GroupedRange {
    readonly kind: GroupedFormulaKind;
    readonly start_row: number;
    readonly start_col: number;
    readonly end_row: number;
    readonly end_col: number;
}

const CELL_RANGE_RE = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/;

/**
 * The `ref` range of every shared formula, array formula, and data table.
 *
 * An array formula writes one `<f t="array" ref="A1:B2">` on its top-left cell;
 * the other cells in that range hold a value and no `<f>` at all. So the
 * per-cell check below cannot see them, and an edit to one would drop a member
 * of the group without ever meeting a formula. Shared followers do carry an
 * `<f>`, but the range check also catches sparse or missing follower cells.
 * A normal formula can override one shared follower without changing the other
 * members. Literal replacement remains refused here: this writer only detaches
 * a shared follower when the edit is unambiguously another formula.
 *
 * Kept as bounds rather than expanded into a set of coordinates: a `ref` is
 * whatever the writing application put there, and a whole-column or
 * whole-sheet range (`A1:XFD1048576`) is legal and not rare. Materializing that
 * is billions of entries for a workbook we may not even be editing near.
 */
function grouped_formula_ranges(xml: Uint8Array): GroupedRange[] {
    const ranges: GroupedRange[] = [];
    // Same reason `scan_rows` skips these: a commented-out array formula is text,
    // and treating it as a live range refuses an edit to a cell that is not in one.
    const ignorable = ignorable_ranges(xml, 0, xml.length);
    for (const tag of live_tags(xml, 'f', 0, xml.length, ignorable)) {
        const kind = get_tag_attr(xml, tag.start, tag.end, 't');
        if (!is_grouped_formula_kind(kind)) continue;
        const ref = get_tag_attr(xml, tag.start, tag.end, 'ref')?.match(CELL_RANGE_RE);
        if (!ref) continue;
        const start_col = letter_to_index(ref[1]);
        const start_row = Number(ref[2]) - 1;
        ranges.push({
            kind,
            start_row,
            start_col,
            end_col: ref[3] !== undefined ? letter_to_index(ref[3]) : start_col,
            end_row: ref[4] !== undefined ? Number(ref[4]) - 1 : start_row,
        });
    }
    return ranges;
}

/**
 * Why an edit inside a formula group that cannot be changed locally is refused.
 *
 * A shared master defines the formula its followers reference by `si`; array
 * formulas and data tables govern every cell in their `ref`. Dropping one of
 * those definitions leaves cells that silently stop calculating, or a workbook
 * Excel offers to repair.
 */
function grouped_formula_error(row: number, col: number, kind: GroupedFormulaKind): Error {
    const described = kind === 'array'
        ? 'an array formula'
        : kind === 'dataTable' ? 'a data table' : 'a shared formula';
    return new Error(
        `Cannot edit ${cell_reference(row, col)}: this cell is calculated by ${described}. `
        + "Edit the formula's input cells instead, or replace the formula in Excel first.",
    );
}

/** The group kind when `row`/`col` falls inside some group's `ref`. */
function grouped_range_kind(
    ranges: readonly GroupedRange[],
    row: number,
    col: number,
): GroupedFormulaKind | null {
    for (const r of ranges) {
        if (row >= r.start_row && row <= r.end_row && col >= r.start_col && col <= r.end_col) {
            return r.kind;
        }
    }
    return null;
}

/**
 * The group kind when the cell's own `<f>` belongs to a multi-cell group.
 *
 * Shared masters and followers both count. A follower can safely override its
 * master with a normal formula; editing the master itself would change or orphan
 * every follower, so it remains a grouped edit that this writer refuses.
 */
interface GroupedCellFormula {
    readonly kind: GroupedFormulaKind;
    readonly shared_master: boolean;
}

function grouped_formula_kind(
    xml: Uint8Array,
    from: number,
    to: number,
): GroupedCellFormula | null {
    // Only the cell's *live* `<f>`: an array formula quoted in a comment inside an
    // ordinary cell refused a literal edit that was never part of a group.
    const ignorable = ignorable_ranges(xml, from, to);
    for (const tag of live_tags(xml, 'f', from, to, ignorable)) {
        const kind = get_tag_attr(xml, tag.start, tag.end, 't');
        return is_grouped_formula_kind(kind)
            ? {
                kind,
                shared_master: kind === 'shared'
                    && get_tag_attr(xml, tag.start, tag.end, 'ref') !== null,
            }
            : null;
    }
    return null;
}

/**
 * The merge ranges the *reader* believes in, read the way it reads them.
 *
 * `parse_xlsx` takes the first `<mergeCells>` section by raw `indexOf`, walks its
 * `<mergeCell ref>` children, and accepts only a two-corner `A1:B2` spelling.
 * Then it hides every cell in a range except the top-left one: `cell_at` returns
 * null for the followers, so the grid shows the anchor's value spanning them and
 * nothing the user can type reaches a follower coordinate.
 *
 * That makes a follower unwritable rather than merely awkward. An edit to one
 * inserted a perfectly valid `<c r="B1">` that no reader on either side would
 * ever show: the save reported success, the reload showed the anchor unchanged,
 * and Excel treats a value under a merged follower as discardable. So a follower
 * is refused, like the grouped-formula ranges above — deliberately mirroring the
 * reader's own parsing, comment-blindness and all, so both sides agree on which
 * coordinates are covered.
 */
function merged_follower_ranges(xml: Uint8Array): GroupedRange[] {
    // Located exactly as `get_text` does it: the first raw `<mergeCells`, closed at
    // the first *literal* `</mergeCells>`. Not `[^>]*` for the opening tag — a legal
    // `<mergeCell note="x > y" ref="A1:C1"/>` cut the match short, so a merge the
    // reader honours went unseen and an edit to a hidden follower was allowed
    // through. And not `</mergeCells\s*>` for the close — the reader does not accept
    // that spelling, so it saw no merges at all while the writer refused a cell the
    // grid was displaying normally.
    let open = index_of_bytes(xml, '<mergeCells');
    while (open !== -1 && xml[open + '<mergeCells'.length] !== 0x3e
        && !is_tag_boundary(xml[open + '<mergeCells'.length])) {
        open = index_of_bytes(xml, '<mergeCells', open + 1);
    }
    if (open === -1) return [];
    const tag_end = find_tag_end(xml, open);
    if (tag_end === -1) return [];
    const close = index_of_bytes(xml, '</mergeCells>', tag_end);
    if (close === -1) return [];
    const ranges: GroupedRange[] = [];
    // Walked tag by tag with the same quote-aware `find_tag_end` the reader uses,
    // rather than matched with one regex: `[^>]*` ends the tag at a `>` inside an
    // attribute value, and the reader does not. Comments are deliberately *not*
    // skipped here — `iter_elements` does not skip them either, so a commented-out
    // `<mergeCell>` hides cells for the reader and must for the writer too.
    let pos = tag_end + 1;
    while (pos < close) {
        const at = index_of_bytes(xml, '<mergeCell', pos);
        if (at === -1 || at >= close) break;
        if (!is_tag_boundary(xml[at + '<mergeCell'.length])) { pos = at + 1; continue; }
        const cell_end = find_tag_end(xml, at);
        if (cell_end === -1 || cell_end >= close) break;
        const m = get_tag_attr(xml, at, cell_end + 1, 'ref')?.match(CELL_RANGE_RE);
        pos = cell_end + 1;
        if (!m || m[3] === undefined || m[4] === undefined) continue;
        const start_row = Number(m[2]) - 1;
        const end_row = Number(m[4]) - 1;
        const start_col = letter_to_index(m[1]);
        const end_col = letter_to_index(m[3]);
        // An inverted range hides nothing, because the reader drops it outright
        // rather than normalizing the corners. Refusing on one would refuse an edit
        // the grid was perfectly willing to accept.
        if (start_row > end_row || start_col > end_col) continue;
        ranges.push({
            kind: 'array',
            start_col,
            start_row,
            end_col,
            end_row,
        });
    }
    return ranges;
}

/** True when `row`/`col` sits in a merge range but is not its anchor. */
function is_merged_follower(
    ranges: readonly GroupedRange[],
    row: number,
    col: number,
): boolean {
    for (const r of ranges) {
        if (row < r.start_row || row > r.end_row || col < r.start_col || col > r.end_col) continue;
        // The anchor is the range's top-left, which is where the reader keeps the
        // visible value — that cell stays editable.
        if (row === r.start_row && col === r.start_col) continue;
        return true;
    }
    return false;
}

/** `A1`-style reference for a message a user will read. */
function cell_reference(row: number, col: number): string {
    return `${col_index_to_letter(col)}${row + 1}`;
}

/**
 * The cell's style index, read exactly as `parse_xlsx` reads it.
 *
 * The reader does `parseInt(s, 10)`, which takes a leading `+` — and `+3` is
 * legal for the `unsignedInt` this attribute is typed as, so a generator may
 * legitimately emit it. A digits-only match here made the same cell style 3 to
 * the reader and unstyled to the writer, and the two disagreeing about a style is
 * the whole bug class: the reader showed C1 as a date, the writer saw no style,
 * so a retyped `2024-01-15` was stored as an inline string and the cell stopped
 * being a date to every formula and filter downstream — while looking unchanged.
 *
 * So this matches `parseInt`'s grammar rather than a stricter one. Being more
 * nearly correct about XML than the reader is not the goal; agreeing with the
 * side that renders the result is.
 */
function existing_style(open_tag: string): number | null {
    const value = get_attr(open_tag, 's');
    if (value === null) return null;
    const parsed = parseInt(value, 10);
    // `parseInt` yields a negative for `s="-1"`; no such style exists, and the
    // reader's own `get_style` falls back for an out-of-range index.
    return parsed >= 0 ? parsed : null;
}

/**
 * Did applying edits drop a formula?
 *
 * Counted rather than tracked through `apply_cell_edits`, which stays a pure
 * string→string function. `<f>` is the only element in a worksheet part whose
 * name is exactly `f`, so a boundary-anchored count is exact; the tag-boundary
 * test is what keeps `<filters>` and friends out of it.
 *
 * Comments and CDATA are skipped for the same reason the scanners skip them: the
 * count only exists to answer "did an edit drop a formula", and formula-shaped
 * text in a comment is a constant on both sides — except that an edit *near* it
 * can move it in or out of the counted range, which read as a dropped formula and
 * deleted `xl/calcChain.xml` from a workbook that never lost one.
 */
export function formula_count(source: Uint8Array | string): number {
    const xml = typeof source === 'string' ? Buffer.from(source, 'utf8') : source;
    const ignorable = ignorable_ranges(xml, 0, xml.length);
    let count = 0;
    let pos = 0;
    while (true) {
        const at = indexOf_live(xml, '<f', pos, ignorable);
        if (at === -1) return count;
        if (is_tag_boundary(xml[at + 2])) count += 1;
        pos = at + 2;
    }
}

/**
 * Collapse repeated edits to one cell, last write winning.
 *
 * Nothing upstream promises a caller cannot name the same cell twice, and every
 * stage below assumes it is unique: the grouped-formula check would report the
 * first, the dimension would widen for both, and — the corruption case — a cell
 * that does not exist yet gets *two* `<c r="A1">` elements spliced into the same
 * row, which Excel rejects. Doing it once here keeps that assumption true for
 * all of them rather than defending it stage by stage.
 *
 * Last wins because these arrive in the order the user made them, and an edit
 * made later is the one they meant.
 */
function canonical_edits(edits: readonly XlsxCellEdit[]): readonly XlsxCellEdit[] {
    const by_cell = new Map<string, XlsxCellEdit>();
    for (const e of edits) by_cell.set(`${e.row}:${e.col}`, e);
    return by_cell.size === edits.length ? edits : [...by_cell.values()];
}

interface RefusalCandidate {
    readonly start: number;
    readonly rank: number;
    readonly code: OoxmlRefusalCode;
    readonly coordinate?: string;
}

function earlier_refusal(
    current: RefusalCandidate | undefined,
    candidate: RefusalCandidate,
): RefusalCandidate {
    return current === undefined
        || candidate.start < current.start
        || (candidate.start === current.start && candidate.rank < current.rank)
        ? candidate
        : current;
}

interface NamespaceBinding {
    readonly prefix: string;
    readonly namespace: string;
}

interface NamespaceDeclarations {
    readonly default_namespace?: string;
    readonly bindings: readonly NamespaceBinding[];
    /** A default declaration was present but not a quoted value we can resolve. */
    readonly unreadable_default_namespace: boolean;
}

/** Namespace declarations on one opening tag, decoded and in lexical order. */
function namespace_declarations(tag: string): NamespaceDeclarations {
    const bindings: NamespaceBinding[] = [];
    let default_namespace: string | undefined;
    let unreadable_default_namespace = false;
    let i = 1;

    // Skip the element QName.
    while (i < tag.length && !/[\s/>]/.test(tag[i])) i++;
    while (i < tag.length) {
        while (i < tag.length && /[\s]/.test(tag[i])) i++;
        if (i >= tag.length || tag[i] === '/' || tag[i] === '>') break;

        const name_start = i;
        while (i < tag.length && !/[\s=/>]/.test(tag[i])) i++;
        const name = tag.slice(name_start, i);
        while (i < tag.length && /[\s]/.test(tag[i])) i++;
        if (tag[i] !== '=') {
            while (i < tag.length && !/[\s>]/.test(tag[i])) i++;
            continue;
        }
        i++;
        while (i < tag.length && /[\s]/.test(tag[i])) i++;
        const quote = tag[i];
        if (quote !== '"' && quote !== "'") {
            if (name === 'xmlns') unreadable_default_namespace = true;
            while (i < tag.length && !/[\s>]/.test(tag[i])) i++;
            continue;
        }
        const value_start = ++i;
        const value_end = tag.indexOf(quote, value_start);
        if (value_end === -1) {
            if (name === 'xmlns') unreadable_default_namespace = true;
            break;
        }
        const value = decode_xml(tag.slice(value_start, value_end));
        if (name === 'xmlns') default_namespace = value;
        else if (name.startsWith('xmlns:') && name.length > 'xmlns:'.length) {
            bindings.push({ prefix: name.slice('xmlns:'.length), namespace: value });
        }
        i = value_end + 1;
    }
    return {
        default_namespace,
        bindings,
        unreadable_default_namespace: default_namespace === undefined && unreadable_default_namespace,
    };
}

interface NamespaceFrame {
    readonly qname: string;
    readonly default_namespace: string;
    readonly bindings: readonly NamespaceBinding[];
    readonly start: number;
    readonly worksheet_document: boolean;
    readonly inside_sheet_data: boolean;
    readonly missing_sheet_data_alternate: boolean;
}

function resolve_prefix(
    stack: readonly NamespaceFrame[],
    own: readonly NamespaceBinding[],
    prefix: string,
): string {
    for (let i = own.length - 1; i >= 0; i--) {
        if (own[i].prefix === prefix) return own[i].namespace;
    }
    for (let depth = stack.length - 1; depth >= 0; depth--) {
        const bindings = stack[depth].bindings;
        for (let i = bindings.length - 1; i >= 0; i--) {
            if (bindings[i].prefix === prefix) return bindings[i].namespace;
        }
    }
    return prefix === 'xml' ? 'http://www.w3.org/XML/1998/namespace' : '';
}

const MARKUP_COMPATIBILITY_NS
    = 'http://schemas.openxmlformats.org/markup-compatibility/2006';

interface WorksheetStructure {
    readonly sheet_data: Span | null;
    /** Earliest structural refusal when an authoritative sheetData exists. */
    readonly refusal?: RefusalCandidate;
    /** Earliest explanatory refusal when no authoritative sheetData exists. */
    readonly missing_sheet_data_refusal?: RefusalCandidate;
}

/** Where one comment, CDATA section, or processing instruction ends. */
function quoted_markup_end(xml: Uint8Array, start: number): number | undefined {
    let close: number;
    let width: number;
    if (starts_with_bytes(xml, '<!--', start)) {
        close = index_of_bytes(xml, '-->', start + 4);
        width = 3;
    } else if (starts_with_bytes(xml, '<![CDATA[', start)) {
        close = index_of_bytes(xml, ']]>', start + 9);
        width = 3;
    } else if (starts_with_bytes(xml, '<?', start)) {
        close = index_of_bytes(xml, '?>', start + 2);
        width = 2;
    } else {
        return undefined;
    }
    return close === -1 ? xml.length : close + width;
}

/** Could any element inside this sheetData alter a refusal decision? */
function needs_namespace_body_scan(xml: Uint8Array, from: number, to: number): boolean {
    const declaration = index_of_bytes(xml, 'xmlns', from);
    if (declaration !== -1 && declaration < to) return true;
    // Exact MC elements either carry/use a namespace declaration or have a
    // prefixed QName. Search the much rarer colon and prove it belongs to the
    // opening QName, rather than walking every `<row>` and `<c>` in JavaScript.
    let colon = index_of_bytes(xml, ':', from);
    while (colon !== -1 && colon < to) {
        let start = colon - 1;
        while (start >= from) {
            const code = xml[start];
            if (code === 0x3c || code === 0x3e || is_tag_boundary(code) || code === 0x3d) break;
            start--;
        }
        if (xml[start] === 0x3c) {
            const first = xml[start + 1];
            if (first !== 0x21 && first !== 0x3f && first !== 0x2f) return true;
        }
        colon = index_of_bytes(xml, ':', colon + 1);
    }
    return false;
}

/**
 * Locate the worksheet document element and its direct `sheetData` child while
 * resolving namespace declarations with an O(depth) SAX-style stack.
 *
 * This walk exists only for writer safety decisions. Frames are discarded at
 * each end tag; no worksheet-sized element tree or namespace map is retained.
 * Ordinary worksheets with no namespace declarations or prefixed elements in
 * `sheetData` take a native-search fast path and do not pay for a second per-cell
 * token walk. Every retained position is a UTF-8 byte offset.
 */
function scan_worksheet_structure(xml: Uint8Array): WorksheetStructure {
    const stack: NamespaceFrame[] = [];
    let pos = 0;
    let saw_document_element = false;
    let saw_sheet_data = false;
    let worksheet_namespace = SPREADSHEETML_NS;
    let sheet_data: Span | null = null;
    let refusal: RefusalCandidate | undefined;
    let missing_sheet_data_refusal: RefusalCandidate | undefined;

    const consider = (
        target: 'both' | 'sheet-data' | 'missing-sheet-data',
        start: number,
        rank: number,
        code: OoxmlRefusalCode,
    ): void => {
        const candidate = { start, rank, code };
        if (target !== 'missing-sheet-data') refusal = earlier_refusal(refusal, candidate);
        if (target !== 'sheet-data') {
            missing_sheet_data_refusal = earlier_refusal(missing_sheet_data_refusal, candidate);
        }
    };

    while (pos < xml.length) {
        const start = index_of_bytes(xml, '<', pos);
        if (start === -1 || (sheet_data !== null && start >= sheet_data.inner_end)) break;
        const quoted_end = quoted_markup_end(xml, start);
        if (quoted_end !== undefined) { pos = quoted_end; continue; }

        // Other declarations are not elements and therefore do not establish the
        // document element or contribute to element depth.
        if (starts_with_bytes(xml, '<!', start)) {
            const end = find_tag_end(xml, start);
            if (end === -1) break;
            pos = end + 1;
            continue;
        }

        const tag_end = find_tag_end(xml, start);
        if (tag_end === -1) break;
        const closing = starts_with_bytes(xml, '</', start);
        if (closing) {
            let name_end = start + 2;
            while (name_end < tag_end && !is_tag_boundary(xml[name_end])) name_end++;
            const closing_qname = utf8_text(xml, start + 2, name_end);
            const frame = stack[stack.length - 1];
            // A mismatched close means this is not a complete worksheet structure.
            // Stop rather than deriving writable spans from malformed nesting.
            if (frame === undefined || frame.qname !== closing_qname) break;
            stack.pop();
            pos = tag_end + 1;
            continue;
        }

        const open_tag = utf8_text(xml, start, tag_end + 1);
        let name_end = 1;
        while (name_end < open_tag.length && !/[\s/>]/.test(open_tag[name_end])) name_end++;
        const qname = open_tag.slice(1, name_end);
        const colon = qname.indexOf(':');
        const prefix = colon === -1 ? undefined : qname.slice(0, colon);
        const local_name = colon === -1 ? qname : qname.slice(colon + 1);
        const declarations = namespace_declarations(open_tag);
        const parent = stack[stack.length - 1];
        const worksheet_document = !saw_document_element && local_name === 'worksheet';
        const implicit_worksheet_namespace = worksheet_document
            && prefix === undefined
            && declarations.default_namespace === undefined;
        const default_namespace = declarations.default_namespace
            ?? parent?.default_namespace
            ?? (implicit_worksheet_namespace ? SPREADSHEETML_NS : '');
        const namespace = prefix === undefined
            ? default_namespace
            : resolve_prefix(stack, declarations.bindings, prefix);
        const direct_worksheet_child = parent?.worksheet_document === true;
        const authoritative_sheet_data = !saw_sheet_data
            && direct_worksheet_child
            && prefix === undefined
            && local_name === 'sheetData';
        const inside_sheet_data = authoritative_sheet_data
            || parent?.inside_sheet_data === true;
        const exact_alternate_content = local_name === 'AlternateContent'
            && namespace === MARKUP_COMPATIBILITY_NS;
        const missing_sheet_data_alternate = direct_worksheet_child
            && exact_alternate_content;

        if (!saw_document_element) {
            saw_document_element = true;
            if (worksheet_document) {
                worksheet_namespace = namespace;
                if (prefix !== undefined) {
                    consider('both', start, 0, 'namespace-prefixed-worksheet-element');
                }
                if (
                    !is_spreadsheetml_namespace(namespace)
                    || declarations.unreadable_default_namespace
                ) {
                    consider('both', start, 1, 'foreign-worksheet-namespace');
                }
            }
        }

        if (authoritative_sheet_data) {
            saw_sheet_data = true;
            if (
                namespace !== worksheet_namespace
                || declarations.unreadable_default_namespace
            ) {
                consider('sheet-data', start, 1, 'foreign-worksheet-namespace');
            }
            // Use the exact boundary scanner shared with the reader. The namespace
            // walk decides structural eligibility; it must not introduce a second
            // notion of where the selected body closes.
            sheet_data = find_first_element(xml, 'sheetData', start);
            if (sheet_data === null) break;
            if (
                sheet_data.inner_start === sheet_data.end
                || !needs_namespace_body_scan(
                    xml,
                    sheet_data.inner_start,
                    sheet_data.inner_end,
                )
            ) {
                return { sheet_data, refusal, missing_sheet_data_refusal };
            }
        } else if (
            !saw_sheet_data
            && direct_worksheet_child
            && prefix !== undefined
            && local_name === 'sheetData'
            && is_spreadsheetml_namespace(namespace)
        ) {
            // This explains a missing literal worksheet body only when it occupies
            // the real structural slot and is genuinely SpreadsheetML.
            consider('missing-sheet-data', start, 0, 'namespace-prefixed-worksheet-element');
        }

        if (
            inside_sheet_data
            && prefix !== undefined
            && (local_name === 'row'
                || local_name === 'c'
                || local_name === 'f'
                || local_name === 'is'
                || local_name === 'v')
        ) {
            consider('sheet-data', start, 0, 'namespace-prefixed-worksheet-element');
        }
        if (
            inside_sheet_data
            && prefix === undefined
            && (local_name === 'row' || local_name === 'c' || local_name === 'f')
            && (
                namespace !== worksheet_namespace
                || declarations.unreadable_default_namespace
            )
        ) {
            consider('sheet-data', start, 1, 'foreign-worksheet-namespace');
        }
        if (inside_sheet_data && exact_alternate_content) {
            consider('sheet-data', start, 0, 'markup-compatibility-alternate-content');
        }

        // With no direct worksheet body, an exact MC wrapper is explanatory only
        // when it is itself a worksheet child and contains a SpreadsheetML
        // `sheetData` candidate in one of its alternatives.
        if (local_name === 'sheetData' && is_spreadsheetml_namespace(namespace)) {
            for (let depth = stack.length - 1; depth >= 0; depth--) {
                if (stack[depth].missing_sheet_data_alternate) {
                    consider(
                        'missing-sheet-data',
                        stack[depth].start,
                        0,
                        'markup-compatibility-alternate-content',
                    );
                    break;
                }
            }
        }

        if (!is_self_closing(xml, start, tag_end)) {
            stack.push({
                qname,
                default_namespace,
                bindings: declarations.bindings,
                start,
                worksheet_document,
                inside_sheet_data,
                missing_sheet_data_alternate,
            });
        }
        pos = tag_end + 1;
    }

    return { sheet_data, refusal, missing_sheet_data_refusal };
}

/**
 * Refuse worksheet constructs whose correct edit is genuinely undetermined.
 *
 * Candidates are compared in strict document order. The opening construct is the
 * anchor; a rank breaks ties only within one opening tag: unsupported element
 * identity, foreign effective namespace, missing reference, invalid reference.
 * UTF-8 byte offsets make that ordering independent of JavaScript string width.
 */
function assert_writable_sheet_data(
    xml: Uint8Array,
    structure: WorksheetStructure,
    scan_options?: Pick<ScanRowsOptions, 'capture_cell' | 'on_cell'>,
): Map<number, Span[]> {
    const sheet_data = structure.sheet_data;
    if (sheet_data === null) throw new Error('Worksheet XML has no <sheetData> element');
    let first = structure.refusal;
    const consider = (
        start: number,
        rank: number,
        code: OoxmlRefusalCode,
        coordinate?: string,
    ): void => {
        first = earlier_refusal(first, { start, rank, code, coordinate });
    };

    const rows = scan_rows(xml, sheet_data.inner_start, sheet_data.inner_end, {
        ...scan_options,
        on_reference: (reference) => {
            if (reference.kind === 'missing') {
                // Excel infers this cell's position from document order. Our
                // coordinate-only contract has no equivalent position, so inserting
                // an explicit cell can create a semantic duplicate Excel already saw.
                consider(reference.start, 2, 'missing-cell-reference');
            } else if (reference.kind === 'invalid') {
                // Never normalize a malformed reference into a coordinate we did not
                // read; that is how the original duplicate-cell corruption was made.
                consider(
                    reference.start,
                    3,
                    'invalid-cell-reference',
                    reference.reference,
                );
            }
        },
    });
    if (first !== undefined) throw new OoxmlRefusalError(first.code, first.coordinate);
    return rows;
}

/**
 * Which of `coordinates` already have a `<c>` element in the worksheet, as
 * `"row:col"` keys.
 *
 * The question is deliberately "is there a `<c>` at all", not "does it hold a
 * value". That is the distinction `parse_xlsx` draws when it decides whether a
 * `<hyperlink display=…>` supplies the cell's text: it keys every `<c r=…>`
 * into its map as it scans — value or not — and falls back to `display` only
 * for a coordinate with no entry. A styled-but-empty `<c r="B2" s="3"/>` stays
 * blank. A formula with no cached `<v>` displays `??`. Treating either cell as
 * display-backed would replace its own state with the hyperlink label.
 *
 * Resolved by the same `scan_rows` cell callback an edit uses, so the answer
 * describes the cell the writer would actually splice.
 *
 * Batched because the caller has a set of coordinates and the scan is
 * sheet-wide: asking one coordinate at a time re-walked the whole worksheet per
 * question, which is quadratic in a save that clears many links at once.
 */
export function cells_present(
    source: Uint8Array | string,
    coordinates: Iterable<{ readonly row: number; readonly col: number }>,
): Set<string> {
    const xml = typeof source === 'string' ? Buffer.from(source, 'utf8') : source;
    const found = new Set<string>();
    const by_row = new Map<number, number[]>();
    for (const { row, col } of coordinates) {
        const cols = by_row.get(row);
        if (cols) cols.push(col);
        else by_row.set(row, [col]);
    }
    if (by_row.size === 0) return found;
    const sheet_data = scan_worksheet_structure(xml).sheet_data;
    if (!sheet_data) return found;
    scan_rows(xml, sheet_data.inner_start, sheet_data.inner_end, {
        on_coordinate: (row, col) => {
            if (by_row.get(row)?.includes(col)) found.add(`${row}:${col}`);
        },
    });
    return found;
}

/** One pending splice: replace `[start, end)` with `text`. */
interface Splice { start: number; end: number; text: string }

interface WorksheetFormulaCell {
    readonly row: number;
    readonly col: number;
    readonly cell: Span;
    readonly type: string | null;
    readonly reference: string | null;
    readonly sharedIndex: string | null;
    readonly text: string;
}

interface WorksheetFormulaState {
    readonly dependencies: number[];
    readonly cells: ReadonlyMap<string, Span>;
}

/**
 * Read formula coordinates and workbook-resolved references from the unedited part.
 * Shared followers borrow and translate their master's text, matching the XLSX
 * reader so the save and the reopen cannot disagree about their dependencies.
 */
function worksheet_formula_state(
    xml: Uint8Array,
    sheet_data: Span,
    sheet_name: string | undefined,
    sheet_index = 0,
    sheet_names: readonly string[] = [sheet_name ?? ''],
): WorksheetFormulaState {
    const formulas: WorksheetFormulaCell[] = [];
    scan_rows(xml, sheet_data.inner_start, sheet_data.inner_end, {
        on_cell: (row, col, cell) => {
            const formula = find_first_element(
                xml,
                'f',
                cell.inner_start,
                cell.inner_end,
            );
            if (!formula) return;
            formulas.push({
                row,
                col,
                cell,
                type: get_tag_attr(xml, formula.start, formula.inner_start, 't'),
                reference: get_tag_attr(xml, formula.start, formula.inner_start, 'ref'),
                sharedIndex: get_tag_attr(xml, formula.start, formula.inner_start, 'si'),
                text: decode_xml(utf8_text(xml, formula.inner_start, formula.inner_end)),
            });
        },
    });

    const shared_masters = new Map<
        string,
        { readonly row: number; readonly col: number; readonly text: string }
    >();
    for (const formula of formulas) {
        if (
            formula.type === 'shared'
            && formula.reference !== null
            && formula.sharedIndex !== null
            && formula.text !== ''
        ) {
            shared_masters.set(formula.sharedIndex, formula);
        }
    }

    const dependencies: number[] = [];
    const cells = new Map<string, Span>();
    for (const formula of formulas) {
        cells.set(`${formula.row}:${formula.col}`, formula.cell);
        let effective: string | undefined;
        if (formula.type === 'shared' && formula.reference === null) {
            const master = formula.sharedIndex === null
                ? undefined
                : shared_masters.get(formula.sharedIndex);
            if (master) {
                effective = '=' + translate_a1_formula(
                    master.text,
                    formula.row - master.row,
                    formula.col - master.col,
                );
            }
        } else if (formula.text !== '') {
            effective = `=${formula.text}`;
        }
        if (effective === undefined) continue;
        for (const reference of workbook_a1_formula_references(
            effective,
            sheet_index,
            sheet_names,
        )) {
            dependencies.push(
                formula.row,
                formula.col,
                reference.sourceSheetIndex,
                reference.firstRow,
                reference.firstColumn,
                reference.lastRow,
                reference.lastColumn,
            );
        }
    }
    return { dependencies, cells };
}

/** Read workbook-resolved dependencies without materializing worksheet cells. */
export function worksheet_formula_dependencies(
    xml: Uint8Array,
    sheet_index: number,
    sheet_names: readonly string[],
): readonly number[] {
    const sheet_data = scan_worksheet_structure(xml).sheet_data;
    if (!sheet_data) return [];
    return worksheet_formula_state(
        xml,
        sheet_data,
        sheet_names[sheet_index],
        sheet_index,
        sheet_names,
    ).dependencies;
}

/** Remove only cached results for formula cells selected by workbook planning. */
export function remove_formula_cached_values(
    xml: Uint8Array,
    cells: readonly { readonly row: number; readonly column: number }[],
): Uint8Array {
    return update_formula_cached_values(xml, cells, []);
}

/** Replace or remove selected formula caches without changing formula source. */
export function update_formula_cached_values(
    xml: Uint8Array,
    cells: readonly { readonly row: number; readonly column: number }[],
    updates: readonly {
        readonly row: number;
        readonly column: number;
        readonly value: string;
    }[],
): Uint8Array {
    if (cells.length === 0) return xml;
    const sheet_data = scan_worksheet_structure(xml).sheet_data;
    if (!sheet_data) return xml;
    const state = worksheet_formula_state(xml, sheet_data, undefined);
    const values = new Map(updates.map(
        ({ row, column, value }) => [`${row}:${column}`, value],
    ));
    const splices: Splice[] = [];
    for (const { row, column } of cells) {
        const cell = state.cells.get(`${row}:${column}`);
        if (!cell) continue;
        const replacement = values.get(`${row}:${column}`);
        const value = find_first_element(xml, 'v', cell.inner_start, cell.inner_end);
        if (value) {
            splices.push({
                start: value.start,
                end: value.end,
                text: replacement === undefined ? '' : `<v>${encode_xml(replacement)}</v>`,
            });
            continue;
        }
        if (replacement === undefined) continue;
        const formula = find_first_element(xml, 'f', cell.inner_start, cell.inner_end);
        if (formula) {
            splices.push({
                start: formula.end,
                end: formula.end,
                text: `<v>${encode_xml(replacement)}</v>`,
            });
        }
    }
    return apply_utf8_splices(xml, splices);
}

/**
 * Apply cell edits to one worksheet's XML, returning the new XML.
 *
 * Throws if the document has no `<sheetData>` — that is not a worksheet we
 * understand well enough to edit safely, and refusing is better than writing a
 * file Excel will reject.
 */
export function apply_cell_edits(
    xml: string,
    edits: readonly XlsxCellEdit[],
    options: XlsxWriteOptions,
): string;
export function apply_cell_edits(
    xml: Uint8Array,
    edits: readonly XlsxCellEdit[],
    options: XlsxWriteOptions,
): Uint8Array;
export function apply_cell_edits(
    source: Uint8Array | string,
    edits: readonly XlsxCellEdit[],
    options: XlsxWriteOptions,
): Uint8Array | string {
    if (edits.length === 0) return source;
    const return_text = typeof source === 'string';
    const xml = return_text ? Buffer.from(source, 'utf8') : source;
    const updated = apply_cell_edits_bytes(xml, canonical_edits(edits), options);
    return return_text ? utf8_text(updated) : updated;
}

function apply_cell_edits_bytes(
    xml: Uint8Array,
    edits: readonly XlsxCellEdit[],
    options: XlsxWriteOptions,
): Uint8Array {
    const structure = scan_worksheet_structure(xml);
    const sheet_data = structure.sheet_data;
    if (!sheet_data) {
        const first = structure.missing_sheet_data_refusal;
        if (first !== undefined) throw new OoxmlRefusalError(first.code);
        throw new Error('Worksheet XML has no <sheetData> element');
    }
    const {
        inner_end,
        start: element_start,
        end: element_end,
    } = sheet_data;
    const self_closing = sheet_data.inner_start === sheet_data.end;

    // An empty `<sheetData/>` has nowhere to splice into, so expand it to a pair
    // first and re-derive the offsets from the expanded document.
    //
    // The open tag is rebuilt from the original rather than written as a bare
    // `<sheetData>`: the element may legitimately carry attributes — a namespace
    // declaration that its descendants rely on, or vendor metadata — and emitting
    // a bare tag dropped every one of them. This module's whole contract is that
    // it changes the cells it was asked to change and nothing else.
    if (self_closing) {
        const open_tag = utf8_text(xml, element_start, element_end).replace(/\/\s*>$/, '>');
        const expanded = apply_utf8_splices(xml, [{
            start: element_start,
            end: element_end,
            text: `${open_tag}</sheetData>`,
        }]);
        return apply_cell_edits_bytes(expanded, edits, options);
    }

    // Group edits by row before scanning, so cell spans are retained only for
    // coordinates this save can touch. The scan still sees every `<c r>` once to
    // validate its owner and to capture edited coordinates without a second pass.
    const by_row = new Map<number, XlsxCellEdit[]>();
    for (const e of edits) {
        const list = by_row.get(e.row);
        if (list) list.push(e);
        else by_row.set(e.row, [e]);
    }
    const cells_by_row = new Map<number, Map<number, Span>>();
    const rows = assert_writable_sheet_data(xml, structure, {
        capture_cell: (row) => by_row.has(row),
        on_cell: (row, col, cell) => {
            let cells = cells_by_row.get(row);
            if (!cells) {
                cells = new Map();
                cells_by_row.set(row, cells);
            }
            cells.set(col, cell);
        },
    });

    const splices: Splice[] = [];
    const new_rows: Array<{ row: number; text: string }> = [];
    const formula_state = worksheet_formula_state(xml, sheet_data, options.sheet_name);
    const edited_keys = new Set(edits.map((edit) => `${edit.row}:${edit.col}`));
    const invalidated_formula_keys = options.formula_result_invalidations === undefined
        ? new Set(compile_workbook_formula_graph([{
            formulaDependencies: formula_state.dependencies,
        }]).invalidatedBy(edits.map((edit) => ({
            sheetIndex: 0,
            row: edit.row,
            column: edit.col,
        }))).forSheet(0).keys())
        : new Set(options.formula_result_invalidations.map(
            ({ row, column }) => `${row}:${column}`,
        ));
    const calculated_formula_results = new Map(
        (options.formula_result_updates ?? []).map(
            ({ row, column, value }) => [`${row}:${column}`, value],
        ),
    );
    // Scanned once for the whole sheet, because grouped-formula members can be
    // identifiable only from the master's `ref`.
    const grouped_ranges = grouped_formula_ranges(xml);

    // Ahead of every row and cell lookup, because a grouped formula's range can
    // cover coordinates that have no `<c>` — and, if the whole row is sparse, no
    // `<row>` either. Left inside the existing-cell branch, those edits reached
    // the insertion paths instead and wrote a literal into the middle of an array
    // formula's result range, which is the corruption the refusal exists to stop.
    const merged = merged_follower_ranges(xml);
    for (const e of edits) {
        const grouped = grouped_range_kind(grouped_ranges, e.row, e.col);
        if (grouped && !(grouped === 'shared' && is_formula_edit(e))) {
            throw grouped_formula_error(e.row, e.col, grouped);
        }
        // Same sweep, same reason: a merged follower usually has no `<c>` of its
        // own, so nothing downstream would ever meet it.
        if (is_merged_follower(merged, e.row, e.col)) {
            throw new Error(
                `Cannot edit ${cell_reference(e.row, e.col)}: it is covered by a merged `
                + 'cell, which shows the value of its top-left cell. Edit that cell '
                + 'instead, or unmerge the range in Excel.',
            );
        }
    }

    // A numbered row can legally own cells whose references name other rows. If
    // edits address more than one of those logical rows, they still mutate one
    // physical owner. Collect its inserts once so opening-tag rewrites and cell
    // insertions cannot overlap at stale offsets.
    const inserts_by_owner = new Map<Span, Array<{ row: number; col: number; text: string }>>();

    for (const [row, row_edits] of by_row) {
        const row_spans = rows.get(row);
        if (!row_spans || row_spans.length === 0) {
            // Whole row absent: synthesize it, with its cells in column order.
            const cells = [...row_edits]
                .sort((a, b) => a.col - b.col)
                .map((e) => build_cell_xml(
                    e.row,
                    e.col,
                    e,
                    null,
                    options,
                    false,
                    false,
                    calculated_formula_results.get(`${e.row}:${e.col}`),
                ))
                .join('');
            new_rows.push({ row, text: `<row r="${row + 1}">${cells}</row>` });
            continue;
        }

        // Merged across every element claiming this row, last-wins per column —
        // the reader's rule exactly, since it keys each `<c r=…>` into a map as it
        // scans and never decides anything at row granularity.
        const cells = cells_by_row.get(row) ?? new Map<number, Span>();
        // New coordinates go into the element the reader treats as authoritative
        // for anything it already holds: the last one.
        const row_span = row_spans[row_spans.length - 1];

        for (const e of row_edits) {
            const cell_span = cells.get(e.col);
            if (cell_span) {
                // Existing cell: keep its style index, replace the element. Any
                // plain `<f>` it carried is dropped with it — the agreed putexcel
                // behavior, where writing a value replaces the formula.
                //
                // Grouped formulas are different. Replacing a master can break
                // other cells. A shared follower may be detached only by an
                // explicit formula edit; literals remain refused.
                const grouped = grouped_formula_kind(
                    xml,
                    cell_span.inner_start,
                    cell_span.inner_end,
                );
                if (grouped && !(
                    grouped.kind === 'shared'
                    && !grouped.shared_master
                    && is_formula_edit(e)
                )) {
                    throw grouped_formula_error(e.row, e.col, grouped.kind);
                }
                const cell_open_tag = opening_tag_text(xml, cell_span);
                const xf = existing_style(cell_open_tag);
                const existing_type = get_attr(cell_open_tag, 't');
                splices.push({
                    start: cell_span.start,
                    end: cell_span.end,
                    text: build_cell_xml(
                        e.row,
                        e.col,
                        e,
                        xf,
                        options,
                        existing_type === 'b',
                        existing_type === 'd',
                        calculated_formula_results.get(`${e.row}:${e.col}`),
                    ),
                });
            } else {
                let inserts = inserts_by_owner.get(row_span);
                if (!inserts) {
                    inserts = [];
                    inserts_by_owner.set(row_span, inserts);
                }
                inserts.push({
                    row: e.row,
                    col: e.col,
                    text: build_cell_xml(
                        e.row,
                        e.col,
                        e,
                        null,
                        options,
                        false,
                        false,
                        calculated_formula_results.get(`${e.row}:${e.col}`),
                    ),
                });
            }
        }
    }

    for (const [row_span, inserts] of inserts_by_owner) {
        // New cells within an existing row must land in ascending column order:
        // Excel tolerates out-of-order `<c>` in many builds but the schema
        // specifies sorted, and some consumers (and Excel's own repair check) do
        // not. Insert each before the first existing cell of a higher column,
        // falling back to the row's end.
        // Sorted, because several inserts landing in the same gap share a splice
        // offset and `apply_utf8_splices` then keeps them in the order they arrived —
        // which is the caller's edit order, not the column order the schema wants.
        inserts.sort((a, b) => (a.col - b.col) || (a.row - b.row));
        // `spans` caches the row's occupied column range. It is an optimization hint
        // that Excel recomputes, but a *stale* one is a lie about the row: an insert
        // outside the cached range left `spans="1:1"` on a row now reaching C, and
        // readers that trust it (ours does not; others do) never see the new cell.
        // Dropped rather than recomputed — the correct value depends on cells this
        // splice does not enumerate, and absent is a legal spelling that means
        // "work it out", while wrong is not.
        const row_open_tag = opening_tag_text(xml, row_span);
        const drop_spans = get_attr(row_open_tag, 'spans') !== null;
        if (row_span.inner_start === row_span.end) {
            // `<row r="5" ht="20"/>` — a valid empty row, which is what a row given
            // a height or a format but no cells looks like. There is no `</row>` to
            // insert before, so the element is replaced by a paired one keeping its
            // attributes; computing an offset from `'</row>'.length` here would
            // splice into the middle of the opening tag and emit malformed XML.
            const open_tag = drop_spans ? remove_attr(row_open_tag, 'spans') : row_open_tag;
            const attributes = open_tag.slice('<row'.length, open_tag.length - '/>'.length);
            splices.push({
                start: row_span.start,
                end: row_span.end,
                text: `<row${attributes}>${inserts.map((i) => i.text).join('')}</row>`,
            });
            continue;
        }
        // Rewritten as its own splice for a paired row, whose opening tag this loop
        // otherwise leaves untouched.
        if (drop_spans) {
            splices.push({
                start: row_span.start,
                end: row_span.inner_start,
                text: remove_attr(row_open_tag, 'spans'),
            });
        }
        const ordering_cells = scan_cells(xml, row_span.inner_start, row_span.inner_end);
        for (const ins of inserts) {
            // The span's own content end, not `end - '</row>'.length`: an end tag may
            // legally be written `</row\n>`, and the subtraction then landed *inside*
            // it, splicing the new cell into the middle of the tag and emitting
            // malformed XML.
            let at = row_span.inner_end;
            let best: number | undefined;
            for (const [col, span] of ordering_cells) {
                if (col > ins.col && (best === undefined || span.start < best)) best = span.start;
            }
            if (best !== undefined) at = best;
            splices.push({ start: at, end: at, text: ins.text });
        }
    }

    // An explicitly edited cell is replaced wholesale below, and a formula edit
    // already emits no `<v>`. Every other affected formula keeps its source and
    // formatting but loses the cached result that became stale. On reopen the
    // reader then shows `??` instead of reviving that old number.
    for (const key of invalidated_formula_keys) {
        if (edited_keys.has(key)) continue;
        const cell = formula_state.cells.get(key);
        if (!cell) continue;
        const replacement = calculated_formula_results.get(key);
        const value = find_first_element(xml, 'v', cell.inner_start, cell.inner_end);
        if (value) {
            splices.push({
                start: value.start,
                end: value.end,
                text: replacement === undefined ? '' : `<v>${encode_xml(replacement)}</v>`,
            });
            continue;
        }
        if (replacement === undefined) continue;
        const formula = find_first_element(xml, 'f', cell.inner_start, cell.inner_end);
        if (formula) {
            splices.push({
                start: formula.end,
                end: formula.end,
                text: `<v>${encode_xml(replacement)}</v>`,
            });
        }
    }

    // New rows are likewise inserted in ascending row order — and sorted for the
    // same reason: several new rows before the same existing row share an offset.
    new_rows.sort((a, b) => a.row - b.row);
    for (const nr of new_rows) {
        let at = inner_end;
        let best: number | undefined;
        for (const [r, spans] of rows) {
            if (r <= nr.row) continue;
            // Earliest element claiming a higher row: with duplicates, a later one
            // would leave the new row after cells that belong ahead of it.
            for (const span of spans) {
                if (best === undefined || span.start < best) best = span.start;
            }
        }
        if (best !== undefined) at = best;
        splices.push({ start: at, end: at, text: nr.text });
    }

    return apply_utf8_splices(xml, splices);
}

/**
 * Apply byte-offset splices with one output allocation. Every offset was computed
 * against the original worksheet, so unchanged ranges copy through verbatim.
 *
 * Ties preserve the old right-to-left splicer's result: same-offset inserts keep
 * source order, and an insert appears before a replacement sharing its start. The
 * latter is load-bearing when inserting a new cell before an existing `C1` while
 * also replacing `C1` itself.
 */
export function apply_utf8_splices(xml: Uint8Array, splices: readonly Splice[]): Uint8Array {
    if (splices.length === 0) return xml;
    const ordered = splices
        .map((splice, index) => ({
            splice,
            index,
            bytes: Buffer.from(splice.text, 'utf8'),
        }))
        .sort((a, b) => (a.splice.start - b.splice.start)
            || ((a.splice.end === a.splice.start ? 0 : 1)
                - (b.splice.end === b.splice.start ? 0 : 1))
            || (a.index - b.index));
    let length = xml.length;
    let previous_end = 0;
    for (const { splice, bytes } of ordered) {
        if (!Number.isSafeInteger(splice.start)
            || !Number.isSafeInteger(splice.end)
            || splice.start < 0
            || splice.end < splice.start
            || splice.end > xml.length) {
            throw new RangeError(`Invalid UTF-8 splice range [${splice.start}, ${splice.end})`);
        }
        if (splice.start < previous_end) {
            throw new RangeError(`Overlapping UTF-8 splice at byte ${splice.start}`);
        }
        previous_end = splice.end;
        length += bytes.length - (splice.end - splice.start);
    }
    const out = Buffer.allocUnsafe(length);
    let input_at = 0;
    let output_at = 0;
    for (const { splice, bytes } of ordered) {
        const unchanged = xml.subarray(input_at, splice.start);
        out.set(unchanged, output_at);
        output_at += unchanged.length;
        out.set(bytes, output_at);
        output_at += bytes.length;
        input_at = splice.end;
    }
    out.set(xml.subarray(input_at), output_at);
    return out;
}

/**
 * Widen `<dimension ref="...">` to cover newly written cells.
 *
 * Excel treats `dimension` as a hint and recomputes it on load, but a stale one
 * makes Ctrl+End land short of the user's new data and confuses other readers —
 * including our own `parse_dimension`. Only widening is safe: shrinking would
 * require knowing that no other cell still occupies the old extent.
 */
export function widen_dimension(
    xml: string,
    min_row: number,
    min_col: number,
    max_row: number,
    max_col: number,
): string;
export function widen_dimension(
    xml: Uint8Array,
    min_row: number,
    min_col: number,
    max_row: number,
    max_col: number,
): Uint8Array;
export function widen_dimension(
    source: Uint8Array | string,
    min_row: number,
    min_col: number,
    max_row: number,
    max_col: number,
): Uint8Array | string {
    const return_text = typeof source === 'string';
    const xml = return_text ? Buffer.from(source, 'utf8') : source;
    // The live one: widening a commented-out `<dimension>` left the real extent
    // stale, which is what `<dimension>` is maintained here to prevent.
    const found = live_tags(
        xml,
        'dimension',
        0,
        xml.length,
        ignorable_ranges(xml, 0, xml.length),
    ).next();
    if (found.done) return source;
    const { start, end } = found.value;
    const open_tag = utf8_text(xml, start, end);
    const m = get_attr(open_tag, 'ref')?.match(CELL_RANGE_RE);
    if (!m) return source;
    const cur_start_col = letter_to_index(m[1]);
    const cur_start_row = Number(m[2]) - 1;
    const cur_end_col = m[3] !== undefined ? letter_to_index(m[3]) : cur_start_col;
    const cur_end_row = m[4] !== undefined ? Number(m[4]) - 1 : cur_start_row;
    // Both corners, not just the bottom-right one: a sheet whose used range starts
    // at C3 and gets a value written into A1 still has to grow up and to the left,
    // or the recorded range excludes the cell we just wrote and readers that trust
    // `<dimension>` never see it.
    const start_col = Math.min(cur_start_col, min_col);
    const start_row = Math.min(cur_start_row, min_row);
    const end_col = Math.max(cur_end_col, max_col);
    const end_row = Math.max(cur_end_row, max_row);
    if (
        start_col === cur_start_col && start_row === cur_start_row
        && end_col === cur_end_col && end_row === cur_end_row
    ) return source;
    const ref = `${col_index_to_letter(start_col)}${start_row + 1}:${col_index_to_letter(end_col)}${end_row + 1}`;
    const updated = apply_utf8_splices(xml, [{
        start,
        end,
        text: replace_attr_value(open_tag, 'ref', ref),
    }]);
    return return_text ? utf8_text(updated) : updated;
}
