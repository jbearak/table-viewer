import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import type { TableViewerIntegrationSession } from '../custom-editor';
import type { TableViewerExtensionTestApi } from '../extension';
import type { HostMessage } from '../types';

export type SnapshotMessage = Extract<HostMessage, { type: 'workbookSnapshot' }>;

/** Marketplace id (`publisher.name`) of the extension under test. */
export const EXT_ID = 'jbearak.table-viewer';

/** Absolute path to the extension root (where the test host loaded it from). */
export function extension_root(): string {
    const ext = vscode.extensions.getExtension(EXT_ID);
    if (!ext) throw new Error(`extension ${EXT_ID} not found in host`);
    return ext.extensionPath;
}

/** URI of a checked-in fixture under src/test/fixtures. */
export function fixture_uri(name: string): vscode.Uri {
    return vscode.Uri.file(path.join(extension_root(), 'src', 'test', 'fixtures', name));
}

/** Activate the extension and return it. */
export async function activate_extension(): Promise<vscode.Extension<unknown>> {
    const ext = vscode.extensions.getExtension(EXT_ID);
    if (!ext) throw new Error(`extension ${EXT_ID} not found in host`);
    await ext.activate();
    return ext;
}

/** Test-only controller protocol exposed by an extension host launched for tests. */
export async function integration_api(): Promise<TableViewerExtensionTestApi> {
    const ext = vscode.extensions.getExtension<TableViewerExtensionTestApi>(EXT_ID);
    if (!ext) throw new Error(`extension ${EXT_ID} not found in host`);
    const api = ext.isActive ? ext.exports : await ext.activate();
    if (!api || typeof api.integrationSession !== 'function') {
        throw new Error('Table Viewer did not expose its integration-test API.');
    }
    return api;
}

/** Every open tab across all groups. */
export function all_tabs(): readonly vscode.Tab[] {
    return vscode.window.tabGroups.all.flatMap((g) => g.tabs);
}

/**
 * True when a webview-panel tab whose viewType contains `fragment` is open.
 * VS Code prefixes panel viewTypes (e.g. `mainThreadWebview-tableViewer.csvPreview`),
 * so we substring-match rather than compare exactly.
 */
export function has_webview_tab(fragment: string): boolean {
    return all_tabs().some(
        (t) =>
            t.input instanceof vscode.TabInputWebview &&
            t.input.viewType.includes(fragment),
    );
}

/** True when a custom-editor tab with the exact `viewType` is open. */
export function has_custom_tab(view_type: string): boolean {
    return all_tabs().some(
        (t) =>
            t.input instanceof vscode.TabInputCustom &&
            t.input.viewType === view_type,
    );
}

/** Close every editor/tab and let the host settle. */
export async function close_all_editors(): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

/** Poll `predicate` until true or the timeout elapses; returns the final value. */
export async function wait_for(
    predicate: () => boolean,
    timeout_ms = 10000,
    interval_ms = 50,
): Promise<boolean> {
    const deadline = Date.now() + timeout_ms;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((r) => setTimeout(r, interval_ms));
    }
    return predicate();
}

/** The newest host message matching `predicate`, polled. */
export async function wait_for_message<T extends HostMessage>(
    session: TableViewerIntegrationSession,
    predicate: (message: HostMessage) => message is T,
    description: string,
): Promise<T> {
    let found: T | undefined;
    const observed = await wait_for(() => {
        found = [...session.messages()].reverse().find(predicate);
        return found !== undefined;
    }, 20_000, 20);
    assert.ok(observed && found, `timed out waiting for ${description}`);
    return found;
}

/** The newest snapshot, once the real webview has acknowledged it. */
export async function wait_for_latest_snapshot_ack(
    session: TableViewerIntegrationSession,
): Promise<SnapshotMessage> {
    let latest: SnapshotMessage | undefined;
    const acknowledged = await wait_for(() => {
        latest = session.messages().filter(
            (message): message is SnapshotMessage => message.type === 'workbookSnapshot',
        ).at(-1);
        return latest !== undefined && session.receivedMessages().some((message) =>
            message.type === 'snapshotApplied'
            && message.identity.deliveryId === latest?.snapshot.identity.deliveryId);
    }, 20_000, 20);
    assert.ok(acknowledged && latest, 'the real webview must acknowledge the latest snapshot');
    return latest;
}

/** Open `uri` in the custom editor and wait for its acknowledged initial snapshot. */
export async function open_session(uri: vscode.Uri): Promise<{
    session: TableViewerIntegrationSession;
    initial: SnapshotMessage;
}> {
    const api = await integration_api();
    await vscode.commands.executeCommand('vscode.openWith', uri, 'tableViewer.editor');
    assert.ok(
        await wait_for(() => has_custom_tab('tableViewer.editor'), 20_000, 20),
        `expected a custom editor for ${path.basename(uri.fsPath)}`,
    );
    let session: TableViewerIntegrationSession | undefined;
    assert.ok(await wait_for(() => {
        session = api.integrationSession(uri);
        return session !== undefined;
    }, 20_000, 20), `expected an integration session for ${uri.fsPath}`);
    const initial = await wait_for_message(
        session!,
        (message): message is SnapshotMessage => message.type === 'workbookSnapshot'
            && message.snapshot.presentation === 'initial',
        'the initial workbook snapshot',
    );
    await wait_for_latest_snapshot_ack(session!);
    return { session: session!, initial };
}
