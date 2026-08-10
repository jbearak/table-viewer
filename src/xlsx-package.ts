import CFB from 'cfb';
import { apply_cell_edits, formula_count, widen_dimension, type XlsxCellEdit } from './xlsx-cell-write';
import { is_date_format } from './spreadsheet-format';
import { decode_xml } from './parse-xlsx';
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

/** Resolve `sheet_index` (workbook order) to its worksheet part path, e.g. `xl/worksheets/sheet3.xml`. */
function worksheet_part_path(cfb_file: ReturnType<typeof CFB.read>, sheet_index: number): string | null {
    const wb = read_part_text(cfb_file, '/xl/workbook.xml');
    const rels = read_part_text(cfb_file, '/xl/_rels/workbook.xml.rels');
    if (!wb || !rels) return null;

    // Indexed exactly as the reader indexes them, or `sheet_index` names a
    // different worksheet here than the one the user was looking at — a valid
    // file, silently wrong. So: skip unnamed `<sheet>` entries, and resolve only
    // through worksheet relationships, which is what drops chartsheets and
    // dialogsheets from the numbering on both sides.
    const worksheet_targets = new Map<string, string>();
    for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
        const type = /\bType="([^"]*)"/.exec(m[0]);
        if (!type?.[1].endsWith('/worksheet')) continue;
        const id = /\bId="([^"]*)"/.exec(m[0]);
        const target = /\bTarget="([^"]*)"/.exec(m[0]);
        if (!id || !target) continue;
        worksheet_targets.set(
            id[1],
            target[1].startsWith('/') ? target[1].slice(1) : `xl/${target[1]}`,
        );
    }

    const rel_ids: string[] = [];
    for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
        if (!/\bname="/.test(m[0])) continue;
        const id = /\br:[iI]d="([^"]*)"/.exec(m[0]);
        const rel_id = id ? id[1] : '';
        if (!worksheet_targets.has(rel_id)) continue;
        rel_ids.push(rel_id);
    }
    const rel_id = rel_ids[sheet_index];
    return rel_id ? worksheet_targets.get(rel_id) ?? null : null;
}

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

/** A leading `[>=100]`-style condition, if the section carries one. */
const CONDITION_RE = /^\s*\[\s*(<=|>=|<>|<|>|=)\s*(-?[\d.]+(?:[eE][+-]?\d+)?)\s*\]/;

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

    const format_map = new Map<number, string>();
    const num_fmts = /<numFmts\b[^>]*>([\s\S]*?)<\/numFmts>/.exec(xml);
    if (num_fmts) {
        for (const m of num_fmts[1].matchAll(/<numFmt\b[^>]*>/g)) {
            const id = /\bnumFmtId="(\d+)"/.exec(m[0]);
            const code = /\bformatCode="([^"]*)"/.exec(m[0]);
            // Decoded before anything reads it: `formatCode` is an XML attribute, so
            // a perfectly ordinary format like `0 "&"` is stored as
            // `0 &quot;&amp;&quot;` — and `SSF.is_date` says *true* of that escaped
            // text and false of what it means. A cell under it would take a typed
            // date as a serial and show the user a five-digit number.
            if (id && code) format_map.set(Number(id[1]), decode_xml(code[1]));
        }
    }

    const xfs: XfEntry[] = [];
    const cell_xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml);
    if (cell_xfs) {
        for (const m of cell_xfs[1].matchAll(/<xf\b[^>]*>/g)) {
            const num_fmt_id = /\bnumFmtId="(\d+)"/.exec(m[0]);
            const font_id = /\bfontId="(\d+)"/.exec(m[0]);
            xfs.push({
                font_index: font_id ? Number(font_id[1]) : 0,
                format_index: num_fmt_id ? Number(num_fmt_id[1]) : 0,
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

function read_datemode(cfb_file: ReturnType<typeof CFB.read>): DateMode {
    const wb = read_part_text(cfb_file, '/xl/workbook.xml');
    if (!wb) return 0;
    const m = /<workbookPr\b[^>]*>/.exec(wb);
    if (!m) return 0;
    const d = /\bdate1904="([^"]*)"/.exec(m[0]);
    return d && (d[1] === '1' || d[1] === 'true') ? 1 : 0;
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

    const part = worksheet_part_path(cfb_file, sheet_index);
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

function escape_regexp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Drop a part's `<Override>` from `[Content_Types].xml` after deleting the part.
 *
 * Both spellings of an empty element: XML lets `<Override .../>` be written
 * `<Override ...></Override>` — or, pretty-printed, with whitespace between the
 * halves. Matching only the self-closing form would leave a content-type override
 * naming a part that is no longer in the package — exactly the inconsistency Excel
 * offers to repair.
 */
function remove_content_type_override(cfb_file: ReturnType<typeof CFB.read>, part_name: string): void {
    const xml = read_part_text(cfb_file, '/[Content_Types].xml');
    if (!xml) return;
    const re = new RegExp(
        `<Override\\b[^>]*PartName="${escape_regexp(part_name)}"[^>]*(?:/>|>\\s*</Override>)`,
        'g',
    );
    const stripped = xml.replace(re, '');
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
    let stripped = xml;
    // Self-closing or paired: see `remove_content_type_override`. A relationship
    // left pointing at a deleted part is the other half of the same broken package.
    // The `\s*` covers a pretty-printed package, where the two halves of an empty
    // element sit on separate lines.
    for (const m of xml.matchAll(/<Relationship\b[^>]*(?:\/>|>\s*<\/Relationship>)/g)) {
        const target = /\bTarget="([^"]*)"/.exec(m[0]);
        if (!target) continue;
        const resolved = target[1].startsWith('/')
            ? target[1].slice(1)
            : `xl/${target[1]}`;
        if (resolved !== wanted) continue;
        stripped = stripped.replace(m[0], '');
    }
    if (stripped !== xml) write_part_text(cfb_file, '/xl/_rels/workbook.xml.rels', stripped);
}
