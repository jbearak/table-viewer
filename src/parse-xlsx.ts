import CFB from 'cfb';
import {
    assert_safe_sheet_count,
    assert_safe_sheet_shape,
    create_workbook_budget,
    MAX_WORKBOOK_CELLS,
    type WorkbookBudget,
} from './spreadsheet-safety';
import {
    densify,
    make_streaming_sheet,
    working_has_formatting,
    type WorkingSet,
    type StreamingSheet,
    type StreamingWorkbook,
} from './data-source/cell-fill';
import { serial_to_iso, is_date_format, is_valid_excel_date_serial, format_value, get_style } from './spreadsheet-format';
import type { FontEntry, XfEntry, DateMode } from './spreadsheet-format';
import type { WorkbookData, SheetData, CellData, MergeRange } from './types';
import type { CellHyperlink, RichText } from './cell-content';
import {
    font_style_bits,
    font_to_style,
    FONT_STYLE_BITS_RANGE,
    parse_font_properties,
    parse_xlsx_string_item,
    resolve_rich_text_runs,
    type ParsedXlsxString,
} from './xlsx-rich-text';
import { parse_relationships, rels_path_for_part, type OoxmlRelationship } from './ooxml-relationships';

// The XML scanning primitives live in ./ooxml-xml so the rich-text and
// hyperlink parsers (and the writer) share the exact same scans.
import { decode_xml, get_attr, get_text, iter_elements } from './ooxml-xml';

// --- ZIP / Entry Access ---

function get_entry_text(cfb_file: ReturnType<typeof CFB.read>, path: string): string | null {
    const entry = CFB.find(cfb_file, path);
    if (!entry?.content) return null;
    return Buffer.from(entry.content).toString('utf8');
}

// --- Workbook Parsing ---

/**
 * A relationship `Target` resolved to a package path, without a leading slash.
 *
 * `.` and `..` segments are legal in a relative URI reference and mean what they do
 * anywhere else, so `./worksheets/sheet1.xml` names the same part as
 * `worksheets/sheet1.xml`. Concatenating without resolving them produced
 * `xl/./worksheets/sheet1.xml`, which matches no entry in the package — the reader
 * then displayed that worksheet as empty, and the save failed outright on a file
 * Excel opens perfectly well.
 *
 * Shared with the writer rather than duplicated there, which is how the two came to
 * disagree: the writer resolved the dot segment and the reader did not, so a save
 * would have spliced into a worksheet the user was shown as blank.
 */
export function resolve_part_path(target: string): string {
    const absolute = target.startsWith('/');
    const segments = (absolute ? target.slice(1) : `xl/${target}`).split('/');
    const out: string[] = [];
    for (const segment of segments) {
        if (segment === '.' || segment === '') continue;
        // A `..` that would climb above the package root has nowhere to go; dropping
        // it keeps the path inside the package rather than inventing a parent.
        if (segment === '..') { out.pop(); continue; }
        out.push(segment);
    }
    return out.join('/');
}

function parse_sheet_rels(cfb_file: ReturnType<typeof CFB.read>): Map<string, string> {
    const map = new Map<string, string>();
    const xml = get_entry_text(cfb_file, '/xl/_rels/workbook.xml.rels');
    if (!xml) return map;

    for (const [id, rel] of parse_relationships(xml)) {
        if (!rel.type.endsWith('/worksheet')) continue;
        map.set(id, resolve_part_path(rel.target));
    }

    return map;
}

/**
 * Worksheet part paths in the order this reader numbers the sheets — `xl/…`, no
 * leading slash — for the writer to resolve a sheet index against.
 *
 * Exported so the two sides cannot disagree. The writer had its own enumeration,
 * written to the same intent but not the same code, and every difference between
 * them was an edit written into a worksheet other than the one the user was
 * looking at. Two found that way: the writer read both quote styles where
 * `get_attr` reads only `"…"`, so a legally single-quoted `name` gave the two a
 * different sheet count; and the writer skipped `<sheet>` tags inside comments
 * where `iter_elements` counts them. Neither disagreement is a bug in the writer's
 * half — it is the more nearly correct one — but "correct" is not the requirement
 * here. Indexing identically is, and sharing one enumeration is the only way to
 * have it hold for the next difference nobody thought of.
 */
