import type { MissingType } from '@jbearak/dta-parser';
import type { RawCell } from './interface';

/** Stata missing identities are shared across DTA and profiled Arrow storage. */
export function raw_stata_missing_cell(code: MissingType): RawCell {
    return { raw: code, rawType: 'number', comparisonKey: `stata:missing:${code}` };
}
