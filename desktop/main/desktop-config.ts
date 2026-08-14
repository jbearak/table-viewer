// Desktop settings store: a small JSON file under the app's userData dir that
// backs the shared `ConfigPort` (src/host-ports.ts) plus the Preferences
// window. Pure Node (no electron import) so it is unit-testable; main.ts
// passes `app.getPath('userData')`-derived paths.
import * as fs from 'fs';
import * as path from 'path';
import type { ConfigPort, Disposable } from '../../src/host-ports';
import {
    sanitize_theme_id,
    sanitize_theme_setting,
    type ThemeId,
    type ThemeSetting,
} from './theme';
import {
    DEFAULT_WINDOW_HEIGHT,
    DEFAULT_WINDOW_WIDTH,
    MIN_WINDOW_HEIGHT,
    MIN_WINDOW_WIDTH,
    sanitize_new_window_size_mode,
    type NewWindowSizeMode,
} from './window-geometry';
import { MONO_FONT, font_family_with_fallback } from './theme-palette';

export const SETTINGS_FILE_NAME = 'settings.json';

export function settings_file_path(user_data_dir: string): string {
    return path.join(user_data_dir, SETTINGS_FILE_NAME);
}

/**
 * The physical spelling of a userData directory, for the paths that must agree
 * about identity rather than merely about text.
 *
 * `app.requestSingleInstanceLock()` is keyed on the userData path Electron was
 * given, not on the directory it resolves to, so two launches that name one
 * directory differently — through a symlink, a `.`-relative path, or a
 * case-different spelling on a case-insensitive volume — each win the lock and
 * then coordinate through the same `state/` tree while each believes it is alone.
 * That matters more here than it would for a cache, because "Set Aside and Start
 * Fresh" carries an all-processes-closed attestation under which the shared
 * backend will reclaim a peer's reader token by exact id and move the database out
 * from under its live handle.
 *
 * Only the *existing* prefix is resolved, and the remainder is appended
 * unresolved: on a first launch the directory does not exist yet, and `realpath`
 * on a missing path throws — refusing to start over a directory Electron is about
 * to create would be a worse outcome than an unresolved name. Any failure falls
 * back to the input for the same reason: this narrows an aliasing hole, it is not
 * a precondition for running.
 */
export function canonical_existing_path(target: string): string {
    const absolute = path.resolve(target);
    let existing = absolute;
    const missing: string[] = [];
    for (;;) {
        try {
            return path.join(fs.realpathSync.native(existing), ...missing);
        } catch {
            const parent = path.dirname(existing);
            // The filesystem root itself did not resolve: nothing above it left
            // to try, so the caller gets the name it gave us.
            if (parent === existing) return absolute;
            missing.unshift(path.basename(existing));
            existing = parent;
        }
    }
}

export interface DesktopSettings {
    /** Empty string means "use the theme default font". */
    fontFamily: string;
    /** Font size in px, applied to the whole app (viewer windows, welcome, prefs). */
    fontSize: number;
    /** Appearance: follow the OS, or pin light / dark. */
    theme: ThemeSetting;
    /** Which theme paints light mode, and which paints dark mode. Two slots,
     *  not one: switching appearance back and forth must not lose the theme
     *  picked for the other mode. `theme` above still decides *which* mode. */
    lightThemeId: ThemeId;
    darkThemeId: ThemeId;
    tabOrientation: 'horizontal' | 'vertical';
    csvMaxRows: number;
    maxFileSizeMiB: number;
    maxStoredFiles: number;
    /** Check the release feed once after the desktop app finishes opening. */
    automaticallyCheckForUpdates: boolean;
    /** The available version whose notification the user dismissed. Empty means
     *  no version is dismissed. This is internal update state, not a control in
     *  Preferences; a newer release replaces it when that release is dismissed. */
    dismissedUpdateVersion: string;
    /** Whether the two sizes below are tracked from the windows the user
     *  resizes, or typed in the Preferences window. */
    newWindowSize: NewWindowSizeMode;
    /** Size a new viewer window opens at. Under `match-last` the app writes
     *  these as viewer windows are resized and closed; under `fixed` only the
     *  Preferences window writes them.
     *
     *  One pair for both modes, unlike the two theme slots above: going
     *  `fixed` → `match-last` → `fixed` does lose the typed size, but a size
     *  is not a choice the way a theme is — the tracked value is a perfectly
     *  good starting point to re-type from, whereas the theme you had picked
     *  for the other mode is not recoverable by looking at it. */
    windowWidth: number;
    windowHeight: number;
}

/** Smallest / largest usable app font size; the prefs input clamps to these. */
export const MIN_FONT_SIZE_PX = 8;
export const MAX_FONT_SIZE_PX = 32;

/** Defaults mirror the VS Code contribution defaults in package.json, except:
 *  the worksheet tab orientation, which is vertical here (there is no editor tab
 *  strip to compete with); the font size, which has no editor setting to inherit
 *  on the desktop; and the appearance, which has no counterpart at all (in VS
 *  Code the viewer takes the editor's theme). */
