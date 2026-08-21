import { describe, it, expect } from 'vitest';
import {
    format_xlsx_edit_preview,
    is_valid_excel_date_serial,
    number_format_is_date,
    number_format_section_for_value,
    resolve_number_format,
    serial_to_iso,
} from '../spreadsheet-format';

const MS_PER_DAY = 86400000;
const MIN_JS_DATE_MS = Date.UTC(-271821, 3, 20);
const MAX_JS_DATE_MS = Date.UTC(275760, 8, 13);
const EXCEL_1900_EPOCH_MS = Date.UTC(1899, 11, 31);
const EXCEL_1904_EPOCH_MS = Date.UTC(1904, 0, 1);

function get_test_bounds(datemode: 0 | 1): { min: number; max: number } {
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

describe('dirty XLSX number-format preview', () => {
    it('formats scalar numeric edits without changing their typed spelling', () => {
        expect(format_xlsx_edit_preview('9876.5', { code: '#,##0.00' }))
            .toBe('9,876.50');
        expect(format_xlsx_edit_preview('0.75', { code: '0%' })).toBe('75%');
    });

    it.each([
        '007',
        '007.5',
        '1234567890123456',
        '1e-400',
        'Infinity',
        '1,234.5',
    ])('keeps %s literal when save will preserve it as text', (value) => {
        expect(format_xlsx_edit_preview(value, { code: '#,##0.00' })).toBe(value);
    });

    it('formats ISO input only when its candidate section is date-like', () => {
        const date_first = { code: '[>40000]m/d/yyyy;0' };
        const number_first = { code: '[>50000]m/d/yyyy;0' };
        expect(format_xlsx_edit_preview('2024-01-15', date_first)).toBe('1/15/2024');
        expect(format_xlsx_edit_preview('2024-01-15', number_first)).toBe('2024-01-15');
        expect(number_format_is_date(date_first, 45306)).toBe(true);
        expect(number_format_is_date(number_first, 45306)).toBe(false);
    });

    it('uses the workbook date system for date previews', () => {
        expect(format_xlsx_edit_preview(
            '2024-01-15',
            { code: 'yyyy-mm-dd', date1904: true },
        )).toBe('2024-01-15');
    });

    it('selects mixed numeric/date sections before applying the 1904 date offset', () => {
        const format = { code: 'yyyy-mm-dd;0', date1904: true as const };
        expect(format_xlsx_edit_preview('12', format)).toBe('1904-01-13');
        expect(format_xlsx_edit_preview('-12', format)).toBe('12');
    });

    it('preserves existing boolean and native ISO-date scalar types', () => {
        expect(format_xlsx_edit_preview(' false ', { code: '0' }, { was_boolean: true }))
            .toBe('FALSE');
        expect(format_xlsx_edit_preview(
            '2024-01-15 12:30:00Z',
            { code: 'yyyy-mm-dd' },
            { was_iso_date: true },
        )).toBe('2024-01-15T12:30:00Z');
    });

    it('leaves rich/styled edits as exact text', () => {
        expect(format_xlsx_edit_preview('1234.5', { code: '#,##0.00' }, { force_text: true }))
            .toBe('1234.5');
    });

    it('resolves built-in and custom recipes but omits General and unknown formats', () => {
        const xfs = [
            { font_index: 0, format_index: 0 },
            { font_index: 0, format_index: 10 },
            { font_index: 0, format_index: 164 },
            { font_index: 0, format_index: 999 },
        ];
        const formats = new Map([[164, '#,##0.000']]);
        expect(resolve_number_format(0, xfs, formats, 0)).toBeUndefined();
        expect(resolve_number_format(1, xfs, formats, 0)?.code).toBe('0.00%');
        expect(resolve_number_format(2, xfs, formats, 1)).toEqual({
            code: '#,##0.000',
            date1904: true,
        });
        expect(resolve_number_format(3, xfs, formats, 0)).toBeUndefined();
    });

    it('resolves built-in formats through the same fallbacks SSF uses', () => {
        const xfs = [5, 41, 27].map((format_index) => ({ font_index: 0, format_index }));
        const currency = resolve_number_format(0, xfs, new Map(), 0);
        const accounting = resolve_number_format(1, xfs, new Map(), 0);
        const locale_date = resolve_number_format(2, xfs, new Map(), 0);
        expect(currency?.code).toBe('#,##0 ;(#,##0)');
        expect(format_xlsx_edit_preview('1234.5', currency!)).toBe('1,235 ');
        expect(accounting?.code).toContain('_(* #,##0_)');
        expect(format_xlsx_edit_preview('1234.5', accounting!)).toContain('1,235');
        expect(locale_date?.code).toBe('m/d/yy');
        expect(format_xlsx_edit_preview('2024-01-15', locale_date!)).toBe('1/15/24');
    });

    it('selects conditional sections without splitting quoted semicolons', () => {
        const code = '[Red][>10]"high;value";[<=10]0.00;"fallback"';
        expect(number_format_section_for_value(code, 11)).toContain('high;value');
        expect(number_format_section_for_value(code, 10)).toBe('[<=10]0.00');
    });
});

describe('spreadsheet-format date serial guards', () => {
    it('converts valid in-range serials in both date modes', () => {
        expect(serial_to_iso(1, 0)).toContain('1900-01-01');
        expect(serial_to_iso(0, 1)).toContain('1904-01-01');
    });

    it('rejects non-finite serials', () => {
        expect(is_valid_excel_date_serial(Number.POSITIVE_INFINITY, 0)).toBe(false);
        expect(is_valid_excel_date_serial(Number.NaN, 1)).toBe(false);
        expect(() => serial_to_iso(Number.POSITIVE_INFINITY, 0)).toThrow('finite number');
    });

    it('rejects serials below the supported lower bound', () => {
        const { min } = get_test_bounds(1);
        expect(is_valid_excel_date_serial(min, 1)).toBe(true);
        expect(is_valid_excel_date_serial(min - 1, 1)).toBe(false);
    });

    it('rejects serials above the supported upper bound', () => {
        const { max } = get_test_bounds(0);
        expect(is_valid_excel_date_serial(max, 0)).toBe(true);
        expect(is_valid_excel_date_serial(max + 1, 0)).toBe(false);
    });

    it('throws a clear range error for finite but out-of-range serials', () => {
        const { max } = get_test_bounds(0);
        expect(() => serial_to_iso(max + 1, 0)).toThrow('out of range');
    });
});
