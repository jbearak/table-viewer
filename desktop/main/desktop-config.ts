// Desktop settings store: a small JSON file under the app's userData dir that
// backs the shared `ConfigPort` (src/host-ports.ts) plus the Preferences
// window. Pure Node (no electron import) so it is unit-testable; main.ts
// passes `app.getPath('userData')`-derived paths.
import * as fs from 'fs';
import * as path from 'path';
import type { ConfigPort, Disposable } from '../../src/host-ports';
import {
    DEFAULT_WINDOW_HEIGHT,
    DEFAULT_WINDOW_WIDTH,
    MIN_WINDOW_HEIGHT,
    MIN_WINDOW_WIDTH,
} from './window-geometry';

export const SETTINGS_FILE_NAME = 'settings.v1.json';

export function settings_file_path(user_data_dir: string): string {
    return path.join(user_data_dir, SETTINGS_FILE_NAME);
}

export interface DesktopSettings {
    /** Empty string means "use the theme default font". */
    fontFamily: string;
    /** Font size in px, applied to the whole app (viewer windows, welcome, prefs). */
    fontSize: number;
    tabOrientation: 'horizontal' | 'vertical';
    csvMaxRows: number;
    maxFileSizeMiB: number;
    maxStoredFiles: number;
    /** Size the last closed viewer window had, so the next one opens like it.
     *  Written by the app, not the Preferences window. */
    windowWidth: number;
    windowHeight: number;
}

/** Smallest / largest usable app font size; the prefs input clamps to these. */
export const MIN_FONT_SIZE_PX = 8;
export const MAX_FONT_SIZE_PX = 32;

/** Defaults mirror the VS Code contribution defaults in package.json, except
 *  the worksheet tab orientation, which is vertical here (there is no editor
 *  tab strip to compete with) and the font size, which has no editor setting
 *  to inherit on the desktop. */
export const DEFAULT_SETTINGS: Readonly<DesktopSettings> = Object.freeze({
    fontFamily: '',
    fontSize: 13,
    tabOrientation: 'vertical',
    csvMaxRows: 1_000_000,
    maxFileSizeMiB: 256,
    maxStoredFiles: 10_000,
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
        tabOrientation: record.tabOrientation === 'horizontal' ? 'horizontal' : 'vertical',
        csvMaxRows: Math.floor(sanitize_number(record.csvMaxRows, DEFAULT_SETTINGS.csvMaxRows, 1)),
        maxFileSizeMiB: sanitize_number(record.maxFileSizeMiB, DEFAULT_SETTINGS.maxFileSizeMiB, 1),
        maxStoredFiles: Math.floor(sanitize_number(record.maxStoredFiles, DEFAULT_SETTINGS.maxStoredFiles, 1)),
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
            font_family: () => this.settings().fontFamily.trim() || null,
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
