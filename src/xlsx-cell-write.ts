import { find_tag_end, is_tag_boundary, is_self_closing } from './parse-xlsx';

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
}

const MS_PER_DAY = 86400000;
const EXCEL_1900_EPOCH_MS = Date.UTC(1899, 11, 31);
const EXCEL_1904_EPOCH_MS = Date.UTC(1904, 0, 1);

function encode_xml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        // A raw CR does not survive: XML 1.0 requires every parser to normalize
        // `\r` and `\r\n` in content to a single `\n` before the application ever
        // sees it, so a literal one is not "preserved as typed" — it is silently a
        // line feed on the way back in, and `\r\n` loses a character outright. The
        // numeric reference is exempt from that normalization, which is what makes
        // it the only spelling that round-trips. Excel writes CRs this way too.
        .replace(/\r/g, '&#13;')
        // Control characters XML 1.0 forbids outright: they have no escape, so a
        // numeric reference would be just as invalid as the raw byte. Excel drops
        // them on paste too. A user pasting from a terminal or a PDF can carry
        // one in without ever seeing it, and the result would be a worksheet part
        // no reader accepts — a corrupt workbook from one invisible character.
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '');
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
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?Z?)?$/;

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
    const serial = iso_to_serial(value, options.datemode);
    if (serial !== null && options.is_date_style(xf_index, serial)) {
        return { kind: 'number', text: String(serial) };
    }

    if (NUMBER_RE.test(value.trim())) {
        const n = Number(value.trim());
        if (Number.isFinite(n)) return { kind: 'number', text: value.trim() };
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
    value: string,
    xf_index: number | null,
    options: XlsxWriteOptions,
    was_boolean = false,
): string {
    const ref = `${col_index_to_letter(col)}${row + 1}`;
    const style_attr = xf_index !== null && xf_index !== 0 ? ` s="${xf_index}"` : '';
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

/** A located element in the worksheet XML: [start, end) byte offsets of the whole element. */
interface Span {
    readonly start: number;
    readonly end: number;
    /** Offset just past the opening tag's `>`; equals `end` for self-closing elements. */
    readonly inner_start: number;
    readonly open_tag: string;
    /**
     * Where the element's content ends, i.e. the start of its end tag. Equals
     * `end` for a self-closing element.
     *
     * Carried rather than derived: an end tag may legally be written `</row\n>`, so
     * `end - '</row>'.length` is not where it starts. Computing it that way put an
     * insertion *inside* the end tag and emitted malformed XML.
     */
    readonly inner_end: number;
}

/**
 * The row number an unnumbered `<row>` implies, taken from its first `<c r="…">`.
 *
 * Undefined for a row with no referenced cell — there is nothing to edit in it,
 * so leaving it unmapped costs nothing.
 */
function row_index_from_first_cell(
    xml: string,
    from: number,
    to: number,
    ranges: ReadonlyArray<[number, number]>,
): number | undefined {
    let pos = from;
    while (pos < to) {
        // A commented-out `<c r="A1"/>` ahead of the row's real cells named the
        // wrong row, so the edit missed the span it was aiming at and synthesized
        // a duplicate row for a coordinate already present.
        const at = indexOf_live(xml, '<c', pos, ranges);
        if (at === -1 || at >= to) return undefined;
        if (!is_tag_boundary(xml[at + 2])) { pos = at + 2; continue; }
        const tag_end = find_tag_end(xml, at);
        if (tag_end === -1 || tag_end >= to) return undefined;
        const ref = /\br="[A-Z]+(\d+)"/.exec(xml.slice(at, tag_end + 1));
        if (ref) return Number(ref[1]) - 1;
        pos = tag_end + 1;
    }
    return undefined;
}

/** Locate every `<row>` element in `sheetData`, in document order. */
/**
 * Ranges inside `[from, to)` whose contents are text, not markup: XML comments,
 * CDATA sections, and processing instructions.
 *
 * The scanners below match on raw `<row`/`<c` substrings, which is exact for real
 * markup and wrong for anything quoting it. A commented-out row — the shape a
 * generator leaves behind, and one Excel preserves on round-trip — looked like a
 * live row to `scan_rows`, so an edit to a cell it names spliced the new value
 * *into the comment*: the file stays valid, the save reports success, and the
 * cell on screen never changes. Skipping these ranges makes the writer agree with
 * an XML parser about what a row is, without needing one.
 *
 * A processing instruction is the third spelling of the same hazard. Everything
 * between `<?` and `?>` is opaque data to a parser and its content is
 * unconstrained, so element-shaped text in there is text — but reading it as
 * markup let an edit rewrite a cell *inside the PI* while the live cell of that
 * name kept its old value.
 */
function ignorable_ranges(xml: string, from: number, to: number): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    let pos = from;
    while (pos < to) {
        const at = earliest_of(xml, ['<!', '<?'], pos);
        if (at === -1 || at >= to) break;
        let end: number;
        if (xml.startsWith('<!--', at)) {
            const close = xml.indexOf('-->', at + 4);
            end = close === -1 ? to : close + 3;
        } else if (xml.startsWith('<![CDATA[', at)) {
            const close = xml.indexOf(']]>', at + 9);
            end = close === -1 ? to : close + 3;
        } else if (xml.startsWith('<?', at)) {
            const close = xml.indexOf('?>', at + 2);
            end = close === -1 ? to : close + 2;
        } else {
            pos = at + 2;
            continue;
        }
        out.push([at, end]);
        pos = end;
    }
    return out;
}

