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

    it('installs the exact-version companion in the local UI host and routes its metadata-only bridge', async () => {
        const main = vscode.extensions.getExtension(EXT_ID);
        const companion = vscode.extensions.getExtension('jbearak.table-viewer-companion');
        assert.ok(main);
        assert.ok(companion, 'expected the separately packaged companion VSIX to be installed');
        assert.strictEqual(companion.packageJSON.version, main.packageJSON.version);
        assert.strictEqual(companion.extensionKind, vscode.ExtensionKind.UI);
        const capabilities = await vscode.commands.executeCommand<Record<string, unknown>>(
            'tableViewerCompanion.hostCapabilities.v1',
        );
        assert.deepStrictEqual(capabilities, {
            extensionId: 'jbearak.table-viewer-companion',
            extensionVersion: main.packageJSON.version,
            extensionKind: 'ui',
            protocolVersion: 1,
            directoryDurabilitySupported: process.platform !== 'win32',
        });
        if (process.platform === 'win32') {
            const commands = await vscode.commands.getCommands(true);
            assert.ok(!commands.includes('tableViewerCompanion.namespace.v1'));
            return;
        }
        const namespace = await vscode.commands.executeCommand<Record<string, unknown>>(
            'tableViewerCompanion.namespace.v1',
            { placementKeyDigest: 'a'.repeat(64), operationId: `integration-${Date.now()}` },
        );
        assert.deepStrictEqual(Object.keys(namespace ?? {}).sort(), [
            'profileDatabaseId', 'protocolVersion', 'storageEnvironmentId',
        ]);
        assert.strictEqual(namespace?.protocolVersion, 1);
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
            'tableViewer.setupPhysicalEditProtocol',
            'tableViewer.armSqliteMigration',
            'tableViewer.upgradeToSqlitePersistence',
        ]) {
            assert.ok(commands.includes(id), `command ${id} not registered`);
        }
    });
});
