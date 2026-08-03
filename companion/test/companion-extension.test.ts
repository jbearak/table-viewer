import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
    acquire_sqlite_exclusive_recovery_gate,
    inspect_sqlite_recovery_gate,
    preserve_sqlite_basename_set,
    reclaim_stale_sqlite_exclusive_intent,
} from '../../src/sqlite-open-recovery';
import { CompanionStore } from '../src/companion-store';
import { activate, COMPANION_COMMANDS, deactivate } from '../src/extension';

const roots: string[] = [];

function context(): vscode.ExtensionContext {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-companion-ui-'));
    roots.push(directory);
    return {
        extension: {
            id: 'jbearak.table-viewer-companion',
            extensionKind: vscode.ExtensionKind.UI,
            packageJSON: { version: '0.7.0' },
        },
        globalStorageUri: vscode.Uri.file(directory),
        subscriptions: [],
    } as unknown as vscode.ExtensionContext;
}

function recovery_input(physicalDigest?: string) {
    return {
        storageEnvironmentId: 'environment-a', databaseId: 'database-a', recoveryEntryId: 'entry-a',
        operationId: randomUUID(), kind: 'snapshot' as const,
        pendingEditsJson: JSON.stringify({ '0:0': { value: 'new', base: 'old' } }),
        resourceIdentityJson: JSON.stringify({ scheme: 'file', path: '/private/example.csv' }),
        authorityRevision: 4, physicalRevision: 3, projectionRevision: 2,
        ...(physicalDigest === undefined ? {} : { physicalDigest }),
    };
}

beforeEach(() => {
    (vscode as unknown as { __reset(): void }).__reset();
});