export function worksheet_part_paths_from_package(
    cfb_file: ReturnType<typeof CFB.read>,
): string[] {
    const rels = parse_sheet_rels(cfb_file);
    const workbook_xml = get_entry_text(cfb_file, '/xl/workbook.xml');
    if (!workbook_xml) return [];
    // `parse_xlsx` drops a sheet whose relationship does not resolve *before*
    // numbering the rest, so the filter belongs here too — see its own loop.
    return parse_workbook_xml(workbook_xml).sheets
        .map((sheet) => rels.get(sheet.rId))
        .filter((path): path is string => path !== undefined);
}

export function worksheet_part_paths(buffer: Uint8Array): string[] {
    return worksheet_part_paths_from_package(CFB.read(buffer, { type: 'buffer' }));
}

function parse_shared_strings(xml: string): ParsedXlsxString[] {
    const sst: ParsedXlsxString[] = [];
    iter_elements(xml, 'si', (_open, inner) => {
        sst.push(parse_xlsx_string_item(inner));
    });
    return sst;
}

/**
 * `xl/styles.xml` as this reader understands it.
 *
 * Exported for the writer, which used to parse the same part itself — quote-aware
 * and comment-aware where this scan is neither — and every difference between the
 * two was a cell stored under a format only one side agreed about. A commented-out
 * `<numFmt numFmtId="164" …/>` shadowing the live entry, or a legally
 * single-quoted `numFmtId='164'`, made a style a date here and a number there, so
 * a typed `2024-01-15` went in as the serial `45306` and that is what the grid
 * then showed. Being right about XML is not the requirement; agreeing with the
 * side that renders the result is, and one parse is the only way to have that
 * hold for the next difference nobody thought of.
 */
export function parse_styles(xml: string): { fonts: FontEntry[]; xfs: XfEntry[]; format_map: Map<number, string> } {
    const fonts: FontEntry[] = [];
    const xfs: XfEntry[] = [];
    const format_map = new Map<number, string>();

    // Parse custom number formats
    const num_fmts_section = get_text(xml, 'numFmts');
    if (num_fmts_section) {
        iter_elements(num_fmts_section, 'numFmt', (open_tag) => {
            const id = get_attr(open_tag, 'numFmtId');
            const code = get_attr(open_tag, 'formatCode');
            if (id && code) {
                format_map.set(parseInt(id, 10), code);
            }
        });
    }

    // Parse fonts
    const fonts_section = get_text(xml, 'fonts');
    if (fonts_section) {
        iter_elements(fonts_section, 'font', (_open, inner) => {
            // <font> and <rPr> share the same property tags, so both go
            // through the one decoder in xlsx-rich-text.ts.
            const style = parse_font_properties(inner);
            fonts.push({
                bold: style?.bold === true,
                italic: style?.italic === true,
                ...(style?.underline ? { underline: true as const } : {}),
                ...(style?.strikethrough ? { strikethrough: true as const } : {}),
            });
        });
    }

    // Parse cell style XFs (cellXfs)
    const cell_xfs_section = get_text(xml, 'cellXfs');
    if (cell_xfs_section) {
        iter_elements(cell_xfs_section, 'xf', (open_tag) => {
            const font_id = get_attr(open_tag, 'fontId');
            const num_fmt_id = get_attr(open_tag, 'numFmtId');
            xfs.push({
                font_index: font_id ? parseInt(font_id, 10) : 0,
                format_index: num_fmt_id ? parseInt(num_fmt_id, 10) : 0,
            });
        });
    }

    return { fonts, xfs, format_map };
}

/**
 * `xl/workbook.xml` as this reader understands it: the sheet list, in the order
 * this reader numbers them, and the date epoch.
 *
 * Exported alongside {@link parse_styles} and for the same reason. The writer's
 * own `workbookPr` scan skipped comments, so a commented `date1904="1"` left the
 * writer on the 1900 epoch while the reader used 1904 — and the two are 1462 days
 * apart, so a saved `2024-01-15` read back as `2028-01-16`.
 */
