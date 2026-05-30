import * as assert from 'assert';
import * as vscode from 'vscode';
import { EXT_ID, activate_extension } from './helpers';

/**
 * Smoke layer: the extension is discoverable, activates cleanly, and contributes
 * exactly the command surface the rest of the parity gate depends on.
 */
describe('extension activation', () => {
    it('extension is present in the host', () => {
        const ext = vscode.extensions.getExtension(EXT_ID);
        assert.ok(ext, `expected extension ${EXT_ID} to be installed`);
    });

    it('activates without throwing', async () => {
        const ext = await activate_extension();
        assert.strictEqual(ext.isActive, true);
    });

    it('registers all contributed commands', async () => {
        await activate_extension();
        const commands = await vscode.commands.getCommands(true);
        for (const id of [
            'tableViewer.showCsvPreviewToSide',
            'tableViewer.showCsvPreview',
            'tableViewer.openCsvTable',
            'tableViewer.openAsText',
        ]) {
            assert.ok(commands.includes(id), `command ${id} not registered`);
        }
    });
});
