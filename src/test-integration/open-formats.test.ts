import * as assert from 'assert';
import * as vscode from 'vscode';
import {
    activate_extension,
    close_all_editors,
    fixture_uri,
    has_custom_tab,
    has_webview_tab,
    wait_for,
} from './helpers';

/**
 * Parity gate (host-observable half): every supported format opens through the
 * Glide renderer and lands the expected tab kind. CSV/TSV ride the webview-panel
 * command; XLSX/XLS ride the custom editor. We assert the tab materialises — the
 * pixel-level canvas check stays a human task.
 */
describe('open supported formats', () => {
    before(async () => {
        await activate_extension();
    });

    afterEach(async () => {
        await close_all_editors();
        // Let the host tear both tab kinds down before the next case inspects them.
        // Awaiting only the webview tab would let a lingering custom-editor tab from
        // a prior case make the next has_custom_tab('tableViewer.editor') wait_for
        // resolve immediately against the stale tab (a false positive).
        await wait_for(() => has_webview_tab('tableViewer.csvTable') === false, 5000);
        await wait_for(() => has_custom_tab('tableViewer.editor') === false, 5000);
    });

    it('CSV opens as a Table Viewer webview panel', async () => {
        await vscode.commands.executeCommand(
            'tableViewer.openCsvTable',
            fixture_uri('basic.csv'),
        );
        const opened = await wait_for(() => has_webview_tab('tableViewer.csvTable'));
        assert.ok(opened, 'expected a tableViewer.csvTable webview tab for basic.csv');
    });

    it('TSV opens as a Table Viewer webview panel', async () => {
        await vscode.commands.executeCommand(
            'tableViewer.openCsvTable',
            fixture_uri('basic.tsv'),
        );
        const opened = await wait_for(() => has_webview_tab('tableViewer.csvTable'));
        assert.ok(opened, 'expected a tableViewer.csvTable webview tab for basic.tsv');
    });

    it('XLSX opens in the custom editor', async () => {
        await vscode.commands.executeCommand(
            'vscode.openWith',
            fixture_uri('basic.xlsx'),
            'tableViewer.editor',
        );
        const opened = await wait_for(() => has_custom_tab('tableViewer.editor'));
        assert.ok(opened, 'expected a tableViewer.editor custom tab for basic.xlsx');
    });

    it('XLS opens in the custom editor', async () => {
        await vscode.commands.executeCommand(
            'vscode.openWith',
            fixture_uri('basic.xls'),
            'tableViewer.editor',
        );
        const opened = await wait_for(() => has_custom_tab('tableViewer.editor'));
        assert.ok(opened, 'expected a tableViewer.editor custom tab for basic.xls');
    });

    it('merged XLSX opens in the custom editor', async () => {
        await vscode.commands.executeCommand(
            'vscode.openWith',
            fixture_uri('merged.xlsx'),
            'tableViewer.editor',
        );
        const opened = await wait_for(() => has_custom_tab('tableViewer.editor'));
        assert.ok(opened, 'expected a tableViewer.editor custom tab for merged.xlsx');
    });
});