interface WorkbookSheetEntry {
    name: string;
    rId: string;
    worksheetId?: string;
}

export function parse_workbook_xml(xml: string): {
    sheets: WorkbookSheetEntry[];
    datemode: DateMode;
} {
    const sheets: WorkbookSheetEntry[] = [];

    iter_elements(xml, 'sheet', (open_tag) => {
        const name = get_attr(open_tag, 'name');
        // OOXML sheetId is stable for a worksheet within this workbook, including
        // rename and reorder, but is workbook-local. The edit session therefore
        // assumes continuity of the file at this path; a wholesale replacement by
        // an unrelated workbook that reuses the same sheetId has no persistent OOXML
        // workbook namespace available to distinguish it safely.
        const worksheetId = get_attr(open_tag, 'sheetId') ?? undefined;
        // The relationship ID can be r:id or r:Id — try both
        const rId = get_attr(open_tag, 'r:id') ?? get_attr(open_tag, 'r:Id') ?? '';
        if (name) {
            sheets.push({ name, rId, worksheetId });
        }
    });

    // A malformed workbook can reuse sheetId. Such an ID cannot identify either
    // worksheet, so remove it from every colliding entry and let the established
    // name fallback keep their edit stores and durable slots distinct.
    const worksheet_id_counts = new Map<string, number>();
    for (const { worksheetId } of sheets) {
        if (worksheetId === undefined) continue;
        worksheet_id_counts.set(
            worksheetId,
            (worksheet_id_counts.get(worksheetId) ?? 0) + 1,
        );
    }
    for (const sheet of sheets) {
        if (
            sheet.worksheetId !== undefined
            && (worksheet_id_counts.get(sheet.worksheetId) ?? 0) > 1
        ) delete sheet.worksheetId;
    }

    // Detect 1904 date system
    let datemode: DateMode = 0;
    iter_elements(xml, 'workbookPr', (open_tag) => {
        const d1904 = get_attr(open_tag, 'date1904');
        if (d1904 === '1' || d1904 === 'true') datemode = 1;
    });

    return { sheets, datemode };
}

// --- Worksheet Parsing ---

function parse_cell_ref(ref: string): { row: number; col: number } | null {
    const match = ref.match(/^([A-Z]+)(\d+)$/);
    if (!match) return null;
    return {
        col: col_letter_to_index(match[1]),
        row: parseInt(match[2], 10) - 1,
    };
}

function parse_dimension(xml: string): { row_count: number; col_count: number } | null {
    let result: { row_count: number; col_count: number } | null = null;
    iter_elements(xml, 'dimension', (open_tag) => {
        const ref = get_attr(open_tag, 'ref');
        if (!ref) return;
        const parts = ref.split(':');
        if (parts.length === 1) {
            // Single cell ref like "A1" — could be empty sheet
            if (!parse_cell_ref(parts[0])) return;
            result = { row_count: 0, col_count: 0 };
            return;
        }
        const start = parse_cell_ref(parts[0]);
        const end = parse_cell_ref(parts[1]);
        if (!start || !end) return;
        result = { row_count: end.row + 1, col_count: end.col + 1 };
    });
    return result;
}

/**
 * The sparse working set for one parsed worksheet, before densification.
 * Extends the shared {@link WorkingSet} shape (cells / merged_cells / dims) with
 * the per-sheet normalized merge ranges. The null/blank resolution rule, the
 * fill seam and the hasFormatting computation all live in `./data-source/cell-fill`.
 */
interface WorksheetWorking extends WorkingSet {
    merges: MergeRange[];
}

