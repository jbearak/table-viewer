import CFB from 'cfb';
import {
    apply_cell_edits,
    element_close,
    element_content,
    formula_count,
    live_tags_in,
    widen_dimension,
    type XlsxCellEdit,
} from './xlsx-cell-write';
import { is_date_format } from './spreadsheet-format';
import { decode_xml, resolve_part_path, worksheet_part_paths } from './parse-xlsx';
import type { XfEntry, DateMode } from './spreadsheet-format';

/**
 * Package-level (.xlsx container) side of `putexcel`-style saving.
 *
 * We reuse the `cfb` dependency already present for reading rather than adding a
 * writer library. That choice was made empirically, not by reputation: round-
 * tripping our fixtures and `docs/examples/garden-cafe-sample.xlsx` through
 * `CFB.read` → `CFB.write` reproduced every part byte-identically, and a mutation
 * test (rewrite one `<c>`, leave everything else) produced a zip that `unzip -t`
 * accepts with `xl/styles.xml` untouched. Every deserialize/re-serialize library
 * we looked at (ExcelJS, xlsx-populate, SheetJS write) instead rebuilds parts it
 * models and drops those it doesn't. Here the parts we never touch are never even
 * parsed, so charts, pivot tables, conditional formatting and macros survive by
 * construction — the strongest preservation guarantee available, and the one the
 * `putexcel` requirement actually asks for.
 */

function read_part_text(cfb_file: ReturnType<typeof CFB.read>, path: string): string | null {
    const entry = CFB.find(cfb_file, path);
    if (!entry?.content) return null;
    return Buffer.from(entry.content as Uint8Array).toString('utf8');
}

function write_part_text(cfb_file: ReturnType<typeof CFB.read>, path: string, text: string): boolean {
    const entry = CFB.find(cfb_file, path);
    if (!entry) return false;
    const bytes = Buffer.from(text, 'utf8');
    entry.content = bytes;
    // `size` is not derived from `content` on write, so both must be set or the
    // emitted zip declares a stale length and readers truncate the part.
    entry.size = bytes.length;
    return true;
}

/**
 * Split a number format into its sections.
 *
 * A `;` inside a quoted literal, an escape, or a bracketed condition/colour is not
 * a section break, so this cannot be a `split(';')`: `"a;b";0` is one section, and
 * cutting it in half would leave a fragment that classifies as anything at all.
 */
function format_sections(code: string): string[] {
    const out: string[] = [];
    let quoted = false;
    let bracket = 0;
    let start = 0;
    for (let i = 0; i < code.length; i += 1) {
        const ch = code[i];
        if (ch === '\\') { i += 1; continue; }
        if (ch === '"') { quoted = !quoted; continue; }
        if (quoted) continue;
        if (ch === '[') bracket += 1;
        else if (ch === ']') bracket = Math.max(0, bracket - 1);
        else if (ch === ';' && bracket === 0) {
            out.push(code.slice(start, i));
            start = i + 1;
        }
    }
    out.push(code.slice(start));
    return out;
}

/**
 * A `[>=100]`-style condition, if the section carries one.
 *
 * Not anchored to the very start: a section may carry a colour or a locale
 * bracket ahead of its condition (`[Red][>50000]yyyy-mm-dd`), and requiring the
 * condition to come first made those read as unconditional — which then took the
 * positive/negative/zero path and picked the wrong section entirely.
 *
 * The bound's sign may be written explicitly: `[>+50000]` is the same condition as
 * `[>50000]`. Accepting only a leading `-` made the format read as unconditional
 * for the same reason and with the same consequence — the date section was picked
 * for a value the cell will not display as a date, so a typed date went in as a
 * serial the user then sees as `45306`.
 */
const CONDITION_RE = /^\s*(?:\[(?![<>=])[^\]]*\]\s*)*\[\s*(<=|>=|<>|<|>|=)\s*([+-]?[\d.]+(?:[eE][+-]?\d+)?)\s*\]/;

function condition_holds(section: string, value: number): boolean | null {
    const m = CONDITION_RE.exec(section);
    if (!m) return null;
    const bound = Number(m[2]);
    if (!Number.isFinite(bound)) return null;
    switch (m[1]) {
        case '<': return value < bound;
        case '>': return value > bound;
        case '<=': return value <= bound;
        case '>=': return value >= bound;
        case '=': return value === bound;
        default: return value !== bound;
    }
}

/**
 * The section of `code` that `value` will actually be displayed by.
 *
 * Sections are ordinarily `positive;negative;zero;text`, so a positive serial
 * takes the first — but a section may instead carry its own condition
 * (`[>50000]yyyy-mm-dd;0`), and then Excel uses the first condition that holds and
 * the last section as the fallback. Getting this wrong is not cosmetic: the writer
 * asks whether a typed date will *render* as a date, and both directions corrupt.
 * Assuming section one, `[>50000]0;yyyy-mm-dd` stored an inline string where the
 * cell would have shown a date, and `[>50000]yyyy-mm-dd;0` stored a serial the
 * cell then displayed as `45306`.
 */
