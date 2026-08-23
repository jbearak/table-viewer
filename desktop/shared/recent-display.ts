// How one Recent entry reads in the launcher's rail.
//
// Pure and separate from the renderer for the same reason
// compare-dialog-model.ts is: the interesting part is the labelling rules — what
// a home-relative folder looks like, and what a comparison of two files in the
// same folder should say — and those are worth testing without a DOM.
import type { RecentEntry } from '../main/recent-documents';

/** One rendered row: a name line and the muted location line under it. */
export interface RecentRow {
    /** The file name, or "before.csv ↔ after.csv" for a comparison. */
    readonly title: string;
    /** Where it lives, home-relative. Empty when there is nothing to add. */
    readonly location: string;
    /** Full text for the row's tooltip: the untruncated path(s). */
    readonly tooltip: string;
    readonly isComparison: boolean;
}

/** The separator between a comparison's two sides. */
export const COMPARISON_SEPARATOR = ' ↔ ';

function base_name(file_path: string): string {
    // Both separators regardless of platform: the list is written by whichever
    // OS opened the file, and a userData directory can be carried between them.
    const parts = file_path.split(/[\\/]/).filter((part) => part !== '');
    return parts.length > 0 ? parts[parts.length - 1] : file_path;
}

function directory_name(file_path: string): string {
    const match = /^(.*)[\\/][^\\/]+$/.exec(file_path);
    return match ? match[1] : '';
}

/**
 * Shorten a directory for display: `~` for the home directory, and the path
 * itself otherwise.
 *
 * `home` is passed in rather than read from `os.homedir()` so this stays
 * loadable in the renderer bundle, which has no Node.
 */
export function display_directory(directory: string, home: string): string {
    if (directory === '') return '';
    if (home === '') return directory;
    if (directory === home) return '~';
    // The separator must be part of the match, or `/home/jo` would abbreviate
    // `/home/jonathan` to `~nathan`.
    for (const separator of ['/', '\\']) {
        const prefix = `${home}${separator}`;
        if (directory.startsWith(prefix)) {
            return `~${separator}${directory.slice(prefix.length)}`;
        }
    }
    return directory;
}

/**
 * The row for one entry.
 *
 * A comparison whose sides share a folder names that folder once; one that
 * spans two folders shows both full paths in the location line instead, because
 * "which two files" is the whole content of the row and a single folder name
 * that applied to only one of them would be a lie.
 */
export function recent_row(entry: RecentEntry, home: string): RecentRow {
    if (entry.kind === 'file') {
        return {
            title: base_name(entry.path),
            location: display_directory(directory_name(entry.path), home),
            tooltip: entry.path,
            isComparison: false,
        };
    }
    const original_directory = directory_name(entry.originalPath);
    const modified_directory = directory_name(entry.modifiedPath);
    const title = `${base_name(entry.originalPath)}${COMPARISON_SEPARATOR}`
        + `${base_name(entry.modifiedPath)}`;
    const tooltip = `${entry.originalPath}${COMPARISON_SEPARATOR}${entry.modifiedPath}`;
    return {
        title,
        location: original_directory === modified_directory
            ? display_directory(original_directory, home)
            : `${display_directory(original_directory, home)}${COMPARISON_SEPARATOR}`
                + `${display_directory(modified_directory, home)}`,
        tooltip,
        isComparison: true,
    };
}
