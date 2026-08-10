import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    DEFAULT_SETTINGS,
    DesktopConfigStore,
    MAX_FONT_SIZE_PX,
    MIN_FONT_SIZE_PX,
    canonical_existing_path,
    sanitize_settings,
    settings_file_path,
} from '../main/desktop-config';
import { clamp_zoom_level } from '../main/zoom';
import { dirty_from_host_message, dirty_from_webview_message } from '../main/dirty-state';
import {
    CASCADE_STEP,
    DEFAULT_WINDOW_HEIGHT,
    DEFAULT_WINDOW_WIDTH,
    MIN_WINDOW_HEIGHT,
    MIN_WINDOW_WIDTH,
    fit_window_size,
    next_window_bounds,
    sanitize_new_window_size_mode,
} from '../main/window-geometry';
import { create_viewer_panel, type ViewerPanelTransport } from '../main/viewer-panel';
import {
    DEFAULT_THEME_ID,
    REQUIRED_THEME_VARIABLES,
    THEME_DEFINITIONS,
    THEME_IDS,
    list_themes,
    resolve_theme_id,
    sanitize_theme_id,
    sanitize_theme_setting,
    THEME_SETTINGS,
    theme_payload,
} from '../main/theme';
import {
    build_edit_tints_from_vars,
    build_theme_from_vars,
    CONFLICT_BG_FALLBACK,
    tint_from_color,
} from '../../src/webview/vscode-theme';
import { notices_file_path } from '../main/notices-path';
import { REPOSITORY_URL, about_link_url } from '../main/about-links';
import {
    VIEWER_CSP_SOURCE,
    VIEWER_SCRIPT_URL,
    VIEWER_STYLE_URL,
    build_desktop_viewer_html,
    is_viewer_host,
    viewer_url,
} from '../main/viewer-html';
import { node_file_system_port } from '../main/desktop-host-ports';
import type { HostMessage, WebviewMessage } from '../../src/types';
import {
    MONO_FONT,
    SYSTEM_FONT,
    font_family_with_fallback,
} from '../main/theme-palette';
import {
    SUPPORTED_FILE_EXTENSIONS,
    WINDOWS_FILE_ASSOCIATIONS,
    portable_file_association_commands,
    register_portable_file_associations,
} from '../main/windows-file-associations';
import { sheet_edits } from '../../src/test/pending-edits-helper';

describe('portable Windows file associations', () => {
    const executable = 'C:\\Tools\\Table Viewer Portable.exe';

    it('registers every supported extension without replacing its default handler', () => {
        const commands = portable_file_association_commands(executable);
        const extension_keys = commands
            .filter((command) => command[1].endsWith('\\OpenWithProgids'))
            .map((command) => command[1].match(/\\\.([^\\]+)\\OpenWithProgids$/)?.[1]);

        expect(extension_keys).toEqual(SUPPORTED_FILE_EXTENSIONS);
        expect(commands).toHaveLength(SUPPORTED_FILE_EXTENSIONS.length * 4);
        expect(commands).not.toContainEqual(expect.arrayContaining([
            'HKCU\\Software\\Classes\\.csv',
            '/ve',
        ]));
        expect(commands).toContainEqual([
            'add',
            'HKCU\\Software\\Classes\\TableViewerPortable.csv\\shell\\open\\command',
            '/ve',
            '/d',
            `"${executable}" "%1"`,
            '/f',
        ]);
    });

    it('keeps the portable association set consistent with the NSIS installer', () => {
        const installer = fs.readFileSync(
            path.join(__dirname, '..', 'installer.nsh'),
            'utf8',
        );
        const installed_associations = [...installer.matchAll(
            /TV_REGISTER_TYPE "([^"]+)"\s+"[^"]+"\s+"([^"]+)"/g,
        )].map((match) => ({ extension: match[1], description: match[2] }));

        expect(installed_associations).toEqual(WINDOWS_FILE_ASSOCIATIONS);
    });

    it('attempts every write and reports a partial registration failure', async () => {
        const seen: (readonly string[])[] = [];
        const result = await register_portable_file_associations(executable, async (command) => {
            seen.push(command);
            if (seen.length === 2) throw new Error('denied');
        });

        expect(result).toBe(false);
        expect(seen).toHaveLength(SUPPORTED_FILE_EXTENSIONS.length * 4);
    });
});

