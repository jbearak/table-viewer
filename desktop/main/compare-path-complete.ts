// Filesystem-facing half of the Compare dialog's path field: what a typed path
// is, and what it might be on its way to becoming.
//
// Separate from main.ts so it can be tested against a real temp directory
// without an Electron app, and separate from shared/compare-dialog-model.ts
// because that module is deliberately filesystem-free.
import * as fs from 'fs';
import * as path from 'path';

/**
 * The one existing entry `candidate` is a proper prefix of, or undefined.
 *
 * Only a unique match completes. Two files sharing the prefix means the user
 * has not yet said which they mean, and picking one for them would silently
 * open the wrong file. Directories complete too — `~/rep` → `~/repos/` is
 * progress toward a file even though it is not one.
 *
 * `tilde_home` is the home directory `~` stands for, passed in rather than read
 * from the environment so the expansion is testable.
 */
export function unique_completion(
    candidate: string,
    tilde_home?: string,
): string | undefined {
    if (candidate.trim() === '') return undefined;
    const expanded = expand_tilde(candidate, tilde_home);
    // A trailing separator already names a directory; there is no partial
    // segment to finish, so there is nothing to complete.
    if (expanded.endsWith(path.sep)) return undefined;
    const parent = path.dirname(expanded);
    const partial = path.basename(expanded);
    if (partial === '') return undefined;
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(parent, { withFileTypes: true });
    } catch {
        return undefined;
    }
    const matches = entries.filter((entry) =>
        entry.name.startsWith(partial) && entry.name !== partial);
    if (matches.length !== 1) return undefined;
    const completed = path.join(parent, matches[0].name);
    // Directories get the separator, so the next keystroke continues the path
    // rather than landing against the folder name.
    return matches[0].isDirectory() ? completed + path.sep : completed;
}

/** `~` and `~/x` against the supplied home directory; anything else unchanged. */
export function expand_tilde(candidate: string, tilde_home?: string): string {
    if (!tilde_home) return candidate;
    if (candidate === '~') return tilde_home;
    // Both separators, not just `path.sep`. On Windows `path.sep` is `\`, but
    // `~/reports` is what people type and what every shell accepts, and Windows
    // takes forward slashes everywhere else too. Matching only `path.sep` there
    // left `~/x` unexpanded — the path was then checked, and opened, literally.
    if (candidate.startsWith('~/') || candidate.startsWith(`~${path.sep}`)) {
        return path.join(tilde_home, candidate.slice(2));
    }
    return candidate;
}

/** Whether the path names an existing directory. */
export function is_existing_directory(
    candidate: string,
    tilde_home?: string,
): boolean {
    if (candidate.trim() === '') return false;
    try {
        return fs.statSync(expand_tilde(candidate, tilde_home)).isDirectory();
    } catch {
        return false;
    }
}
