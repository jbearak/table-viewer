import * as assert from 'assert';
import * as vscode from 'vscode';
import {
    activate_extension,
    close_all_editors,
    fixture_uri,
    has_webview_tab,
    wait_for,
} from './helpers';

/**
 * The CSV preview pane is a distinct webview surface (tableViewer.csvPreview)
 * from the full table panel. Verify the command opens it; the scroll-sync
 * behaviour itself is exercised by unit tests over the sync core.
 */
describe('CSV preview pane', () => {
    before(async () => {
        await activate_extension();
    });

    afterEach(async () => {
        await close_all_editors();
        await wait_for(() => has_webview_tab('tableViewer.csvPreview') === false, 5000);
    });

    it('opens a preview webview for a CSV file', async () => {
        await vscode.commands.executeCommand(
            'tableViewer.showCsvPreview',
            fixture_uri('basic.csv'),
        );
        const opened = await wait_for(() => has_webview_tab('tableViewer.csvPreview'));
        assert.ok(opened, 'expected a tableViewer.csvPreview webview tab');
    });
});
