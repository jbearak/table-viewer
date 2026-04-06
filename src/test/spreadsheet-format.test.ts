import { describe, it, expect } from 'vitest';
import { is_valid_excel_date_serial, serial_to_iso } from '../spreadsheet-format';

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