function section_for_value(code: string, value: number): string {
    const sections = format_sections(code);
    if (sections.length === 1) return sections[0];
    const conditional = sections.some((section) => CONDITION_RE.test(section));
    if (!conditional) {
        if (value > 0) return sections[0];
        if (value < 0) return sections[1] ?? sections[0];
        return sections[2] ?? sections[0];
    }
    // The text section never applies to a number, and a trailing one would
    // otherwise be picked up as the fallback below.
    const numeric = sections.length === 4 ? sections.slice(0, 3) : sections;
    for (const section of numeric) {
        const holds = condition_holds(section, value);
        if (holds === true) return section;
        if (holds === null) return section;
    }
    return numeric[numeric.length - 1];
}

/** Parse just enough of `xl/styles.xml` to answer "is this style index a date format?". */
function read_style_date_predicate(
    cfb_file: ReturnType<typeof CFB.read>,
): (xf_index: number, serial: number) => boolean {
    const xml = read_part_text(cfb_file, '/xl/styles.xml');
    if (!xml) return () => false;

    // `applyNumberFormat="0"` is deliberately not consulted. Excel reads it as
    // "inherit the format from `cellStyleXfs` instead of using my own
    // `numFmtId`", so honouring it here would be more faithful to the format —
    // but `is_date_format`, which the *reader* uses, ignores it too. Teaching
    // only the writer about it would make the two disagree about whether a cell
    // is a date, which is a worse failure than the display quirk it fixes: a
    // value written as a serial and read back as text. Both sides have to change
    // together, and that is a reader change this branch does not make.
    //
    // Quote-aware throughout, like the sheet enumeration above: a `>` inside a
    // quoted attribute value is legal XML, so `[^>]*` cut both the `<numFmts>`
    // opening tag and the `<numFmt>` entries short. A format code as ordinary as
    // `yyyy>mm` then went unread, its date style was invisible here, and a typed
    // date was stored as an inline string under a format that renders dates.
    const format_map = new Map<number, string>();
    const num_fmts = element_content(xml, 'numFmts');
    if (num_fmts !== null) {
        for (const [, tag] of live_tags_in(num_fmts, 'numFmt')) {
            const id = numeric_attr(tag, 'numFmtId');
            const code = attr(tag, 'formatCode');
            // `attr` decodes, and that matters most here: `formatCode` is an XML
            // attribute, so a perfectly ordinary format like `0 "&"` is stored as
            // `0 &quot;&amp;&quot;` — and `SSF.is_date` says *true* of that escaped
            // text and false of what it means. A cell under it would take a typed
            // date as a serial and show the user a five-digit number.
            if (id !== null && code) format_map.set(id, code);
        }
    }

    const xfs: XfEntry[] = [];
    const cell_xfs = element_content(xml, 'cellXfs');
    if (cell_xfs !== null) {
        for (const [, tag] of live_tags_in(cell_xfs, 'xf')) {
            xfs.push({
                font_index: numeric_attr(tag, 'fontId') ?? 0,
                format_index: numeric_attr(tag, 'numFmtId') ?? 0,
            });
        }
    }

    // Narrowed to the section the serial about to be written will be *displayed*
    // by. `SSF.is_date` says true if any section of a format is a date, so
    // `0;0;yyyy-mm-dd` counted and a typed date was stored as a serial the cell
    // then showed as `45306`. Which section applies depends on the value — plain
    // formats split positive/negative/zero, and a conditional one
    // (`[>50000]yyyy-mm-dd;0`) picks by its own test — so the predicate takes the
    // candidate serial rather than answering for the format as a whole. Only the
    // reading side wants that whole-format answer.
    return (xf_index: number, serial: number) => {
        const scoped = new Map<number, string>();
        for (const [id, code] of format_map) scoped.set(id, section_for_value(code, serial));
        return is_date_format(xf_index, xfs, scoped);
    };
}

/**
 * The decoded value of `tag`'s `name` attribute, or null if it has none.
 *
 * Both quote styles, because XML allows either and calling one of them malformed
 * is this module's own invention: `formatCode='yyyy-mm-dd'` is an ordinary date
 * format, and reading only `"…"` left it unseen, so the style did not look like a
 * date and a typed date was written as text. The worksheet parts get away with a
 * double-quote-only scan because `assert_writable_sheet_data` refuses anything it
 * cannot read that way; these parts are read, never spliced, and have no such
 * guard — so they have to actually handle it.
 *
 * Decoded on the way out for the same reason every other value here is.
 *
 * `name` is spliced into the pattern, so a caller may pass a fragment — `r:[iI]d`
 * for the relationship reference, which is spelled both ways in the wild. Every
 * caller here is a literal in this file; none is user input.
 */