function parse_worksheet_core(
    xml: string,
    sst: ParsedXlsxString[],
    xfs: XfEntry[],
    fonts: FontEntry[],
    format_map: Map<number, string>,
    datemode: DateMode,
    budget: WorkbookBudget,
    sheet_rels: Map<string, OoxmlRelationship>,
): WorksheetWorking {
    // Rich-run resolution cache: one shared string may be referenced by many
    // cells, but binding (run inheritance) depends only on the cell font, so
    // (sst index, font-style bits) fully determines the resolved RichText.
    // Cache hits also mean referencing cells share ONE RichText by reference,
    // which the columnar store's sparse extras map preserves. `null` marks a
    // cached "resolves to plain" so misses need a single get().
    const rich_cache = new Map<number, RichText | null>();
    const resolve_shared_rich = (idx: number, font: FontEntry): RichText | undefined => {
        const parsed = sst[idx];
        if (typeof parsed === 'string') return undefined;
        const key = idx * FONT_STYLE_BITS_RANGE + font_style_bits(font);
        const cached = rich_cache.get(key);
        if (cached !== undefined) return cached ?? undefined;
        const rich = resolve_rich_text_runs(parsed, font_to_style(font));
        rich_cache.set(key, rich ?? null);
        return rich;
    };
    // Parse dimension and validate row/col limits early before materializing cells
    const dim = parse_dimension(xml);
    if (dim && dim.row_count > 0 && dim.col_count > 0) {
        // Check row/col limits without mutating budget — full budget check happens after parsing
        assert_safe_sheet_shape({ total_cells: 0 }, dim.row_count, dim.col_count, 0);
    }

    // Parse merge cells
    const merges: MergeRange[] = [];
    const merge_cells_section = get_text(xml, 'mergeCells');
    if (merge_cells_section) {
        iter_elements(merge_cells_section, 'mergeCell', (open_tag) => {
            const ref = get_attr(open_tag, 'ref');
            if (!ref) return;
            const range = parse_merge_range(ref);
            if (range) merges.push(range);
        });
    }

    // Build merged cells set — deferred until after safety validation
    const merged_cells = new Set<string>();

    // Parse cells
    const cells = new Map<string, CellData>();
    let max_row = 0;
    let max_col = 0;

    const sheet_data = get_text(xml, 'sheetData');
    if (sheet_data) {
        iter_elements(sheet_data, 'row', (_row_open, row_inner) => {
            iter_elements(row_inner, 'c', (c_open, c_inner) => {
                const ref = get_attr(c_open, 'r');
                if (!ref) return;
                const cell_ref = parse_cell_ref(ref);
                if (!cell_ref) return;
                const { row, col } = cell_ref;
                if (row + 1 > max_row) max_row = row + 1;
                if (col + 1 > max_col) max_col = col + 1;

                const t = get_attr(c_open, 't');
                const s = get_attr(c_open, 's');
                const xf_index = s ? parseInt(s, 10) : 0;
                const v_text = get_text(c_inner, 'v');
                const style = get_style(xf_index, xfs, fonts);

                let raw: string | number | boolean | null = null;
                let formatted = '';
                let rawType: CellData['rawType'];
                let richText: RichText | undefined;

                if (t === 's') {
                    // Shared string (already decoded during SST parsing)
                    const idx = v_text !== null ? parseInt(v_text, 10) : -1;
                    if (idx >= 0 && idx < sst.length) {
                        const entry = sst[idx];
                        raw = typeof entry === 'string' ? entry : entry.text;
                        richText = resolve_shared_rich(idx, style);
                    }
                    formatted = raw !== null ? String(raw) : '';
                } else if (t === 'b') {
                    // Boolean
                    raw = v_text === '1';
                    formatted = raw ? 'TRUE' : 'FALSE';
                } else if (t === 'e') {
                    // Error
                    raw = v_text !== null ? decode_xml(v_text) : null;
                    formatted = raw !== null ? String(raw) : '';
                } else if (t === 'str') {
                    // Inline formula string result
                    raw = v_text !== null ? decode_xml(v_text) : null;
                    formatted = raw !== null ? String(raw) : '';
                } else if (t === 'inlineStr') {
                    // Inline string — same rich-run parsing as shared strings.
                    // Note the legacy plain path returned null for an <is> with
                    // no <t>; parse_xlsx_string_item returns '' there, and an
                    // empty string densifies identically to a blank cell.
                    const is_elem = get_text(c_inner, 'is');
                    if (is_elem) {
                        const parsed = parse_xlsx_string_item(is_elem);
                        if (typeof parsed === 'string') {
                            raw = parsed;
                        } else {
                            raw = parsed.text;
                            richText = resolve_rich_text_runs(parsed, font_to_style(style));
                        }
                    }
                    formatted = raw !== null ? String(raw) : '';
                } else if (t === 'd') {
                    // ISO 8601 date cell
                    if (v_text !== null && v_text !== '') {
                        raw = v_text;
                        formatted = v_text;
                        rawType = 'date';
                    }
                } else {
                    // Numeric (default) — includes dates, formulas with numeric results
                    if (v_text !== null && v_text !== '') {
                        const num = Number(v_text);
                        if (v_text.trim() === '' || !Number.isFinite(num)) {
                            // non-numeric or infinite — leave as null
                        } else if (is_date_format(xf_index, xfs, format_map)) {
                            raw = is_valid_excel_date_serial(num, datemode)
                                ? serial_to_iso(num, datemode)
                                : num;
                            if (typeof raw === 'string') rawType = 'date';
                            formatted = format_value(num, xf_index, xfs, format_map, datemode);
                        } else {
                            raw = num;
                            formatted = format_value(num, xf_index, xfs, format_map, datemode);
                        }
                    }
                }

                const cell: CellData = { raw, formatted, rawType, ...style };
                if (richText) cell.richText = richText;
                cells.set(`${row}:${col}`, cell);
                // Defensive pre-check: bound the in-progress cell map during
                // streaming parse so a single pathological sheet can't exhaust
                // memory before the cumulative budget is enforced below. A lone
                // sheet can never legitimately exceed the whole-workbook cell
                // cap, so MAX_WORKBOOK_CELLS is the correct ceiling here; the
                // real per-workbook budget is assert_safe_sheet_shape() (line ~406).
                if (cells.size > MAX_WORKBOOK_CELLS) {
                    throw new Error(
                        `Spreadsheet has too many cells to open safely (max ${MAX_WORKBOOK_CELLS.toLocaleString()})`
                    );
                }
            });
        });
    }

    // Attach hyperlinks. Excel's model is one link per cell; refs that are
    // ranges are skipped (deferred), and a link on a cell with no data entry
    // synthesizes a blank cell so the link still renders and extends the grid.
    const hyperlinks_section = get_text(xml, 'hyperlinks');
    if (hyperlinks_section) {
        iter_elements(hyperlinks_section, 'hyperlink', (open_tag) => {
            const ref = get_attr(open_tag, 'ref');
            if (!ref) return;
            const cell_ref = parse_cell_ref(ref);
            if (!cell_ref) return; // range ref or malformed — skipped in v1
            const tooltip = get_attr(open_tag, 'tooltip') ?? undefined;
            let hyperlink: CellHyperlink;
            const r_id = get_attr(open_tag, 'r:id');
            if (r_id !== null) {
                const rel = sheet_rels.get(r_id);
                // Untrusted input: only follow actual hyperlink relationships
                // (an r:id could point at an image/OLE rel), and only external
                // ones — a package-internal hyperlink target is malformed.
                if (!rel || !rel.external || !rel.type.endsWith('/hyperlink')) return;
                // The optional location attribute is a fragment within the
                // external target (e.g. a bookmark); append it Excel-style.
                const location = get_attr(open_tag, 'location');
                const target = location ? `${rel.target}#${location}` : rel.target;
                hyperlink = { kind: 'external', target, ...(tooltip !== undefined ? { tooltip } : {}) };
            } else {
                const location = get_attr(open_tag, 'location');
                if (!location) return;
                hyperlink = { kind: 'internal', location, ...(tooltip !== undefined ? { tooltip } : {}) };
            }
            const { row, col } = cell_ref;
            const key = `${row}:${col}`;
            const existing = cells.get(key);
            if (existing) {
                existing.hyperlink = hyperlink;
            } else {
                // Same in-progress ceiling as the cell loop above — hyperlink
                // refs are attacker-controlled and must not bypass it.
                if (cells.size >= MAX_WORKBOOK_CELLS) {
                    throw new Error(
                        `Spreadsheet has too many cells to open safely (max ${MAX_WORKBOOK_CELLS.toLocaleString()})`
                    );
                }
                // The optional display attribute is the link's text when the
                // cell has no value of its own.
                const display = get_attr(open_tag, 'display');
                const cell: CellData = display !== null && display !== ''
                    ? { raw: display, formatted: display, bold: false, italic: false, hyperlink }
                    : { raw: null, formatted: '', bold: false, italic: false, hyperlink };
                cells.set(key, cell);
                if (row + 1 > max_row) max_row = row + 1;
                if (col + 1 > max_col) max_col = col + 1;
            }
        });
    }

    // If no cells were found, the sheet is empty regardless of what dimension says
    if (cells.size === 0) {
        return { cells, merged_cells, merges: [], row_count: 0, col_count: 0 };
    }

    // Use dimension if available and non-degenerate, otherwise fall back to observed max
    const row_count = dim && dim.row_count > 0 ? Math.max(dim.row_count, max_row) : max_row;
    const col_count = dim && dim.col_count > 0 ? Math.max(dim.col_count, max_col) : max_col;

    // Validate final shape (catches cells beyond dimension and merge count)
    assert_safe_sheet_shape(budget, row_count, col_count, merges.length);

    // Expand merges into merged_cells set, clamping to validated bounds
    const normalized_merges: MergeRange[] = [];
    for (const m of merges) {
        if (m.startRow >= row_count || m.startCol >= col_count) continue;
        if (m.startRow > m.endRow || m.startCol > m.endCol) continue;
        if (m.endRow < 0 || m.endCol < 0) continue;

        const sr = Math.max(0, m.startRow);
        const er = Math.min(row_count - 1, m.endRow);
        const sc = Math.max(0, m.startCol);
        const ec = Math.min(col_count - 1, m.endCol);
        if (sr > er || sc > ec) continue;

        normalized_merges.push({ startRow: sr, startCol: sc, endRow: er, endCol: ec });
        for (let r = sr; r <= er; r++) {
            for (let c = sc; c <= ec; c++) {
                if (r === sr && c === sc) continue;
                merged_cells.add(`${r}:${c}`);
            }
        }
    }

    return { cells, merged_cells, merges: normalized_merges, row_count, col_count };
}

