// The launcher's Recent list: the files and comparisons this app has opened,
// newest first.
//
// Separate from `app.addRecentDocument`, which main.ts also still calls. That
// one feeds the OS list (the dock menu, the Windows Jump List) and is
// deliberately write-only — Electron exposes no way to read it back, and on
// Linux there is nothing there at all. The launcher needs to *display* the list,
// so it needs its own record. Comparisons are the other reason: the OS list
// holds paths, and a comparison is a pair, which has no representation there.
//
// Pure Node (no electron import) so it is unit-testable; main.ts passes the
// `app.getPath('userData')` value, exactly as `settings_file_path` and
// `save_open_window_paths` do.
import * as fs from 'fs';
import * as path from 'path';

export const RECENT_DOCUMENTS_FILE_NAME = 'recent-documents.json';

export function recent_documents_file_path(user_data_dir: string): string {
    return path.join(user_data_dir, RECENT_DOCUMENTS_FILE_NAME);
}

/** One thing the app opened. `openedAt` is epoch milliseconds. */
export type RecentEntry =
    | { readonly kind: 'file'; readonly path: string; readonly openedAt: number }
    | {
        readonly kind: 'comparison';
        readonly originalPath: string;
        readonly modifiedPath: string;
        readonly openedAt: number;
    };

/**
 * How many entries the file keeps.
 *
 * Larger than the launcher shows (`RECENT_DISPLAY_LIMIT`), on purpose: entries
 * are filtered against the filesystem at display time, so a list trimmed to
 * exactly the display limit would show fewer than that many rows as soon as one
 * file was moved away, with nothing behind it to take its place.
 */
export const RECENT_HISTORY_LIMIT = 30;
/** How many entries the launcher renders. */
export const RECENT_DISPLAY_LIMIT = 8;

/**
 * The identity two entries are the same document under.
 *
 * Reopening a file must move its existing entry rather than add a second one,
 * and a comparison is identified by its ordered pair — swapping the sides is a
 * different comparison, because which file is "original" decides the direction
 * every difference is reported in.
 */
function identity(entry: RecentEntry): string {
    return entry.kind === 'file'
        ? `file ${entry.path}`
        : `comparison ${entry.originalPath} ${entry.modifiedPath}`;
}

function is_record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse one stored entry, or reject it. Anything unrecognized is dropped
 *  rather than repaired: a Recent list is a convenience, and a malformed entry
 *  that survived into the UI would be a row that cannot be opened. */
function parse_entry(value: unknown): RecentEntry | undefined {
    if (!is_record(value)) return undefined;
    const opened_at = value.openedAt;
    if (typeof opened_at !== 'number' || !Number.isFinite(opened_at)) return undefined;
    if (value.kind === 'file') {
        return typeof value.path === 'string' && value.path !== ''
            ? { kind: 'file', path: value.path, openedAt: opened_at }
            : undefined;
    }
    if (value.kind === 'comparison') {
        return typeof value.originalPath === 'string' && value.originalPath !== ''
            && typeof value.modifiedPath === 'string' && value.modifiedPath !== ''
            ? {
                kind: 'comparison',
                originalPath: value.originalPath,
                modifiedPath: value.modifiedPath,
                openedAt: opened_at,
            }
            : undefined;
    }
    return undefined;
}

/** Every stored entry, newest first, without touching the filesystem to check
 *  whether the paths still resolve — see `usable_recent_entries` for that. */
export function read_recent_entries(user_data_dir: string): RecentEntry[] {
    let raw: unknown;
    try {
        raw = JSON.parse(fs.readFileSync(recent_documents_file_path(user_data_dir), 'utf8'));
    } catch {
        // No list yet, or an unreadable one. Either way the app opens with an
        // empty Recent rail rather than failing to start.
        return [];
    }
    if (!Array.isArray(raw)) return [];
    const entries: RecentEntry[] = [];
    const seen = new Set<string>();
    for (const candidate of raw) {
        const entry = parse_entry(candidate);
        if (!entry) continue;
        // A duplicate can only come from a hand-edited or partially-written
        // file; keep the first, which is the newer one.
        const key = identity(entry);
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push(entry);
    }
    entries.sort((left, right) => right.openedAt - left.openedAt);
    return entries.slice(0, RECENT_HISTORY_LIMIT);
}

function write_recent_entries(user_data_dir: string, entries: readonly RecentEntry[]): void {
    const target = recent_documents_file_path(user_data_dir);
    fs.mkdirSync(user_data_dir, { recursive: true });
    // Same write-then-rename as `save_open_window_paths`: a list truncated by a
    // crash mid-write would be read back as an empty one.
    const temporary = `${target}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(
            temporary,
            JSON.stringify(entries),
            { encoding: 'utf8', mode: 0o600 },
        );
        fs.renameSync(temporary, target);
    } catch (error) {
        try {
            fs.rmSync(temporary, { force: true });
        } catch {
            // Best-effort temp cleanup.
        }
        throw error;
    }
}

/**
 * Record one opened document and return the resulting list, newest first.
 *
 * Returns rather than only writes so a caller that has to tell the launcher
 * what changed does not have to read the file back to find out.
 */
export function record_recent_entry(
    user_data_dir: string,
    entry: RecentEntry,
): RecentEntry[] {
    const key = identity(entry);
    const entries = [
        entry,
        ...read_recent_entries(user_data_dir).filter((existing) => identity(existing) !== key),
    ].slice(0, RECENT_HISTORY_LIMIT);
    write_recent_entries(user_data_dir, entries);
    return entries;
}

/**
 * The entries worth offering, capped at the display limit.
 *
 * `is_usable` decides — main.ts passes the same file check the restore path
 * uses. Entries that fail are skipped rather than deleted: a file on an
 * unmounted volume is not gone, and forgetting it the one time the launcher was
 * opened without that disk attached is the wrong outcome. A comparison needs
 * both of its sides.
 */
export function usable_recent_entries(
    entries: readonly RecentEntry[],
    is_usable: (file_path: string) => boolean,
    limit: number = RECENT_DISPLAY_LIMIT,
): RecentEntry[] {
    const usable: RecentEntry[] = [];
    for (const entry of entries) {
        const ok = entry.kind === 'file'
            ? is_usable(entry.path)
            : is_usable(entry.originalPath) && is_usable(entry.modifiedPath);
        if (ok) usable.push(entry);
        if (usable.length === limit) break;
    }
    return usable;
}

/** Forget everything. Backs the launcher's "Clear" affordance, so the OS list's
 *  Clear Menu item and this one can be kept in step. */
export function clear_recent_entries(user_data_dir: string): void {
    try {
        fs.rmSync(recent_documents_file_path(user_data_dir), { force: true });
    } catch {
        // Nothing to clear, or a file we cannot remove; either way the caller
        // has nothing to do about it.
    }
}
