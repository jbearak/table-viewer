import CFB from 'cfb';
import {
    assert_safe_sheet_count,
    assert_safe_sheet_shape,
    create_workbook_budget,
} from './spreadsheet-safety';
import { workbook_has_formatting } from './cell-display';
import { serial_to_iso, is_date_format, format_value, get_style } from './spreadsheet-format';
import type { FontEntry, XfEntry, DateMode } from './spreadsheet-format';
import type { WorkbookData, SheetData, CellData, MergeRange } from './types';

// --- XML Helpers ---

function decode_xml(s: string): string {
    if (s.indexOf('&') === -1) return s;
    return s
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");
}

function get_attr(tag: string, attr: string): string | null {
    const re = new RegExp(`\\b${attr}="([^"]*)"`, '');
    const m = tag.match(re);
    return m ? decode_xml(m[1]) : null;
}

/** Check whether the character after a tag-name match is a valid tag delimiter. */
function is_tag_boundary(ch: string | undefined): boolean {
    return ch === '>' || ch === ' ' || ch === '/' || ch === '\t' || ch === '\n' || ch === '\r';
}

/**
 * Iterate every occurrence of `<tag ...>...</tag>` or self-closing `<tag .../>`.
 * Calls `cb` with the full opening tag string and inner content (empty for self-closing).
 */
function iter_elements(xml: string, tag: string, cb: (open_tag: string, inner: string) => void): void {
    const open = `<${tag}`;
    let pos = 0;
    while (true) {
        const start = xml.indexOf(open, pos);
        if (start === -1) break;

        // Verify full tag name match (not just a prefix)
        if (!is_tag_boundary(xml[start + open.length])) {
            pos = start + 1;
            continue;
        }

        // Find end of opening tag
        const tag_end = xml.indexOf('>', start);
        if (tag_end === -1) break;

        const open_tag = xml.substring(start, tag_end + 1);

        if (xml[tag_end - 1] === '/') {
            // Self-closing
            cb(open_tag, '');
            pos = tag_end + 1;
        } else {
            const close = `</${tag}>`;
            const close_pos = xml.indexOf(close, tag_end);
            if (close_pos === -1) {
                pos = tag_end + 1;
                continue;
            }
            const inner = xml.substring(tag_end + 1, close_pos);
            cb(open_tag, inner);
            pos = close_pos + close.length;
        }
    }
}

function get_text(xml: string, tag: string): string | null {
    const open = `<${tag}`;
    let pos = 0;
    while (true) {
        const start = xml.indexOf(open, pos);
        if (start === -1) return null;
        if (!is_tag_boundary(xml[start + open.length])) {
            pos = start + 1;
            continue;
        }
        const tag_end = xml.indexOf('>', start);
        if (tag_end === -1) return null;
        if (xml[tag_end - 1] === '/') return '';
        const close = `</${tag}>`;
        const close_pos = xml.indexOf(close, tag_end);
        if (close_pos === -1) return null;
        return xml.substring(tag_end + 1, close_pos);
    }
}

// --- ZIP / Entry Access ---

function get_entry_text(cfb_file: ReturnType<typeof CFB.read>, path: string): string | null {
    const entry = CFB.find(cfb_file, path);
    if (!entry?.content) return null;
    return Buffer.from(entry.content).toString('utf8');
}

// --- Workbook Parsing ---

function parse_sheet_rels(cfb_file: ReturnType<typeof CFB.read>): Map<string, string> {
    const map = new Map<string, string>();
    const xml = get_entry_text(cfb_file, '/xl/_rels/workbook.xml.rels');
    if (!xml) return map;

    iter_elements(xml, 'Relationship', (open_tag) => {
        const type = get_attr(open_tag, 'Type');
        if (!type || !type.endsWith('/worksheet')) return;
        const id = get_attr(open_tag, 'Id');
        const target = get_attr(open_tag, 'Target');
        if (id && target) {
            // Targets are relative to xl/
            const resolved = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
            map.set(id, resolved);
        }
    });

    return map;
}

function parse_shared_strings(xml: string): string[] {
    const sst: string[] = [];
    iter_elements(xml, 'si', (_open, inner) => {
        // Check for rich text runs — match <r> or <r  but not <rPh>, <rPr>, etc.
        if (inner.indexOf('<r>') !== -1 || inner.indexOf('<r ') !== -1) {
            let text = '';
            iter_elements(inner, 'r', (_r_open, r_inner) => {
                const t = get_text(r_inner, 't');
                if (t !== null) text += decode_xml(t);
            });
            sst.push(text);
        } else {
            const t = get_text(inner, 't');
            sst.push(t !== null ? decode_xml(t) : '');
        }
    });
    return sst;
}

function parse_styles(xml: string): { fonts: FontEntry[]; xfs: XfEntry[]; format_map: Map<number, string> } {
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
            const has_b = /<b[\s/>]/.test(inner);
            const bold = has_b && !/\bb val="0"/.test(inner);
            const has_i = /<i[\s/>]/.test(inner);
            const italic = has_i && !/\bi val="0"/.test(inner);
            fonts.push({ bold, italic });
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

function parse_workbook_xml(xml: string): { sheets: Array<{ name: string; rId: string }>; datemode: DateMode } {
    const sheets: Array<{ name: string; rId: string }> = [];

    iter_elements(xml, 'sheet', (open_tag) => {
        const name = get_attr(open_tag, 'name');
        // The relationship ID can be r:id or r:Id — try both
        const rId = get_attr(open_tag, 'r:id') ?? get_attr(open_tag, 'r:Id') ?? '';
        if (name) {
            sheets.push({ name, rId });
        }
    });

    // Detect 1904 date system
    let datemode: DateMode = 0;
    iter_elements(xml, 'workbookPr', (open_tag) => {
        const d1904 = get_attr(open_tag, 'date1904');
        if (d1904 === '1' || d1904 === 'true') datemode = 1;
    });

    return { sheets, datemode };
}

// --- Worksheet Parsing ---

function parse_cell_ref(ref: string): { row: number; col: number } {
    const match = ref.match(/^([A-Z]+)(\d+)$/);
    if (!match) return { row: 0, col: 0 };
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
            result = { row_count: 0, col_count: 0 };
            return;
        }
        const end = parse_cell_ref(parts[1]);
        result = { row_count: end.row + 1, col_count: end.col + 1 };
    });
    return result;
}