describe('desktop-config', () => {
    let dir: string;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-desktop-config-'));
    });
    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('returns defaults when the settings file is missing', () => {
        const store = new DesktopConfigStore(settings_file_path(dir));
        expect(store.settings()).toEqual(DEFAULT_SETTINGS);
    });

    it('returns defaults when the settings file is corrupt', () => {
        const file = settings_file_path(dir);
        fs.writeFileSync(file, '{not json', 'utf8');
        const store = new DesktopConfigStore(file);
        expect(store.settings()).toEqual(DEFAULT_SETTINGS);
    });

    it('persists updates and re-reads them from disk', () => {
        const file = settings_file_path(dir);
        const store = new DesktopConfigStore(file);
        store.update({ fontFamily: 'Menlo', tabOrientation: 'vertical' });
        const reread = new DesktopConfigStore(file);
        expect(reread.settings().fontFamily).toBe('Menlo');
        expect(reread.settings().tabOrientation).toBe('vertical');
        // Untouched keys keep their defaults.
        expect(reread.settings().csvMaxRows).toBe(DEFAULT_SETTINGS.csvMaxRows);
    });

    it('defaults worksheet tabs to vertical, like the extension', () => {
        expect(DEFAULT_SETTINGS.tabOrientation).toBe('vertical');
    });

    it('defaults the appearance to following the OS and round-trips a pinned one', () => {
        expect(DEFAULT_SETTINGS.theme).toBe('system');
        const file = settings_file_path(dir);
        new DesktopConfigStore(file).update({ theme: 'dark' });
        expect(new DesktopConfigStore(file).settings().theme).toBe('dark');
    });

    it('keeps a theme per mode, and rejects a cross-kind swap', () => {
        expect(DEFAULT_SETTINGS.lightThemeId).toBe('light');
        expect(DEFAULT_SETTINGS.darkThemeId).toBe('dark');
        const file = settings_file_path(dir);
        new DesktopConfigStore(file).update({
            lightThemeId: 'solarized-light',
            darkThemeId: 'catppuccin-mocha',
        });
        const reread = new DesktopConfigStore(file).settings();
        expect([reread.lightThemeId, reread.darkThemeId])
            .toEqual(['solarized-light', 'catppuccin-mocha']);
        // A hand-edited file with the slots swapped: both slots are validated
        // against their own fixed kind on every read, so neither survives.
        expect(sanitize_settings({
            lightThemeId: 'catppuccin-mocha',
            darkThemeId: 'solarized-light',
        })).toMatchObject({ lightThemeId: 'light', darkThemeId: 'dark' });
        // Picking a theme for the inactive mode is still remembered.
        expect(sanitize_settings({ theme: 'light', darkThemeId: 'synthwave-84' }).darkThemeId)
            .toBe('synthwave-84');
    });

    it('sanitizes malformed values', () => {
        expect(sanitize_settings({
            fontFamily: 42,
            fontSize: 'big',
            theme: 'sepia',
            lightThemeId: 42,
            darkThemeId: 'nope',
            tabOrientation: 'diagonal',
            csvMaxRows: -5,
            maxFileSizeMiB: 'huge',
            maxStoredFiles: 2.9,
            newWindowSize: 'whatever',
            windowWidth: 'wide',
            windowHeight: 10,
        })).toEqual({
            fontFamily: '',
            fontSize: DEFAULT_SETTINGS.fontSize,
            theme: 'system',
            lightThemeId: 'light',
            darkThemeId: 'dark',
            tabOrientation: 'vertical',
            csvMaxRows: 1,
            maxFileSizeMiB: DEFAULT_SETTINGS.maxFileSizeMiB,
            maxStoredFiles: 2,
            newWindowSize: 'match-last',
            windowWidth: DEFAULT_SETTINGS.windowWidth,
            // Below the usable minimum: raised, not taken literally.
            windowHeight: MIN_WINDOW_HEIGHT,
        });
    });

    it('clamps the font size to the usable range', () => {
        expect(sanitize_settings({ fontSize: 2 }).fontSize).toBe(MIN_FONT_SIZE_PX);
        expect(sanitize_settings({ fontSize: 500 }).fontSize).toBe(MAX_FONT_SIZE_PX);
        expect(sanitize_settings({ fontSize: 16.4 }).fontSize).toBe(16);
    });

    it('notifies change listeners with previous and next settings', () => {
        const store = new DesktopConfigStore(settings_file_path(dir));
        const seen: Array<[string, string]> = [];
        store.on_change((previous, next) => {
            seen.push([previous.fontFamily, next.fontFamily]);
        });
        store.update({ fontFamily: 'Menlo' });
        expect(seen).toEqual([['', 'Menlo']]);
    });

    it('config_port fires font listener only on font changes and supports dispose', () => {
        const store = new DesktopConfigStore(settings_file_path(dir));
        const port = store.config_port();
        const listener = vi.fn();
        const subscription = port.on_font_change(listener);

        store.update({ csvMaxRows: 5 });
        expect(listener).not.toHaveBeenCalled();
        store.update({ fontFamily: 'Menlo' });
        expect(listener).toHaveBeenCalledTimes(1);
        store.update({ fontSize: 17 });
        expect(listener).toHaveBeenCalledTimes(2);
        expect(port.font_size()).toBe(17);

        subscription.dispose();
        store.update({ fontFamily: 'Monaco' });
        expect(listener).toHaveBeenCalledTimes(2);

        expect(port.font_family()).toBe(`Monaco, ${MONO_FONT}`);
        store.update({ fontFamily: '   ' });
        expect(port.font_family()).toBeNull();
    });
});

describe('userData path canonicalization', () => {
    let dir: string;
    beforeEach(() => {
        dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tv-userdata-')));
    });
    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('collapses aliased spellings of one directory onto one value', () => {
        // Why this matters: `app.requestSingleInstanceLock()` is keyed on the
        // userData path Electron was given, not on the directory it resolves to,
        // so two launches of `TABLE_VIEWER_USER_DATA_DIR` naming the same
        // directory differently each won the lock and then coordinated through the
        // same `state/` tree while each believed it was alone — after which the
        // attested "Set Aside and Start Fresh" reclaims the peer's reader token by
        // exact id and moves the database out from under its live handle.
        const real = path.join(dir, 'real');
        fs.mkdirSync(real);
        const link = path.join(dir, 'link');
        fs.symlinkSync(real, link);

        expect(canonical_existing_path(link)).toBe(real);
        expect(canonical_existing_path(path.join(dir, '.', 'real')))
            .toBe(canonical_existing_path(real));
        expect(canonical_existing_path(path.join(real, 'x', '..')))
            .toBe(canonical_existing_path(real));
    });

    it('resolves the existing prefix of a path that does not exist yet', () => {
        // A first launch names a userData directory Electron has yet to create, and
        // `realpath` on a missing path throws — refusing to start would be a worse
        // outcome than an unresolved name, so only the existing prefix is resolved
        // and the remainder is appended.
        const link = path.join(dir, 'link');
        fs.symlinkSync(dir, link);

        expect(canonical_existing_path(path.join(link, 'not', 'created', 'yet')))
            .toBe(path.join(dir, 'not', 'created', 'yet'));
    });
});

describe('desktop font fallback', () => {
    it('puts the same default stack after an unavailable configured family', () => {
        expect(font_family_with_fallback('', SYSTEM_FONT)).toBe(SYSTEM_FONT);
        expect(font_family_with_fallback('Nonexistent Zzz Face', SYSTEM_FONT))
            .toBe(`Nonexistent Zzz Face, ${SYSTEM_FONT}`);
    });

    it('preserves a configured fallback list before the app default', () => {
        expect(font_family_with_fallback('Hack, monospace', SYSTEM_FONT))
            .toBe(`Hack, monospace, ${SYSTEM_FONT}`);
    });
});

describe('zoom', () => {
    it('clamps levels into the supported range', () => {
        expect(clamp_zoom_level(0)).toBe(0);
        expect(clamp_zoom_level(99)).toBe(5);
        expect(clamp_zoom_level(-99)).toBe(-5);
        expect(clamp_zoom_level(Number.NaN)).toBe(0);
    });

});