function attr(tag: string, name: string): string | null {
    const m = new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)')`).exec(tag);
    if (!m) return null;
    return decode_xml(m[1] ?? m[2]);
}

/**
 * A non-negative integer attribute of `tag`, or null if absent or not one.
 *
 * The pattern cannot be `"(\d+)"` directly: an encoded digit is still a digit,
 * so `numFmtId="16&#52;"` is `164` — a custom date format — and matching the raw
 * text failed, left the index at its `0` default, and stored a typed date as an
 * inline string under a format that renders dates. Decoding first and validating
 * after also rejects the encoded spelling of a genuinely malformed value rather
 * than reading it as `NaN`.
 */
function numeric_attr(tag: string, name: string): number | null {
    const text = attr(tag, name);
    return text !== null && /^\d+$/.test(text) ? Number(text) : null;
}

function read_datemode(cfb_file: ReturnType<typeof CFB.read>): DateMode {
    const wb = read_part_text(cfb_file, '/xl/workbook.xml');
    if (!wb) return 0;
    // Quote-aware for the same reason: `[^>]*` cuts `<workbookPr>` at a legal `>`
    // in an earlier attribute value, and the fragment no longer carries
    // `date1904`. The two epochs are 1462 days apart, so misreading the mode is
    // not a rounding error — it writes a date four years off.
    const [, m] = live_tags_in(wb, 'workbookPr').next().value ?? [];
    if (m === undefined) return 0;
    // `attr` decodes and takes either quote style: `date1904="&#49;"` and
    // `date1904='1'` both mean 1904, and a raw double-quote-only compare saw
    // neither `1` nor `true` in either, falling back to the 1900 epoch. The two
    // epochs are 1462 days apart, so this writes a date four years off rather than
    // rounding one.
    const flag = attr(m, 'date1904');
    return flag === '1' || flag === 'true' ? 1 : 0;
}

/**
 * Rewrite one worksheet's cells inside an .xlsx, returning the new file bytes.
 *
 * `raw` must be the bytes we most recently verified against the file on disk —
 * the caller's TOCTOU checks establish that, and this function assumes it, since
 * splicing edits into stale bytes would resurrect content the user's edits were
 * never based on.
 */
export function write_xlsx_cell_edits(
    raw: Uint8Array,
    sheet_index: number,
    edits: readonly XlsxCellEdit[],
): Uint8Array {
    if (edits.length === 0) return raw;

    let cfb_file: ReturnType<typeof CFB.read>;
    try {
        cfb_file = CFB.read(raw, { type: 'buffer' });
    } catch {
        throw new Error('Not a valid .xlsx file');
    }

    // The reader's own enumeration, not a second one written to match it: see
    // `worksheet_part_paths`. `sheet_index` is the index of the worksheet the user
    // was looking at, so anything that numbers differently here saves into a
    // different sheet — valid file, wrong data, no error.
    const part = worksheet_part_paths(raw)[sheet_index];
    if (!part) throw new Error('Could not locate the worksheet to save');

    const sheet_xml = read_part_text(cfb_file, `/${part}`);
    if (sheet_xml === null) throw new Error('Could not read the worksheet to save');

    const is_date_style = read_style_date_predicate(cfb_file);
    const datemode = read_datemode(cfb_file);

    let updated = apply_cell_edits(sheet_xml, edits, { datemode, is_date_style });

    let min_row = Infinity, min_col = Infinity, max_row = 0, max_col = 0;
    for (const e of edits) {
        if (e.row < min_row) min_row = e.row;
        if (e.col < min_col) min_col = e.col;
        if (e.row > max_row) max_row = e.row;
        if (e.col > max_col) max_col = e.col;
    }
    updated = widen_dimension(updated, min_row, min_col, max_row, max_col);

    if (!write_part_text(cfb_file, `/${part}`, updated)) {
        throw new Error('Could not update the worksheet to save');
    }

    // `xl/calcChain.xml` caches the order Excel recalculates formulas in. Writing
    // a literal over a formula cell leaves a chain entry pointing at a cell that
    // no longer has an `<f>`. Excel treats a stale chain as a repairable
    // inconsistency and may prompt on open, so drop the part: it is a pure cache,
    // Excel rebuilds it on the next recalculation, and its absence is valid (many
    // workbooks, including our sample, ship without one).
    //
    // Only when a formula was actually dropped, though. Deleting it on every save
    // would break the guarantee this whole module exists for — an untouched part
    // surviving byte-identically — for the ordinary case of editing a plain cell.
    if (formula_count(updated) < formula_count(sheet_xml)) {
        remove_part(cfb_file, '/xl/calcChain.xml');
    }

    // `xl/sharedStrings.xml` is deliberately not touched, including its `count`.
    // Writing over a `t="s"` cell drops one *reference* to the table, so `count`
    // (total references) can read high afterwards while `uniqueCount` (entries)
    // stays exact — no `<si>` is ever added or removed here, since values are
    // written inline. Excel and openpyxl both index by position and ignore the
    // tally; rewriting the part to correct it would give up the byte-identity
    // guarantee for every string edit, in exchange for a number nothing reads.

    const out = CFB.write(cfb_file, { type: 'buffer', fileType: 'zip', compression: true });
    return out instanceof Uint8Array ? out : new Uint8Array(out as ArrayBufferLike);
}