/** The earliest occurrence at or after `from` of any of `needles`, or -1. */
function earliest_of(xml: string, needles: readonly string[], from: number): number {
    let best = -1;
    for (const needle of needles) {
        const at = xml.indexOf(needle, from);
        if (at !== -1 && (best === -1 || at < best)) best = at;
    }
    return best;
}

/** Where to resume from if `at` falls inside an ignorable range, else undefined. */
function ignorable_end(ranges: ReadonlyArray<[number, number]>, at: number): number | undefined {
    for (const [start, end] of ranges) {
        if (at < start) return undefined;
        if (at < end) return end;
    }
    return undefined;
}

/**
 * Every real `<name …>` opening tag in `[from, to)`, as [offset, whole tag].
 *
 * The one way to scan tags here. `matchAll(/<f\b[^>]*>/g)` gets both halves of
 * this wrong: `[^>]*` stops at the first `>`, and a `>` inside a quoted attribute
 * value is legal XML — `x:note="1 &gt; 0"` need not be escaped — so the "tag" it
 * yields is a fragment, which made the safety guard refuse a perfectly editable
 * worksheet and made a sheet named `Welcome > Intro` shift the workbook's
 * worksheet numbering, writing an edit into the wrong sheet. And a bare regex has
 * no idea what a comment is, so a commented-out element read as live.
 * `find_tag_end` is the reader's own quote-aware scan; `ignorable_ranges` is what
 * makes "live" mean live.
 */
/**
 * Every real `<name …>` opening tag in a whole document, quote- and comment-aware.
 *
 * The package layer's `matchAll(/<sheet\b[^>]*>/g)` had the same defect as the
 * writer's scans: a legal raw `>` inside a sheet name truncated the tag, the
 * `name="` test then failed, and that worksheet dropped out of the numbering —
 * so an edit aimed at sheet 0 was written into sheet 1. Silent, and valid on disk.
 */
