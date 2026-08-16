/**
 * The host side of the hyperlink open path: the webview posts `openExternal`
 * and the controller re-validates with parse_http_external_url before handing
 * anything to the OS opener. The webview pre-validates too, but that copy is
 * UX — this one is the security boundary a compromised renderer cannot skip.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { attach_viewer, csv_table_profile } from '../viewer-controller';
import { with_in_memory_authority_transactions } from '../state-authority';
import { versioned_state_store } from './helpers/versioned-state-store';
import * as vscode_mock from './mocks/vscode';
import { fake_viewer_host, opened_external_urls } from './mocks/host-ports';

const enc = new TextEncoder();

function open_csv_table() {
    const panel = vscode_mock.window.createWebviewPanel('tableViewer.editor', 'table');
    const controller = attach_viewer(
        panel as unknown as Parameters<typeof attach_viewer>[0],
        vscode_mock.Uri.file('/tmp/open-external.csv') as unknown as vscode.Uri,
        with_in_memory_authority_transactions(versioned_state_store().store),
        csv_table_profile(),
        fake_viewer_host,
    );
    panel.onDidDispose(() => controller.dispose());
    return panel;
}

beforeEach(() => {
    for (const panel of vscode_mock.__getPanels()) panel.dispose();
    vi.restoreAllMocks();
    vscode_mock.__reset();
    vscode_mock.__setStatImplementation(async () => ({ size: 8, mtime: 1 }));
    vscode_mock.__setReadFileImplementation(async () => enc.encode('h\na\n'));
    opened_external_urls.length = 0;
});

describe('openExternal message', () => {
    it('opens a valid http(s) URL through the host port', async () => {
        const panel = open_csv_table();
        await panel.__receive({ type: 'ready' });
        await panel.__receive({
            type: 'openExternal',
            url: 'https://example.com/page',
        });
        expect(opened_external_urls).toEqual(['https://example.com/page']);
    });

    it('blocks non-http schemes and warns instead of opening', async () => {
        const warning = vi.spyOn(vscode_mock.window, 'showWarningMessage');
        const panel = open_csv_table();
        await panel.__receive({ type: 'ready' });
        for (const url of [
            'file:///etc/passwd',
            'javascript:alert(1)',
            'not a url',
            'https://example.com/\x00',
        ]) {
            await panel.__receive({ type: 'openExternal', url });
        }
        expect(opened_external_urls).toEqual([]);
        expect(warning).toHaveBeenCalledTimes(4);
    });
});