/**
 * Remove a part and every reference to it: the container entry, the content-type
 * override, and the workbook relationship.
 *
 * All three, because a package that still points at a part it no longer contains
 * is exactly the corruption the removal was meant to avoid — `cfb_del` is a
 * container operation and knows nothing about OOXML's reference graph.
 */
function remove_part(cfb_file: ReturnType<typeof CFB.read>, part_path: string): void {
    if (!CFB.find(cfb_file, part_path)) return;
    try {
        CFB.utils.cfb_del(cfb_file, part_path);
        remove_content_type_override(cfb_file, part_path);
        remove_workbook_relationship(cfb_file, part_path);
    } catch {
        // A workbook we cannot fully detach the part from is still savable; the
        // worst case is Excel offering to repair the recalculation cache.
    }
}

/**
 * Delete every live empty `<name …>` element that `wanted` selects.
 *
 * Both spellings: XML lets an empty element be written `<X .../>` or
 * `<X ...></X>` — pretty-printed, with whitespace between the halves — and
 * writers in the wild use both. Spans are removed back to front so the earlier
 * offsets stay valid. An element that actually has content is left alone rather
 * than half-deleted; both parts this serves are attribute-only by schema.
 */
function remove_elements(xml: string, name: string, wanted: (tag: string) => boolean): string {
    const spans: Array<[number, number]> = [];
    for (const [at, tag] of live_tags_in(xml, name)) {
        if (!wanted(tag)) continue;
        const inner_start = at + tag.length;
        if (tag.endsWith('/>')) {
            spans.push([at, inner_start]);
            continue;
        }
        // Located comment-aware, not by `indexOf`: `</Override>` written inside a
        // comment is text, and mistaking it for the real end tag made the element
        // look like it had content, so the removal declined and the package kept a
        // reference to a part it no longer contains.
        const closed = element_close(xml, name, inner_start);
        if (closed === null || /\S/.test(closed.inner)) continue;
        spans.push([at, closed.end]);
    }
    let out = xml;
    for (const [start, end] of spans.reverse()) out = out.slice(0, start) + out.slice(end);
    return out;
}

/**
 * Drop a part's `<Override>` from `[Content_Types].xml` after deleting the part.
 *
 * Located quote-aware, then removed by span. A `[^>]*` match cut the tag at a
 * legal `>` inside an earlier attribute value, so an `<Override>` carrying one
 * never matched at all and the package kept a content type naming a part it no
 * longer contains — exactly the inconsistency Excel offers to repair, and the one
 * this removal exists to prevent.
 */
function remove_content_type_override(cfb_file: ReturnType<typeof CFB.read>, part_name: string): void {
    const xml = read_part_text(cfb_file, '/[Content_Types].xml');
    if (!xml) return;
    const stripped = remove_elements(
        xml,
        'Override',
        // `attr` decodes, as in `worksheet_part_path`: an encoded spelling of the
        // same part name is the same part, and missing it leaves an override for a
        // part that is no longer in the package.
        (tag) => attr(tag, 'PartName') === part_name,
    );
    if (stripped !== xml) write_part_text(cfb_file, '/[Content_Types].xml', stripped);
}

/**
 * Drop the workbook relationship targeting a deleted part.
 *
 * Targets are matched after resolution, since the same part is spelled both
 * `calcChain.xml` (relative to `xl/`) and `/xl/calcChain.xml` in the wild.
 */
function remove_workbook_relationship(
    cfb_file: ReturnType<typeof CFB.read>,
    part_path: string,
): void {
    const xml = read_part_text(cfb_file, '/xl/_rels/workbook.xml.rels');
    if (!xml) return;
    const wanted = part_path.replace(/^\//, '');
    // See `remove_content_type_override`: same quote-aware location, and a
    // relationship left pointing at a deleted part is the other half of the same
    // broken package.
    const stripped = remove_elements(xml, 'Relationship', (tag) => {
        const path = attr(tag, 'Target');
        if (path === null) return false;
        const resolved = resolve_part_path(path);
        return resolved === wanted;
    });
    if (stripped !== xml) write_part_text(cfb_file, '/xl/_rels/workbook.xml.rels', stripped);
}