export const DEFAULT_SETTINGS: Readonly<DesktopSettings> = Object.freeze({
    fontFamily: '',
    fontSize: 13,
    theme: 'system',
    lightThemeId: 'light',
    darkThemeId: 'dark',
    tabOrientation: 'vertical',
    csvMaxRows: 1_000_000,
    maxFileSizeMiB: 256,
    maxStoredFiles: 10_000,
    automaticallyCheckForUpdates: true,
    dismissedUpdateVersion: '',
    newWindowSize: 'match-last',
    windowWidth: DEFAULT_WINDOW_WIDTH,
    windowHeight: DEFAULT_WINDOW_HEIGHT,
});

function sanitize_number(value: unknown, fallback: number, minimum: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.max(minimum, value);
}

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(maximum, Math.max(minimum, value));
}

/** Coerce an untrusted parsed blob into a complete, valid settings object. */
export function sanitize_settings(raw: unknown): DesktopSettings {
    const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    return {
        fontFamily: typeof record.fontFamily === 'string' ? record.fontFamily : DEFAULT_SETTINGS.fontFamily,
        fontSize: clamp(
            Math.round(sanitize_number(
                record.fontSize,
                DEFAULT_SETTINGS.fontSize,
                MIN_FONT_SIZE_PX,
            )),
            MIN_FONT_SIZE_PX,
            MAX_FONT_SIZE_PX,
        ),
        theme: sanitize_theme_setting(record.theme),
        // Each slot is validated against its own fixed kind, always — not just
        // the slot the current appearance uses. Validating only the active one
        // would let a corrupt inactive value lie dormant until the OS flipped.
        lightThemeId: sanitize_theme_id(record.lightThemeId, 'light'),
        darkThemeId: sanitize_theme_id(record.darkThemeId, 'dark'),
        tabOrientation: record.tabOrientation === 'horizontal' ? 'horizontal' : 'vertical',
        csvMaxRows: Math.floor(sanitize_number(record.csvMaxRows, DEFAULT_SETTINGS.csvMaxRows, 1)),
        maxFileSizeMiB: sanitize_number(record.maxFileSizeMiB, DEFAULT_SETTINGS.maxFileSizeMiB, 1),
        maxStoredFiles: Math.floor(sanitize_number(record.maxStoredFiles, DEFAULT_SETTINGS.maxStoredFiles, 1)),
        automaticallyCheckForUpdates: typeof record.automaticallyCheckForUpdates === 'boolean'
            ? record.automaticallyCheckForUpdates
            : DEFAULT_SETTINGS.automaticallyCheckForUpdates,
        dismissedUpdateVersion: typeof record.dismissedUpdateVersion === 'string'
            && record.dismissedUpdateVersion.length <= 100
            ? record.dismissedUpdateVersion
            : DEFAULT_SETTINGS.dismissedUpdateVersion,
        newWindowSize: sanitize_new_window_size_mode(record.newWindowSize),
        windowWidth: Math.round(sanitize_number(
            record.windowWidth,
            DEFAULT_WINDOW_WIDTH,
            MIN_WINDOW_WIDTH,
        )),
        windowHeight: Math.round(sanitize_number(
            record.windowHeight,
            DEFAULT_WINDOW_HEIGHT,
            MIN_WINDOW_HEIGHT,
        )),
    };
}

export class DesktopConfigStore {
    private cached: DesktopSettings | undefined;
    private readonly listeners = new Set<(previous: DesktopSettings, next: DesktopSettings) => void>();

    constructor(private readonly file_path: string) {}

    settings(): DesktopSettings {
        if (!this.cached) {
            let raw: unknown;
            try {
                raw = JSON.parse(fs.readFileSync(this.file_path, 'utf8'));
            } catch {
                // Missing or corrupt settings file: fall back to defaults; the
                // next update() rewrites it.
                raw = undefined;
            }
            this.cached = sanitize_settings(raw);
        }
        return { ...this.cached };
    }

    /** Apply a partial update, persist atomically, notify change listeners. */
    update(partial: Partial<DesktopSettings>): DesktopSettings {
        const previous = this.settings();
        const next = sanitize_settings({ ...previous, ...partial });
        this.cached = next;
        const serialized = JSON.stringify(next, null, 2);
        fs.mkdirSync(path.dirname(this.file_path), { recursive: true });
        const temp = `${this.file_path}.${process.pid}.tmp`;
        try {
            fs.writeFileSync(temp, serialized, 'utf8');
            fs.renameSync(temp, this.file_path);
        } catch (error) {
            try {
                fs.rmSync(temp, { force: true });
            } catch {
                // Best-effort temp cleanup.
            }
            throw error;
        }
        for (const listener of [...this.listeners]) listener(previous, next);
        return { ...next };
    }

    on_change(
        listener: (previous: DesktopSettings, next: DesktopSettings) => void,
    ): Disposable {
        this.listeners.add(listener);
        return { dispose: () => void this.listeners.delete(listener) };
    }

    /** The shared `ConfigPort` view over this store. */
    config_port(): ConfigPort {
        return {
            font_family: () => {
                const family = this.settings().fontFamily.trim();
                return family ? font_family_with_fallback(family, MONO_FONT) : null;
            },
            font_size: () => this.settings().fontSize,
            max_file_size_mib: () => this.settings().maxFileSizeMiB,
            csv_max_rows: () => this.settings().csvMaxRows,
            default_tab_orientation: () => this.settings().tabOrientation,
            on_font_change: (notify) => this.on_change((previous, next) => {
                if (
                    previous.fontFamily !== next.fontFamily
                    || previous.fontSize !== next.fontSize
                ) notify();
            }),
        };
    }
}
