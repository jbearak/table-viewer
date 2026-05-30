import * as assert from 'assert';
import * as vscode from 'vscode';
import {
    activate_extension,
    all_tabs,
    close_all_editors,
    fixture_uri,
    has_custom_tab,
    wait_for,
} from './helpers';

/**
 * Parity gate (host-observable half): every supported format opens through the
 * Glide renderer in the custom editor and lands the expected tab. CSV/TSV ride
 * the repurposed `tableViewer.editor` viewType (editable); XLSX/XLS ride
 * `tableViewer.excelViewer` (read-only). We assert the tab materialises — the
 * pixel-level canvas check stays a human task.
 */
describe('open supported formats', () => {
    before(async () => {
        await activate_extension();
    });

    afterEach(async () => {
        await close_all_editors();
        // Let the host tear both viewTypes down before the next case inspects them.
        await wait_for(() => has_custom_tab('tableViewer.editor') === false, 5000);
        await wait_for(() => has_custom_tab('tableViewer.excelViewer') === false, 5000);
    });

    it('CSV opens in the table editor', async () => {
        await vscode.commands.executeCommand(
            'tableViewer.openCsvTable',
            fixture_uri('basic.csv'),
        );
        const opened = await wait_for(() => has_custom_tab('tableViewer.editor'));
        assert.ok(opened, 'expected a tableViewer.editor custom tab for basic.csv');
    });

    it('TSV opens in the table editor', async () => {
        await vscode.commands.executeCommand(
            'tableViewer.openCsvTable',
            fixture_uri('basic.tsv'),
        );
        const opened = await wait_for(() => has_custom_tab('tableViewer.editor'));
        assert.ok(opened, 'expected a tableViewer.editor custom tab for basic.tsv');
    });

    it('CSV opened via the editor association renders (no xls error)', async () => {
        await vscode.commands.executeCommand(
            'vscode.openWith',
            fixture_uri('basic.csv'),
            'tableViewer.editor',
        );
        const opened = await wait_for(() => has_custom_tab('tableViewer.editor'));
        assert.ok(opened, 'expected basic.csv to open in tableViewer.editor without error');
    });

    it('Open in Text Editor reopens a CSV as text', async () => {
        await vscode.commands.executeCommand(
            'vscode.openWith',
            fixture_uri('basic.csv'),
            'tableViewer.editor',
        );
        await wait_for(() => has_custom_tab('tableViewer.editor'));
        await vscode.commands.executeCommand(
            'tableViewer.openAsText',
            fixture_uri('basic.csv'),
        );
        const as_text = await wait_for(() => all_tabs().some(
            (t) => t.input instanceof vscode.TabInputText
                && t.input.uri.fsPath.endsWith('basic.csv'),
        ));
        assert.ok(as_text, 'expected basic.csv to open in a text editor tab');
    });

    it('XLSX opens in the Excel viewer', async () => {
        await vscode.commands.executeCommand(
            'vscode.openWith',
            fixture_uri('basic.xlsx'),
            'tableViewer.excelViewer',
        );
        const opened = await wait_for(() => has_custom_tab('tableViewer.excelViewer'));
        assert.ok(opened, 'expected a tableViewer.excelViewer custom tab for basic.xlsx');
    });

    it('XLS opens in the Excel viewer', async () => {
        await vscode.commands.executeCommand(
            'vscode.openWith',
            fixture_uri('basic.xls'),
            'tableViewer.excelViewer',
        );
        const opened = await wait_for(() => has_custom_tab('tableViewer.excelViewer'));
        assert.ok(opened, 'expected a tableViewer.excelViewer custom tab for basic.xls');
    });

    it('merged XLSX opens in the Excel viewer', async () => {
        await vscode.commands.executeCommand(
            'vscode.openWith',
            fixture_uri('merged.xlsx'),
            'tableViewer.excelViewer',
        );
        const opened = await wait_for(() => has_custom_tab('tableViewer.excelViewer'));
        assert.ok(opened, 'expected a tableViewer.excelViewer custom tab for merged.xlsx');
    });
});
