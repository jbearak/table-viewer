import { text_styles_equal, type CellTextStyle, type RichTextRun } from './cell-content';
import type { DateMode } from './spreadsheet-format';

const MS_PER_DAY = 86400000;
const EXCEL_1900_EPOCH_MS = Date.UTC(1899, 11, 31);
const EXCEL_1904_EPOCH_MS = Date.UTC(1904, 0, 1);

/**
 * Excel accepts a narrow set of unambiguous date spellings. Locale-sensitive
 * dates stay strings rather than being guessed incorrectly.
 */
const ISO_DATE_RE
    = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** Convert an ISO date string to an Excel serial, or null if it is not valid. */
export function iso_to_serial(text: string, datemode: DateMode): number | null {
    // Excel serials are naive wall-clock values, so an accepted timezone suffix
    // does not shift the visible date/time.
    const m = ISO_DATE_RE.exec(text.trim());
    if (!m) return null;
    const [, y, mo, d, hh, mm, ss, ms] = m;
    const year = Number(y), month = Number(mo), day = Number(d);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const hour = hh ? Number(hh) : 0;
    const minute = mm ? Number(mm) : 0;
    const second = ss ? Number(ss) : 0;
    if (hour > 23 || minute > 59 || second > 59) return null;
    const utc = Date.UTC(
        year, month - 1, day, hour, minute, second,
        ms ? Number(ms.padEnd(3, '0')) : 0,
    );
    if (!Number.isFinite(utc)) return null;
    const back = new Date(utc);
    if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) {
        return null;
    }
    if (datemode === 1) return (utc - EXCEL_1904_EPOCH_MS) / MS_PER_DAY;
    const serial = (utc - EXCEL_1900_EPOCH_MS) / MS_PER_DAY;
    return serial >= 60 ? serial + 1 : serial;
}

/**
 * Excel's numeric literal grammar, excluding redundant leading zeros so IDs and
 * account numbers keep the spelling the user typed.
 */
const NUMBER_RE = /^[+-]?((0|[1-9]\d*)(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const MAX_EXACT_DIGITS = 15;

function significant_digits(text: string): number {
    const mantissa = text.replace(/[eE][+-]?\d+$/, '').replace(/[+-]/, '').replace('.', '');
    return mantissa.replace(/^0+/, '').length;
}

function boolean_literal(value: string): '1' | '0' | null {
    const text = value.trim().toUpperCase();
    if (text === 'TRUE') return '1';
    if (text === 'FALSE') return '0';
    return null;
}

/** Whether runs carry styling beyond the cell font and must be saved as rich text. */
export function xlsx_runs_require_inline_string(
    runs: readonly RichTextRun[],
    cell_style: CellTextStyle | undefined,
): boolean {
    return runs.length > 0
        && !runs.every((run) => text_styles_equal(run.style, cell_style));
}

export interface XlsxValueClassificationContext {
    readonly datemode: DateMode;
    readonly is_date_style: (serial: number) => boolean;
    readonly was_boolean?: boolean;
    readonly was_iso_date?: boolean;
}

export type XlsxValueClassification =
    | { readonly kind: 'empty' }
    | { readonly kind: 'number'; readonly text: string }
    | { readonly kind: 'string'; readonly text: string }
    | { readonly kind: 'boolean'; readonly text: '1' | '0' }
    | { readonly kind: 'iso-date'; readonly text: string };

/** Classify typed text exactly once for both XLSX save and dirty-cell preview. */
export function classify_xlsx_cell_value(
    value: string,
    context: XlsxValueClassificationContext,
): XlsxValueClassification {
    if (value === '') return { kind: 'empty' };

    const serial = iso_to_serial(value, context.datemode);
    if (context.was_iso_date && serial !== null) {
        return { kind: 'iso-date', text: value.trim().replace(' ', 'T') };
    }

    if (context.was_boolean) {
        const bool = boolean_literal(value);
        if (bool !== null) return { kind: 'boolean', text: bool };
    }

    if (serial !== null && serial >= 0 && context.is_date_style(serial)) {
        return { kind: 'number', text: String(serial) };
    }

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
