// The URLs the About window can ask the main process to open, and the lookup
// that maps a renderer-supplied target name onto one.
//
// A module of its own, like notices-path.ts, for the same reason: it is pure
// (no electron, no fs) and therefore unit-testable, and getting it wrong shows
// up only as a dead link — or, in the prototype-chain case below, as a crash
// nobody sees until a user clicks.
//
// The main process owns the URL list so a compromised About renderer can pick
// only *which* of these three links opens, never the destination.

export const REPOSITORY_URL = 'https://github.com/jbearak/table-viewer';

/** Keyed by the target names about.ts sends (see AboutLink in
 *  desktop/preload/about-preload.ts). */
const ABOUT_LINKS: Record<string, string> = {
    license: `${REPOSITORY_URL}/blob/main/LICENSE`,
    notices: `${REPOSITORY_URL}/blob/main/NOTICE.md`,
};

/**
 * The URL for a link target, or undefined for anything else.
 *
 * Own-property-only on purpose: a plain `ABOUT_LINKS[target]` answers a truthy
 * *non-string* for `__proto__`, `constructor`, or `toString`, and passing one of
 * those to `shell.openExternal` throws synchronously inside an `ipcMain.on`
 * listener — an uncaught main-process exception, triggerable by the renderer,
 * from what reads like a harmless lookup.
 */
export function about_link_url(target: unknown): string | undefined {
    return typeof target === 'string' && Object.hasOwn(ABOUT_LINKS, target)
        ? ABOUT_LINKS[target]
        : undefined;
}
