import CFB from 'cfb';
import SSF from 'ssf';
import {
    assert_safe_sheet_count,
    assert_safe_sheet_shape,
    create_workbook_budget,
    type WorkbookBudget,
} from './spreadsheet-safety';
import type { WorkbookData, SheetData, CellData, MergeRange } from './types';

// --- Constants ---

const RECORD_CONTINUE = 0x003C;
const RT_BOF = 0x0809;
const RT_EOF = 0x000A;
const RT_BOUNDSHEET8 = 0x0085;
const RT_SST = 0x00FC;
const RT_FONT = 0x0031;
const RT_XF = 0x00E0;
const RT_FORMAT = 0x041E;
const RT_DIMENSION = 0x0200;
const RT_LABELSST = 0x00FD;
const RT_NUMBER = 0x0203;
const RT_RK = 0x027E;
const RT_MULRK = 0x00BD;
const RT_BOOLERR = 0x0205;
const RT_BLANK = 0x0201;
const RT_MERGECELLS = 0x00E5;
const RT_LABEL = 0x0204;
const RT_FILEPASS = 0x002F;
const RT_FORMULA = 0x0006;
const RT_STRING = 0x0207;

const BIFF8_VERSION = 0x0600;

// --- Types ---

export interface BiffRecord {
    type: number;
    data: Buffer;
    offset: number;
    /** @internal Used during scanning to collect Continue chunks before final concat */
    _chunks?: Buffer[];
}

export interface ParseResult {
    data: WorkbookData;
    warnings: string[];
}

export interface StringReadResult {
    value: string;
    bytesRead: number;
}

interface SheetEntry {
    name: string;
    offset: number;
}

interface FontEntry {
    bold: boolean;
    italic: boolean;
}

interface XfEntry {
    font_index: number;
    format_index: number;
}

function warn_malformed_record(message: string): void {
    console.warn(`[parse-xls] ${message}`);
}

// --- Layer 1: Record Scanner ---

export interface ScanResult {
    records: BiffRecord[];
    truncated: boolean;
}

export function scan_records(buf: Buffer): ScanResult {
    const records: BiffRecord[] = [];
    let pos = 0;
    let truncated = false;

    while (pos + 4 <= buf.length) {
        const type = buf.readUInt16LE(pos);
        const len = buf.readUInt16LE(pos + 2);

        if (pos + 4 + len > buf.length) {
            truncated = true;
            break;
        }

        const data = Buffer.from(buf.subarray(pos + 4, pos + 4 + len));
        const offset = pos;
        pos += 4 + len;

        if (type === RECORD_CONTINUE && records.length > 0) {
            const prev = records[records.length - 1];
            if (!prev._chunks) {
                prev._chunks = [prev.data];
            }
            prev._chunks.push(data);
        } else {
            records.push({ type, data, offset });
        }
    }

    // Finalize Continue chunks: for most records, flatten into single buffer.
    // For SST records, preserve chunk boundaries (needed for string decoding).
    for (const rec of records) {
        if (rec._chunks) {
            if (rec.type === 0x00FC) {
                // SST: keep chunks for read_sst_chunked
                // rec.data stays as the first chunk, _chunks has all chunks including first
            } else {
                rec.data = Buffer.concat(rec._chunks);
                delete rec._chunks;
            }
        }
    }

    return { records, truncated };
}

// --- Layer 2 Helpers: Decoders ---

const f64_buf = new Float64Array(1);
const u8_view = new Uint8Array(f64_buf.buffer);

export function decode_rk(rk: number): number {
    const is_integer = (rk & 0x02) !== 0;
    const div_100 = (rk & 0x01) !== 0;

    let value: number;
    if (is_integer) {
        value = rk >> 2;
    } else {
        u8_view[0] = 0; u8_view[1] = 0; u8_view[2] = 0; u8_view[3] = 0;
        u8_view[4] = (rk & 0xFC);
        u8_view[5] = (rk >> 8) & 0xFF;
        u8_view[6] = (rk >> 16) & 0xFF;
        u8_view[7] = (rk >> 24) & 0xFF;
        value = f64_buf[0];
    }

    return div_100 ? value / 100 : value;
}