afterEach(async () => {
    vi.restoreAllMocks();
    await deactivate();
    for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('companion-owned basis-aware recovery UI', () => {
    it('rejects unknown RPC properties instead of stripping them before receipt hashing', async () => {
        const extensionContext = context();
        await activate(extensionContext);
        const operationId = randomUUID();
        const exact = { operationId, orderedSourceJson: '{}' };

        const first = await vscode.commands.executeCommand(
            COMPANION_COMMANDS.submitCapsuleCandidate,
            exact,
        );
        await expect(vscode.commands.executeCommand(
            COMPANION_COMMANDS.submitCapsuleCandidate,
            { ...exact, ignoredSensitiveMetadata: 'must not cross the bridge' },
        )).rejects.toThrow(/invalid property set/);
        await expect(vscode.commands.executeCommand(
            COMPANION_COMMANDS.submitCapsuleCandidate,
            exact,
        )).resolves.toEqual(first);
    });

    it('exports a frozen Memento capsule when no pending-edit recovery record exists', async () => {
        const extensionContext = context();
        await activate(extensionContext);
        const orderedSourceJson = JSON.stringify({
            format: 'tableViewer.fileState.v1',
            nextRevision: 2,
            absenceRevision: 0,
            entries: {
                '/private/example.csv': {
                    revision: 1,
                    state: { columnWidths: [{ 0: 120 }] },
                },
            },
        });
        await vscode.commands.executeCommand(COMPANION_COMMANDS.submitCapsuleCandidate, {
            operationId: randomUUID(),
            orderedSourceJson,
        });
        vi.spyOn(vscode.window, 'showQuickPick').mockImplementation(async (items) => (items as unknown[])[0] as never);
        const exportPath = path.join(extensionContext.globalStorageUri.fsPath, 'capsule.json');
        vi.spyOn(vscode.window, 'showSaveDialog').mockResolvedValue(vscode.Uri.file(exportPath));

        await vscode.commands.executeCommand(COMPANION_COMMANDS.openRecovery);

        expect(JSON.parse(fs.readFileSync(exportPath, 'utf8'))).toMatchObject({
            format: 'tableViewer.frozenMementoCapsule.v1',
            status: 'armed',
            orderedSourceJson,
        });
    });

    it('exports an explicit bundle containing resource identity, basis, and pending edits', async () => {
        const extensionContext = context();
        await activate(extensionContext);
        await vscode.commands.executeCommand(COMPANION_COMMANDS.preparePendingEditRecovery, recovery_input());
        vi.spyOn(vscode.window, 'showQuickPick').mockImplementation(async (items) => (items as unknown[])[0] as never);
        vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation(async (message) =>
            String(message).startsWith('Recovery basis:') ? 'Export Recovery Bundle' as never : undefined);
        const exportPath = path.join(extensionContext.globalStorageUri.fsPath, 'recovery.json');
        vi.spyOn(vscode.window, 'showSaveDialog').mockResolvedValue(vscode.Uri.file(exportPath));

        await vscode.commands.executeCommand(COMPANION_COMMANDS.openRecovery);

        expect(JSON.parse(fs.readFileSync(exportPath, 'utf8'))).toMatchObject({
            format: 'tableViewer.pendingEditRecovery.v1',
            resourceIdentity: { scheme: 'file', path: '/private/example.csv' },
            basis: { authorityRevision: 4, physicalRevision: 3, projectionRevision: 2 },
            pendingEdits: { '0:0': { value: 'new', base: 'old' } },
        });
    });

    it('warns and performs no write when selected bytes do not match the recorded physical basis', async () => {
        const extensionContext = context();
        await activate(extensionContext);
        const expectedDigest = createHash('sha256').update('expected bytes').digest('hex');
        await vscode.commands.executeCommand(COMPANION_COMMANDS.preparePendingEditRecovery, recovery_input(expectedDigest));
        vi.spyOn(vscode.window, 'showQuickPick').mockImplementation(async (items) => (items as unknown[])[0] as never);
        vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation(async (message) =>
            String(message).startsWith('Recovery basis:') ? 'Validate Restored Resource Basis' as never : undefined);
        vi.spyOn(vscode.window, 'showOpenDialog').mockResolvedValue([vscode.Uri.file('/restored/example.csv')]);
        const warning = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
        const write = vi.fn(async () => undefined);
        (vscode as unknown as {
            __setReadFileImplementation(impl: (uri: unknown) => Promise<Uint8Array>): void;
            __setWriteFileImplementation(impl: (uri: unknown, content: Uint8Array) => Promise<void>): void;
        }).__setReadFileImplementation(async () => new TextEncoder().encode('different bytes'));
        (vscode as unknown as {
            __setWriteFileImplementation(impl: (uri: unknown, content: Uint8Array) => Promise<void>): void;
        }).__setWriteFileImplementation(write);

        await vscode.commands.executeCommand(COMPANION_COMMANDS.openRecovery);

        expect(warning).toHaveBeenCalledWith(expect.stringMatching(/does not match.*will not apply positional edits/i));
        expect(write).not.toHaveBeenCalled();
    });

    it('reports a matching physical basis without applying or writing anything', async () => {
        const extensionContext = context();
        await activate(extensionContext);
        const bytes = new TextEncoder().encode('matching bytes');
        const expectedDigest = createHash('sha256').update(bytes).digest('hex');
        await vscode.commands.executeCommand(COMPANION_COMMANDS.preparePendingEditRecovery, recovery_input(expectedDigest));
        vi.spyOn(vscode.window, 'showQuickPick').mockImplementation(async (items) => (items as unknown[])[0] as never);
        const information = vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation(async (message) =>
            String(message).startsWith('Recovery basis:') ? 'Validate Restored Resource Basis' as never : undefined);
        vi.spyOn(vscode.window, 'showOpenDialog').mockResolvedValue([vscode.Uri.file('/restored/example.csv')]);
        const write = vi.fn(async () => undefined);
        (vscode as unknown as {
            __setReadFileImplementation(impl: (uri: unknown) => Promise<Uint8Array>): void;
            __setWriteFileImplementation(impl: (uri: unknown, content: Uint8Array) => Promise<void>): void;
        }).__setReadFileImplementation(async () => bytes);
        (vscode as unknown as {
            __setWriteFileImplementation(impl: (uri: unknown, content: Uint8Array) => Promise<void>): void;
        }).__setWriteFileImplementation(write);

        await vscode.commands.executeCommand(COMPANION_COMMANDS.openRecovery);

        expect(information).toHaveBeenCalledWith(expect.stringMatching(/matches.*does not apply edits automatically/i));
        expect(write).not.toHaveBeenCalled();
    });

    it('keeps recovery manual when the record has no physical digest', async () => {
        const extensionContext = context();
        await activate(extensionContext);
        await vscode.commands.executeCommand(COMPANION_COMMANDS.preparePendingEditRecovery, recovery_input());
        vi.spyOn(vscode.window, 'showQuickPick').mockImplementation(async (items) => (items as unknown[])[0] as never);
        vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation(async (message) =>
            String(message).startsWith('Recovery basis:') ? 'Validate Restored Resource Basis' as never : undefined);
        const warning = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
        const open = vi.spyOn(vscode.window, 'showOpenDialog');

        await vscode.commands.executeCommand(COMPANION_COMMANDS.openRecovery);

        expect(warning).toHaveBeenCalledWith(expect.stringMatching(/no physical digest.*export it for manual recovery/i));
        expect(open).not.toHaveBeenCalled();
    });

    it('lets the companion-owned UI select and retire an archived drift payload', async () => {
        const extensionContext = context();
        await activate(extensionContext);
        const first = await vscode.commands.executeCommand<{ capsuleId: string }>(
            COMPANION_COMMANDS.submitCapsuleCandidate,
            { operationId: randomUUID(), orderedSourceJson: '{}' },
        );
        await vscode.commands.executeCommand(
            COMPANION_COMMANDS.archiveDrift,
            { operationId: randomUUID(), orderedSourceJson: '{"changed":{}}' },
        );
        vi.spyOn(vscode.window, 'showQuickPick').mockImplementation(async (items) => (
            items as { label: string }[]
        ).find((item) => item.label.includes('Archived drift')) as never);
        vi.spyOn(vscode.window, 'showWarningMessage')
            .mockResolvedValue('Retire Frozen Source Payload' as never);

        await vscode.commands.executeCommand(COMPANION_COMMANDS.retireCapsule);
        await deactivate();

        const database = new DatabaseSync(path.join(
            extensionContext.globalStorageUri.fsPath,
            'state',
            'namespace-recovery.sqlite3',
        ), { readOnly: true });
        expect(database.prepare('SELECT status FROM capsules WHERE capsule_id=?').get(first?.capsuleId)?.status)
            .toBe('retired');
        database.close();
    });

    it('keeps forced workspace placement diagnostic-only without opening permanent state', async () => {
        const extensionContext = context();
        (extensionContext.extension as unknown as { extensionKind: vscode.ExtensionKind }).extensionKind =
            vscode.ExtensionKind.Workspace;
        const open = vi.spyOn(CompanionStore, 'open');
        const showError = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);

        await activate(extensionContext);

        expect(open).not.toHaveBeenCalled();
        await expect(vscode.commands.executeCommand(COMPANION_COMMANDS.hostCapabilities))
            .resolves.toMatchObject({
                extensionKind: 'workspace',
                directoryDurabilitySupported: false,
            });
        expect(await vscode.commands.executeCommand(COMPANION_COMMANDS.namespace, {
            placementKeyDigest: 'a'.repeat(64), operationId: randomUUID(),
        })).toBeUndefined();
        expect(fs.existsSync(path.join(extensionContext.globalStorageUri.fsPath, 'state'))).toBe(false);
        await vscode.commands.executeCommand(COMPANION_COMMANDS.openRecovery);
        expect(showError).toHaveBeenCalledWith(
            expect.stringMatching(/not running in the local UI extension host/),
            { modal: true },
        );
        expect(fs.existsSync(path.join(extensionContext.globalStorageUri.fsPath, 'state'))).toBe(false);
    });

    it('registers recovery before open and withholds bridge commands until a retry succeeds', async () => {
        const extensionContext = context();
        const originalOpen = CompanionStore.open.bind(CompanionStore);
        vi.spyOn(CompanionStore, 'open')
            .mockRejectedValueOnce(new Error('/private/secret/state.sqlite: payload text'))
            .mockImplementation(originalOpen);
        const errorDialog = vi.spyOn(vscode.window, 'showErrorMessage')
            .mockResolvedValue('Try Again' as never);

        await activate(extensionContext);
        await expect(vscode.commands.executeCommand(COMPANION_COMMANDS.hostCapabilities))
            .resolves.toEqual({
                extensionId: 'jbearak.table-viewer-companion',
                extensionVersion: '0.7.0',
                extensionKind: 'ui',
                protocolVersion: 1,
                directoryDurabilitySupported: false,
            });
        expect(await vscode.commands.executeCommand(COMPANION_COMMANDS.namespace, {
            placementKeyDigest: 'before-ready', operationId: randomUUID(),
        })).toBeUndefined();

        await vscode.commands.executeCommand(COMPANION_COMMANDS.openRecovery);
        const result = await vscode.commands.executeCommand(COMPANION_COMMANDS.namespace, {
            placementKeyDigest: 'a'.repeat(64), operationId: randomUUID(),
        });

        expect(result).toMatchObject({ protocolVersion: 1 });
        await expect(vscode.commands.executeCommand(COMPANION_COMMANDS.hostCapabilities))
            .resolves.toEqual({
                extensionId: 'jbearak.table-viewer-companion',
                extensionVersion: '0.7.0',
                extensionKind: 'ui',
                protocolVersion: 1,
                directoryDurabilitySupported: process.platform !== 'win32',
            });
        expect(errorDialog).toHaveBeenCalledWith(
            expect.stringMatching(/could not open/i),
            expect.objectContaining({
                modal: true,
                detail: expect.not.stringContaining('/private/secret'),
            }),
            'Try Again',
            'Open Diagnostics Folder',
            'Set Aside Complete State and Retry…',
        );
    });

    it('does not preserve anything when the all-processes-closed attestation is declined', async () => {
        const extensionContext = context();
        const state = path.join(extensionContext.globalStorageUri.fsPath, 'state');
        fs.mkdirSync(state, { recursive: true });
        const database = path.join(state, 'namespace-recovery.sqlite3');
        fs.writeFileSync(database, 'original evidence');
        vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue('Set Aside Complete State and Retry…' as never);
        vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);

        await activate(extensionContext);
        await vscode.commands.executeCommand(COMPANION_COMMANDS.openRecovery);

        expect(fs.readFileSync(database, 'utf8')).toBe('original evidence');
        expect(fs.readdirSync(state).some((name) => name.includes('.recovery.'))).toBe(false);
        expect(await vscode.commands.executeCommand(COMPANION_COMMANDS.namespace, {
            placementKeyDigest: 'still-degraded', operationId: randomUUID(),
        })).toBeUndefined();
    });

    it('opens the diagnostics folder while remaining degraded', async () => {
        const extensionContext = context();
        const state = path.join(extensionContext.globalStorageUri.fsPath, 'state');
        fs.mkdirSync(state, { recursive: true });
        fs.writeFileSync(path.join(state, 'namespace-recovery.sqlite3'), 'unopenable evidence');
        vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue('Open Diagnostics Folder' as never);
        const reveal = vi.fn();
        (vscode as unknown as {
            __setCommand(command: string, handler: (...args: unknown[]) => unknown): void;
        }).__setCommand('revealFileInOS', reveal);

        await activate(extensionContext);
        await vscode.commands.executeCommand(COMPANION_COMMANDS.openRecovery);

        expect(reveal).toHaveBeenCalledWith(extensionContext.globalStorageUri);
        expect(await vscode.commands.executeCommand(COMPANION_COMMANDS.namespace, {
            placementKeyDigest: 'still-degraded', operationId: randomUUID(),
        })).toBeUndefined();
        expect(fs.readFileSync(path.join(state, 'namespace-recovery.sqlite3'), 'utf8'))
            .toBe('unopenable evidence');
    });

    it('resumes an interrupted preservation generation instead of starting another', async () => {
        const extensionContext = context();
        const state = path.join(extensionContext.globalStorageUri.fsPath, 'state');
        fs.mkdirSync(state, { recursive: true });
        const database = path.join(state, 'namespace-recovery.sqlite3');
        fs.writeFileSync(database, 'interrupted evidence');
        const gate = await acquire_sqlite_exclusive_recovery_gate(database);
        let interrupted = false;
        await expect(preserve_sqlite_basename_set(database, {
            gate,
            onEvent(event) {
                if (!interrupted && event === 'preserve-after-member-source-removal') {
                    interrupted = true;
                    throw new Error('simulated interruption');
                }
            },
        })).rejects.toThrow();
        const interruptedGate = inspect_sqlite_recovery_gate(database);
        expect(interruptedGate.recoveryBlocked).toBe(true);
        expect(interruptedGate.exclusiveIntentTokenId).toBeDefined();
        await reclaim_stale_sqlite_exclusive_intent(
            database,
            interruptedGate.exclusiveIntentTokenId!,
            { allProcessesClosed: true },
        );
        const generationsBefore = fs.readdirSync(state)
            .filter((name) => name.startsWith('namespace-recovery.sqlite3.recovery.'));
        expect(generationsBefore).toHaveLength(1);
        vi.spyOn(vscode.window, 'showErrorMessage').mockImplementation(async (message) =>
            String(message).includes('could not open its migration')
                ? 'Set Aside Complete State and Retry…' as never
                : undefined);
        vi.spyOn(vscode.window, 'showWarningMessage')
            .mockResolvedValue('I Closed Every Table Viewer Process — Set Aside Complete State' as never);

        await activate(extensionContext);
        await vscode.commands.executeCommand(COMPANION_COMMANDS.openRecovery);

        expect(inspect_sqlite_recovery_gate(database).recoveryBlocked).toBe(false);
        expect(fs.readdirSync(state)
            .filter((name) => name.startsWith('namespace-recovery.sqlite3.recovery.')))
            .toEqual(generationsBefore);
        expect(await vscode.commands.executeCommand(COMPANION_COMMANDS.namespace, {
            placementKeyDigest: 'b'.repeat(64), operationId: randomUUID(),
        })).toMatchObject({ protocolVersion: 1 });
    });

    it('requires explicit attestation, preserves the complete basename, and opens fresh state', async () => {
        const extensionContext = context();
        const state = path.join(extensionContext.globalStorageUri.fsPath, 'state');
        fs.mkdirSync(state, { recursive: true });
        const basename = 'namespace-recovery.sqlite3';
        const generation = '00000000-0000-4000-8000-000000000000';
        for (const name of [
            basename,
            `${basename}-journal`,
            `${basename}-wal`,
            `${basename}-shm`,
            `${basename}.init-candidate.${generation}`,
        ]) fs.writeFileSync(path.join(state, name), `evidence:${name}`);
        vi.spyOn(vscode.window, 'showErrorMessage').mockImplementation(async (message) =>
            String(message).includes('could not open its migration')
                ? 'Set Aside Complete State and Retry…' as never
                : undefined);
        const warning = vi.spyOn(vscode.window, 'showWarningMessage')
            .mockResolvedValue('I Closed Every Table Viewer Process — Set Aside Complete State' as never);

        await activate(extensionContext);
        await vscode.commands.executeCommand(COMPANION_COMMANDS.openRecovery);

        expect(warning).toHaveBeenCalledWith(
            expect.stringMatching(/complete companion SQLite basename set/i),
            { modal: true },
            'I Closed Every Table Viewer Process — Set Aside Complete State',
        );
        const recoveryDirectory = fs.readdirSync(state)
            .find((name) => name.startsWith(`${basename}.recovery.`));
        expect(recoveryDirectory).toBeDefined();
        const preservedNames = fs.readdirSync(path.join(state, recoveryDirectory!));
        expect(preservedNames).toEqual(expect.arrayContaining([
            basename,
            `${basename}-journal`,
            `${basename}-wal`,
            `${basename}-shm`,
            `${basename}.init-candidate.${generation}`,
            'manifest.json',
        ]));
        expect(await vscode.commands.executeCommand(COMPANION_COMMANDS.namespace, {
            placementKeyDigest: 'c'.repeat(64), operationId: randomUUID(),
        })).toMatchObject({ protocolVersion: 1 });
    });
});
