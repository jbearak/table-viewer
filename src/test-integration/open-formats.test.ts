import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
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
 * the single `tableViewer.editor` viewType. We assert the tab materialises — the
 * pixel-level canvas check stays a human task.
 */
describe('open supported formats', () => {
    before(async () => {
        await activate_extension();
    });

    afterEach(async () => {
        await close_all_editors();
        // Let the host tear the viewType down before the next case inspects it.
        await wait_for(() => has_custom_tab('tableViewer.editor') === false, 5000);
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

    it('does not claim TSX source files as TSV workbooks', async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'table-viewer-tsx-'));
        const target = vscode.Uri.file(path.join(directory, 'component.tsx'));
        try {
            await fs.writeFile(target.fsPath, 'export const Cell = () => <span>value</span>;\n');
            await vscode.commands.executeCommand('vscode.open', target);
            const opened_as_text = await wait_for(() => all_tabs().some((tab) =>
                tab.input instanceof vscode.TabInputText
                && tab.input.uri.fsPath === target.fsPath));
            assert.ok(opened_as_text, 'expected component.tsx to open as source text');
            assert.strictEqual(
                has_custom_tab('tableViewer.editor'),
                false,
                'Table Viewer must not treat .tsx as the supported .tsv format',
            );
        } finally {
            await fs.rm(directory, { recursive: true, force: true });
        }
    });

    it('discovers the table editor for every selector alternative and letter case', async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'table-viewer-selector-'));
        const cases = [
            ['basic.xlsx', 'selector.XlSx'],
            ['basic.xls', 'selector.XlS'],
            ['basic.csv', 'selector.CsV'],
            ['basic.tsv', 'selector.TsV'],
            ['all_types_v118.dta', 'selector.DtA'],
        ] as const;

        try {
            for (const [fixture, target_name] of cases) {
                const target = vscode.Uri.file(path.join(directory, target_name));
                await fs.copyFile(fixture_uri(fixture).fsPath, target.fsPath);
                await vscode.commands.executeCommand('vscode.open', target);

                const opened = await wait_for(() => has_custom_tab('tableViewer.editor'));
                assert.ok(opened, `expected Table Viewer to be discovered for ${target_name}`);
                if (target_name === 'selector.DtA') {
                    const loaded = await vscode.commands.executeCommand<boolean>(
                        'tableViewer.openWorkbookAtSheet',
                        { uri: target.toString(), sheetName: 'Sheet1' },
                    );
                    assert.strictEqual(
                        loaded,
                        true,
                        'expected the mixed-case DTA fixture to finish loading',
                    );
                }

                await close_all_editors();
                const closed = await wait_for(
                    () => has_custom_tab('tableViewer.editor') === false,
                    5000,
                );
                assert.ok(closed, `expected Table Viewer to close after testing ${target_name}`);
            }
        } finally {
            await close_all_editors();
            await fs.rm(directory, { recursive: true, force: true });
        }
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
            'tableViewer.editor',
        );
        const opened = await wait_for(() => has_custom_tab('tableViewer.editor'));
        assert.ok(opened, 'expected a tableViewer.editor custom tab for basic.xlsx');
    });

    it('XLS opens in the Excel viewer', async () => {
        await vscode.commands.executeCommand(
            'vscode.openWith',
            fixture_uri('basic.xls'),
            'tableViewer.editor',
        );
        const opened = await wait_for(() => has_custom_tab('tableViewer.editor'));
        assert.ok(opened, 'expected a tableViewer.editor custom tab for basic.xls');
    });

    it('merged XLSX opens in the Excel viewer', async () => {
        await vscode.commands.executeCommand(
            'vscode.openWith',
            fixture_uri('merged.xlsx'),
            'tableViewer.editor',
        );
        const opened = await wait_for(() => has_custom_tab('tableViewer.editor'));
        assert.ok(opened, 'expected a tableViewer.editor custom tab for merged.xlsx');
    });
});
