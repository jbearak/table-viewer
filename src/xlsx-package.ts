import CFB from 'cfb';
import { apply_cell_edits, formula_count, widen_dimension, type XlsxCellEdit } from './xlsx-cell-write';
import { is_date_format } from './spreadsheet-format';
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

/** Parse just enough of `xl/styles.xml` to answer "is this style index a date format?". */
function read_style_date_predicate(cfb_file: ReturnType<typeof CFB.read>): (xf_index: number) => boolean {
    const xml = read_part_text(cfb_file, '/xl/styles.xml');
    if (!xml) return () => false;

    const format_map = new Map<number, string>();
    const num_fmts = /<numFmts\b[^>]*>([\s\S]*?)<\/numFmts>/.exec(xml);
    if (num_fmts) {
        for (const m of num_fmts[1].matchAll(/<numFmt\b[^>]*>/g)) {
            const id = /\bnumFmtId="(\d+)"/.exec(m[0]);
            const code = /\bformatCode="([^"]*)"/.exec(m[0]);
            if (id && code) format_map.set(Number(id[1]), code[1]);
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

    return (xf_index: number) => is_date_format(xf_index, xfs, format_map);
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

    let max_row = 0, max_col = 0;
    for (const e of edits) {
        if (e.row > max_row) max_row = e.row;
        if (e.col > max_col) max_col = e.col;
    }
    updated = widen_dimension(updated, max_row, max_col);

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

/** Drop a part's `<Override>` from `[Content_Types].xml` after deleting the part. */
function remove_content_type_override(cfb_file: ReturnType<typeof CFB.read>, part_name: string): void {
    const xml = read_part_text(cfb_file, '/[Content_Types].xml');
    if (!xml) return;
    const re = new RegExp(`<Override\\b[^>]*PartName="${escape_regexp(part_name)}"[^>]*/>`, 'g');
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
    for (const m of xml.matchAll(/<Relationship\b[^>]*\/>/g)) {
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