export function* live_tags_in(xml: string, name: string): Generator<[number, string]> {
    yield* live_tags(xml, name, 0, xml.length, ignorable_ranges(xml, 0, xml.length));
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
export function element_close(
    xml: string,
    name: string,
    inner_start: number,
): { inner: string; end: number } | null {
    const ranges = ignorable_ranges(xml, 0, xml.length);
    const end_tag = end_tag_after(xml, name, inner_start, ranges);
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
 * The inner text of the first live `<name>…</name>` element, or null.
 *
 * The same hazard one level up: `<numFmts[^>]*>([\s\S]*?)</numFmts>` cut the
 * opening tag at the first `>`, so an attribute value legally containing one
 * swallowed the element's content and every entry inside went unread. An empty
 * element has no content and answers null.
 */
export function element_content(xml: string, name: string): string | null {
    const ranges = ignorable_ranges(xml, 0, xml.length);
    for (const [at, tag] of live_tags(xml, name, 0, xml.length, ranges)) {
        if (tag.endsWith('/>')) return null;
        const inner_start = at + tag.length;
        const end_tag = end_tag_after(xml, name, inner_start, ranges);
        return end_tag === null ? null : xml.slice(inner_start, end_tag[0]);
    }
    return null;
}

function* live_tags(
    xml: string,
    name: string,
    from: number,
    to: number,
    ranges: ReadonlyArray<[number, number]>,
): Generator<[number, string]> {
    let pos = from;
    while (pos < to) {
        const at = indexOf_live(xml, `<${name}`, pos, ranges);
        if (at === -1 || at >= to) return;
        if (!is_tag_boundary(xml[at + name.length + 1])) { pos = at + 1; continue; }
        const tag_end = find_tag_end(xml, at);
        if (tag_end === -1) return;
        yield [at, xml.slice(at, tag_end + 1)];
        pos = tag_end + 1;
    }
}

/**
 * The first `needle` at or after `from` that is real markup rather than quoted text.
 *
 * Every raw `indexOf` in these scanners needs this, not just the ones that find
 * opening tags. Skipping a commented-out `<row>` but then closing the *live* row
 * at a `</row>` inside a comment is the same bug wearing the other shoe: the span
 * ends early, and the edit splices into the comment (silent no-op) or across it
 * (malformed XML, which is worse than either).
 */
function indexOf_live(
    xml: string,
    needle: string,
    from: number,
    ranges: ReadonlyArray<[number, number]>,
): number {
    let pos = from;
    while (true) {
        const at = xml.indexOf(needle, pos);
        if (at === -1) return -1;
        const skip_to = ignorable_end(ranges, at);
        if (skip_to === undefined) return at;
        pos = skip_to;
    }
}

/**
 * The span of the first live `</name>` end tag at or after `from`, as
 * `[start, end)`, or null if there is none.
 *
 * Not an `indexOf('</c>')`: XML permits whitespace between the name and the `>`,
 * so `</c\n>` is an ordinary end tag that a pretty-printer may well write.
 * Missing it made the element look unterminated, the cell took the
 * synthesize-a-new-one path, and the row came out with *two* `<c r="A1">` — a
 * file whose displayed value depends on which one the reader keeps.
 *
 * The name boundary is checked rather than assumed, because `</c` is also a
 * prefix of `</calcChain`; a prefix match resumes the search instead of ending
 * the element in the wrong place.
 */
function end_tag_after(
    xml: string,
    name: string,
    from: number,
    ranges: ReadonlyArray<[number, number]>,
): [number, number] | null {
    let pos = from;
    while (true) {
        const at = indexOf_live(xml, `</${name}`, pos, ranges);
        if (at === -1) return null;
        const after = at + name.length + 2;
        if (xml[after] === '>') return [at, after + 1];
        const gt = xml.indexOf('>', after);
        if (gt !== -1 && after < gt && !/\S/.test(xml.slice(after, gt))) return [at, gt + 1];
        pos = at + 1;
    }
}

function scan_rows(xml: string, from: number, to: number): Map<number, Span> {
    const out = new Map<number, Span>();
    const ignorable = ignorable_ranges(xml, from, to);
    let pos = from;
    while (pos < to) {
        const start = xml.indexOf('<row', pos);
        if (start === -1 || start >= to) break;
        const skip_to = ignorable_end(ignorable, start);
        if (skip_to !== undefined) { pos = skip_to; continue; }
        if (!is_tag_boundary(xml[start + 4])) { pos = start + 1; continue; }
        const tag_end = find_tag_end(xml, start);
        if (tag_end === -1) break;
        const open_tag = xml.slice(start, tag_end + 1);
        const r = /\br="(\d+)"/.exec(open_tag);
        if (is_self_closing(xml, start, tag_end)) {
            // Nothing inside to infer a row number from, and nothing to edit either.
            if (r) out.set(Number(r[1]) - 1, { start, end: tag_end + 1, inner_start: tag_end + 1, inner_end: tag_end + 1, open_tag });
            pos = tag_end + 1;
            continue;
        }
        const end_tag = end_tag_after(xml, 'row', tag_end, ignorable);
        if (end_tag === null) break;
        const [close, after_close] = end_tag;
        // `r` is optional in SpreadsheetML, and the reader never needed it: it keys
        // cells off `<c r="A1">`. Skipping an unnumbered row here made the writer
        // disagree, and an edit to a cell the user can plainly see took the
        // synthesize-the-row path — appending a *second* row with a second copy of
        // that cell. Duplicate coordinates, and a reader may pick either value.
        // Recover the number from the first cell reference inside instead.
        const row_index = r
            ? Number(r[1]) - 1
            : row_index_from_first_cell(xml, tag_end + 1, close, ignorable);
        if (row_index !== undefined) {
            out.set(row_index, { start, end: after_close, inner_start: tag_end + 1, inner_end: close, open_tag });
        }
        pos = after_close;
    }
    return out;
}

/** Locate every `<c>` element inside one row's inner range, keyed by column index. */
function scan_cells(xml: string, from: number, to: number): Map<number, Span> {
    const out = new Map<number, Span>();
    const ignorable = ignorable_ranges(xml, from, to);
    let pos = from;
    while (pos < to) {
        const start = xml.indexOf('<c', pos);
        if (start === -1 || start >= to) break;
        const skip_to = ignorable_end(ignorable, start);
        if (skip_to !== undefined) { pos = skip_to; continue; }
        if (!is_tag_boundary(xml[start + 2])) { pos = start + 1; continue; }
        const tag_end = find_tag_end(xml, start);
        if (tag_end === -1 || tag_end >= to) break;
        const open_tag = xml.slice(start, tag_end + 1);
        const r = /\br="([A-Z]+)(\d+)"/.exec(open_tag);
        const col = r ? letter_to_index(r[1]) : null;
        if (is_self_closing(xml, start, tag_end)) {
            if (col !== null) out.set(col, { start, end: tag_end + 1, inner_start: tag_end + 1, inner_end: tag_end + 1, open_tag });
            pos = tag_end + 1;
            continue;
        }
        const end_tag = end_tag_after(xml, 'c', tag_end, ignorable);
        if (end_tag === null) break;
        const [close, after_close] = end_tag;
        if (col !== null) out.set(col, { start, end: after_close, inner_start: tag_end + 1, inner_end: close, open_tag });
        pos = after_close;
    }
    return out;
}

function letter_to_index(letters: string): number {
    let index = 0;
    for (let i = 0; i < letters.length; i++) index = index * 26 + (letters.charCodeAt(i) - 64);
    return index - 1;
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

function is_grouped_formula_kind(value: string | undefined): value is GroupedFormulaKind {
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
function grouped_formula_ranges(xml: string): GroupedRange[] {
    const ranges: GroupedRange[] = [];
    // Same reason `scan_rows` skips these: a commented-out array formula is text,
    // and treating it as a live range refuses an edit to a cell that is not in one.
    const ignorable = ignorable_ranges(xml, 0, xml.length);
    for (const [, tag] of live_tags(xml, 'f', 0, xml.length, ignorable)) {
        const type = /\bt="([^"]*)"/.exec(tag);
        const kind = type?.[1];
        if (!is_grouped_formula_kind(kind)) continue;
        const ref = /\bref="([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?"/.exec(tag);
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
function grouped_formula_kind(cell_inner: string): GroupedFormulaKind | null {
    // Only the cell's *live* `<f>`: an array formula quoted in a comment inside an
    // ordinary cell refused a literal edit that was never part of a group.
    const ignorable = ignorable_ranges(cell_inner, 0, cell_inner.length);
    for (const [, tag] of live_tags(cell_inner, 'f', 0, cell_inner.length, ignorable)) {
        const type = /\bt="([^"]*)"/.exec(tag);
        return is_grouped_formula_kind(type?.[1]) ? type![1] as GroupedFormulaKind : null;
    }
    return null;
}

/** `A1`-style reference for a message a user will read. */
function cell_reference(row: number, col: number): string {
    return `${col_index_to_letter(col)}${row + 1}`;
}

function existing_style(open_tag: string): number | null {
    const m = /\bs="(\d+)"/.exec(open_tag);
    return m ? Number(m[1]) : null;
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
export function formula_count(xml: string): number {
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

/**
 * Refuse a worksheet this writer cannot read the way an XML parser would.
 *
 * The scanners here match literal spellings — `<row`, `<c`, `<f`, `r="A1"` — which
 * is exact for how Excel and every mainstream generator write a worksheet, and
 * wrong for spellings that are equally valid XML. Three of them corrupt silently
 * rather than failing loudly, which is why this refuses instead of trying harder:
 *
 *  - A namespace prefix (`<x:row>`, `<x:c>`, `<x:f>`), or a default-namespace
 *    override (`<row xmlns="urn:other">`). Both bind the element to a URI, so they
 *    are the same elements to a parser and invisible to these scanners. A mixed
 *    document is the dangerous case: unprefixed rows and cells scan normally but a
 *    prefixed `<x:f>` is not seen, so the edit overwrites an array formula and
 *    `formula_count` reports no loss, leaving `calcChain.xml` attached and stale.
 *    An override is worse still — a `<c>` spliced into an overridden row inherits
 *    the foreign namespace, so the save succeeds and writes no worksheet cell.
 *  - An attribute spelled any way but `name="value"` — single-quoted (`r='A1'`),
 *    space-padded (`r = "A1"`), or carrying an entity reference (`r="A&#49;"`).
 *    Every attribute the writer consumes is matched literally, so each spelling
 *    has its own silent failure: an unrecognized `r` *appends a second cell with
 *    the same reference*, an unrecognized `s` drops the cell's formatting, an
 *    unrecognized `t="b"` turns a boolean into a string, and an unrecognized
 *    `t`/`ref` on `<f>` hides an array formula the writer would then overwrite.
 *    Checked across every attribute of `<row>`, `<c>` and `<f>` rather than just
 *    the consumed ones: the consumed set is a moving target, and a worksheet
 *    that spells one attribute unusually will spell its neighbours that way too.
 *  - A cell with no `r` at all, whose column is implied by document order. Same
 *    duplicate-coordinate outcome, and the reader ignores such cells too, so the
 *    user is editing a cell they cannot see.
 *
 * Handling any of these properly means a namespace-aware tokenizer that preserves
 * byte offsets — real work, and unnecessary for the files this feature is for. A
 * refusal costs the user a save they could not safely have had anyway; the
 * alternative costs them a workbook that looks fine and is not.
 *
 * Scoped to `<sheetData>`, since that is all the writer touches, and to the parts
 * of it a splice depends on.
 */
function assert_writable_sheet_data(xml: string, from: number, to: number): void {
    // Offsets kept absolute so the ignorable ranges line up; comments and CDATA are
    // text, and refusing a worksheet over markup quoted inside one would be a
    // false positive on a file that edits perfectly well.
    const ignorable = ignorable_ranges(xml, from, to);
    const live = (at: number): boolean => ignorable_end(ignorable, at) === undefined;
    const unsupported = (what: string): never => {
        throw new Error(
            `Cannot edit this worksheet: it uses ${what}, which Table Viewer cannot `
            + 'edit safely. Re-saving the file in Excel will normally fix it.',
        );
    };
    for (const m of xml.matchAll(/<[A-Za-z_][\w.-]*:(?:row|c|f|is|v)\b/g)) {
        if (m.index >= from && m.index < to && live(m.index)) {
            unsupported('namespace-prefixed cell elements');
        }
    }
    // Markup-compatibility branches. `<mc:AlternateContent>` holds several
    // alternative spellings of the same content, of which a consumer picks *one*
    // by whether it understands the `Requires` namespaces — so the same `<row
    // r="1">` legitimately appears more than once with different values, and
    // which one is real depends on the reader.
    //
    // The row and cell scans are flat maps keyed by coordinate, so the last
    // branch simply overwrote the earlier ones: an edit landed in `mc:Fallback`
    // alone and every application that understands the `mc:Choice` went on
    // showing the old value, after a save that reported success. There is no
    // position this writer can splice that is correct for all readers, so it
    // declines instead. Any prefix, since `mc` is a convention and not a rule.
    for (const m of xml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?AlternateContent\b/g)) {
        if (m.index >= from && m.index < to && live(m.index)) {
            unsupported('markup-compatibility alternate content');
        }
    }
    // A commented-out cell that carries an `r`. Being right about XML is not
    // enough here: `parse_xlsx` scans raw text with `indexOf`, so a `<c r="A1">`
    // written inside a comment is a cell *to the reader*, and a later one wins over
    // the live cell before it. The writer correctly edits the live cell, the reader
    // correctly-for-itself keeps the commented value, and the save reports success
    // having changed nothing the user can see.
    //
    // Refused rather than followed: splicing the comment would mean writing into
    // text every conforming parser discards, and teaching the reader to skip
    // comments is a reader change this branch does not make. A comment with no `r`
    // in it is invisible to both sides and stays allowed — that is the ordinary
    // annotated worksheet, and refusing it would be a false positive.
    for (const [start, end] of ignorable) {
        if (start < from || start >= to) continue;
        if (!xml.startsWith('<!--', start)) continue;
        if (/<c\s[^>]*\br=/.test(xml.slice(start, end))) {
            unsupported('cells commented out but still carrying a reference');
        }
    }
    const tags: Array<[number, string]> = [];
    for (const name of ['row', 'c', 'f'] as const) {
        // Whole tags, quote-aware. Matching `[^>]*` cut every tag at the first `>`,
        // and a `>` inside a quoted attribute value is legal and needs no escaping —
        // so the fragment left over had an unbalanced quote in it, failed the
        // subtraction below, and refused a worksheet that edits perfectly well.
        for (const found of live_tags(xml, name, from, to, ignorable)) tags.push(found);
    }
    for (const [at, tag] of tags) {
        if (!live(at)) continue;
        // Any whitespace separates a tag name from its attributes, not a space
        // alone: `<c\nr="A1"\ns='7'>` is how a pretty-printer that writes one
        // attribute per line spells an ordinary cell. Looking only for a space
        // found none, so the subtraction below examined an empty string, the
        // unreadable single-quoted style passed the guard unexamined, and the edit
        // silently dropped the cell's formatting.
        const first_space = /\s/.exec(tag)?.index;
        const attrs = tag.slice(first_space ?? tag.length - 1, -1);
        // Whatever remains once every canonical `name="value"` pair is removed has
        // to be nothing but the tag's own whitespace and its self-closing slash.
        // Written as a subtraction so an attribute spelled some way not thought of
        // here still fails closed rather than passing unexamined.
        const rest = attrs.replace(/\s[A-Za-z_:][\w.:-]*="[^"]*"/g, '');
        if (/\S/.test(rest.replace(/\/$/, ''))) {
            unsupported('attributes this writer cannot read the way a parser would');
        }
        // Entities are only a hazard in the values this writer reads back: `r="A&#49;"`
        // is `A1` to a parser and unmatchable here, so the cell is missed and the edit
        // appends a duplicate. Elsewhere in the tag an `&amp;` is ordinary and legal.
        if (/\s(?:r|s|t|ref)="[^"]*&/.test(attrs)) {
            unsupported('cell references written with XML entities');
        }
        if (tag.startsWith('<c') && !/\br="/.test(tag)) {
            unsupported('cells whose position is implied rather than written');
        }
        // A prefix is not the only way to move an element out of SpreadsheetML: a
        // default-namespace override (`<row xmlns="urn:other">`) rebinds the row and
        // every unprefixed child. A `<c>` spliced in there inherits the foreign
        // namespace, so the save reports success and no worksheet cell is written.
        //
        // Only the *default* declaration, because only it rebinds anything.
        // `xmlns:vendor="…"` introduces a prefix for elements that opt into it and
        // leaves the unprefixed `<c>` exactly where it was — refusing on that
        // rejected an ordinary worksheet, and the prefixed elements themselves are
        // already caught above.
        if (/\sxmlns=/.test(attrs)) {
            unsupported('worksheet elements in a different XML namespace');
        }
    }
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
): string {
    if (edits.length === 0) return xml;
    edits = canonical_edits(edits);

    const sd_open = find_sheet_data_open(xml);
    if (!sd_open) throw new Error('Worksheet XML has no <sheetData> element');
    const { inner_start, inner_end, self_closing, element_start, element_end } = sd_open;

    // An empty `<sheetData/>` has nowhere to splice into, so expand it to a pair
    // first and re-derive the offsets from the expanded document.
    if (self_closing) {
        const expanded = xml.slice(0, element_start) + '<sheetData></sheetData>' + xml.slice(element_end);
        return apply_cell_edits(expanded, edits, options);
    }

    assert_writable_sheet_data(xml, inner_start, inner_end);

    const rows = scan_rows(xml, inner_start, inner_end);

    // Group edits by row so each row is scanned for cells at most once.
    const by_row = new Map<number, XlsxCellEdit[]>();
    for (const e of edits) {
        const list = by_row.get(e.row);
        if (list) list.push(e);
        else by_row.set(e.row, [e]);
    }

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
    for (const e of edits) {
        const grouped = grouped_range_kind(grouped_ranges, e.row, e.col);
        if (grouped) throw grouped_formula_error(e.row, e.col, grouped);
    }

    for (const [row, row_edits] of by_row) {
        const row_span = rows.get(row);
        if (!row_span) {
            // Whole row absent: synthesize it, with its cells in column order.
            const cells = [...row_edits]
                .sort((a, b) => a.col - b.col)
                .map((e) => build_cell_xml(e.row, e.col, e.value, null, options))
                .join('');
            new_rows.push({ row, text: `<row r="${row + 1}">${cells}</row>` });
            continue;
        }

        const cells = scan_cells(xml, row_span.inner_start, row_span.end);
        const inserts: Array<{ col: number; text: string }> = [];

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
                    xml.slice(cell_span.inner_start, cell_span.end),
                );
                if (grouped) throw grouped_formula_error(e.row, e.col, grouped);
                const xf = existing_style(cell_span.open_tag);
                splices.push({
                    start: cell_span.start,
                    end: cell_span.end,
                    text: build_cell_xml(
                        e.row,
                        e.col,
                        e.value,
                        xf,
                        options,
                        /\bt="b"/.test(cell_span.open_tag),
                    ),
                });
            } else {
                inserts.push({ col: e.col, text: build_cell_xml(e.row, e.col, e.value, null, options) });
            }
        }

        // New cells within an existing row must land in ascending column order:
        // Excel tolerates out-of-order `<c>` in many builds but the schema
        // specifies sorted, and some consumers (and Excel's own repair check) do
        // not. Insert each before the first existing cell of a higher column,
        // falling back to the row's end.
        // Sorted, because several inserts landing in the same gap share a splice
        // offset and `apply_splices` then keeps them in the order they arrived —
        // which is the caller's edit order, not the column order the schema wants.
        inserts.sort((a, b) => a.col - b.col);
        // `spans` caches the row's occupied column range. It is an optimization hint
        // that Excel recomputes, but a *stale* one is a lie about the row: an insert
        // outside the cached range left `spans="1:1"` on a row now reaching C, and
        // readers that trust it (ours does not; others do) never see the new cell.
        // Dropped rather than recomputed — the correct value depends on cells this
        // splice does not enumerate, and absent is a legal spelling that means
        // "work it out", while wrong is not.
        const drop_spans = inserts.length > 0 && / spans="[^"]*"/.test(row_span.open_tag);
        if (inserts.length > 0 && row_span.inner_start === row_span.end) {
            // `<row r="5" ht="20"/>` — a valid empty row, which is what a row given
            // a height or a format but no cells looks like. There is no `</row>` to
            // insert before, so the element is replaced by a paired one keeping its
            // attributes; computing an offset from `'</row>'.length` here would
            // splice into the middle of the opening tag and emit malformed XML.
            const attributes = row_span.open_tag.slice(
                '<row'.length,
                row_span.open_tag.length - '/>'.length,
            );
            splices.push({
                start: row_span.start,
                end: row_span.end,
                text: `<row${drop_spans ? attributes.replace(/ spans="[^"]*"/, '') : attributes}>`
                    + `${inserts.map((i) => i.text).join('')}</row>`,
            });
            continue;
        }
        // Rewritten as its own splice for a paired row, whose opening tag this loop
        // otherwise leaves untouched.
        if (drop_spans) {
            splices.push({
                start: row_span.start,
                end: row_span.inner_start,
                text: row_span.open_tag.replace(/ spans="[^"]*"/, ''),
            });
        }
        for (const ins of inserts) {
            // The span's own content end, not `end - '</row>'.length`: an end tag may
            // legally be written `</row\n>`, and the subtraction then landed *inside*
            // it, splicing the new cell into the middle of the tag and emitting
            // malformed XML.
            let at = row_span.inner_end;
            let best: number | undefined;
            for (const [col, span] of cells) {
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
        for (const [r, span] of rows) {
            if (r > nr.row && (best === undefined || span.start < best)) best = span.start;
        }
        if (best !== undefined) at = best;
        splices.push({ start: at, end: at, text: nr.text });
    }

    return apply_splices(xml, splices);
}

