import * as path from 'path';
import * as vscode from 'vscode';

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

/** Every open tab across all groups. */
export function all_tabs(): readonly vscode.Tab[] {
    return vscode.window.tabGroups.all.flatMap((g) => g.tabs);
}

/**
 * True when a webview-panel tab whose viewType contains `fragment` is open.
 * VS Code prefixes panel viewTypes (e.g. `mainThreadWebview-tableViewer.csvTable`),
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
