// Pure decision logic for the Compare Files dialog: what the fields say about
// themselves, whether Compare is offerable, and what it should be called.
// Separated from the renderer so it is testable without Electron or a DOM.
import type { ComparePathCheck } from './ipc';

export type ComparePathState =
    | { readonly kind: 'empty' }
    | { readonly kind: 'ok'; readonly path: string; readonly extension: string }
    | { readonly kind: 'missing'; readonly path: string }
    | { readonly kind: 'unsupported'; readonly path: string };

/** Report a checked path as the state the field should render. */
export function path_state(path: string, check: ComparePathCheck | undefined): ComparePathState {
    const trimmed = path.trim();
    if (trimmed === '') return { kind: 'empty' };
    if (!check) return { kind: 'empty' };
    if (!check.exists) return { kind: 'missing', path: trimmed };
    if (!check.supported) return { kind: 'unsupported', path: trimmed };
    return { kind: 'ok', path: trimmed, extension: check.extension };
}

/** The message a field shows under itself, or undefined when it is fine. */
export function path_error(state: ComparePathState): string | undefined {
    switch (state.kind) {
        case 'missing':
            return 'That file no longer exists.';
        case 'unsupported':
            return 'Table Viewer cannot open that kind of file.';
        default:
            return undefined;
    }
}

export interface CompareDialogState {
    /** Whether the Compare button can be pressed. */
    readonly canCompare: boolean;
    /** The Compare button's label — "Compare Anyway" when a warning stands. */
    readonly compareLabel: string;
    /** A caveat the user should see before comparing, but which does not block. */
    readonly warning?: string;
}

/**
 * Whether the two chosen paths can be compared, and with what caveat.
 *
 * Cross-format and same-file pairs are warnings rather than refusals: comparing
 * a CSV export against its XLSX source is a real thing to want, and the result
 * is honest about what it found. Only a path that cannot be read at all blocks.
 */
export function dialog_state(
    original: ComparePathState,
    modified: ComparePathState,
): CompareDialogState {
    if (original.kind !== 'ok' || modified.kind !== 'ok') {
        return { canCompare: false, compareLabel: 'Compare' };
    }
    if (original.path === modified.path) {
        return {
            canCompare: false,
            compareLabel: 'Compare',
            warning: 'Those are the same file.',
        };
    }
    if (original.extension !== modified.extension) {
        const csv_like = (extension: string) => extension === 'csv' || extension === 'tsv';
        // A CSV is one sheet, so pairing it with a workbook compares it against
        // that workbook's first sheet and calls the rest added. Worth saying
        // before the grid says it in bulk.
        const warning = csv_like(original.extension) !== csv_like(modified.extension)
            ? 'Different formats. The delimited file is compared as a single sheet; '
                + 'any other sheets will show as added.'
            : 'These files are in different formats.';
        return { canCompare: true, compareLabel: 'Compare Anyway', warning };
    }
    return { canCompare: true, compareLabel: 'Compare' };
}
