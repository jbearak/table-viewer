import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    CHANNEL_WEBVIEW_DOCUMENT_TOKEN,
    CHANNEL_WEBVIEW_MESSAGE,
    type DesktopWebviewMessageEnvelope,
} from '../shared/ipc';

const electron_mock = vi.hoisted(() => {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    const exposed = new Map<string, unknown>();
    const state = { documentTokenResponse: undefined as unknown };
    return {
        listeners,
        exposed,
        state,
        contextBridge: {
            exposeInMainWorld: vi.fn((name: string, value: unknown) => exposed.set(name, value)),
        },
        ipcRenderer: {
            on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
                const channel_listeners = listeners.get(channel) ?? [];
                channel_listeners.push(listener);
                listeners.set(channel, channel_listeners);
            }),
            send: vi.fn(),
            sendSync: vi.fn((channel: string) => channel === 'tableViewer:webviewDocumentToken'
                ? state.documentTokenResponse
                : undefined),
        },
        emit(channel: string, payload: unknown) {
            for (const listener of listeners.get(channel) ?? []) listener({}, payload);
        },
    };
});

vi.mock('electron', () => electron_mock);
vi.mock('../main/theme', () => ({ apply_theme_to_document: vi.fn() }));
vi.mock('../shared/titlebar', () => ({
    install_titlebar: vi.fn(),
    set_titlebar_active: vi.fn(),
    set_titlebar_zoom: vi.fn(),
}));
vi.mock('../preload/titlebar-api', () => ({
    titlebar_preload_api: () => ({
        titlebar_inset: 0,
        titlebar_zoom: () => 1,
        titlebar_active: () => true,
        on_titlebar_zoom: vi.fn(),
        on_titlebar_active: vi.fn(),
    }),
}));

type HostBridge = { postMessage(message: unknown): void };

const window_listeners = new Map<string, Array<(...args: unknown[]) => void>>();

function dispatch_dom_content_loaded(): void {
    for (const listener of window_listeners.get('DOMContentLoaded') ?? []) listener();
}

async function load_preload(): Promise<HostBridge> {
    await import('../preload/viewer-preload');
    const bridge = electron_mock.exposed.get('__tableViewerHostBridge') as HostBridge | undefined;
    if (!bridge) throw new Error('viewer host bridge was not exposed');
    return bridge;
}

function sent_envelopes(): DesktopWebviewMessageEnvelope[] {
    return electron_mock.ipcRenderer.send.mock.calls
        .filter(([channel]) => channel === CHANNEL_WEBVIEW_MESSAGE)
        .map(([, envelope]) => envelope as DesktopWebviewMessageEnvelope);
}

beforeEach(() => {
    vi.resetModules();
    electron_mock.listeners.clear();
    electron_mock.exposed.clear();
    electron_mock.state.documentTokenResponse = undefined;
    window_listeners.clear();
    electron_mock.contextBridge.exposeInMainWorld.mockClear();
    electron_mock.ipcRenderer.on.mockClear();
    electron_mock.ipcRenderer.send.mockClear();
    electron_mock.ipcRenderer.sendSync.mockClear();
    vi.stubGlobal('window', {
        addEventListener: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
            const listeners = window_listeners.get(event) ?? [];
            listeners.push(listener);
            window_listeners.set(event, listeners);
        }),
        postMessage: vi.fn(),
    });
    vi.stubGlobal('document', {});
});

describe('viewer preload document admission', () => {
    it('queues messages until a token arrives and flushes them in order', async () => {
        const bridge = await load_preload();
        bridge.postMessage({ type: 'ready' });
        bridge.postMessage({ type: 'visibleRowChanged', row: 4 });
        expect(sent_envelopes()).toEqual([]);

        electron_mock.state.documentTokenResponse = 'document-a';
        dispatch_dom_content_loaded();

        expect(sent_envelopes()).toEqual([
            { documentToken: 'document-a', message: { type: 'ready' } },
            {
                documentToken: 'document-a',
                message: { type: 'visibleRowChanged', row: 4 },
            },
        ]);
    });

    it('wraps later messages with the installed token', async () => {
        const bridge = await load_preload();
        electron_mock.state.documentTokenResponse = 'document-a';
        dispatch_dom_content_loaded();

        bridge.postMessage({ type: 'ready' });

        expect(sent_envelopes()).toEqual([
            { documentToken: 'document-a', message: { type: 'ready' } },
        ]);
    });

    it('never lets page data provide or replace the envelope token', async () => {
        const bridge = await load_preload();
        electron_mock.state.documentTokenResponse = 'document-a';
        dispatch_dom_content_loaded();

        bridge.postMessage({
            documentToken: 'forged',
            message: { type: 'ready' },
        });
        electron_mock.state.documentTokenResponse = 'document-b';
        dispatch_dom_content_loaded();
        bridge.postMessage({ type: 'ready' });

        expect(sent_envelopes()).toEqual([
            {
                documentToken: 'document-a',
                message: { documentToken: 'forged', message: { type: 'ready' } },
            },
            { documentToken: 'document-a', message: { type: 'ready' } },
        ]);
        expect(electron_mock.ipcRenderer.sendSync.mock.calls.filter(
            ([channel]) => channel === CHANNEL_WEBVIEW_DOCUMENT_TOKEN,
        )).toHaveLength(1);
    });

    it.each([undefined, null, '', 3, {}])(
        'does not release queued messages for malformed token %j',
        async (token) => {
            const bridge = await load_preload();
            bridge.postMessage({ type: 'ready' });

            electron_mock.state.documentTokenResponse = token;
            dispatch_dom_content_loaded();

            expect(sent_envelopes()).toEqual([]);
        },
    );

    it('fails visibly instead of silently dropping a full pre-admission queue', async () => {
        const bridge = await load_preload();
        for (let index = 0; index < 1024; index += 1) {
            bridge.postMessage({ type: 'queued', index });
        }

        expect(() => bridge.postMessage({ type: 'overflow' })).toThrow(
            'Viewer document admission did not arrive before its message queue filled.',
        );
        expect(sent_envelopes()).toEqual([]);
    });
});