export function read_biff8_string(buf: Buffer, offset: number, char_count: number): StringReadResult {
    let pos = offset;
    if (pos >= buf.length) {
        warn_malformed_record('Skipping truncated BIFF8 string with missing flags byte');
        return { value: '', bytesRead: 0 };
    }
    const flags = buf[pos];
    pos += 1;

    const is_utf16 = (flags & 0x01) !== 0;
    const has_rich_text = (flags & 0x08) !== 0;
    const has_ext_string = (flags & 0x04) !== 0;

    let rich_text_runs = 0;
    let ext_string_size = 0;

    if (has_rich_text) {
        if (pos + 2 > buf.length) {
            warn_malformed_record('Skipping truncated BIFF8 string with missing rich text run count');
            return { value: '', bytesRead: Math.max(0, buf.length - offset) };
        }
        rich_text_runs = buf.readUInt16LE(pos);
        pos += 2;
    }
    if (has_ext_string) {
        if (pos + 4 > buf.length) {
            warn_malformed_record('Skipping truncated BIFF8 string with missing extended string size');
            return { value: '', bytesRead: Math.max(0, buf.length - offset) };
        }
        ext_string_size = buf.readUInt32LE(pos);
        pos += 4;
    }

    let value: string;
    if (is_utf16) {
        const bytes_available = Math.max(0, buf.length - pos);
        const chars_available = Math.floor(bytes_available / 2);
        const chars_to_read = Math.min(char_count, chars_available);
        if (chars_to_read < char_count) {
            warn_malformed_record('Truncated UTF-16 BIFF8 string; returning partial value');
        }
        value = buf.toString('utf16le', pos, pos + chars_to_read * 2);
        pos += chars_to_read * 2;
    } else {
        value = '';
        const chars_to_read = Math.min(char_count, Math.max(0, buf.length - pos));
        if (chars_to_read < char_count) {
            warn_malformed_record('Truncated compressed BIFF8 string; returning partial value');
        }
        for (let i = 0; i < chars_to_read; i++) {
            value += String.fromCharCode(buf[pos + i]);
        }
        pos += chars_to_read;
    }

    pos = Math.min(buf.length, pos + rich_text_runs * 4);
    pos = Math.min(buf.length, pos + ext_string_size);

    return { value, bytesRead: pos - offset };
}

// --- Layer 2: Record Readers ---

/**
 * Read SST with proper CONTINUE boundary handling.
 *
 * When an SST spans CONTINUE records, a string can be split mid-character.
 * Each CONTINUE chunk starts with a fresh compression flag byte that may
 * differ from the original string's flag. We must decode strings chunk-aware.
 */
