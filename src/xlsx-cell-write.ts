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
 * algorithm rather than a checklist we have to keep up to date. Parts other than
 * the edited worksheet are never even read (see `xlsx-package.ts`).
 *
 * The unit of edit is one `<c>` element. For each edited cell we either splice a
 * replacement `<c>` over the existing one, or synthesize a new `<c>` (and, if
 * needed, a new `<row>`) at the correct sorted position. Everything between
 * splices is untouched original text.
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
}

const MS_PER_DAY = 86400000;
const EXCEL_1900_EPOCH_MS = Date.UTC(1899, 11, 31);
const EXCEL_1904_EPOCH_MS = Date.UTC(1904, 0, 1);

function encode_xml(s: string): string {
    return strip_illegal_xml_chars(
        s
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            // A raw CR does not survive: XML 1.0 requires every parser to
            // normalize `\r` and `\r\n` in content to a single `\n` before the
            // application ever sees it, so a literal one is not "preserved as
            // typed" — it is silently a line feed on the way back in, and
            // `\r\n` loses a character outright. The numeric reference is
            // exempt from that normalization, which is what makes it the only
            // spelling that round-trips. Excel writes CRs this way too.
            .replace(/\r/g, '&#13;'),
    );
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

/**
 * Excel accepts a narrow set of unambiguous date spellings. We deliberately do
 * NOT attempt locale-sensitive parsing: `03/04/2024` is March 4th to one user and
 * April 3rd to another, and silently picking one would corrupt data in a way the
 * user cannot see. Ambiguous input stays a string, which is visible and
 * correctable; a wrong date is neither.
 */
const ISO_DATE_RE
    = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Convert an ISO date string to an Excel serial, or null if not an ISO date.
 *
 * The 1900 system reserves serial 60 for 1900-02-29, a day that never existed —
 * Lotus 1-2-3 had the bug and Excel kept it for compatibility. That makes the
 * serial→date map non-injective around the boundary, so going backwards needs a
 * deliberate tie-break: dates on or after 1900-03-01 get the +1 shift, and
 * 1900-02-28 maps to 59 (the real day) rather than 60 (the fictitious one).
 * Nothing round-trips to 60; a workbook containing it still reads back as
 * 1900-02-28, we just never write it.
 */
export function iso_to_serial(text: string, datemode: 0 | 1): number | null {
    // A timezone offset is accepted and then ignored for the arithmetic. An Excel
    // serial is a naive wall-clock number with no zone in it at all, so there is
    // nothing to carry the offset into: shifting the instant to UTC would move the
    // displayed date, which is the one thing the user can see. Accepting the
    // spelling is what matters — `2024-01-15T12:00:00+02:00` is a perfectly ordinary
    // `t="d"` value, and rejecting it meant retyping exactly what the grid showed
    // rewrote the cell as an inline string, silently dropping its date type for
    // every formula and filter downstream.
    const m = ISO_DATE_RE.exec(text.trim());
    if (!m) return null;
    const [, y, mo, d, hh, mm, ss, ms] = m;
    const year = Number(y), month = Number(mo), day = Number(d);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    // Bounded before `Date.UTC`, which rolls `12:60` forward to `13:00` and leaves
    // the calendar date intact — so the round-trip check below cannot see it, and
    // we would store a time the user did not type.
    const hour = hh ? Number(hh) : 0;
    const minute = mm ? Number(mm) : 0;
    const second = ss ? Number(ss) : 0;
    if (hour > 23 || minute > 59 || second > 59) return null;
    const utc = Date.UTC(
        year, month - 1, day, hour, minute, second,
        ms ? Number(ms.padEnd(3, '0')) : 0,
    );
    if (!Number.isFinite(utc)) return null;
    // Reject inputs that rolled over (e.g. 2024-02-31 → March 2nd). Silently
    // accepting a rollover would write a date the user never typed.
    const back = new Date(utc);
    if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) {
        return null;
    }
    if (datemode === 1) {
        return (utc - EXCEL_1904_EPOCH_MS) / MS_PER_DAY;
    }
    const serial = (utc - EXCEL_1900_EPOCH_MS) / MS_PER_DAY;
    // See the doc comment: only dates strictly after the fictitious 1900-02-29
    // carry the compatibility shift.
    return serial >= 60 ? serial + 1 : serial;
}