// --- Merge Range / Column Helpers ---

function parse_merge_range(range_str: string): MergeRange | null {
    const match = range_str.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
    if (!match) return null;

    return {
        startCol: col_letter_to_index(match[1]),
        startRow: parseInt(match[2], 10) - 1,
        endCol: col_letter_to_index(match[3]),
        endRow: parseInt(match[4], 10) - 1,
    };
}

function col_letter_to_index(letters: string): number {
    let index = 0;
    for (let i = 0; i < letters.length; i++) {
        index = index * 26 + (letters.charCodeAt(i) - 64);
    }
    return index - 1;
}

// --- Public API ---

/**
 * The parsed .xlsx container plus the global tables every worksheet needs:
 * sheet entries (name + relationship id), the rels map, shared strings, styles
 * (fonts/xfs/format_map), date system and a fresh per-workbook cell budget.
 * Shared by the densifying `parse_xlsx` and the streaming `parse_xlsx_streaming`
 * so the container validation and global-table reads are byte-identical across
 * both paths (mirrors `open_workbook` on the .xls side).
 */
interface OpenedXlsxWorkbook {
    cfb_file: ReturnType<typeof CFB.read>;
    sheet_entries: WorkbookSheetEntry[];
    rels: Map<string, string>;
    sst: ParsedXlsxString[];
    fonts: FontEntry[];
    xfs: XfEntry[];
    format_map: Map<number, string>;
    datemode: DateMode;
    budget: WorkbookBudget;
}