function read_sst(records: BiffRecord[]): string[] {
    const strings: string[] = [];

    for (const rec of records) {
        if (rec.type !== RT_SST) continue;

        const chunks = rec._chunks ?? [rec.data];

        // Build a reader that tracks position across chunks
        const total_buf = Buffer.concat(chunks);

        // Absolute position in the concatenated buffer
        // But we also track chunk boundaries for flag-byte re-reads
        const chunk_offsets: number[] = [];
        let running = 0;
        for (const c of chunks) {
            chunk_offsets.push(running);
            running += c.length;
        }
        if (total_buf.length < 8) {
            warn_malformed_record('Skipping truncated SST record header');
            delete rec._chunks;
            break;
        }

        const unique_count = total_buf.readUInt32LE(4);
        let abs_pos = 8;

        for (let i = 0; i < unique_count && abs_pos < total_buf.length; i++) {
            if (abs_pos + 2 > total_buf.length) {
                warn_malformed_record('Stopping SST parsing at truncated character count');
                break;
            }
            const char_count = total_buf.readUInt16LE(abs_pos);
            abs_pos += 2;

            // Read flags
            if (abs_pos >= total_buf.length) {
                warn_malformed_record('Stopping SST parsing at truncated flags byte');
                break;
            }
            const flags = total_buf[abs_pos];
            abs_pos += 1;

            const has_rich_text = (flags & 0x08) !== 0;
            const has_ext_string = (flags & 0x04) !== 0;

            let rich_text_runs = 0;
            let ext_string_size = 0;

            if (has_rich_text) {
                if (abs_pos + 2 > total_buf.length) break;
                rich_text_runs = total_buf.readUInt16LE(abs_pos);
                abs_pos += 2;
            }
            if (has_ext_string) {
                if (abs_pos + 4 > total_buf.length) break;
                ext_string_size = total_buf.readUInt32LE(abs_pos);
                abs_pos += 4;
            }

            // Now read char_count characters, handling CONTINUE boundaries
            let is_utf16 = (flags & 0x01) !== 0;
            let value = '';
            let chars_remaining = char_count;
            let trailing_utf16_byte: number | null = null;

            while (chars_remaining > 0 && abs_pos < total_buf.length) {
                // Find which chunk we're in
                let current_chunk = 0;
                for (let ci = chunk_offsets.length - 1; ci >= 0; ci--) {
                    if (abs_pos >= chunk_offsets[ci]) {
                        current_chunk = ci;
                        break;
                    }
                }

                // How many bytes until the next chunk boundary?
                const chunk_end = current_chunk + 1 < chunk_offsets.length
                    ? chunk_offsets[current_chunk + 1]
                    : total_buf.length;
                const bytes_left_in_chunk = chunk_end - abs_pos;

                // How many characters can we read from this chunk?
                const char_size = is_utf16 ? 2 : 1;
                const chars_in_chunk = Math.min(
                    chars_remaining,
                    Math.floor(bytes_left_in_chunk / char_size)
                );

                if (chars_in_chunk > 0) {
                    if (is_utf16) {
                        value += total_buf.toString('utf16le', abs_pos, abs_pos + chars_in_chunk * 2);
                        abs_pos += chars_in_chunk * 2;
                    } else {
                        for (let j = 0; j < chars_in_chunk; j++) {
                            value += String.fromCharCode(total_buf[abs_pos + j]);
                        }
                        abs_pos += chars_in_chunk;
                    }
                    chars_remaining -= chars_in_chunk;
                } else if (is_utf16 && bytes_left_in_chunk === 1) {
                    trailing_utf16_byte = total_buf[abs_pos];
                    abs_pos += 1;
                }

                // If we hit a chunk boundary mid-string, read the new compression flag
                if (chars_remaining > 0 && abs_pos >= chunk_end && abs_pos < total_buf.length) {
                    const new_flags = total_buf[abs_pos];
                    abs_pos += 1;
                    is_utf16 = (new_flags & 0x01) !== 0;
                    if (trailing_utf16_byte !== null) {
                        if (abs_pos >= total_buf.length) {
                            warn_malformed_record('Stopping SST parsing at truncated UTF-16 continuation');
                            break;
                        }
                        value += Buffer.from([trailing_utf16_byte, total_buf[abs_pos]]).toString('utf16le');
                        trailing_utf16_byte = null;
                        abs_pos += 1;
                        chars_remaining -= 1;
                    }
                } else if (chars_in_chunk === 0) {
                    warn_malformed_record('Stopping SST parsing after zero-progress chunk');
                    break;
                }
            }

            // Skip rich text run data and extended string data
            abs_pos = Math.min(total_buf.length, abs_pos + rich_text_runs * 4);
            abs_pos = Math.min(total_buf.length, abs_pos + ext_string_size);

            strings.push(value);
        }

        delete rec._chunks;
        break;
    }

    return strings;
}

function read_fonts(records: BiffRecord[]): FontEntry[] {
    const fonts: FontEntry[] = [];

    for (const rec of records) {
        if (rec.type !== RT_FONT) continue;
        const buf = rec.data;
        if (buf.length < 8) {
            warn_malformed_record('Skipping truncated FONT record');
            continue;
        }
        const grbit = buf.readUInt16LE(2);
        // BIFF8 FONT: 0-1 height, 2-3 grbit, 4-5 color index, 6-7 bold weight
        const weight = buf.readUInt16LE(6);
        const italic = (grbit & 0x02) !== 0;
        const bold = weight >= 700;
        if (fonts.length === 4) {
            fonts.push({ bold: false, italic: false });
        }
        fonts.push({ bold, italic });
    }

    return fonts;
}