/**
 * Excel's own numeric literal grammar — deliberately stricter than `Number()`.
 *
 * Redundant leading zeros are excluded on purpose: `007`, a zip code, a phone
 * extension and an account id are all things a user types *as typed*, and
 * storing them as numbers loses the zeros visibly and irreversibly. `0`, `0.5`
 * and `-0.5` are still numbers — a single leading zero before a decimal point is
 * a spelling of the value, not padding. This matches what editing the same text
 * in a CSV does, where it round-trips verbatim.
 */
const NUMBER_RE = /^[+-]?((0|[1-9]\d*)(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/**
 * Significant digits a double holds exactly. Excel's own limit is the same 15,
 * and for the same reason: `<v>` is read back as an IEEE double.
 */
const MAX_EXACT_DIGITS = 15;

/** The two standardized default namespaces for SpreadsheetML worksheet elements. */
const SPREADSHEETML_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const STRICT_SPREADSHEETML_NS = 'http://purl.oclc.org/ooxml/spreadsheetml/main';

function is_spreadsheetml_namespace(namespace: string): boolean {
    return namespace === SPREADSHEETML_NS || namespace === STRICT_SPREADSHEETML_NS;
}

/**
 * How many significant digits a numeric literal spells out.
 *
 * Leading zeros and the exponent do not count — `0.00012` and `1.2e-30` carry two
 * — because neither costs precision. Only the digits that must survive the
 * round-trip through a double are counted.
 */
function significant_digits(text: string): number {
    const mantissa = text.replace(/[eE][+-]?\d+$/, '').replace(/[+-]/, '').replace('.', '');
    return mantissa.replace(/^0+/, '').length;
}

/**
 * Decide how one typed string is stored, given the cell's existing style.
 *
 * Per the agreed `putexcel` semantics the cell keeps its existing `s=` style
 * index in every case — we are changing the value, not the formatting. Type
 * inference only decides what goes between `<v>` and `</v>` and what `t=` says.
 */
export function classify_value(
    value: string,
    xf_index: number,
    options: XlsxWriteOptions,
): { kind: 'empty' } | { kind: 'number'; text: string } | { kind: 'string'; text: string } {
    if (value === '') return { kind: 'empty' };

    // A date spelling is stored as a serial only when the cell is already
    // formatted as a date. Writing a bare serial into a General cell would show
    // the user "45000" where they typed a date — visibly wrong. Under a date
    // style the serial and the format agree, so it renders as they typed it.
    //
    // A negative serial is refused: Excel has no date before its own epoch, and
    // shows one as `########` in a date-formatted cell. Typing `1899-12-30` into
    // such a cell stored `<v>-1</v>`, which our own reader renders back as the
    // date — so it looked right here and was unreadable in the application the
    // file exists to be opened in. Falling through stores the text the user typed,
    // which every consumer can at least display.
    const serial = iso_to_serial(value, options.datemode);
    if (serial !== null && serial >= 0 && options.is_date_style(xf_index, serial)) {
        return { kind: 'number', text: String(serial) };
    }

    // Numeric only when storing it as a number is *lossless*. `<v>` is read back
    // as an IEEE double, so a token carrying more than ~15 significant digits —
    // an account number, an order id, a long barcode — comes back rounded:
    // `12345678901234567890` reads as `12345678901234567000`, and the digits the
    // user typed are gone from the file. Round-tripping the parse is the exact
    // test for that, and it costs nothing on the ordinary values that dominate.
    //
    // Such a token is stored as a string instead, which is also what Excel does
    // with an identifier too long to hold as a number, and what editing the same
    // text in a CSV already does here.
    //
    // `n !== 0` covers the other end of the same loss: `1e-400` underflows to zero
    // in every double-based reader there is, so storing it as a number replaces a
    // nonzero value the user typed with `0` — silently and permanently. A typed
    // `0` is of course still a number; only a token that *means* nonzero and
    // *reads back* as zero falls through to text.
    const trimmed = value.trim();
    if (NUMBER_RE.test(trimmed)) {
        const n = Number(trimmed);
        const underflowed = n === 0 && /[1-9]/.test(trimmed.replace(/[eE][+-]?\d+$/, ''));
        if (Number.isFinite(n) && !underflowed && significant_digits(trimmed) <= MAX_EXACT_DIGITS) {
            return { kind: 'number', text: trimmed };
        }
    }

    return { kind: 'string', text: value };
}

/**
 * `'1'`/`'0'` for the two spellings Excel shows a boolean cell as, else null.
 *
 * Matched case-insensitively and trimmed, since that is how a user retypes what
 * the grid displayed; anything else is a value, not a boolean.
 */
function boolean_literal(value: string): '1' | '0' | null {
    const text = value.trim().toUpperCase();
    if (text === 'TRUE') return '1';
    if (text === 'FALSE') return '0';
    return null;
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
): string {
    const { value } = edit;
    const ref = `${col_index_to_letter(col)}${row + 1}`;
    const style_attr = xf_index !== null && xf_index !== 0 ? ` s="${xf_index}"` : '';
    // A rich edit whose runs still carry styling beyond the cell's own font is
    // written as a rich inline string — checked ahead of the scalar paths
    // because styled text is text: `**2024-01-15**` must not become a serial.
    // Runs that all match the cell font carry nothing the `s=` style doesn't
    // already say, so they reduce to `value` and fall through to the ordinary
    // classification below (string, number, date, boolean — unchanged).
    if (edit.runs !== undefined && edit.runs.length > 0) {
        const cell_style = options.cell_font_style?.(xf_index ?? 0);
        if (!edit.runs.every((run) => text_styles_equal(run.style, cell_style))) {
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
    // An ISO-date cell edited back to a date stays one, for the same reason a
    // boolean does. `t="d"` stores the date as text and the reader shows it
    // verbatim — no serial, no style consulted — so the user retypes what looks
    // like the same thing and got back an inline string: identical on screen,
    // and no longer a date to any formula, filter or consumer downstream.
    //
    // Checked before `classify_value`, which would otherwise turn the typed date
    // into a serial whenever the cell also carries a date *style*. A serial under
    // `t="d"` is not a date at all — the reader reads that element's text — so the
    // two spellings cannot be mixed, and the cell's existing type is the one to
    // keep. Narrow like the boolean case: only a cell that was already `t="d"`,
    // and only when what was typed is still a date.
    //
    // Validity is decided by `iso_to_serial`, not by `ISO_DATE_RE`, which only
    // describes the *shape*: `2024-02-31` and `2024-01-01T25:00` match it and are
    // not dates. Writing those under `t="d"` produced a cell claiming to be a date
    // whose text no date parser accepts — Excel reports the workbook as needing
    // repair. The shape test alone was the wrong gate; a value that cannot be a
    // date falls through and is stored as the text the user typed.
    if (was_iso_date && iso_to_serial(value, options.datemode) !== null) {
        // The space-separated spelling `2024-01-15 12:00` is what a user retypes
        // from a grid, and `ISO_DATE_RE` accepts it — but a `t="d"` cell's text is
        // an `xsd:dateTime`, where the `T` is required. Written through verbatim it
        // made a date cell whose value no conforming date parser accepts: strict
        // consumers reject it and prefix-parsing ones keep the date and drop the
        // 12:00. Normalized rather than refused, since the value *is* the date the
        // user meant, and this is the same repair the invalid-date gate above is
        // there to prevent.
        return `<c r="${ref}"${style_attr} t="d"><v>${encode_xml(value.trim().replace(' ', 'T'))}</v></c>`;
    }
    // A boolean cell edited back to a boolean stays one. The reader renders `t="b"`
    // as the text TRUE/FALSE, so that is what the user sees in the grid and types
    // back — and without this it returned as an inline string that merely *looks*
    // the same, silently changing the cell's type for every formula, filter and
    // consumer downstream. Narrow on purpose: only a cell that was already boolean,
    // so typing TRUE into a text cell still stores text.
    if (was_boolean) {
        const bool = boolean_literal(value);
        if (bool !== null) return `<c r="${ref}"${style_attr} t="b"><v>${bool}</v></c>`;
    }
    const classified = classify_value(value, xf_index ?? 0, options);
    switch (classified.kind) {
        case 'empty':
            // A styled-but-valueless `<c>` is retained rather than deleted so the
            // cell keeps its formatting, borders and fill after being cleared —
            // exactly what Delete does in Excel, and what `putexcel` leaves behind.
            return `<c r="${ref}"${style_attr}/>`;
        case 'number':
            return `<c r="${ref}"${style_attr}><v>${classified.text}</v></c>`;
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

/**
 * Formula kinds whose `<f>` governs cells other than its own.
 *
 * `shared` names a definition its followers reference by `si`; `array` and
 * `dataTable` each carry a `ref` spanning a range whose other cells hold only a
 * cached value. Writing a literal into any of them leaves the group pointing at
 * a definition that is gone, so all three are refused the same way.
 */
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
 * The `ref` range of every shared/array formula on the sheet.
 *
 * An array formula writes one `<f t="array" ref="A1:B2">` on its top-left cell;
 * the other cells in that range hold a value and no `<f>` at all. So the
 * per-cell check below cannot see them, and an edit to one would drop a member
 * of the group without ever meeting a formula. A shared master's `ref` spans its
 * followers the same way — those *do* carry an `<f>`, but scanning the range
 * catches them uniformly and costs one pass either way.
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
 * Why an edit inside a shared or array formula is refused.
 *
 * Its `<f>` is not local to the cell: a shared master defines the formula its
 * followers reference by `si`, and an array formula's `ref` spans a range.
 * Dropping either leaves the rest of the group pointing at a definition that no
 * longer exists — cells that silently stop calculating, or a workbook Excel
 * offers to repair. Handling those groups properly means rewriting cells the
 * user did not edit, which is the opposite of a surgical save, so this refuses
 * and says why instead of quietly corrupting the sheet.
 */
function grouped_formula_error(row: number, col: number, kind: GroupedFormulaKind): Error {
    const described = kind === 'array'
        ? 'an array formula'
        : kind === 'dataTable' ? 'a data table' : 'a shared formula';
    return new Error(
        `Cannot edit ${cell_reference(row, col)}: it is part of ${described}. `
        + 'Clear the formula in Excel first.',
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
 * Both a shared master (`t="shared"` with an `si`) and a shared *follower* (an
 * empty `<f t="shared" si="..."/>`) count: replacing either breaks the group.
 */
function grouped_formula_kind(
    xml: Uint8Array,
    from: number,
    to: number,
): GroupedFormulaKind | null {
    // Only the cell's *live* `<f>`: an array formula quoted in a comment inside an
    // ordinary cell refused a literal edit that was never part of a group.
    const ignorable = ignorable_ranges(xml, from, to);
    for (const tag of live_tags(xml, 'f', from, to, ignorable)) {
        const kind = get_tag_attr(xml, tag.start, tag.end, 't');
        return is_grouped_formula_kind(kind) ? kind : null;
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
 * for a coordinate with no entry. So a styled-but-empty `<c r="B2" s="3"/>`, or
 * a formula cell with no cached `<v>`, reads as BLANK today, and treating
 * either as display-backed would let a save invent text the user never saw.
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
    // Scanned once for the whole sheet, because an array formula's members are
    // only identifiable from the master's `ref` — see `grouped_formula_ranges`.
    const grouped_ranges = grouped_formula_ranges(xml);

    // Ahead of every row and cell lookup, because a grouped formula's range can
    // cover coordinates that have no `<c>` — and, if the whole row is sparse, no
    // `<row>` either. Left inside the existing-cell branch, those edits reached
    // the insertion paths instead and wrote a literal into the middle of an array
    // formula's result range, which is the corruption the refusal exists to stop.
    const merged = merged_follower_ranges(xml);
    for (const e of edits) {
        const grouped = grouped_range_kind(grouped_ranges, e.row, e.col);
        if (grouped) throw grouped_formula_error(e.row, e.col, grouped);
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
                .map((e) => build_cell_xml(e.row, e.col, e, null, options))
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
                // A *shared* or *array* formula is different, and refused. Its `<f>`
                // is not local to the cell: a shared master defines the formula its
                // followers reference by `si`, and an array formula's `ref` spans a
                // range of cells. Dropping either leaves the rest of the group
                // pointing at a definition that no longer exists — cells that
                // silently stop calculating, or a workbook Excel offers to repair.
                // Handling those groups properly means rewriting cells the user did
                // not edit, which is the opposite of a surgical save, so this
                // refuses and says why instead of quietly corrupting the sheet.
                // The range sweep above already covered every cell a group's `ref`
                // names. This catches the one it cannot see: a shared *follower*,
                // whose `<f t="shared" si="…"/>` carries no `ref` of its own.
                const grouped = grouped_formula_kind(
                    xml,
                    cell_span.inner_start,
                    cell_span.inner_end,
                );
                if (grouped) throw grouped_formula_error(e.row, e.col, grouped);
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
                    text: build_cell_xml(e.row, e.col, e, null, options),
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