function open_xlsx_workbook(buffer: Uint8Array): OpenedXlsxWorkbook {
    let cfb_file: ReturnType<typeof CFB.read>;
    try {
        cfb_file = CFB.read(buffer, { type: 'buffer' });
    } catch {
        throw new Error('Not a valid .xlsx file');
    }

    // Parse workbook structure
    const workbook_xml = get_entry_text(cfb_file, '/xl/workbook.xml');
    if (!workbook_xml) throw new Error('No workbook data found in .xlsx file');

    const { sheets: sheet_entries, datemode } = parse_workbook_xml(workbook_xml);
    assert_safe_sheet_count(sheet_entries.length);

    const rels = parse_sheet_rels(cfb_file);

    // Parse shared strings (may be absent for workbooks with no string cells)
    const sst_xml = get_entry_text(cfb_file, '/xl/sharedStrings.xml');
    const sst = sst_xml ? parse_shared_strings(sst_xml) : [];

    // Parse styles
    const styles_xml = get_entry_text(cfb_file, '/xl/styles.xml');
    const { fonts, xfs, format_map } = styles_xml
        ? parse_styles(styles_xml)
        : { fonts: [], xfs: [], format_map: new Map<number, string>() };

    const budget = create_workbook_budget();

    return { cfb_file, sheet_entries, rels, sst, fonts, xfs, format_map, datemode, budget };
}