describe('unsaved-edit indicator', () => {
    const snapshot = (pendingEdits?: Record<string, string>) => ({
        type: 'workbookSnapshot' as const,
        snapshot: { state: pendingEdits ? { pendingEdits } : {} },
    } as unknown as HostMessage);

    it('reads a live draft, and its clearing, from the webview', () => {
        expect(dirty_from_webview_message({
            type: 'pendingEditsChanged',
            edits: { '0:0': { value: 'draft', base: 'a' } },
            editSessionId: 's',
            sequence: 1,
        })).toBe(true);
        // Saving posts null; an empty map means the same thing.
        expect(dirty_from_webview_message({
            type: 'pendingEditsChanged',
            edits: null,
            editSessionId: 's',
            sequence: 2,
        })).toBe(false);
        expect(dirty_from_webview_message({
            type: 'pendingEditsChanged',
            edits: {},
            editSessionId: 's',
            sequence: 3,
        })).toBe(false);
    });

    // A draft restored from a previous session arrives host → webview; the webview
    // only echoes pendingEditsChanged once it is in edit mode with a session.
    it('reads a restored draft from the granted session and the snapshot', () => {
        expect(dirty_from_host_message({
            type: 'editSessionResult',
            requestId: 'r',
            granted: true,
            editSessionId: 's',
            pendingEdits: sheet_edits({ '0:0': { value: 'draft', base: 'a' } }),
        })).toBe(true);
        expect(dirty_from_host_message({
            type: 'editSessionResult',
            requestId: 'r',
            granted: true,
            editSessionId: 's',
        })).toBe(false);
        expect(dirty_from_host_message(snapshot({ '0:0': 'draft' }))).toBe(true);
        expect(dirty_from_host_message(snapshot())).toBe(false);
    });

    // undefined means "no information": the indicator must not flip on messages
    // that simply do not mention pending edits.
    it('says nothing about unrelated messages, or a refused session', () => {
        expect(dirty_from_host_message({
            type: 'editSessionResult',
            requestId: 'r',
            granted: false,
        })).toBeUndefined();
        expect(dirty_from_host_message({
            type: 'fontChanged',
            fontFamily: null,
            fontSize: null,
        })).toBeUndefined();
        expect(dirty_from_webview_message({ type: 'ready' })).toBeUndefined();
    });
});

describe('new window size mode', () => {
    it('defaults to tracking the last window, and only accepts the two modes', () => {
        expect(DEFAULT_SETTINGS.newWindowSize).toBe('match-last');
        expect(sanitize_new_window_size_mode('fixed')).toBe('fixed');
        expect(sanitize_new_window_size_mode('match-last')).toBe('match-last');
        for (const bad of ['Fixed', '', null, undefined, 7, {}]) {
            expect(sanitize_new_window_size_mode(bad)).toBe('match-last');
        }
    });

    it('keeps a fixed size the user typed, raising one below the minimum', () => {
        const settings = sanitize_settings({
            newWindowSize: 'fixed',
            windowWidth: 1440,
            windowHeight: 100,
        });
        expect(settings.windowWidth).toBe(1440);
        expect(settings.windowHeight).toBe(MIN_WINDOW_HEIGHT);
    });
});

describe('window geometry', () => {
    const work_area = { x: 0, y: 0, width: 1920, height: 1080 };

    it('centers the first window at the default size', () => {
        expect(next_window_bounds(work_area, null, null)).toEqual({
            x: (1920 - DEFAULT_WINDOW_WIDTH) / 2,
            y: (1080 - DEFAULT_WINDOW_HEIGHT) / 2,
            width: DEFAULT_WINDOW_WIDTH,
            height: DEFAULT_WINDOW_HEIGHT,
        });
    });

    it('reopens at the remembered size', () => {
        const bounds = next_window_bounds(work_area, { width: 900, height: 600 }, null);
        expect([bounds.width, bounds.height]).toEqual([900, 600]);
    });

    it('cascades the next window down-right from the previous one', () => {
        const previous = { x: 100, y: 80, width: 900, height: 600 };
        const bounds = next_window_bounds(work_area, { width: 900, height: 600 }, previous);
        expect([bounds.x, bounds.y])
            .toEqual([100 + CASCADE_STEP, 80 + CASCADE_STEP]);
    });

    it('restarts the cascade instead of walking off the work area', () => {
        const previous = { x: 1000, y: 470, width: 900, height: 600 };
        const bounds = next_window_bounds(work_area, { width: 900, height: 600 }, previous);
        expect([bounds.x, bounds.y]).toEqual([work_area.x, work_area.y]);
    });

    // Regression: wrapping both axes together stacked every window in the corner
    // whenever one axis had no slack — the common case, since the window is sized
    // to fit the work area, so a short work area leaves no vertical room at all.
    // On a 1366x768 laptop every window after the first landed on (0, 0).
    it('keeps cascading along the axis that still has room', () => {
        const laptop = { x: 0, y: 0, width: 1366, height: 728 };
        const remembered = { width: 1200, height: 800 };
        const seen: string[] = [];
        let previous = next_window_bounds(laptop, remembered, null);
        seen.push(`${previous.x},${previous.y}`);
        for (let index = 0; index < 2; index += 1) {
            previous = next_window_bounds(laptop, remembered, previous);
            seen.push(`${previous.x},${previous.y}`);
        }
        // Distinct positions, and the wrapped axis stayed put rather than
        // dragging the other one back to the corner with it.
        expect(new Set(seen).size).toBe(seen.length);
        expect(previous.y).toBe(laptop.y);
    });

    it('honors a work area that does not start at the origin', () => {
        const dock = { x: 1920, y: 25, width: 1440, height: 875 };
        const bounds = next_window_bounds(dock, { width: 5000, height: 5000 }, null);
        expect(bounds).toEqual({ x: 1920, y: 25, width: 1440, height: 875 });
    });

    // A window on a second display, cascading from one dragged past that
    // display's left/top edge: the result must land back inside the work area,
    // not at the primary display's origin.
    it('clamps a cascade into an offset work area', () => {
        const second = { x: 1920, y: 25, width: 1440, height: 875 };
        const previous = { x: 100, y: -200, width: 900, height: 600 };
        const bounds = next_window_bounds(second, { width: 900, height: 600 }, previous);
        expect(bounds.x).toBeGreaterThanOrEqual(second.x);
        expect(bounds.y).toBeGreaterThanOrEqual(second.y);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(second.x + second.width);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(second.y + second.height);
    });

    it('never sizes a window past the work area', () => {
        expect(fit_window_size(work_area, { width: 4000, height: 3000 }))
            .toEqual({ width: 1920, height: 1080 });
        // A display smaller than the minimum: fill it rather than overhang.
        expect(fit_window_size({ x: 0, y: 0, width: 320, height: 240 }, null))
            .toEqual({ width: 320, height: 240 });
    });

    it('raises undersized and non-finite sizes to the usable minimum', () => {
        expect(fit_window_size(work_area, { width: 10, height: 10 }))
            .toEqual({ width: MIN_WINDOW_WIDTH, height: MIN_WINDOW_HEIGHT });
        expect(fit_window_size(work_area, { width: Number.NaN, height: undefined }))
            .toEqual({ width: DEFAULT_WINDOW_WIDTH, height: DEFAULT_WINDOW_HEIGHT });
    });

    it('keeps a window fully on screen even when placed near the edge', () => {
        const previous = { x: 1000, y: 100, width: 400, height: 300 };
        const bounds = next_window_bounds(work_area, { width: 1900, height: 1000 }, previous);
        expect(bounds.x).toBeGreaterThanOrEqual(work_area.x);
        expect(bounds.y).toBeGreaterThanOrEqual(work_area.y);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(work_area.x + work_area.width);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(work_area.y + work_area.height);
    });
});

