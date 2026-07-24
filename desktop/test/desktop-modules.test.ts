import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    DEFAULT_SETTINGS,
    DesktopConfigStore,
    MAX_FONT_SIZE_PX,
    MIN_FONT_SIZE_PX,
    sanitize_settings,
    settings_file_path,
} from '../main/desktop-config';
import { clamp_zoom_level, zoom_factor } from '../main/zoom';
import { BASE_TAB_BAR_HEIGHT, tab_bar_height } from '../shared/chrome';
import { create_viewer_panel, type ViewerPanelTransport } from '../main/viewer-panel';
import { REQUIRED_THEME_VARIABLES, theme_css_variables, theme_payload } from '../main/theme';
import {
    VIEWER_CSP_SOURCE,
    VIEWER_SCRIPT_URL,
    VIEWER_STYLE_URL,
    build_desktop_viewer_html,
} from '../main/viewer-html';
import { node_file_system_port } from '../main/desktop-host-ports';
import type { HostMessage, WebviewMessage } from '../../src/types';

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

    it('sanitizes malformed values', () => {
        expect(sanitize_settings({
            fontFamily: 42,
            fontSize: 'big',
            tabOrientation: 'diagonal',
            csvMaxRows: -5,
            maxFileSizeMiB: 'huge',
            maxStoredFiles: 2.9,
        })).toEqual({
            fontFamily: '',
            fontSize: DEFAULT_SETTINGS.fontSize,
            tabOrientation: 'vertical',
            csvMaxRows: 1,
            maxFileSizeMiB: DEFAULT_SETTINGS.maxFileSizeMiB,
            maxStoredFiles: 2,
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

        expect(port.font_family()).toBe('Monaco');
        store.update({ fontFamily: '   ' });
        expect(port.font_family()).toBeNull();
    });
});

describe('zoom', () => {
    it('clamps levels into the supported range', () => {
        expect(clamp_zoom_level(0)).toBe(0);
        expect(clamp_zoom_level(99)).toBe(5);
        expect(clamp_zoom_level(-99)).toBe(-5);
        expect(clamp_zoom_level(Number.NaN)).toBe(0);
    });

    it('scales by 1.2 per level so the tab bar tracks the zoomed page', () => {
        expect(zoom_factor(0)).toBe(1);
        expect(zoom_factor(1)).toBeCloseTo(1.2);
        expect(zoom_factor(-1)).toBeCloseTo(1 / 1.2);
    });
});

describe('chrome metrics', () => {
    it('keeps the stock tab bar height at the base font size', () => {
        expect(tab_bar_height(13)).toBe(BASE_TAB_BAR_HEIGHT);
        expect(tab_bar_height()).toBe(BASE_TAB_BAR_HEIGHT);
    });

    it('grows with the font size and never shrinks below the stock height', () => {
        expect(tab_bar_height(20)).toBeGreaterThan(BASE_TAB_BAR_HEIGHT);
        expect(tab_bar_height(8)).toBe(BASE_TAB_BAR_HEIGHT);
    });
});

describe('viewer-panel adapter', () => {
    function fake_transport() {
        const sent: HostMessage[] = [];
        const listeners = new Set<(msg: WebviewMessage) => void>();
        const transport: ViewerPanelTransport = {
            send(message) {
                sent.push(message);
                return true;
            },
            on_message(listener) {
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
        };
        return {
            transport,
            sent,
            emit(msg: WebviewMessage) {
                for (const listener of [...listeners]) listener(msg);
            },
            listener_count: () => listeners.size,
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
        expect(listener_count()).toBe(0);
    });

    it('panel dispose drops messages and unsubscribes everything', () => {
        const { transport, emit, sent, listener_count } = fake_transport();
        const panel = create_viewer_panel(transport);
        panel.webview.onDidReceiveMessage(() => {});
        panel.webview.onDidReceiveMessage(() => {});
        expect(listener_count()).toBe(2);

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
    it('provides every --vscode-* variable the webview consumes, for both kinds', () => {
        for (const kind of ['light', 'dark'] as const) {
            const vars = theme_css_variables(kind);
            for (const name of REQUIRED_THEME_VARIABLES) {
                expect(vars[name], `${kind} missing ${name}`).toBeTruthy();
            }
        }
    });

    it('light and dark differ and payload reflects the OS flag', () => {
        expect(theme_css_variables('light')['--vscode-editor-background'])
            .not.toBe(theme_css_variables('dark')['--vscode-editor-background']);
        expect(theme_payload(true).kind).toBe('dark');
        expect(theme_payload(false).kind).toBe('light');
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