/**
 * Apply splices right-to-left so each splice's offsets stay valid — they were all
 * computed against the original string. Ties (two zero-width inserts at the same
 * offset) keep their relative order, which matters when two new cells insert
 * before the same existing cell.
 *
 * A replacement and an insert can share a start offset: inserting a new cell
 * before existing `C1` puts the insert at `C1`'s start, and editing `C1` itself
 * replaces from there. Applying right-to-left, the *replacement* has to go first
 * — otherwise the insert lands at that offset and the replacement, still holding
 * the original `[start, end)`, overwrites the text just inserted. So among ties,
 * nonzero-width splices sort ahead of zero-width ones.
 */
function apply_splices(xml: string, splices: Splice[]): string {
    const is_insert = (s: Splice) => (s.end > s.start ? 0 : 1);
    const ordered = splices
        .map((s, i) => ({ s, i }))
        .sort((a, b) => (b.s.start - a.s.start)
            || (is_insert(a.s) - is_insert(b.s))
            || (b.i - a.i));
    let out = xml;
    for (const { s } of ordered) {
        out = out.slice(0, s.start) + s.text + out.slice(s.end);
    }
    return out;
}

function find_sheet_data_open(xml: string): {
    inner_start: number;
    inner_end: number;
    self_closing: boolean;
    element_start: number;
    element_end: number;
} | null {
    // A commented-out `<sheetData>` ahead of the live one took every edit into the
    // comment: the worksheet on disk never changed and the save reported success.
    const ignorable = ignorable_ranges(xml, 0, xml.length);
    let pos = 0;
    while (true) {
        const start = indexOf_live(xml, '<sheetData', pos, ignorable);
        if (start === -1) return null;
        if (!is_tag_boundary(xml[start + 10])) { pos = start + 1; continue; }
        const tag_end = find_tag_end(xml, start);
        if (tag_end === -1) return null;
        if (is_self_closing(xml, start, tag_end)) {
            return {
                inner_start: tag_end + 1,
                inner_end: tag_end + 1,
                self_closing: true,
                element_start: start,
                element_end: tag_end + 1,
            };
        }
        const end_tag = end_tag_after(xml, 'sheetData', tag_end, ignorable);
        if (end_tag === null) return null;
        const [close, after_close] = end_tag;
        return {
            inner_start: tag_end + 1,
            inner_end: close,
            self_closing: false,
            element_start: start,
            element_end: after_close,
        };
    }
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
): string {
    // The live one: widening a commented-out `<dimension>` left the real extent
    // stale, which is what `<dimension>` is maintained here to prevent.
    const found = live_tags(
        xml,
        'dimension',
        0,
        xml.length,
        ignorable_ranges(xml, 0, xml.length),
    ).next();
    if (found.done) return xml;
    const [start, open_tag] = found.value;
    const tag_end = start + open_tag.length - 1;
    const m = /\bref="([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?"/.exec(open_tag);
    if (!m) return xml;
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
    ) return xml;
    const ref = `${col_index_to_letter(start_col)}${start_row + 1}:${col_index_to_letter(end_col)}${end_row + 1}`;
    const replaced = open_tag.replace(/\bref="[^"]*"/, `ref="${ref}"`);
    return xml.slice(0, start) + replaced + xml.slice(tag_end + 1);
}