/** Read and parse one worksheet's own `.rels` part (hyperlink targets live
 *  there). Absent part -> empty map, which is the common case. */
function worksheet_rels(
    cfb_file: ReturnType<typeof CFB.read>,
    sheet_path: string,
): Map<string, OoxmlRelationship> {
    const rels_xml = get_entry_text(cfb_file, `/${rels_path_for_part(sheet_path)}`);
    return rels_xml ? parse_relationships(rels_xml) : new Map();
}

export async function parse_xlsx(buffer: Uint8Array): Promise<{ data: WorkbookData; warnings: string[] }> {
    const { cfb_file, sheet_entries, rels, sst, fonts, xfs, format_map, datemode, budget } =
        open_xlsx_workbook(buffer);

    // Parse each worksheet
    const sheets: SheetData[] = [];
    const workings: WorksheetWorking[] = [];

    for (const entry of sheet_entries) {
        const sheet_path = rels.get(entry.rId);
        if (!sheet_path) continue;

        const ws_xml = get_entry_text(cfb_file, `/${sheet_path}`);
        if (!ws_xml) {
            // Empty or missing sheet
            sheets.push({
                name: entry.name,
                worksheetId: entry.worksheetId,
                rows: [],
                merges: [],
                columnCount: 0,
                rowCount: 0,
            });
            continue;
        }

        const working = parse_worksheet_core(
            ws_xml, sst, xfs, fonts, format_map, datemode, budget,
            worksheet_rels(cfb_file, sheet_path)
        );
        workings.push(working);

        sheets.push({
            name: entry.name,
            worksheetId: entry.worksheetId,
            rows: densify(working),
            merges: working.merges,
            columnCount: working.col_count,
            rowCount: working.row_count,
        });
    }

    return { data: { sheets, hasFormatting: working_has_formatting(workings) }, warnings: [] };
}

// --- Streaming API (direct-to-builder; no densified intermediate) ---

/**
 * Parse an .xlsx into per-sheet meta + a fill function, never materializing the
 * intermediate (CellData|null)[][]. Lets a consumer build its own columnar store
 * directly, eliminating the transient 2x representation peak (Task A7).
 */
export async function parse_xlsx_streaming(buffer: Uint8Array): Promise<StreamingWorkbook> {
    const { cfb_file, sheet_entries, rels, sst, fonts, xfs, format_map, datemode, budget } =
        open_xlsx_workbook(buffer);

    const sheets: StreamingSheet[] = [];
    const workings: WorksheetWorking[] = [];

    for (const entry of sheet_entries) {
        const sheet_path = rels.get(entry.rId);
        if (!sheet_path) continue;

        const ws_xml = get_entry_text(cfb_file, `/${sheet_path}`);
        if (!ws_xml) {
            sheets.push({
                name: entry.name,
                worksheetId: entry.worksheetId,
                rowCount: 0,
                columnCount: 0,
                merges: [],
                fill: () => {},
            });
            continue;
        }

        const working = parse_worksheet_core(
            ws_xml, sst, xfs, fonts, format_map, datemode, budget,
            worksheet_rels(cfb_file, sheet_path)
        );
        workings.push(working);
        sheets.push(make_streaming_sheet(entry.name, working, working.merges, entry.worksheetId));
    }

    return { sheets, hasFormatting: working_has_formatting(workings), warnings: [] };
}
