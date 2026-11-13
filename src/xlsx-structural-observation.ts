/**
 * What the host learns about an `.xlsx` package's structure once per source
 * generation: the per-part digests its Structural Basis is made of, and the
 * structural support scan.
 *
 * The design ("External changes") makes an `.xlsx` worksheet's Structural
 * Basis the SHA-256 digests of the parts the save planner reads to restructure
 * it: the worksheet part, `sharedStrings.xml`, `styles.xml`, and
 * `workbook.xml`. A tool that rewrites only another worksheet's part leaves
 * the basis intact. The digests are of the parts' uncompressed bytes, so a
 * re-zip that keeps every part's content keeps the basis too.
 *
 * The scan ("XLSX structural support") runs with the tokenizer wired in as
 * its `formula_is_anchorable` check, so a formula the renderer could not
 * adjust refuses its worksheets before the user starts. Its answer is
 * advisory; the save planner runs the same scan on the bytes it rewrites.
 *
 * The paths are the ones the reader and the cell writer read
 * (`/xl/workbook.xml`, `/xl/sharedStrings.xml`, `/xl/styles.xml`), so the
 * basis covers exactly what a save depends on.
 */

import { content_digest } from './content-digest';
import { formula_blocks_structure } from './formula-anchors';
import { worksheet_part_entries_from_package } from './parse-xlsx';
import {
    scan_xlsx_structural_support,
    unanchorable_formula_refusal,
    type FormulaAnchorabilityCheck,
    type WorksheetStructuralSupport,
} from './xlsx-structural-support';
import { ZipPackage } from './zip-package';

export const XLSX_WORKBOOK_PART = 'xl/workbook.xml';
export const XLSX_SHARED_STRINGS_PART = 'xl/sharedStrings.xml';
export const XLSX_STYLES_PART = 'xl/styles.xml';

/** The digests one worksheet's `.xlsx` Structural Basis is made of. */
export interface XlsxPartDigests {
    readonly workbookDigest: string;
    readonly sharedStringsDigest: string | null;
    readonly stylesDigest: string | null;
    /** Per worksheet, in reader order; null for a part the package lacks. */
    readonly worksheetPartDigests: readonly (string | null)[];
}

export interface XlsxStructuralObservation {
    /** Undefined when the package cannot be read as a workbook. */
    readonly parts?: XlsxPartDigests;
    /** Per worksheet in reader order; undefined when the scan itself failed. */
    readonly support?: readonly WorksheetStructuralSupport[];
}

/** Rule 5 of the allowlist: the reference tokenizer decides what can be anchored. */
export const formula_is_anchorable: FormulaAnchorabilityCheck = (formula) => {
    const issue = formula_blocks_structure(formula);
    return issue === undefined
        ? undefined
        : unanchorable_formula_refusal(formula, formula.slice(issue.start, issue.end));
};

function part_digest(zip: ZipPackage, path: string): string | null {
    const bytes = zip.read(`/${path}`);
    return bytes === null ? null : content_digest(bytes);
}

/** Per-part digests of a package, or undefined when it is not a readable workbook. */
export function xlsx_part_digests(raw: Uint8Array): XlsxPartDigests | undefined {
    try {
        const zip = ZipPackage.open(raw);
        const workbookDigest = part_digest(zip, XLSX_WORKBOOK_PART);
        if (workbookDigest === null) return undefined;
        return Object.freeze({
            workbookDigest,
            sharedStringsDigest: part_digest(zip, XLSX_SHARED_STRINGS_PART),
            stylesDigest: part_digest(zip, XLSX_STYLES_PART),
            worksheetPartDigests: Object.freeze(worksheet_part_entries_from_package(zip)
                .map((entry) => part_digest(zip, entry.path))),
        });
    } catch {
        return undefined;
    }
}

/** The structural support scan with the tokenizer wired in, or undefined when it cannot run. */
export function xlsx_structural_support(raw: Uint8Array): readonly WorksheetStructuralSupport[] | undefined {
    try {
        return Object.freeze(scan_xlsx_structural_support(raw, { formula_is_anchorable }));
    } catch {
        return undefined;
    }
}

/** Both, for one source generation's bytes. */
export function observe_xlsx_structure(raw: Uint8Array): XlsxStructuralObservation {
    const parts = xlsx_part_digests(raw);
    const support = parts === undefined ? undefined : xlsx_structural_support(raw);
    return Object.freeze({
        ...(parts === undefined ? {} : { parts }),
        ...(support === undefined ? {} : { support }),
    });
}
