/**
 * What the host tells the webview about restructuring a workbook's worksheets:
 * per worksheet and per axis, whether Insert, Delete, Restore, and Move are
 * available, and the Structural Basis a first layout change records.
 *
 * Kept apart from the controller so the snapshot projection, publication, and
 * the save path all read one definition of the current file's basis. The
 * basis is the file the host already verifies saves against: its digest and
 * byte length as observed when the source was built, and the worksheet's
 * canonical row and column counts.
 */

import type { SheetMeta } from './data-source/interface';
import type { StructuralBasis } from './pending-changes';
import { MAX_SHEET_COLUMNS } from './spreadsheet-safety';
import type { TableFormatId } from './table-format';
import type { StructuralEditingCapability, WorksheetStructuralSupport } from './viewer-snapshot';
import { TOO_WIDE_TO_RESTRUCTURE_MESSAGE } from './worksheet-layout';

/**
 * Until the `.xlsx` structural writer lands (delivery step 9), every
 * `.xlsx` worksheet reports both axes unsupported with this reason.
 */
export const STRUCTURE_NOT_AVAILABLE_YET = 'Not available yet';

/** The physical observation a basis is computed from: what save verification checks. */
export interface StructuralBasisObservation {
    readonly digest: string;
    /** Byte length of the bytes `digest` covers; absent when the observation predates it. */
    readonly byteLength?: number;
}

/**
 * The current file's Structural Basis for one worksheet, or undefined when the
 * format cannot be restructured yet or the observation lacks a byte length.
 * Delimited files are one worksheet, so their basis is the whole file.
 */
export function current_structural_basis(
    format: TableFormatId,
    observation: StructuralBasisObservation | undefined,
    sheet: Pick<SheetMeta, 'sourceRowCount' | 'columnCount'> | undefined,
): StructuralBasis | undefined {
    if (format !== 'csv' && format !== 'tsv') return undefined;
    if (observation === undefined || sheet === undefined) return undefined;
    const { byteLength, digest } = observation;
    if (byteLength === undefined || !Number.isSafeInteger(byteLength) || byteLength < 0) {
        return undefined;
    }
    return Object.freeze({
        kind: 'delimited',
        byteLength,
        digest,
        sourceRowCount: sheet.sourceRowCount,
        sourceColumnCount: sheet.columnCount,
    });
}

const SUPPORTED = Object.freeze({ supported: true as const });

function unsupported(reason: string): WorksheetStructuralSupport {
    const axis = Object.freeze({ supported: false as const, reason });
    return Object.freeze({ rows: axis, columns: axis });
}

/**
 * The snapshot capability for every worksheet, positionally matching
 * `sheets`. CSV and TSV support both axes, except columns on a source wider
 * than `MAX_SHEET_COLUMNS`; `.xlsx` reports "Not available yet" on both. A
 * delimited sheet without a computable basis is refused the same way, since
 * the host would refuse its first layout publication.
 */
export function structural_editing_capability(
    format: TableFormatId,
    observation: StructuralBasisObservation | undefined,
    sheets: readonly Pick<SheetMeta, 'sourceRowCount' | 'columnCount'>[],
): StructuralEditingCapability {
    return Object.freeze({
        sheets: Object.freeze(sheets.map((sheet): WorksheetStructuralSupport => {
            const basis = current_structural_basis(format, observation, sheet);
            if (basis === undefined) return unsupported(STRUCTURE_NOT_AVAILABLE_YET);
            const columns = sheet.columnCount > MAX_SHEET_COLUMNS
                ? Object.freeze({ supported: false as const, reason: TOO_WIDE_TO_RESTRUCTURE_MESSAGE })
                : SUPPORTED;
            return Object.freeze({ rows: SUPPORTED, columns, basis });
        })),
    });
}
