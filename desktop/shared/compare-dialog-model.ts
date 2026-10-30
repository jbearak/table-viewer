// Pure decision logic for the Compare Files dialog: what the fields say about
// themselves, whether Compare is offerable, and what it should be called.
// Separated from the renderer so it is testable without Electron or a DOM.
import type { ComparePathCheck } from './ipc';

export type ComparePathState =
    | { readonly kind: 'empty' }
    | { readonly kind: 'ok'; readonly path: string; readonly extension: string }
    | { readonly kind: 'missing'; readonly path: string }
    | { readonly kind: 'unsupported'; readonly path: string }
    /** An existing folder, or a path with a unique completion pending. Neither
     *  is a file yet, but neither is a mistake to report — the user is still on
     *  their way to one. `completion`, when present, is what to fill in. */
    | {
        readonly kind: 'incomplete';
        readonly path: string;
        readonly completion?: string;
    };

/** Report a checked path as the state the field should render. */
export function path_state(path: string, check: ComparePathCheck | undefined): ComparePathState {
    // Trimmed only to decide emptiness. The path itself is carried through as
    // typed, because a filename may legitimately begin or end with a space and
    // the state must name the file that was actually checked.
    if (path.trim() === '') return { kind: 'empty' };
    if (!check) return { kind: 'empty' };
    if (!check.exists) {
        // Reported before "missing", because both of these mean the path is
        // unfinished rather than wrong. Accusing someone of a nonexistent file
        // while they are still typing its name is the complaint this answers.
        if (check.isDirectory === true || check.completion !== undefined) {
            return {
                kind: 'incomplete',
                path,
                ...(check.completion !== undefined
                    ? { completion: check.completion }
                    : {}),
            };
        }
        return { kind: 'missing', path };
    }
    if (!check.supported) return { kind: 'unsupported', path };
    return { kind: 'ok', path, extension: check.extension };
}

/** The message a field shows under itself, or undefined when it is fine. */
export function path_error(state: ComparePathState): string | undefined {
    switch (state.kind) {
        case 'missing':
            return 'That file does not exist.';
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
    // A side with a completion pending counts as offerable, because Compare is
    // one of the two moments the dialog finishes a path (blur is the other).
    // Leaving the button dead until the last letter meant the click that was
    // supposed to complete the path could never be made.
    const completable = (state: ComparePathState) =>
        state.kind === 'incomplete' && state.completion !== undefined;
    if (completable(original) || completable(modified)) {
        const blocked = [original, modified].some((state) =>
            state.kind !== 'ok' && !completable(state));
        return blocked
            ? { canCompare: false, compareLabel: 'Compare' }
            : { canCompare: true, compareLabel: 'Compare' };
    }
    if (original.kind !== 'ok' || modified.kind !== 'ok') {
        return { canCompare: false, compareLabel: 'Compare' };
    }
    if (original.path === modified.path) {
        // A warning, not a refusal: comparing a file with itself is a
        // reasonable way to confirm a tool changed nothing, and the result
        // says so honestly.
        return {
            canCompare: true,
            compareLabel: 'Compare Anyway',
            warning: 'Those are the same file, so nothing will differ.',
        };
    }
    if (original.extension !== modified.extension) {
        const single_table = (extension: string) =>
            ['csv', 'tsv', 'dta'].includes(extension);
        const original_is_single_table = single_table(original.extension);
        const modified_is_single_table = single_table(modified.extension);
        let warning = 'These files are in different formats.';
        // A single-table file is treated as one sheet, so pairing it with a
        // workbook compares it against that workbook's first sheet and reports
        // the rest as one-sided. Which side the workbook is on decides whether
        // those sheets read as added or deleted, so the warning has to name it.
        if (original_is_single_table !== modified_is_single_table) {
            warning = original_is_single_table
                ? 'Different formats. The original is compared as a single sheet; '
                    + 'the modified workbook\u2019s other sheets will show as added.'
                : 'Different formats. The modified file is compared as a single sheet; '
                    + 'the original workbook\u2019s other sheets will show as deleted.';
        }
        return { canCompare: true, compareLabel: 'Compare Anyway', warning };
    }
    return { canCompare: true, compareLabel: 'Compare' };
}