function read_xfs(records: BiffRecord[]): XfEntry[] {
    const xfs: XfEntry[] = [];

    for (const rec of records) {
        if (rec.type !== RT_XF) continue;
        const buf = rec.data;
        if (buf.length < 4) {
            warn_malformed_record('Skipping truncated XF record');
            continue;
        }
        const font_index = buf.readUInt16LE(0);
        const format_index = buf.readUInt16LE(2);
        xfs.push({ font_index, format_index });
    }

    return xfs;
}

function read_formats(records: BiffRecord[]): Map<number, string> {
    const formats = new Map<number, string>();

    for (const rec of records) {
        if (rec.type !== RT_FORMAT) continue;
        const buf = rec.data;
        if (buf.length < 5) {
            warn_malformed_record('Skipping truncated FORMAT record');
            continue;
        }
        const index = buf.readUInt16LE(0);
        const char_count = buf.readUInt16LE(2);
        const result = read_biff8_string(buf, 4, char_count);
        formats.set(index, result.value);
    }

    return formats;
}

function read_bound_sheets(records: BiffRecord[]): SheetEntry[] {
    const sheets: SheetEntry[] = [];

    for (const rec of records) {
        if (rec.type !== RT_BOUNDSHEET8) continue;
        const buf = rec.data;
        if (buf.length < 8) {
            warn_malformed_record('Skipping truncated BOUNDSHEET8 record');
            continue;
        }
        const offset = buf.readUInt32LE(0);
        const char_count = buf[6];
        const result = read_biff8_string(buf, 7, char_count);
        sheets.push({ name: result.value, offset });
    }

    return sheets;
}

function format_value(raw: number, xf_index: number, xfs: XfEntry[], format_map: Map<number, string>): string {
    if (xf_index >= xfs.length) return String(raw);
    const xf = xfs[xf_index];
    const fmt_index = xf.format_index;
    const fmt = format_map.get(fmt_index);
    try {
        if (fmt) {
            return SSF.format(fmt, raw);
        }
        // SSF handles built-in format indices (0-49) natively
        return SSF.format(fmt_index, raw);
    } catch {
        return String(raw);
    }
}

function get_style(xf_index: number, xfs: XfEntry[], fonts: FontEntry[]): { bold: boolean; italic: boolean } {
    if (xf_index >= xfs.length) return { bold: false, italic: false };
    const xf = xfs[xf_index];
    const font_idx = xf.font_index;
    if (font_idx >= fonts.length) return { bold: false, italic: false };
    return fonts[font_idx];
}

// --- Layer 2: Sheet Parser ---