describe('viewer-panel adapter', () => {
    function controlled_deadlines() {
        const scheduled: Array<{ active: boolean; callback: () => void; delayMs: number }> = [];
        const schedule = vi.fn((callback: () => void, delayMs: number) => {
            const deadline = { active: true, callback, delayMs };
            scheduled.push(deadline);
            return () => { deadline.active = false; };
        });
        return {
            schedule,
            expire_next() {
                const deadline = scheduled.find((candidate) => candidate.active);
                if (!deadline) throw new Error('missing active deadline');
                deadline.active = false;
                deadline.callback();
            },
            active_count: () => scheduled.filter((deadline) => deadline.active).length,
        };
    }

    function fake_transport() {
        const sent: HostMessage[] = [];
        const listeners = new Set<(msg: WebviewMessage) => void>();
        const generation_listeners = new Set<(error: Error) => void>();
        const loss_listeners = new Set<(error: Error, retryable: boolean) => void>();
        const responsive_listeners = new Set<() => void>();
        const receipt_listeners = new Set<(receipt: import('../shared/ipc').PendingEditAcknowledgementReceipt) => void>();
        const receipts: import('../shared/ipc').PendingEditAcknowledgementReceipt[] = [];
        const transport: ViewerPanelTransport = {
            send(message, _generation, receipt) {
                sent.push(message);
                if (receipt) receipts.push(receipt);
                return true;
            },
            on_message(listener) {
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
            on_renderer_generation_changed(listener) {
                generation_listeners.add(listener);
                return () => generation_listeners.delete(listener);
            },
            on_renderer_unavailable(listener) {
                loss_listeners.add(listener);
                return () => loss_listeners.delete(listener);
            },
            on_renderer_responsive(listener) {
                responsive_listeners.add(listener);
                return () => responsive_listeners.delete(listener);
            },
            on_pending_edit_ack_receipt(listener) {
                receipt_listeners.add(listener);
                return () => receipt_listeners.delete(listener);
            },
        };
        return {
            transport,
            sent,
            emit(msg: WebviewMessage) {
                for (const listener of [...listeners]) listener(msg);
            },
            navigate_renderer(error = new Error('renderer replaced')) {
                for (const listener of [...generation_listeners]) listener(error);
            },
            lose_renderer(error = new Error('renderer lost'), retryable = false) {
                for (const listener of [...loss_listeners]) listener(error, retryable);
            },
            restore_renderer() {
                for (const listener of [...responsive_listeners]) listener();
            },
            last_receipt() {
                const receipt = receipts.at(-1);
                if (!receipt) throw new Error('missing acknowledgement receipt request');
                return receipt;
            },
            emit_receipt(receipt: import('../shared/ipc').PendingEditAcknowledgementReceipt) {
                for (const listener of [...receipt_listeners]) listener(receipt);
            },
            acknowledge_last_delivery() {
                const receipt = receipts.at(-1);
                if (!receipt) throw new Error('missing acknowledgement receipt request');
                for (const listener of [...receipt_listeners]) listener(receipt);
            },
            listener_count: () => listeners.size
                + generation_listeners.size
                + loss_listeners.size
                + responsive_listeners.size
                + receipt_listeners.size,
        };
    }

    it('forwards postMessage to the transport', () => {
        const { transport, sent } = fake_transport();
        const panel = create_viewer_panel(transport);
        expect(panel.webview.postMessage({
            type: 'fontChanged',
            fontFamily: null,
            fontSize: null,
        })).toBe(true);
        expect(sent).toEqual([{ type: 'fontChanged', fontFamily: null, fontSize: null }]);
    });

    it('delivers inbound messages to subscribed handlers until disposed', () => {
        const { transport, emit, listener_count } = fake_transport();
        const panel = create_viewer_panel(transport);
        const received: WebviewMessage[] = [];
        const subscription = panel.webview.onDidReceiveMessage((msg) => received.push(msg));
        emit({ type: 'ready' });
        expect(received).toEqual([{ type: 'ready' }]);

        subscription.dispose();
        subscription.dispose(); // idempotent
        emit({ type: 'ready' });
        expect(received).toHaveLength(1);
        // The panel keeps its private message and renderer lifecycle listeners.
        expect(listener_count()).toBe(5);
    });

    it('treats an immediate pre-ready close as sequence zero', async () => {
        const { transport, sent } = fake_transport();
        const panel = create_viewer_panel(transport);

        await expect(panel.flush_pending_edits()).resolves.toEqual({ sequence: 0, rendererGeneration: 0 });
        expect(sent).toEqual([]);
    });

    it('rejects an explicit renderer flush failure and leaves a retry clean', async () => {
        const { transport, emit, sent } = fake_transport();
        const deadlines = controlled_deadlines();
        const panel = create_viewer_panel(transport, deadlines.schedule);
        emit({ type: 'ready' });

        const failed = panel.flush_pending_edits();
        const failed_request = sent.at(-1);
        if (failed_request?.type !== 'requestPendingEditsFlush') {
            throw new Error('missing failed flush request');
        }
        emit({ type: 'pendingEditsFlushFailed', requestId: failed_request.requestId });
        await expect(failed).rejects.toThrow('could not flush pending edits');
        expect(deadlines.active_count()).toBe(0);

        const retried = panel.flush_pending_edits();
        const retry_request = sent.at(-1);
        if (retry_request?.type !== 'requestPendingEditsFlush') {
            throw new Error('missing retry flush request');
        }
        emit({
            type: 'pendingEditsFlush',
            requestId: retry_request.requestId,
            highestProducedSequence: 0,
        });
        await expect(retried).resolves.toMatchObject({ sequence: 0 });
        expect(deadlines.active_count()).toBe(0);
    });

    it('rejects a positive flush sequence without a session', async () => {
        const { transport, emit, sent } = fake_transport();
        const deadlines = controlled_deadlines();
        const panel = create_viewer_panel(transport, deadlines.schedule);
        emit({ type: 'ready' });

        const flush = panel.flush_pending_edits();
        const request = sent.at(-1);
        if (request?.type !== 'requestPendingEditsFlush') throw new Error('missing flush request');
        emit({
            type: 'pendingEditsFlush',
            requestId: request.requestId,
            highestProducedSequence: 1,
        });

        await expect(flush).rejects.toThrow('malformed pending-edit flush');
        expect(deadlines.active_count()).toBe(0);
    });

    it('bounds a flush wait and permits a fresh retry', async () => {
        const { transport, emit, sent } = fake_transport();
        const deadlines = controlled_deadlines();
        const panel = create_viewer_panel(transport, deadlines.schedule);
        emit({ type: 'ready' });

        const timed_out = panel.flush_pending_edits();
        deadlines.expire_next();
        await expect(timed_out).rejects.toThrow('Timed out waiting');

        const retried = panel.flush_pending_edits();
        const request = sent.at(-1);
        if (request?.type !== 'requestPendingEditsFlush') throw new Error('missing retry flush');
        emit({
            type: 'pendingEditsFlush',
            requestId: request.requestId,
            highestProducedSequence: 0,
        });
        await expect(retried).resolves.toMatchObject({ sequence: 0 });
        expect(deadlines.active_count()).toBe(0);
    });

    it('waits for the exact session acknowledgement reported by renderer flush', async () => {
        const { transport, emit, sent, acknowledge_last_delivery } = fake_transport();
        const panel = create_viewer_panel(transport);
        emit({ type: 'ready' });
        const flush = panel.flush_pending_edits();
        const request = sent.at(-1);
        expect(request?.type).toBe('requestPendingEditsFlush');
        if (request?.type !== 'requestPendingEditsFlush') throw new Error('missing flush request');

        emit({
            type: 'pendingEditsFlush',
            requestId: request.requestId,
            editSessionId: 'edit:1',
            highestProducedSequence: 2,
        });
        const result = await flush;
        const acknowledged = panel.wait_for_pending_edit_ack(
            result.rendererGeneration,
            result.editSessionId,
            result.sequence,
        );
        let settled = false;
        void acknowledged.then(() => { settled = true; });

        panel.webview.postMessage({
            type: 'pendingEditsAcknowledged',
            editSessionId: 'edit:1',
            sequence: 1,
        });
        acknowledge_last_delivery();
        await Promise.resolve();
        expect(settled).toBe(false);

        panel.webview.postMessage({
            type: 'pendingEditsAcknowledged',
            editSessionId: 'edit:1',
            sequence: 2,
        });
        await Promise.resolve();
        expect(settled).toBe(false);
        acknowledge_last_delivery();
        await acknowledged;
        expect(settled).toBe(true);
    });

    it('accepts only the exact generation, session, and sequence receipt', async () => {
        const { transport, emit, sent, last_receipt, emit_receipt } = fake_transport();
        const panel = create_viewer_panel(transport);
        emit({ type: 'ready' });
        const flush = panel.flush_pending_edits();
        const request = sent.at(-1);
        if (request?.type !== 'requestPendingEditsFlush') throw new Error('missing flush request');
        emit({
            type: 'pendingEditsFlush',
            requestId: request.requestId,
            editSessionId: 'edit:receipt-scope',
            highestProducedSequence: 7,
        });
        const result = await flush;
        const acknowledged = panel.wait_for_pending_edit_ack(
            result.rendererGeneration,
            result.editSessionId,
            result.sequence,
        );
        let settled = false;
        void acknowledged.then(() => { settled = true; });
        panel.webview.postMessage({
            type: 'pendingEditsAcknowledged',
            editSessionId: 'edit:receipt-scope',
            sequence: 7,
        });
        const receipt = last_receipt();

        emit_receipt({ ...receipt, rendererGeneration: receipt.rendererGeneration + 1 });
        emit_receipt({ ...receipt, editSessionId: 'edit:other' });
        emit_receipt({ ...receipt, sequence: receipt.sequence + 1 });
        await Promise.resolve();
        expect(settled).toBe(false);

        emit_receipt(receipt);
        await acknowledged;
        expect(settled).toBe(true);
    });

    it('bounds acknowledgement receipt waits, cleans stale receipts, and permits retry', async () => {
        const { transport, emit, sent, last_receipt, emit_receipt } = fake_transport();
        const deadlines = controlled_deadlines();
        const panel = create_viewer_panel(transport, deadlines.schedule);
        emit({ type: 'ready' });
        const flush = panel.flush_pending_edits();
        const request = sent.at(-1);
        if (request?.type !== 'requestPendingEditsFlush') throw new Error('missing flush request');
        emit({
            type: 'pendingEditsFlush',
            requestId: request.requestId,
            editSessionId: 'edit:deadline',
            highestProducedSequence: 3,
        });
        const result = await flush;

        const timed_out = panel.wait_for_pending_edit_ack(
            result.rendererGeneration,
            result.editSessionId,
            result.sequence,
        );
        panel.webview.postMessage({
            type: 'pendingEditsAcknowledged',
            editSessionId: 'edit:deadline',
            sequence: 3,
        });
        const stale_receipt = last_receipt();
        deadlines.expire_next();
        await expect(timed_out).rejects.toThrow('Timed out waiting');

        const retried = panel.wait_for_pending_edit_ack(
            result.rendererGeneration,
            result.editSessionId,
            result.sequence,
        );
        let settled = false;
        void retried.then(() => { settled = true; });
        emit_receipt(stale_receipt);
        await Promise.resolve();
        expect(settled).toBe(false);

        panel.webview.postMessage({
            type: 'pendingEditsAcknowledged',
            editSessionId: 'edit:deadline',
            sequence: 3,
        });
        emit_receipt(last_receipt());
        await retried;
        expect(deadlines.active_count()).toBe(0);
    });

    it('rejects old-generation waiters after a successful main-frame navigation', async () => {
        const { transport, emit, sent, navigate_renderer } = fake_transport();
        const panel = create_viewer_panel(transport);
        emit({ type: 'ready' });

        const old_flush = panel.flush_pending_edits();
        navigate_renderer(new Error('successful reload replaced renderer'));
        await expect(old_flush).rejects.toThrow('successful reload replaced renderer');
        // The replacement renderer has not become ready and cannot have produced edits.
        await expect(panel.flush_pending_edits()).resolves.toEqual({ sequence: 0, rendererGeneration: 1 });

        emit({ type: 'ready' });
        const next_flush = panel.flush_pending_edits();
        const request = sent.at(-1);
        if (request?.type !== 'requestPendingEditsFlush') throw new Error('missing flush request');
        emit({
            type: 'pendingEditsFlush',
            requestId: request.requestId,
            editSessionId: 'edit:next',
            highestProducedSequence: 1,
        });
        await expect(next_flush).resolves.toEqual({
            editSessionId: 'edit:next',
            sequence: 1,
            rendererGeneration: 1,
        });
    });

    it('rejects an old-generation acknowledgement waiter after successful navigation', async () => {
        const { transport, emit, sent, navigate_renderer } = fake_transport();
        const panel = create_viewer_panel(transport);
        emit({ type: 'ready' });
        const flush = panel.flush_pending_edits();
        const request = sent.at(-1);
        if (request?.type !== 'requestPendingEditsFlush') throw new Error('missing flush request');
        emit({
            type: 'pendingEditsFlush',
            requestId: request.requestId,
            editSessionId: 'edit:old',
            highestProducedSequence: 1,
        });
        await flush;

        const acknowledged = panel.wait_for_pending_edit_ack(0, 'edit:old', 1);
        navigate_renderer(new Error('successful navigation replaced renderer'));

        await expect(acknowledged).rejects.toThrow('successful navigation replaced renderer');
    });

    it('rejects obsolete waiters when ready repeats for a new renderer generation', async () => {
        const { transport, emit, sent } = fake_transport();
        const panel = create_viewer_panel(transport);
        emit({ type: 'ready' });
        const old_flush = panel.flush_pending_edits();
        const old_request = sent.at(-1);
        if (old_request?.type !== 'requestPendingEditsFlush') {
            throw new Error('missing old flush request');
        }
        emit({
            type: 'pendingEditsFlush',
            requestId: old_request.requestId,
            editSessionId: 'edit:repeated-ready',
            highestProducedSequence: 2,
        });
        const old_result = await old_flush;
        const old_ack = panel.wait_for_pending_edit_ack(
            old_result.rendererGeneration,
            old_result.editSessionId,
            old_result.sequence,
        );

        emit({ type: 'ready' });

        await expect(old_ack).rejects.toThrow('new protocol generation');
        await expect(panel.wait_for_pending_edit_ack(
            old_result.rendererGeneration,
            old_result.editSessionId,
            old_result.sequence,
        )).rejects.toThrow('generation changed');
        const next_flush = panel.flush_pending_edits();
        const next_request = sent.at(-1);
        if (next_request?.type !== 'requestPendingEditsFlush') {
            throw new Error('missing next flush request');
        }
        emit({
            type: 'pendingEditsFlush',
            requestId: next_request.requestId,
            highestProducedSequence: 0,
        });
        await expect(next_flush).resolves.toMatchObject({ rendererGeneration: 1 });
    });

    it('rejects a flush waiter when a ready renderer is lost', async () => {
        const { transport, emit, lose_renderer } = fake_transport();
        const panel = create_viewer_panel(transport);
        emit({ type: 'ready' });

        const flush = panel.flush_pending_edits();
        lose_renderer(new Error('navigation failed'));

        await expect(flush).rejects.toThrow('navigation failed');
        await expect(panel.flush_pending_edits()).rejects.toThrow('navigation failed');
    });

    it('allows a fresh flush after an unresponsive renderer becomes responsive', async () => {
        const { transport, emit, sent, lose_renderer, restore_renderer } = fake_transport();
        const panel = create_viewer_panel(transport);
        emit({ type: 'ready' });
        const interrupted = panel.flush_pending_edits();

        lose_renderer(new Error('renderer unresponsive'), true);
        await expect(interrupted).rejects.toThrow('renderer unresponsive');
        await expect(panel.flush_pending_edits()).rejects.toThrow('renderer unresponsive');

        restore_renderer();
        const retried = panel.flush_pending_edits();
        const request = sent.at(-1);
        if (request?.type !== 'requestPendingEditsFlush') throw new Error('missing retry flush');
        emit({
            type: 'pendingEditsFlush',
            requestId: request.requestId,
            highestProducedSequence: 0,
        });
        await expect(retried).resolves.toMatchObject({
            sequence: 0,
            rendererGeneration: 0,
        });
    });

    it('rejects an acknowledgement waiter when the renderer is lost', async () => {
        const { transport, emit, sent, lose_renderer } = fake_transport();
        const panel = create_viewer_panel(transport);
        emit({ type: 'ready' });
        const flush = panel.flush_pending_edits();
        const request = sent.at(-1);
        if (request?.type !== 'requestPendingEditsFlush') throw new Error('missing flush request');
        emit({
            type: 'pendingEditsFlush',
            requestId: request.requestId,
            editSessionId: 'edit:1',
            highestProducedSequence: 1,
        });
        await flush;

        const acknowledged = panel.wait_for_pending_edit_ack(0, 'edit:1', 1);
        lose_renderer(new Error('renderer terminated'));

        await expect(acknowledged).rejects.toThrow('renderer terminated');
    });

    it('panel dispose drops messages and unsubscribes everything', () => {
        const { transport, emit, sent, listener_count } = fake_transport();
        const panel = create_viewer_panel(transport);
        panel.webview.onDidReceiveMessage(() => {});
        panel.webview.onDidReceiveMessage(() => {});
        expect(listener_count()).toBe(7);

        panel.dispose();
        expect(listener_count()).toBe(0);
        expect(panel.webview.postMessage({
            type: 'fontChanged',
            fontFamily: null,
            fontSize: null,
        })).toBe(false);
        expect(sent).toHaveLength(0);
        // Subscriptions after dispose are inert.
        panel.webview.onDidReceiveMessage(() => {});
        emit({ type: 'ready' });
        expect(listener_count()).toBe(0);
    });
});

describe('theme', () => {
    // Every theme, not just the two built-ins: a ported theme that omits one
    // variable does not fail loudly, it silently falls back to a hardcoded dark
    // color inside the Glide grid (see build_theme_from_vars).
    it('provides every --vscode-* variable the webview consumes, for every theme', () => {
        for (const id of THEME_IDS) {
            const vars = theme_payload(id).variables;
            for (const name of REQUIRED_THEME_VARIABLES) {
                expect(vars[name], `${id} missing ${name}`).toBeTruthy();
            }
        }
    });

    it('light and dark differ and payload reflects the OS flag', () => {
        expect(theme_payload('light').variables['--vscode-editor-background'])
            .not.toBe(theme_payload('dark').variables['--vscode-editor-background']);
        expect(theme_payload('dark').kind).toBe('dark');
        expect(theme_payload('light').kind).toBe('light');
        expect(theme_payload('synthwave-84').kind).toBe('dark');
        expect(theme_payload('solarized-light').themeId).toBe('solarized-light');
    });

    it('accepts only the three appearance settings, defaulting to system', () => {
        for (const value of THEME_SETTINGS) {
            expect(sanitize_theme_setting(value)).toBe(value);
        }
        for (const value of [undefined, null, '', 'Dark', 'sepia', 7, {}]) {
            expect(sanitize_theme_setting(value)).toBe('system');
        }
    });

    it('lists exactly the light themes for light and the dark ones for dark', () => {
        expect(list_themes('light').map((t) => t.id)).toEqual([
            'light', 'solarized-light', 'catppuccin-latte',
            'gruvbox-light-hard', 'gruvbox-light-medium', 'gruvbox-light-soft',
        ]);
        expect(list_themes('dark').map((t) => t.id)).toEqual([
            'dark', 'solarized-dark', 'catppuccin-frappe',
            'catppuccin-macchiato', 'catppuccin-mocha',
            'gruvbox-dark-hard', 'gruvbox-dark-medium', 'gruvbox-dark-soft',
            'synthwave-84', 'cyberpunk', 'cyberpunk-scarlet',
        ]);
        // Every id belongs to exactly one kind's list.
        expect(list_themes('light').length + list_themes('dark').length)
            .toBe(THEME_IDS.length);
    });

    it('rejects unknown AND wrong-kind theme ids', () => {
        expect(sanitize_theme_id('catppuccin-mocha', 'dark')).toBe('catppuccin-mocha');
        // Valid id, wrong kind: dormant corruption that would surface the moment
        // the OS flipped, so it is rejected at read time.
        expect(sanitize_theme_id('synthwave-84', 'light')).toBe('light');
        expect(sanitize_theme_id('light', 'dark')).toBe('dark');
        for (const value of [undefined, null, '', 'Dark', 'sepia', 7, {}]) {
            expect(sanitize_theme_id(value, 'light')).toBe('light');
            expect(sanitize_theme_id(value, 'dark')).toBe('dark');
        }
    });

    // Gruvbox's three contrasts per kind are one palette with bg0 swapped, which
    // is how upstream defines them. Written as an object spread, so a hex pasted
    // into the medium palette silently reaches its two siblings — intended — while
    // a *fourth* difference creeping into one contrast alone is the drift worth
    // catching. Distinct backgrounds are asserted too: a copy-paste that left two
    // contrasts on the same bg0 would otherwise ship as two identical themes
    // under different names.
    it('varies only the background across each gruvbox kind\'s three contrasts', () => {
        for (const kind of ['light', 'dark'] as const) {
            const ids = THEME_IDS.filter((id) => id.startsWith(`gruvbox-${kind}-`));
            expect(ids).toHaveLength(3);
            const backgrounds = new Set<string>();
            for (const id of ids) {
                const { ['--vscode-editor-background']: bg, ...rest } =
                    THEME_DEFINITIONS[id].variables;
                backgrounds.add(bg);
                const medium = THEME_DEFINITIONS[`gruvbox-${kind}-medium`].variables;
                const { ['--vscode-editor-background']: _, ...medium_rest } = medium;
                expect(rest, id).toEqual(medium_rest);
            }
            expect(backgrounds.size, `${kind} contrasts differ`).toBe(3);
        }
    });

    it('resolves the active theme from the mode, one slot each', () => {
        const slots = { lightThemeId: 'catppuccin-latte', darkThemeId: 'synthwave-84' } as const;
        expect(resolve_theme_id(slots, false)).toBe('catppuccin-latte');
        expect(resolve_theme_id(slots, true)).toBe('synthwave-84');
    });

    it('never lets a theme override the app font', () => {
        // Fonts are an app-wide preference; every theme must carry the same ones.
        for (const id of THEME_IDS) {
            const vars = theme_payload(id).variables;
            expect(vars['--vscode-font-family'])
                .toBe(theme_payload('dark').variables['--vscode-font-family']);
            expect(vars['--vscode-editor-font-family'])
                .toBe(theme_payload('dark').variables['--vscode-editor-font-family']);
        }
    });

    // The teeth behind the SemanticPalette "opaque 6-digit hex" invariant, which
    // theme-palette.ts relies on when it builds the find highlight and the
    // info/warning banner fills by *concatenating* an alpha suffix. Paste an
    // upstream 8-digit color into a palette — which upstream themes routinely
    // publish, and which the SynthWave '84 notes call out as needing flattening —
    // and those three become invalid 10-digit strings that CSS drops silently:
    // one theme's find highlight and banners go transparent, with a green suite.
    it('paints every theme in opaque or 8-digit hex, never a longer string', () => {
        const color = /^(#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?|transparent)$/;
        for (const id of THEME_IDS) {
            for (const [name, value] of Object.entries(theme_payload(id).variables)) {
                // The font variables are names and sizes, not colors.
                if (name.includes('font')) continue;
                expect(value, `${id} ${name}`).toMatch(color);
            }
        }
    });
});

// Pins that each theme's variables actually *reach* the canvas grid, rather than
// being replaced by build_theme_from_vars' hardcoded fallbacks — which are
// non-empty for every field, so a shape-only assertion here would pass even on an
// entirely empty variable map. Completeness is the neighbouring
// REQUIRED_THEME_VARIABLES test's job; this one is about the mapping.
describe('theme × Glide grid theme', () => {
    it('maps every theme onto the Glide theme the webview builds', () => {
        for (const id of THEME_IDS) {
            const vars = THEME_DEFINITIONS[id].variables;
            const theme = build_theme_from_vars((name) => vars[name] ?? '');
            expect(theme.bgCell, id).toBe(vars['--vscode-editor-background']);
            expect(theme.textDark, id).toBe(vars['--vscode-editor-foreground']);
            expect(theme.accentColor, id).toBe(vars['--vscode-focusBorder']);
            expect(theme.accentFg, id).toBe(vars['--vscode-list-activeSelectionForeground']);
            // The selection fill is the theme's channels but a clamped alpha —
            // opaque would hide highlights and edit tints under selection.
            expect(theme.accentLight, id).toBe(
                tint_from_color(vars['--vscode-editor-selectionBackground'], 0.35, 'FAIL'),
            );
            expect(theme.bgHeader, id).toBe(vars['--vscode-editorGroupHeader-tabsBackground']);
            expect(theme.bgHeaderHovered, id).toBe(vars['--vscode-list-hoverBackground']);
            expect(theme.borderColor, id).toBe(vars['--vscode-editorWidget-border']);
            expect(theme.textMedium, id).toBe(vars['--vscode-descriptionForeground']);
            expect(theme.textLight, id).toBe(vars['--vscode-disabledForeground']);
            expect(theme.linkColor, id).toBe(vars['--vscode-textLink-foreground']);
            expect(theme.bgSearchResult, id)
                .toBe(vars['--vscode-editor-findMatchHighlightBackground']);
            // The grid font comes from the theme's mono family (the app-wide font
            // preference overrides it at runtime via --table-viewer-font-family,
            // which no theme sets).
            expect(theme.fontFamily, id).toBe(vars['--vscode-editor-font-family']);
        }
    });

    // Backstop for the fields the mapping assertions above do not name one by one.
    it('leaves no Glide theme field empty for any shipped theme', () => {
        for (const id of THEME_IDS) {
            const vars = THEME_DEFINITIONS[id].variables;
            const theme = build_theme_from_vars((name) => vars[name] ?? '');
            for (const [field, value] of Object.entries(theme)) {
                expect(typeof value, `${id}.${field}`).toBe('string');
                expect((value as string).trim(), `${id}.${field} is empty`).not.toBe('');
            }
        }
    });

    it('derives a distinct edit tint per theme rather than silently falling back', () => {
        const dirty = new Set<string>();
        const conflict = new Set<string>();
        for (const id of THEME_IDS) {
            const vars = THEME_DEFINITIONS[id].variables;
            const tints = build_edit_tints_from_vars((name) => vars[name] ?? '');
            // Fixed semantic alpha, canonical rgb: a theme whose variable went
            // missing would emit the fallback literal instead.
            expect(tints.dirtyBg, id).toMatch(/^rgba\(\d+, \d+, \d+, 0\.16\)$/);
            expect(tints.conflictBg, id).toMatch(/^rgba\(\d+, \d+, \d+, 0\.22\)$/);
            dirty.add(tints.dirtyBg);
            conflict.add(tints.conflictBg);
        }
        // 17 themes, 11 distinct values each. The collisions are all intended
        // palette sharing: solarized-light and solarized-dark share one palette;
        // each gruvbox kind's three contrasts differ only in their background;
        // and the two Cyberpunk variants share their warning and error colors.
        expect(dirty.size).toBe(11);
        expect(conflict.size).toBe(11);
        // A typo'd variable name would collapse every theme onto the fallback.
        // (`dark`'s warning genuinely IS #cca700 — the same rgb as the dirty
        // fallback — so only the conflict side can assert non-fallback.)
        expect(conflict.has(CONFLICT_BG_FALLBACK)).toBe(false);
    });
});

describe('notices path', () => {
    // electron-builder excludes the file from `files` and ships it via
    // extraResources instead, so packaged and dev builds look in different
    // places — and it is easy to get backwards.
    it('reads from Resources when packaged and from dist/desktop in dev', () => {
        expect(notices_file_path(true, '/App/Contents/Resources', '/repo/dist/desktop'))
            .toBe(path.join('/App/Contents/Resources', 'THIRD_PARTY_NOTICES.txt'));
        expect(notices_file_path(false, '/App/Contents/Resources', '/repo/dist/desktop'))
            .toBe(path.join('/repo/dist/desktop', 'THIRD_PARTY_NOTICES.txt'));
    });
});

describe('about links', () => {
    it('resolves the two link targets to repository URLs', () => {
        expect(about_link_url('license')).toBe(`${REPOSITORY_URL}/blob/main/LICENSE`);
        expect(about_link_url('notices')).toBe(`${REPOSITORY_URL}/blob/main/NOTICE.md`);
    });

    // The renderer picks the target name, so anything it can send must resolve to
    // a string or to nothing. A plain `LINKS[target]` answers a truthy *function*
    // for these three, and handing one to shell.openExternal throws out of the
    // ipcMain listener — an uncaught main-process exception from a button click.
    it('never resolves an inherited property or a non-string target', () => {
        for (const target of ['__proto__', 'constructor', 'toString', 'valueOf', 'repository', '']) {
            expect(about_link_url(target), target).toBeUndefined();
        }
        for (const target of [undefined, null, 7, {}, ['license']]) {
            expect(about_link_url(target), String(target)).toBeUndefined();
        }
    });
});

describe('viewer html', () => {
    it('references the tv-app bundle URLs with a nonce-locked CSP', () => {
        const html = build_desktop_viewer_html('Menlo');
        expect(html).toContain(`src="${VIEWER_SCRIPT_URL}"`);
        expect(html).toContain(`href="${VIEWER_STYLE_URL}"`);
        expect(html).toContain(`style-src ${VIEWER_CSP_SOURCE}`);
        expect(html).toMatch(/script-src 'nonce-[0-9a-f]{32}'/);
        expect(html).toContain('--table-viewer-font-family');
        expect(html).toContain('id="portal"');
    });

    it('bootstraps the configured font size', () => {
        const html = build_desktop_viewer_html(null, 17);
        expect(html).toContain('--table-viewer-font-size');
        expect(html).toContain('17px');
    });

    it('omits the font bootstrap when no font is configured', () => {
        const html = build_desktop_viewer_html(null);
        expect(html).not.toContain('--table-viewer-font-family');
        expect(html).not.toContain('--table-viewer-font-size');
    });

    // Regression: nothing outside VS Code sets the --vscode-* variables the
    // shared webview themes itself from. They used to be pushed in by the viewer
    // preload, which crashed before it could (documentElement is null that
    // early), leaving the grid on its dark fallbacks in light mode forever.
    it('bakes the light palette into the page so the grid paints light', () => {
        const html = build_desktop_viewer_html(null, null, theme_payload('light'));
        expect(html).toContain('"--vscode-editor-background"');
        expect(html).toContain(
            `"${theme_payload('light').variables['--vscode-editor-background']}"`,
        );
        expect(html).toContain('r.style.colorScheme = "light"');
    });

    it('bakes the dark palette in when the OS is dark', () => {
        const html = build_desktop_viewer_html(null, null, theme_payload('dark'));
        expect(html).toContain(
            `"${theme_payload('dark').variables['--vscode-editor-background']}"`,
        );
        expect(html).toContain('r.style.colorScheme = "dark"');
    });

    // Chromium keys zoom by origin, so viewer windows sharing one host would
    // share their zoom level too — View → Zoom would move every window at once.
    it('gives each window its own viewer host, and serves all of them', () => {
        expect(viewer_url(1)).toBe('tv-app://viewer-1/index.html');
        expect(viewer_url(2)).not.toBe(viewer_url(1));
        expect(is_viewer_host('viewer-1')).toBe(true);
        expect(is_viewer_host('viewer-42')).toBe(true);
        expect(is_viewer_host('viewer')).toBe(true);
        expect(is_viewer_host('webview')).toBe(false);
        expect(is_viewer_host('viewer-evil.example.com')).toBe(false);
    });

    it('bootstraps every variable the webview consumes', () => {
        const html = build_desktop_viewer_html(null, null, theme_payload('light'));
        for (const name of REQUIRED_THEME_VARIABLES) {
            expect(html, `missing ${name}`).toContain(`"${name}"`);
        }
    });
});

describe('node file system port', () => {
    it('stats, reads, and writes through file: resources', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-desktop-fs-'));
        try {
            const file = path.join(dir, 'data.csv');
            const resource = {
                scheme: 'file',
                authority: '',
                path: file,
                query: '',
                fragment: '',
                fsPath: file,
            };
            await node_file_system_port.write_file(resource, new TextEncoder().encode('a,b\n'));
            const stat = await node_file_system_port.stat(resource);
            expect(stat.size).toBe(4);
            expect(stat.mtime).toBeGreaterThan(0);
            const bytes = await node_file_system_port.read_file(resource);
            expect(new TextDecoder().decode(bytes)).toBe('a,b\n');
            await expect(node_file_system_port.stat({ ...resource, scheme: 'untitled' }))
                .rejects.toThrow(/Unsupported resource scheme/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
