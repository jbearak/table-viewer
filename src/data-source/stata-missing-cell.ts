import type { MissingType } from '@jbearak/dta-parser';
import type { RawCell } from './interface';

/** Stata missing identities (`.`, `.a` to `.z`) shared by buffered and file-backed DTA. */
export function raw_stata_missing_cell(code: MissingType): RawCell {
    return { raw: code, rawType: 'number', comparisonKey: `stata:missing:${code}` };
}