function parse_sheet_records(
    records: BiffRecord[],
    sst: string[],
    xfs: XfEntry[],
    fonts: FontEntry[],
    format_map: Map<number, string>,
    budget: WorkbookBudget,
): SheetData {
    let row_count = 0;
    let col_count = 0;
    const cells = new Map<string, CellData>();
    const merges: MergeRange[] = [];
    // Track last FORMULA cell so a following STRING record can fill its value
    let pending_formula_key: string | null = null;
    let pending_formula_style: { bold: boolean; italic: boolean } = { bold: false, italic: false };

    for (const rec of records) {
        switch (rec.type) {
            case RT_DIMENSION: {
                const buf = rec.data;
                if (buf.length < 12) {
                    warn_malformed_record('Skipping truncated DIMENSION record');
                    break;
                }
                row_count = buf.readUInt32LE(4);
                col_count = buf.readUInt16LE(10);
                break;
            }

            case RT_LABELSST: {
                const buf = rec.data;
                if (buf.length < 10) {
                    warn_malformed_record('Skipping truncated LABELSST record');
                    break;
                }
                const row = buf.readUInt16LE(0);
                const col = buf.readUInt16LE(2);
                const xf_index = buf.readUInt16LE(4);
                const sst_index = buf.readUInt32LE(6);
                const value = sst_index < sst.length ? sst[sst_index] : '';
                const style = get_style(xf_index, xfs, fonts);
                cells.set(`${row}:${col}`, {
                    raw: value, formatted: value,
                    bold: style.bold, italic: style.italic,
                });
                break;
            }

            case RT_NUMBER: {
                const buf = rec.data;
                if (buf.length < 14) {
                    warn_malformed_record('Skipping truncated NUMBER record');
                    break;
                }
                const row = buf.readUInt16LE(0);
                const col = buf.readUInt16LE(2);
                const xf_index = buf.readUInt16LE(4);
                const value = buf.readDoubleLE(6);
                const style = get_style(xf_index, xfs, fonts);
                const formatted = format_value(value, xf_index, xfs, format_map);
                cells.set(`${row}:${col}`, {
                    raw: value, formatted,
                    bold: style.bold, italic: style.italic,
                });
                break;
            }

            case RT_RK: {
                const buf = rec.data;
                if (buf.length < 10) {
                    warn_malformed_record('Skipping truncated RK record');
                    break;
                }
                const row = buf.readUInt16LE(0);
                const col = buf.readUInt16LE(2);
                const xf_index = buf.readUInt16LE(4);
                const value = decode_rk(buf.readInt32LE(6));
                const style = get_style(xf_index, xfs, fonts);
                const formatted = format_value(value, xf_index, xfs, format_map);
                cells.set(`${row}:${col}`, {
                    raw: value, formatted,
                    bold: style.bold, italic: style.italic,
                });
                break;
            }

            case RT_MULRK: {
                const buf = rec.data;
                if (buf.length < 6) break; // minimum: row(2) + first_col(2) + last_col(2)
                const row = buf.readUInt16LE(0);
                const first_col = buf.readUInt16LE(2);
                const last_col = buf.readUInt16LE(buf.length - 2);
                let pos = 4;
                for (let c = first_col; c <= last_col && pos + 6 <= buf.length - 2; c++) {
                    const xf_index = buf.readUInt16LE(pos);
                    const rk_val = buf.readInt32LE(pos + 2);
                    const value = decode_rk(rk_val);
                    const style = get_style(xf_index, xfs, fonts);
                    const formatted = format_value(value, xf_index, xfs, format_map);
                    cells.set(`${row}:${c}`, {
                        raw: value, formatted,
                        bold: style.bold, italic: style.italic,
                    });
                    pos += 6;
                }
                break;
            }

            case RT_BOOLERR: {
                const buf = rec.data;
                if (buf.length < 8) {
                    warn_malformed_record('Skipping truncated BOOLERR record');
                    break;
                }
                const row = buf.readUInt16LE(0);
                const col = buf.readUInt16LE(2);
                const xf_index = buf.readUInt16LE(4);
                const val = buf[6];
                const is_error = buf[7] === 1;
                const style = get_style(xf_index, xfs, fonts);
                if (is_error) {
                    const error_codes: Record<number, string> = {
                        0x00: '#NULL!', 0x07: '#DIV/0!', 0x0F: '#VALUE!',
                        0x17: '#REF!', 0x1D: '#NAME?', 0x24: '#NUM!', 0x2A: '#N/A',
                    };
                    const formatted = error_codes[val] ?? `#ERR(${val})`;
                    cells.set(`${row}:${col}`, { raw: formatted, formatted, bold: style.bold, italic: style.italic });
                } else {
                    cells.set(`${row}:${col}`, {
                        raw: val === 1,
                        formatted: val === 1 ? 'TRUE' : 'FALSE',
                        bold: style.bold, italic: style.italic,
                    });
                }
                break;
            }

            case RT_BLANK: {
                const buf = rec.data;
                if (buf.length < 6) {
                    warn_malformed_record('Skipping truncated BLANK record');
                    break;
                }
                const row = buf.readUInt16LE(0);
                const col = buf.readUInt16LE(2);
                const xf_index = buf.readUInt16LE(4);
                const style = get_style(xf_index, xfs, fonts);
                cells.set(`${row}:${col}`, {
                    raw: null, formatted: '',
                    bold: style.bold, italic: style.italic,
                });
                break;
            }

            case RT_LABEL: {
                const buf = rec.data;
                if (buf.length < 9) {
                    warn_malformed_record('Skipping truncated LABEL record');
                    break;
                }
                const row = buf.readUInt16LE(0);
                const col = buf.readUInt16LE(2);
                const xf_index = buf.readUInt16LE(4);
                const char_count = buf.readUInt16LE(6);
                const result = read_biff8_string(buf, 8, char_count);
                const style = get_style(xf_index, xfs, fonts);
                cells.set(`${row}:${col}`, {
                    raw: result.value, formatted: result.value,
                    bold: style.bold, italic: style.italic,
                });
                break;
            }

            case RT_FORMULA: {
                // FORMULA record: row(2), col(2), xf(2), result(8), flags(2), reserved(4), ...
                const buf = rec.data;
                if (buf.length < 20) break;
                const row = buf.readUInt16LE(0);
                const col = buf.readUInt16LE(2);
                const xf_index = buf.readUInt16LE(4);
                const style = get_style(xf_index, xfs, fonts);
                const key = `${row}:${col}`;

                // Bytes 12-13 of the result (offset 6+6=12, 6+7=13) indicate the type:
                // If byte 6+6 (offset 12) == 0xFF and byte 6+7 (offset 13) == 0xFF,
                // the result is NOT a number — check byte 6 for the type.
                // Actually in BIFF8: result is at offset 6, 8 bytes.
                // If bytes 12-13 (last 2 of the 8-byte result) == 0xFFFF, it's a special value.
                const result_high = buf.readUInt16LE(12);
                if (result_high === 0xFFFF) {
                    const result_type = buf[6];
                    if (result_type === 0) {
                        // String result — the actual string comes in a following STRING record
                        pending_formula_key = key;
                        pending_formula_style = style;
                    } else if (result_type === 1) {
                        // Boolean
                        const bool_val = buf[8] === 1;
                        cells.set(key, {
                            raw: bool_val,
                            formatted: bool_val ? 'TRUE' : 'FALSE',
                            bold: style.bold, italic: style.italic,
                        });
                    } else if (result_type === 2) {
                        // Error
                        const error_codes: Record<number, string> = {
                            0x00: '#NULL!', 0x07: '#DIV/0!', 0x0F: '#VALUE!',
                            0x17: '#REF!', 0x1D: '#NAME?', 0x24: '#NUM!', 0x2A: '#N/A',
                        };
                        const err_val = buf[8];
                        const formatted = error_codes[err_val] ?? `#ERR(${err_val})`;
                        cells.set(key, { raw: formatted, formatted, bold: style.bold, italic: style.italic });
                    } else if (result_type === 3) {
                        // Empty string
                        cells.set(key, { raw: '', formatted: '', bold: style.bold, italic: style.italic });
                    }
                } else {
                    // Numeric result — read as IEEE 754 double
                    const value = buf.readDoubleLE(6);
                    const formatted = format_value(value, xf_index, xfs, format_map);
                    cells.set(key, { raw: value, formatted, bold: style.bold, italic: style.italic });
                }
                break;
            }

            case RT_STRING: {
                // STRING record follows a FORMULA when the cached result is a string
                if (!pending_formula_key) break;
                const buf = rec.data;
                if (buf.length < 3) break;
                const char_count = buf.readUInt16LE(0);
                const result = read_biff8_string(buf, 2, char_count);
                cells.set(pending_formula_key, {
                    raw: result.value, formatted: result.value,
                    bold: pending_formula_style.bold, italic: pending_formula_style.italic,
                });
                pending_formula_key = null;
                break;
            }

            case RT_MERGECELLS: {
                const buf = rec.data;
                if (buf.length < 2) break;
                const count = buf.readUInt16LE(0);
                let pos = 2;
                for (let i = 0; i < count && pos + 8 <= buf.length; i++) {
                    const startRow = buf.readUInt16LE(pos);
                    const endRow = buf.readUInt16LE(pos + 2);
                    const startCol = buf.readUInt16LE(pos + 4);
                    const endCol = buf.readUInt16LE(pos + 6);
                    merges.push({ startRow, startCol, endRow, endCol });
                    pos += 8;
                }
                break;
            }
        }
    }

    assert_safe_sheet_shape(budget, row_count, col_count, merges.length);

    // Build merged cells set
    const normalized_merges: MergeRange[] = [];
    const merged_cells = new Set<string>();
    for (const m of merges) {
        if (row_count <= 0 || col_count <= 0) continue;
        if (m.startRow > m.endRow || m.startCol > m.endCol) continue;
        if (m.startRow >= row_count || m.startCol >= col_count) continue;
        if (m.endRow < 0 || m.endCol < 0) continue;

        const clampedStartRow = Math.max(0, m.startRow);
        const clampedEndRow = Math.min(row_count - 1, m.endRow);
        const clampedStartCol = Math.max(0, m.startCol);
        const clampedEndCol = Math.min(col_count - 1, m.endCol);

        if (clampedStartRow > clampedEndRow || clampedStartCol > clampedEndCol) continue;

        normalized_merges.push({
            startRow: clampedStartRow,
            startCol: clampedStartCol,
            endRow: clampedEndRow,
            endCol: clampedEndCol,
        });

        for (let r = clampedStartRow; r <= clampedEndRow; r++) {
            for (let c = clampedStartCol; c <= clampedEndCol; c++) {
                if (r === clampedStartRow && c === clampedStartCol) continue;
                merged_cells.add(`${r}:${c}`);
            }
        }
    }

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

    return {
        name: '',
        rows,
        merges: normalized_merges,
        columnCount: col_count,
        rowCount: row_count,
    };
}

