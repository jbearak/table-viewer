import SSF from 'ssf';

export interface FontEntry { bold: boolean; italic: boolean }
export interface XfEntry { font_index: number; format_index: number }
export type DateMode = 0 | 1;

const MS_PER_DAY = 86400000;
const MIN_JS_DATE_MS = Date.UTC(-271821, 3, 20);
const MAX_JS_DATE_MS = Date.UTC(275760, 8, 13);
const EXCEL_1900_EPOCH_MS = Date.UTC(1899, 11, 31);
const EXCEL_1904_EPOCH_MS = Date.UTC(1904, 0, 1);

function get_excel_date_serial_bounds(datemode: DateMode): { min: number; max: number } {
    if (datemode === 1) {
        return {
            min: (MIN_JS_DATE_MS - EXCEL_1904_EPOCH_MS) / MS_PER_DAY,
            max: (MAX_JS_DATE_MS - EXCEL_1904_EPOCH_MS) / MS_PER_DAY,
        };
    }

    return {
        min: (MIN_JS_DATE_MS - EXCEL_1900_EPOCH_MS) / MS_PER_DAY,
        max: (MAX_JS_DATE_MS - EXCEL_1900_EPOCH_MS) / MS_PER_DAY + 1,
    };
}

export function is_valid_excel_date_serial(serial: number, datemode: DateMode): boolean {
    if (!Number.isFinite(serial)) return false;

    const bounds = get_excel_date_serial_bounds(datemode);
    return serial >= bounds.min && serial <= bounds.max;
}

/** Convert an Excel date serial number to an ISO 8601 string. */
export function serial_to_iso(serial: number, datemode: DateMode): string {
    if (!Number.isFinite(serial)) {
        throw new Error('Excel date serial must be a finite number');
    }
    if (!is_valid_excel_date_serial(serial, datemode)) {
        throw new Error('Excel date serial is out of range for JS Date');
    }

    if (datemode === 1) {
        const ms = EXCEL_1904_EPOCH_MS + serial * MS_PER_DAY;
        return new Date(ms).toISOString();
    }

    let adjusted_serial = serial;
    if (adjusted_serial >= 60) {
        adjusted_serial -= 1;
    }

    const ms = EXCEL_1900_EPOCH_MS + adjusted_serial * MS_PER_DAY;
    return new Date(ms).toISOString();
}

/** Elapsed-time formats use bracketed hour/minute/second tokens like [h], [mm], [ss]. */
const ELAPSED_TIME_RE = /\[[hms]+\]/i;

/** Check whether an XF format index refers to a date/time format. */
export function is_date_format(xf_index: number, xfs: XfEntry[], format_map: Map<number, string>): boolean {
    if (!Number.isInteger(xf_index) || xf_index < 0 || xf_index >= xfs.length) return false;
    const fmt_index = xfs[xf_index].format_index;
    const fmt = format_map.get(fmt_index);
    if (fmt) return SSF.is_date(fmt) && !ELAPSED_TIME_RE.test(fmt);
    // Built-in formats 14-22, 27-36, 45-47 are dates
    const builtin = (SSF as Record<string, unknown>)._table as Record<number, string> | undefined;
    const builtin_fmt = builtin?.[fmt_index];
    if (builtin_fmt) return SSF.is_date(builtin_fmt) && !ELAPSED_TIME_RE.test(builtin_fmt);
    return false;
}

export function format_value(
    raw: number,
    xf_index: number,
    xfs: XfEntry[],
    format_map: Map<number, string>,
    datemode: DateMode
): string {
    if (!Number.isInteger(xf_index) || xf_index < 0 || xf_index >= xfs.length) return String(raw);
    const xf = xfs[xf_index];
    const fmt_index = xf.format_index;
    const fmt = format_map.get(fmt_index);
    const formatted_raw =
        datemode === 1 && is_date_format(xf_index, xfs, format_map)
            ? raw + 1462
            : raw;
    try {
        if (fmt) {
            return SSF.format(fmt, formatted_raw);
        }
        // SSF handles built-in format indices (0-49) natively
        return SSF.format(fmt_index, formatted_raw);
    } catch {
        return String(raw);
    }
}

export function get_style(xf_index: number, xfs: XfEntry[], fonts: FontEntry[]): { bold: boolean; italic: boolean } {
    if (!Number.isInteger(xf_index) || xf_index < 0 || xf_index >= xfs.length) return { bold: false, italic: false };
    const xf = xfs[xf_index];
    const font_idx = xf.font_index;
    if (!Number.isInteger(font_idx) || font_idx < 0 || font_idx >= fonts.length) return { bold: false, italic: false };
    return fonts[font_idx];
}