function parse_worksheet(
    xml: string,
    sst: string[],
    xfs: XfEntry[],
    fonts: FontEntry[],
    format_map: Map<number, string>,
    datemode: DateMode
): { rows: (CellData | null)[][]; merges: MergeRange[]; row_count: number; col_count: number } {
    // Parse dimension
    const dim = parse_dimension(xml);

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

    // Build merged cells set
    const merged_cells = new Set<string>();
    for (const range of merges) {
        for (let r = range.startRow; r <= range.endRow; r++) {
            for (let c = range.startCol; c <= range.endCol; c++) {
                if (r === range.startRow && c === range.startCol) continue;
                merged_cells.add(`${r}:${c}`);
            }
        }
    }

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
                const { row, col } = parse_cell_ref(ref);
                if (row + 1 > max_row) max_row = row + 1;
                if (col + 1 > max_col) max_col = col + 1;

                const t = get_attr(c_open, 't');
                const s = get_attr(c_open, 's');
                const xf_index = s ? parseInt(s, 10) : 0;
                const v_text = get_text(c_inner, 'v');
                const style = get_style(xf_index, xfs, fonts);

                let raw: string | number | boolean | null = null;
                let formatted = '';

                if (t === 's') {
                    // Shared string (already decoded during SST parsing)
                    const idx = v_text !== null ? parseInt(v_text, 10) : -1;
                    raw = idx >= 0 && idx < sst.length ? sst[idx] : null;
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
                    // Inline string
                    const is_elem = get_text(c_inner, 'is');
                    if (is_elem) {
                        if (is_elem.indexOf('<r>') !== -1 || is_elem.indexOf('<r ') !== -1) {
                            let text = '';
                            iter_elements(is_elem, 'r', (_r, r_inner) => {
                                const rt = get_text(r_inner, 't');
                                if (rt !== null) text += decode_xml(rt);
                            });
                            raw = text;
                        } else {
                            const it = get_text(is_elem, 't');
                            raw = it !== null ? decode_xml(it) : null;
                        }
                    }
                    formatted = raw !== null ? String(raw) : '';
                } else {
                    // Numeric (default) — includes dates, formulas with numeric results
                    if (v_text !== null && v_text !== '') {
                        const num = parseFloat(v_text);
                        if (is_date_format(xf_index, xfs, format_map)) {
                            raw = serial_to_iso(num, datemode);
                            formatted = format_value(num, xf_index, xfs, format_map, datemode);
                        } else {
                            raw = num;
                            formatted = format_value(num, xf_index, xfs, format_map, datemode);
                        }
                    }
                }

                cells.set(`${row}:${col}`, { raw, formatted, ...style });
            });
        });
    }

    // If no cells were found, the sheet is empty regardless of what dimension says
    if (cells.size === 0) {
        return { rows: [], merges, row_count: 0, col_count: 0 };
    }

    // Use dimension if available and non-degenerate, otherwise fall back to observed max
    const row_count = dim && dim.row_count > 0 ? Math.max(dim.row_count, max_row) : max_row;
    const col_count = dim && dim.col_count > 0 ? Math.max(dim.col_count, max_col) : max_col;

    // Build rows array
    const rows: (CellData | null)[][] = [];
    for (let r = 0; r < row_count; r++) {
        const row_data: (CellData | null)[] = [];
        for (let c = 0; c < col_count; c++) {
            if (merged_cells.has(`${r}:${c}`)) {
                row_data.push(null);
            } else {
                row_data.push(cells.get(`${r}:${c}`) ?? { raw: null, formatted: '', bold: false, italic: false });
            }
        }
        rows.push(row_data);
    }

    return { rows, merges, row_count, col_count };
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

export async function parse_xlsx(buffer: Uint8Array): Promise<{ data: WorkbookData; warnings: string[] }> {
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

    // Parse each worksheet
    const sheets: SheetData[] = [];
    const budget = create_workbook_budget();

    for (const entry of sheet_entries) {
        const sheet_path = rels.get(entry.rId);
        if (!sheet_path) continue;

        const ws_xml = get_entry_text(cfb_file, `/${sheet_path}`);
        if (!ws_xml) {
            // Empty or missing sheet
            sheets.push({ name: entry.name, rows: [], merges: [], columnCount: 0, rowCount: 0 });
            continue;
        }

        const { rows, merges, row_count, col_count } = parse_worksheet(
            ws_xml, sst, xfs, fonts, format_map, datemode
        );

        assert_safe_sheet_shape(budget, row_count, col_count, merges.length);

        sheets.push({
            name: entry.name,
            rows,
            merges,
            columnCount: col_count,
            rowCount: row_count,
        });
    }

    return { data: { sheets, hasFormatting: workbook_has_formatting(sheets) }, warnings: [] };
}