// --- Public API ---

export function parse_xls(buffer: Buffer): ParseResult {
    const warnings: string[] = [];

    let cfb_file: ReturnType<typeof CFB.read>;
    try {
        cfb_file = CFB.read(buffer, { type: 'buffer' });
    } catch {
        throw new Error('Not a valid .xls file');
    }

    const workbook_entry = CFB.find(cfb_file, '/Workbook') ?? CFB.find(cfb_file, '/Book');
    if (!workbook_entry?.content) {
        throw new Error('No workbook data found in .xls file');
    }

    const wb_buf = Buffer.from(workbook_entry.content);
    const { records, truncated } = scan_records(wb_buf);

    if (truncated) {
        warnings.push('Some data in this file could not be read. The file may be damaged.');
    }

    if (records.length === 0) {
        throw new Error('No workbook data found in .xls file');
    }

    // Check BIFF version
    const first_bof = records.find(r => r.type === RT_BOF);
    if (first_bof) {
        if (first_bof.data.length < 2) {
            warn_malformed_record('Skipping BIFF version check for truncated BOF record');
        } else {
            const version = first_bof.data.readUInt16LE(0);
            if (version !== BIFF8_VERSION) {
                const ver_names: Record<number, string> = {
                    0x0200: 'BIFF2', 0x0300: 'BIFF3', 0x0400: 'BIFF4', 0x0500: 'BIFF5',
                };
                const name = ver_names[version] ?? `0x${version.toString(16)}`;
                throw new Error(`Unsupported Excel format: ${name}`);
            }
        }
    }

    // Check for password protection
    if (records.some(r => r.type === RT_FILEPASS)) {
        throw new Error('Password-protected .xls files are not supported');
    }

    // Read global tables
    const sst = read_sst(records);
    const fonts = read_fonts(records);
    const xfs = read_xfs(records);
    const format_map = read_formats(records);
    const sheet_entries = read_bound_sheets(records);
    assert_safe_sheet_count(sheet_entries.length);
    const budget = create_workbook_budget();

    // Parse each sheet
    const sheets: SheetData[] = [];
    for (const entry of sheet_entries) {
        const sheet_start_pos = entry.offset;
        let start_idx = records.findIndex(r => r.offset >= sheet_start_pos && r.type === RT_BOF);
        if (start_idx === -1) {
            warnings.push('Some sheet data could not be found. The file may be damaged.');
            sheets.push({
                name: entry.name,
                rows: [],
                merges: [],
                columnCount: 0,
                rowCount: 0,
            });
            continue;
        }

        start_idx += 1; // skip BOF
        let end_idx = records.findIndex((r, i) => i >= start_idx && r.type === RT_EOF);
        if (end_idx === -1) {
            end_idx = records.length;
            warnings.push('Some data in this file could not be read. The file may be damaged.');
        }

        const sheet_records = records.slice(start_idx, end_idx);
        const sheet_data = parse_sheet_records(
            sheet_records,
            sst,
            xfs,
            fonts,
            format_map,
            budget
        );
        sheet_data.name = entry.name;
        sheets.push(sheet_data);
    }

    return { data: { sheets }, warnings };
}
