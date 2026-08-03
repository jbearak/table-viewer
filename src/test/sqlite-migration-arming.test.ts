import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
    MIGRATION_ARMING_STATE_KEY,
    MIGRATION_CAPSULE_MAX_UTF8_BYTES,
    MIGRATION_COMPANION_COMMANDS,
    MIGRATION_COMPANION_EXTENSION_ID,
    read_migration_arming_state,
    type FinalizedMigrationArmingState,
    type MigrationArmingState,
} from '../migration-companion';
import {
    evaluate_sqlite_migration_cold_start,
    prepare_sqlite_migration_arming,
} from '../sqlite-migration-arming';

interface Fixture {
    readonly context: vscode.ExtensionContext;
    readonly state: Map<string, unknown>;
}

function digest(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

function fixture(envelope: unknown = {}): Fixture {
    const state = new Map<string, unknown>([['tableViewer.fileState', envelope]]);
    const context = {
        extension: { packageJSON: { version: '0.7.0' }, extensionKind: vscode.ExtensionKind.Workspace },
        globalStorageUri: vscode.Uri.from({ scheme: 'file', path: '/profile/table-viewer' }),
        globalState: {
            get(key: string, fallback?: unknown) { return state.has(key) ? state.get(key) : fallback; },
            async update(key: string, value: unknown) { state.set(key, value); },
        },
    } as unknown as vscode.ExtensionContext;
    return { context, state };
}

function install_companion(options: {
    profileDatabaseId?: string;
    storageEnvironmentId?: string;
    capsuleId?: string;
    sourceJson: string;
    sourceFormat?: string;
    directoryDurabilitySupported?: boolean;
    active?: boolean;
}) {
    const profileDatabaseId = options.profileDatabaseId ?? 'profile-a';
    const storageEnvironmentId = options.storageEnvironmentId ?? 'environment-a';
    let capsuleId = options.capsuleId ?? 'capsule-a';
    let sourceDigest = digest(options.sourceJson);
    let active = options.active ?? false;
    const archive = vi.fn(async (value: unknown) => {
        const input = value as { orderedSourceJson: string };
        capsuleId = 'capsule-drift';
        sourceDigest = digest(input.orderedSourceJson);
        active = true;
        return {};
    });
    (vscode as unknown as { __setExtension(id: string, extension: unknown): void }).__setExtension(
        MIGRATION_COMPANION_EXTENSION_ID,
        {
            packageJSON: { version: '0.7.0' },
            extensionKind: vscode.ExtensionKind.UI,
            activate: vi.fn(async () => undefined),
        },
    );
    const set = (command: string, handler: (...args: unknown[]) => unknown) => (
        vscode as unknown as { __setCommand(command: string, handler: (...args: unknown[]) => unknown): void }
    ).__setCommand(command, handler);
    set(MIGRATION_COMPANION_COMMANDS.hostCapabilities, () => ({
        extensionId: MIGRATION_COMPANION_EXTENSION_ID,
        extensionVersion: '0.7.0',
        extensionKind: 'ui',
        protocolVersion: 1,
        directoryDurabilitySupported: options.directoryDurabilitySupported ?? true,
    }));
    const namespace = vi.fn((_input: unknown) => ({ profileDatabaseId, storageEnvironmentId, protocolVersion: 1 }));
    set(MIGRATION_COMPANION_COMMANDS.namespace, namespace);
    const submit = vi.fn((input: unknown) => {
        const request = input as { orderedSourceJson: string };
        sourceDigest = digest(request.orderedSourceJson);
        active = true;
        return { capsuleId, sourceDigest };
    });
    set(MIGRATION_COMPANION_COMMANDS.submitCapsuleCandidate, submit);
    set(MIGRATION_COMPANION_COMMANDS.activeCapsule, () => {
        if (!active) throw new Error('No active migration capsule is armed.');
        return {
            capsuleId,
            sourceFormat: options.sourceFormat ?? 'tableViewer.fileState.legacy',
            sourceDigest,
            meta: { nextRevision: 1, absenceRevision: 0, nextRecencyOrder: '1' },
            entryCount: 0,
            status: 'armed',
        };
    });
    set(MIGRATION_COMPANION_COMMANDS.archiveDrift, archive);
    return { archive, submit, namespace, identity: () => ({ profileDatabaseId, storageEnvironmentId, capsuleId, sourceDigest }) };
}

function boundary(events: string[]) {
    let viewOnly = false;
    return {
        store: {} as never,
        get viewOnly() { return viewOnly; },
        markerStatus: 'unarmed' as const,
        async enter_view_only() {
            if (viewOnly) return;
            viewOnly = true;
            events.push('view-only');
        },
        async drain() { events.push('drain'); },
    };
}

beforeEach(() => {
    (vscode as unknown as { __reset(): void }).__reset();
    (vscode.env as unknown as { remoteName?: string }).remoteName = undefined;
    vi.restoreAllMocks();
});

describe('SQLite migration preparation arming', () => {
    it('does not fence or seed when the all-window attestation is declined', async () => {
        const { context } = fixture({});
        const events: string[] = [];
        vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);

        await expect(prepare_sqlite_migration_arming(context, boundary(events), () => { events.push('stop'); }))
            .resolves.toBe(false);
        expect(events).toEqual([]);
    });

    it('rejects an oversized frozen source before checkpointing or fencing writers', async () => {
        const { context, state } = fixture({ oversized: 'x'.repeat(MIGRATION_CAPSULE_MAX_UTF8_BYTES) });
        const events: string[] = [];
        vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(
            'I Attest Every Other VS Code Window Is Closed' as never,
        );
        vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);

        await expect(prepare_sqlite_migration_arming(context, boundary(events), () => { events.push('stop'); }))
            .resolves.toBe(false);
        expect(events).toEqual([]);
        expect(state.get(MIGRATION_ARMING_STATE_KEY)).toBeUndefined();
    });

    it('restores the prior checkpoint and remains view-only if the drained source crosses the capsule limit', async () => {
        const { context, state } = fixture({});
        install_companion({ sourceJson: '{}' });
        const events: string[] = [];
        let acceptsWrites = true;
        const activationBoundary = boundary(events);
        activationBoundary.drain = vi.fn(async () => {
            events.push('drain');
            state.set('tableViewer.fileState', {
                oversized: 'x'.repeat(MIGRATION_CAPSULE_MAX_UTF8_BYTES),
            });
        });
        activationBoundary.enter_view_only = vi.fn(async () => {
            if (!acceptsWrites) return;
            events.push('view-only');
            acceptsWrites = false;
        });
        vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(
            'I Attest Every Other VS Code Window Is Closed' as never,
        );
        vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);

        await expect(prepare_sqlite_migration_arming(
            context,
            activationBoundary,
            () => { events.push('stop'); },
        )).resolves.toBe(false);

        if (acceptsWrites) state.set('tableViewer.fileState', { forbiddenLateWrite: true });
        expect(events).toEqual(['stop', 'drain', 'view-only']);
        expect(state.get('tableViewer.fileState')).not.toEqual({ forbiddenLateWrite: true });
        expect(state.get(MIGRATION_ARMING_STATE_KEY)).toBeUndefined();
    });

    it('checks durability in the local UI companion host before fencing workspace writers', async () => {
        const { context, state } = fixture({});
        const companion = install_companion({
            sourceJson: '{}',
            directoryDurabilitySupported: false,
        });
        const events: string[] = [];
        vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(
            'I Attest Every Other VS Code Window Is Closed' as never,
        );
        vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);

        await expect(prepare_sqlite_migration_arming(context, boundary(events), () => { events.push('stop'); }))
            .resolves.toBe(false);

        expect(events).toEqual([]);
        expect(companion.namespace).not.toHaveBeenCalled();
        expect(state.get(MIGRATION_ARMING_STATE_KEY)).toBeUndefined();
    });

    it('restores the pre-arming state when the companion capability probe rejects', async () => {
        const { context, state } = fixture({});
        install_companion({ sourceJson: '{}' });
        (vscode as unknown as { __setCommand(command: string, handler: (...args: unknown[]) => unknown): void })
            .__setCommand(MIGRATION_COMPANION_COMMANDS.hostCapabilities, () => {
                throw new Error('capability route failed');
            });
        const events: string[] = [];
        vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(
            'I Attest Every Other VS Code Window Is Closed' as never,
        );

        await expect(prepare_sqlite_migration_arming(context, boundary(events), () => { events.push('stop'); }))
            .rejects.toThrow('capability route failed');
        expect(state.get(MIGRATION_ARMING_STATE_KEY)).toBeUndefined();
        expect(events).toEqual([]);
    });

    it('fences writers if a failed capability probe cannot restore the previous checkpoint', async () => {
        const { context } = fixture({});
        install_companion({ sourceJson: '{}' });
        (vscode as unknown as { __setCommand(command: string, handler: (...args: unknown[]) => unknown): void })
            .__setCommand(MIGRATION_COMPANION_COMMANDS.hostCapabilities, () => {
                throw new Error('capability route failed');
            });
        const originalUpdate = context.globalState.update.bind(context.globalState);
        let updates = 0;
        (context.globalState as unknown as { update(key: string, value: unknown): Promise<void> }).update =
            vi.fn(async (key, value) => {
                updates += 1;
                if (updates === 2) throw new Error('checkpoint restore failed');
                await originalUpdate(key, value);
            });
        const events: string[] = [];
        vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(
            'I Attest Every Other VS Code Window Is Closed' as never,
        );

        await expect(prepare_sqlite_migration_arming(context, boundary(events), () => { events.push('stop'); }))
            .rejects.toThrow('checkpoint restore failed');
        expect(events).toEqual(['stop', 'drain', 'view-only']);
    });

    it.each(['stop', 'drain'] as const)('rolls back the resumable checkpoint when viewer %s fails', async (failureStage) => {
        const { context, state } = fixture({});
        const companion = install_companion({ sourceJson: '{}' });
        const events: string[] = [];
        const activationBoundary = boundary(events);
        if (failureStage === 'drain') {
            activationBoundary.drain = vi.fn(async () => {
                events.push('drain');
                throw new Error('viewer drain failed');
            });
        }
        const stopViewers = vi.fn(async () => {
            events.push('stop');
            if (failureStage === 'stop') throw new Error('viewer stop failed');
        });
        vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(
            'I Attest Every Other VS Code Window Is Closed' as never,
        );

        await expect(prepare_sqlite_migration_arming(context, activationBoundary, stopViewers))
            .rejects.toThrow(`viewer ${failureStage} failed`);

        expect(state.get(MIGRATION_ARMING_STATE_KEY)).toBeUndefined();
        expect(companion.submit).not.toHaveBeenCalled();
        expect(events).toEqual(failureStage === 'stop' ? ['stop'] : ['stop', 'drain']);
        await expect(evaluate_sqlite_migration_cold_start(context)).resolves.toEqual({
            blocksStateWriters: false,
            phase: 'unarmed',
        });
    });

    it('leaves a non-resumable checkpoint and fails closed after an ambiguous flush rollback', async () => {
        const { context, state } = fixture({});
        const companion = install_companion({ sourceJson: '{}' });
        const hostCapabilities = vi.fn(() => ({
            extensionId: MIGRATION_COMPANION_EXTENSION_ID,
            extensionVersion: '0.7.0',
            extensionKind: 'ui',
            protocolVersion: 1,
            directoryDurabilitySupported: true,
        }));
        (vscode as unknown as { __setCommand(command: string, handler: (...args: unknown[]) => unknown): void })
            .__setCommand(MIGRATION_COMPANION_COMMANDS.hostCapabilities, hostCapabilities);
        const originalUpdate = context.globalState.update.bind(context.globalState);
        let updates = 0;
        (context.globalState as unknown as { update(key: string, value: unknown): Promise<void> }).update =
            vi.fn(async (key, value) => {
                updates += 1;
                if (updates === 2) throw new Error('checkpoint rollback outcome unknown');
                await originalUpdate(key, value);
            });
        const events: string[] = [];
        vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(
            'I Attest Every Other VS Code Window Is Closed' as never,
        );
        vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);

        await expect(prepare_sqlite_migration_arming(context, boundary(events), async () => {
            events.push('stop');
            throw new Error('viewer stop failed');
        })).rejects.toThrow(/could not flush every viewer or roll back/);

        expect(state.get(MIGRATION_ARMING_STATE_KEY)).toMatchObject({
            phase: 'armingInProgress',
            flushCompleted: false,
        });
        expect(events).toEqual(['stop', 'view-only']);
        expect(hostCapabilities).toHaveBeenCalledTimes(1);
        await expect(evaluate_sqlite_migration_cold_start(context)).resolves.toEqual({
            blocksStateWriters: true,
            phase: 'failedClosed',
        });
        expect(hostCapabilities).toHaveBeenCalledTimes(1);
        expect(companion.namespace).not.toHaveBeenCalled();
        expect(companion.submit).not.toHaveBeenCalled();
    });

    it('fences writers, drains, snapshots exact ordered bytes, and persists only arming metadata', async () => {
        const envelope = { z: { columnWidths: [{ 0: 120 }] }, a: {} };
        const { context, state } = fixture(envelope);
        const sourceJson = JSON.stringify(envelope);
        install_companion({ sourceJson });
        const events: string[] = [];
        let fenced = false;
        const activationBoundary = boundary(events);
        activationBoundary.enter_view_only = vi.fn(async () => {
            events.push('view-only');
            fenced = true;
        });
        const originalGet = context.globalState.get.bind(context.globalState);
        const sourceReadFenceStates: boolean[] = [];
        (context.globalState as unknown as { get(key: string, fallback?: unknown): unknown }).get = (key, fallback) => {
            if (key === 'tableViewer.fileState') sourceReadFenceStates.push(fenced);
            return originalGet(key, fallback);
        };
        vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(
            'I Attest Every Other VS Code Window Is Closed' as never,
        );
        vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);

        await expect(prepare_sqlite_migration_arming(context, activationBoundary, () => { events.push('stop'); }))
            .resolves.toBe(true);

        expect(events).toEqual(['stop', 'drain', 'view-only']);
        expect(sourceReadFenceStates).toEqual([false, true]);
        expect(state.get('tableViewer.fileState')).toBe(envelope);
        expect(state.get(MIGRATION_ARMING_STATE_KEY)).toMatchObject({
            phase: 'awaitingColdStart',
            profileDatabaseId: 'profile-a',
            storageEnvironmentId: 'environment-a',
            sourceDigest: digest(sourceJson),
        });
    });

    it('archives an existing fixed-root capsule when initial arming has no placement-local metadata', async () => {
        const envelope = { current: {} };
        const { context, state } = fixture(envelope);
        const companion = install_companion({
            sourceJson: JSON.stringify({ priorPlacement: {} }),
            active: true,
        });
        const submit = vi.fn(() => { throw new Error('submit must not run while another capsule is active'); });
        (vscode as unknown as { __setCommand(command: string, handler: (...args: unknown[]) => unknown): void })
            .__setCommand(MIGRATION_COMPANION_COMMANDS.submitCapsuleCandidate, submit);
        vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(
            'I Attest Every Other VS Code Window Is Closed' as never,
        );
        vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);

        await expect(prepare_sqlite_migration_arming(context, boundary([]), () => undefined))
            .resolves.toBe(true);

        expect(submit).not.toHaveBeenCalled();
        expect(companion.archive).toHaveBeenCalledTimes(1);
        expect(state.get(MIGRATION_ARMING_STATE_KEY)).toMatchObject({
            phase: 'awaitingColdStart',
            capsuleId: 'capsule-drift',
            sourceDigest: digest(JSON.stringify(envelope)),
        });
    });

    it('persists the durable checkpoint before any companion command can activate or mutate it', async () => {
        const { context, state } = fixture({});
        const installed = install_companion({ sourceJson: '{}' });
        const extension = vscode.extensions.getExtension(MIGRATION_COMPANION_EXTENSION_ID)!;
        const activate = vi.mocked(extension.activate);
        const assertCheckpoint = (flushCompleted: boolean) => {
            expect(state.get(MIGRATION_ARMING_STATE_KEY)).toMatchObject({
                phase: 'armingInProgress',
                sourceDigest: digest('{}'),
                flushCompleted,
            });
        };
        const capabilityFlushStates: boolean[] = [];
        const capabilities = vi.fn(() => {
            capabilityFlushStates.push((state.get(MIGRATION_ARMING_STATE_KEY) as { flushCompleted: boolean }).flushCompleted);
            return {
                extensionId: MIGRATION_COMPANION_EXTENSION_ID,
                extensionVersion: '0.7.0',
                extensionKind: 'ui',
                protocolVersion: 1,
                directoryDurabilitySupported: true,
            };
        });
        const submit = vi.fn((input: unknown) => {
            assertCheckpoint(true);
            return installed.submit(input);
        });
        const setCommand = (command: string, handler: (...args: unknown[]) => unknown) => (
            vscode as unknown as { __setCommand(command: string, handler: (...args: unknown[]) => unknown): void }
        ).__setCommand(command, handler);
        setCommand(MIGRATION_COMPANION_COMMANDS.hostCapabilities, capabilities);
        setCommand(MIGRATION_COMPANION_COMMANDS.submitCapsuleCandidate, submit);
        vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(
            'I Attest Every Other VS Code Window Is Closed' as never,
        );
        vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);

        await expect(prepare_sqlite_migration_arming(context, boundary([]), () => undefined))
            .resolves.toBe(true);
        expect(activate).not.toHaveBeenCalled();
        expect(capabilities).toHaveBeenCalledTimes(2);
        expect(capabilityFlushStates).toEqual([false, true]);
        expect(submit).toHaveBeenCalledTimes(1);
        expect(installed.identity().sourceDigest).toBe(digest('{}'));
    });

    it('waits for durable flush-completion persistence before routing any stateful companion command', async () => {
        const { context, state } = fixture({});
        const companion = install_companion({ sourceJson: '{}' });
        const hostCapabilities = vi.fn(() => ({
            extensionId: MIGRATION_COMPANION_EXTENSION_ID,
            extensionVersion: '0.7.0',
            extensionKind: 'ui',
            protocolVersion: 1,
            directoryDurabilitySupported: true,
        }));
        (vscode as unknown as { __setCommand(command: string, handler: (...args: unknown[]) => unknown): void })
            .__setCommand(MIGRATION_COMPANION_COMMANDS.hostCapabilities, hostCapabilities);
        const originalUpdate = context.globalState.update.bind(context.globalState);
        let releaseSecondWrite!: () => void;
        const secondWriteGate = new Promise<void>((resolve) => { releaseSecondWrite = resolve; });
        let reportSecondWriteStarted!: () => void;
        const secondWriteStarted = new Promise<void>((resolve) => { reportSecondWriteStarted = resolve; });
        let updates = 0;
        (context.globalState as unknown as { update(key: string, value: unknown): Promise<void> }).update =
            vi.fn(async (key, value) => {
                updates += 1;
                if (updates === 2) {
                    reportSecondWriteStarted();
                    await secondWriteGate;
                }
                await originalUpdate(key, value);
            });
        vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(
            'I Attest Every Other VS Code Window Is Closed' as never,
        );
        vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);

        const preparing = prepare_sqlite_migration_arming(context, boundary([]), () => undefined);
        await secondWriteStarted;
        expect(state.get(MIGRATION_ARMING_STATE_KEY)).toMatchObject({ flushCompleted: false });
        expect(hostCapabilities).toHaveBeenCalledTimes(1);
        expect(companion.namespace).not.toHaveBeenCalled();
        expect(companion.submit).not.toHaveBeenCalled();

        releaseSecondWrite();
        await expect(preparing).resolves.toBe(true);
        expect(hostCapabilities).toHaveBeenCalledTimes(2);
        expect(companion.namespace).toHaveBeenCalledTimes(1);
        expect(companion.submit).toHaveBeenCalledTimes(1);
    });

    it('does not route stateful companion commands when flush-completion persistence fails', async () => {
        const { context, state } = fixture({});
        const companion = install_companion({ sourceJson: '{}' });
        const hostCapabilities = vi.fn(() => ({
            extensionId: MIGRATION_COMPANION_EXTENSION_ID,
            extensionVersion: '0.7.0',
            extensionKind: 'ui',
            protocolVersion: 1,
            directoryDurabilitySupported: true,
        }));
        (vscode as unknown as { __setCommand(command: string, handler: (...args: unknown[]) => unknown): void })
            .__setCommand(MIGRATION_COMPANION_COMMANDS.hostCapabilities, hostCapabilities);
        const originalUpdate = context.globalState.update.bind(context.globalState);
        let updates = 0;
        (context.globalState as unknown as { update(key: string, value: unknown): Promise<void> }).update =
            vi.fn(async (key, value) => {
                updates += 1;
                if (updates === 2) throw new Error('flush completion write failed');
                await originalUpdate(key, value);
            });
        vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(
            'I Attest Every Other VS Code Window Is Closed' as never,
        );

        await expect(prepare_sqlite_migration_arming(context, boundary([]), () => undefined))
            .rejects.toThrow('flush completion write failed');
        expect(state.get(MIGRATION_ARMING_STATE_KEY)).toMatchObject({ flushCompleted: false });
        expect(hostCapabilities).toHaveBeenCalledTimes(1);
        expect(companion.namespace).not.toHaveBeenCalled();
        expect(companion.submit).not.toHaveBeenCalled();
    });

    it('does not activate or mutate the companion when checkpoint persistence fails', async () => {
        const { context } = fixture({});
        install_companion({ sourceJson: '{}' });
        const extension = vscode.extensions.getExtension(MIGRATION_COMPANION_EXTENSION_ID)!;
        const activate = vi.mocked(extension.activate);
        const submit = vi.fn();
        (vscode as unknown as { __setCommand(command: string, handler: (...args: unknown[]) => unknown): void })
            .__setCommand(MIGRATION_COMPANION_COMMANDS.submitCapsuleCandidate, submit);
        (context.globalState as unknown as { update(key: string, value: unknown): Promise<void> }).update =
            vi.fn(async () => { throw new Error('checkpoint write failed'); });
        vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(
            'I Attest Every Other VS Code Window Is Closed' as never,
        );

        await expect(prepare_sqlite_migration_arming(context, boundary([]), () => undefined))
            .rejects.toThrow('checkpoint write failed');
        expect(activate).not.toHaveBeenCalled();
        expect(submit).not.toHaveBeenCalled();
    });

    it('rejects a companion winner whose digest does not describe the exact submitted bytes', async () => {
        const { context, state } = fixture({});
        install_companion({ sourceJson: '{}' });
        (vscode as unknown as { __setCommand(command: string, handler: (...args: unknown[]) => unknown): void })
            .__setCommand(MIGRATION_COMPANION_COMMANDS.activeCapsule, () => ({
                capsuleId: 'capsule-a', sourceFormat: 'tableViewer.fileState.legacy',
                sourceDigest: 'f'.repeat(64),
                meta: { nextRevision: 1, absenceRevision: 0, nextRecencyOrder: '1' },
                entryCount: 0, status: 'armed',
            }));
        const events: string[] = [];
        vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(
            'I Attest Every Other VS Code Window Is Closed' as never,
        );

        await expect(prepare_sqlite_migration_arming(context, boundary(events), () => { events.push('stop'); }))
            .rejects.toThrow(/checkpointed Memento digest/);
        expect(events).toEqual(['stop', 'drain', 'view-only']);
        expect(state.get(MIGRATION_ARMING_STATE_KEY)).toMatchObject({
            phase: 'armingInProgress',
            sourceDigest: digest('{}'),
        });
    });

    it('reconciles an ambiguous capsule commit by replaying the exact checkpointed operation ids', async () => {
        const { context, state } = fixture({});
        const companion = install_companion({ sourceJson: '{}' });
        const attempts: Array<{ operationId: string; orderedSourceJson: string }> = [];
        const namespaceAttempts: string[] = [];
        const commands = vscode as unknown as { __setCommand(command: string, handler: (...args: unknown[]) => unknown): void };
        commands.__setCommand(MIGRATION_COMPANION_COMMANDS.namespace, (raw) => {
            namespaceAttempts.push((raw as { operationId: string }).operationId);
            return { profileDatabaseId: 'profile-a', storageEnvironmentId: 'environment-a', protocolVersion: 1 };
        });
        commands.__setCommand(MIGRATION_COMPANION_COMMANDS.submitCapsuleCandidate, (raw) => {
                const input = raw as { operationId: string; orderedSourceJson: string };
                attempts.push(input);
                const result = companion.submit(raw);
                if (attempts.length === 1) throw new Error('response lost after commit');
                return result;
            });
        vi.spyOn(vscode.window, 'showWarningMessage')
            .mockResolvedValueOnce('I Attest Every Other VS Code Window Is Closed' as never)
            .mockResolvedValue(undefined);

        await expect(prepare_sqlite_migration_arming(context, boundary([]), () => undefined))
            .rejects.toThrow(/response lost/);
        const checkpoint = state.get(MIGRATION_ARMING_STATE_KEY) as {
            capsuleOperationId: string;
            namespaceOperationId: string;
        };
        await expect(evaluate_sqlite_migration_cold_start(context)).resolves.toEqual({
            blocksStateWriters: true,
            phase: 'awaitingColdStart',
        });
        expect(attempts.map((attempt) => attempt.operationId)).toEqual([
            checkpoint.capsuleOperationId,
            checkpoint.capsuleOperationId,
        ]);
        expect(namespaceAttempts.slice(0, 2)).toEqual([
            checkpoint.namespaceOperationId,
            checkpoint.namespaceOperationId,
        ]);
        expect(state.get(MIGRATION_ARMING_STATE_KEY)).toMatchObject({ phase: 'awaitingColdStart' });
    });

    it('replaces an interrupted prior-version seed with a fresh upgrade archive', async () => {
        const { context, state } = fixture({});
        const companion = install_companion({ sourceJson: '{}' });
        (vscode as unknown as { __setCommand(command: string, handler: (...args: unknown[]) => unknown): void })
            .__setCommand(MIGRATION_COMPANION_COMMANDS.submitCapsuleCandidate, (raw) => {
                companion.submit(raw);
                throw new Error('old-version response lost after commit');
            });
        vi.spyOn(vscode.window, 'showWarningMessage')
            .mockResolvedValueOnce('I Attest Every Other VS Code Window Is Closed' as never)
            .mockResolvedValue(undefined);

        await expect(prepare_sqlite_migration_arming(context, boundary([]), () => undefined))
            .rejects.toThrow(/old-version response lost/);
        state.set(MIGRATION_ARMING_STATE_KEY, {
            ...(state.get(MIGRATION_ARMING_STATE_KEY) as Record<string, unknown>),
            extensionVersion: '0.6.9',
        });

        await expect(evaluate_sqlite_migration_cold_start(context)).resolves.toEqual({
            blocksStateWriters: true,
            phase: 'awaitingColdStart',
        });
        expect(companion.archive).toHaveBeenCalledTimes(1);
        expect(state.get(MIGRATION_ARMING_STATE_KEY)).toMatchObject({
            phase: 'awaitingColdStart',
            extensionVersion: '0.7.0',
            capsuleId: 'capsule-drift',
        });
    });

    it('archives current source drift after an interrupted capsule commit', async () => {
        const { context, state } = fixture({});
        const companion = install_companion({ sourceJson: '{}' });
        (vscode as unknown as { __setCommand(command: string, handler: (...args: unknown[]) => unknown): void })
            .__setCommand(MIGRATION_COMPANION_COMMANDS.submitCapsuleCandidate, (raw) => {
                companion.submit(raw);
                throw new Error('response lost after commit');
            });
        vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(
            'I Attest Every Other VS Code Window Is Closed' as never,
        );

        await expect(prepare_sqlite_migration_arming(context, boundary([]), () => undefined))
            .rejects.toThrow(/response lost/);
        const changed = { changed: { columnWidths: [{ 0: 240 }] } };
        state.set('tableViewer.fileState', changed);

        await expect(evaluate_sqlite_migration_cold_start(context)).resolves.toEqual({
            blocksStateWriters: true,
            phase: 'awaitingColdStart',
        });
        expect(companion.archive).toHaveBeenCalledWith(expect.objectContaining({
            orderedSourceJson: JSON.stringify(changed),
        }));
        expect(state.get(MIGRATION_ARMING_STATE_KEY)).toMatchObject({
            phase: 'awaitingColdStart',
            sourceDigest: digest(JSON.stringify(changed)),
        });
    });

    it('keeps a changed submit checkpoint decodable when no capsule was committed', async () => {
        const { context, state } = fixture({});
        install_companion({ sourceJson: '{}' });
        const commands = vscode as unknown as { __setCommand(command: string, handler: (...args: unknown[]) => unknown): void };
        commands.__setCommand(MIGRATION_COMPANION_COMMANDS.submitCapsuleCandidate, () => {
            throw new Error('submit unavailable');
        });
        vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(
            'I Attest Every Other VS Code Window Is Closed' as never,
        );
        await expect(prepare_sqlite_migration_arming(context, boundary([]), () => undefined))
            .rejects.toThrow('submit unavailable');
        state.set('tableViewer.fileState', { changed: {} });
        commands.__setCommand(MIGRATION_COMPANION_COMMANDS.activeCapsule, () => {
            throw new Error('No active migration capsule is armed.');
        });

        await expect(evaluate_sqlite_migration_cold_start(context)).resolves.toEqual({
            blocksStateWriters: true,
            phase: 'failedClosed',
        });
        expect(read_migration_arming_state(context)).toMatchObject({
            phase: 'armingInProgress',
            capsuleMutation: 'submit',
            sourceDigest: digest(JSON.stringify({ changed: {} })),
        });
        expect(read_migration_arming_state(context)).not.toHaveProperty('expectedProfileDatabaseId');
        expect(read_migration_arming_state(context)).not.toHaveProperty('expectedStorageEnvironmentId');
    });

    it('replays the exact receipt after capsule commit when finalized-state persistence fails', async () => {
        const { context, state } = fixture({});
        const companion = install_companion({ sourceJson: '{}' });
        const attempts: Array<{ operationId: string; orderedSourceJson: string }> = [];
        (vscode as unknown as { __setCommand(command: string, handler: (...args: unknown[]) => unknown): void })
            .__setCommand(MIGRATION_COMPANION_COMMANDS.submitCapsuleCandidate, (raw) => {
                const input = raw as { operationId: string; orderedSourceJson: string };
                attempts.push(input);
                return companion.submit(raw);
            });
        const originalUpdate = context.globalState.update.bind(context.globalState);
        let rejectFinalized = true;
        (context.globalState as unknown as { update(key: string, value: unknown): Promise<void> }).update =
            vi.fn(async (key, value) => {
                if (rejectFinalized
                    && key === MIGRATION_ARMING_STATE_KEY
                    && (value as { phase?: string }).phase === 'awaitingColdStart') {
                    rejectFinalized = false;
                    throw new Error('final state write failed');
                }
                await originalUpdate(key, value);
            });
        vi.spyOn(vscode.window, 'showWarningMessage')
            .mockResolvedValueOnce('I Attest Every Other VS Code Window Is Closed' as never)
            .mockResolvedValue(undefined);

        await expect(prepare_sqlite_migration_arming(context, boundary([]), () => undefined))
            .rejects.toThrow('final state write failed');
        const checkpoint = state.get(MIGRATION_ARMING_STATE_KEY) as { capsuleOperationId: string };
        await expect(evaluate_sqlite_migration_cold_start(context)).resolves.toEqual({
            blocksStateWriters: true,
            phase: 'awaitingColdStart',
        });
        expect(attempts.map(({ operationId }) => operationId)).toEqual([
            checkpoint.capsuleOperationId,
            checkpoint.capsuleOperationId,
        ]);
    });

    it('remains fail-closed after the writer boundary if companion seeding fails', async () => {
        const { context, state } = fixture({});
        install_companion({ sourceJson: '{}' });
        (vscode as unknown as { __setCommand(command: string, handler: (...args: unknown[]) => unknown): void })
            .__setCommand(MIGRATION_COMPANION_COMMANDS.submitCapsuleCandidate, () => { throw new Error('route failed'); });
        const events: string[] = [];
        vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(
            'I Attest Every Other VS Code Window Is Closed' as never,
        );

        await expect(prepare_sqlite_migration_arming(context, boundary(events), () => { events.push('stop'); }))
            .rejects.toThrow('route failed');
        expect(events).toEqual(['stop', 'drain', 'view-only']);
        expect(state.get(MIGRATION_ARMING_STATE_KEY)).toMatchObject({
            phase: 'armingInProgress',
            sourceDigest: digest('{}'),
        });
    });
});

describe('cold capsule confirmation', () => {
    it('keeps the authoritative Memento writer available on unarmed Windows hosts', async () => {
        vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
        const showError = vi.spyOn(vscode.window, 'showErrorMessage');
        const { context } = fixture({});

        await expect(evaluate_sqlite_migration_cold_start(context)).resolves.toEqual({
            blocksStateWriters: false,
            phase: 'unarmed',
        });
        expect(showError).not.toHaveBeenCalled();
    });

    function armed_fixture(envelope: unknown, override: Partial<FinalizedMigrationArmingState> = {}) {
        const value = fixture(envelope);
        const sourceJson = JSON.stringify(envelope);
        value.state.set(MIGRATION_ARMING_STATE_KEY, {
            version: 1,
            phase: 'awaitingColdStart',
            extensionVersion: '0.7.0',
            profileDatabaseId: 'profile-a',
            storageEnvironmentId: 'environment-a',
            capsuleId: 'capsule-a',
            sourceFormat: 'tableViewer.fileState.legacy',
            sourceDigest: digest(sourceJson),
            namespaceOperationId: 'namespace-op',
            armedAtMs: 1,
            ...override,
        } satisfies MigrationArmingState);
        return { ...value, sourceJson };
    }

    it('restores an established cold fence when a later arming attempt uses an unsupported companion host', async () => {
        const seeded = armed_fixture({});
        const previous = seeded.state.get(MIGRATION_ARMING_STATE_KEY);
        install_companion({
            sourceJson: seeded.sourceJson,
            directoryDurabilitySupported: false,
            active: true,
        });
        vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(
            'I Attest Every Other VS Code Window Is Closed' as never,
        );
        vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);

        await expect(prepare_sqlite_migration_arming(seeded.context, boundary([]), () => undefined))
            .resolves.toBe(false);
        expect(seeded.state.get(MIGRATION_ARMING_STATE_KEY)).toEqual(previous);
        await expect(evaluate_sqlite_migration_cold_start(seeded.context)).resolves.toEqual({
            blocksStateWriters: true,
            phase: 'failedClosed',
        });
    });

    it('blocks writers fail-closed for a cold-confirmed phase without its required attestation timestamp', async () => {
        const seeded = armed_fixture({});
        seeded.state.set(MIGRATION_ARMING_STATE_KEY, {
            ...(seeded.state.get(MIGRATION_ARMING_STATE_KEY) as MigrationArmingState),
            phase: 'coldConfirmed',
        });
        vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);
        await expect(evaluate_sqlite_migration_cold_start(seeded.context)).resolves.toEqual({
            blocksStateWriters: true,
            phase: 'failedClosed',
        });
    });

    it('confirms only after exact namespace, capsule, digest, and explicit cold attestation all match', async () => {
        const { context, state, sourceJson } = armed_fixture({});
        install_companion({ sourceJson, active: true });
        vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(
            'I Attest Every VS Code Window Was Closed' as never,
        );
        vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);

        await expect(evaluate_sqlite_migration_cold_start(context)).resolves.toEqual({
            blocksStateWriters: true,
            phase: 'coldConfirmed',
        });
        expect(state.get(MIGRATION_ARMING_STATE_KEY)).toMatchObject({ phase: 'coldConfirmed' });
    });

    it('replays one persisted namespace receipt instead of growing receipts on every cold start', async () => {
        const seeded = armed_fixture({}, { phase: 'coldConfirmed', coldConfirmedAtMs: 2 });
        const companion = install_companion({ sourceJson: seeded.sourceJson, active: true });

        await evaluate_sqlite_migration_cold_start(seeded.context);
        await evaluate_sqlite_migration_cold_start(seeded.context);

        expect(companion.namespace).toHaveBeenCalledTimes(2);
        expect(companion.namespace.mock.calls.map(([input]) => input)).toEqual([
            { placementKeyDigest: expect.any(String), operationId: 'namespace-op' },
            { placementKeyDigest: expect.any(String), operationId: 'namespace-op' },
        ]);
    });

    it('does not cold-confirm when the user declines even though every identity guard matches', async () => {
        const { context, state, sourceJson } = armed_fixture({});
        install_companion({ sourceJson, active: true });
        vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);

        await expect(evaluate_sqlite_migration_cold_start(context)).resolves.toEqual({
            blocksStateWriters: true,
            phase: 'awaitingColdStart',
        });
        expect(state.get(MIGRATION_ARMING_STATE_KEY)).toMatchObject({ phase: 'awaitingColdStart' });
    });

    it('archives changed Memento bytes, records the new cold winner, and requires another cold cycle', async () => {
        const seeded = armed_fixture({ old: {} });
        seeded.state.set('tableViewer.fileState', { changed: {} });
        const companion = install_companion({ sourceJson: seeded.sourceJson, active: true });
        vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);

        await expect(evaluate_sqlite_migration_cold_start(seeded.context)).resolves.toEqual({
            blocksStateWriters: true,
            phase: 'awaitingColdStart',
        });
        expect(companion.archive).toHaveBeenCalledTimes(1);
        expect(seeded.state.get(MIGRATION_ARMING_STATE_KEY)).toMatchObject({
            phase: 'awaitingColdStart',
            capsuleId: 'capsule-drift',
            sourceDigest: digest(JSON.stringify({ changed: {} })),
        });
    });

    it('reconciles an ambiguous archive commit with the exact checkpointed operation id', async () => {
        const seeded = armed_fixture({ old: {} });
        seeded.state.set('tableViewer.fileState', { changed: {} });
        const companion = install_companion({ sourceJson: seeded.sourceJson, active: true });
        const attempts: Array<{ operationId: string; orderedSourceJson: string }> = [];
        let loseFirstResponse = true;
        (vscode as unknown as { __setCommand(command: string, handler: (...args: unknown[]) => unknown): void })
            .__setCommand(MIGRATION_COMPANION_COMMANDS.archiveDrift, async (raw) => {
                const input = raw as { operationId: string; orderedSourceJson: string };
                attempts.push(input);
                await companion.archive(raw);
                if (loseFirstResponse) {
                    loseFirstResponse = false;
                    throw new Error('archive response lost after commit');
                }
                return {};
            });
        vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);
        vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);

        await expect(evaluate_sqlite_migration_cold_start(seeded.context)).resolves.toEqual({
            blocksStateWriters: true,
            phase: 'failedClosed',
        });
        const checkpoint = seeded.state.get(MIGRATION_ARMING_STATE_KEY) as { capsuleOperationId: string };
        await expect(evaluate_sqlite_migration_cold_start(seeded.context)).resolves.toEqual({
            blocksStateWriters: true,
            phase: 'awaitingColdStart',
        });
        expect(attempts.map(({ operationId }) => operationId)).toEqual([
            checkpoint.capsuleOperationId,
            checkpoint.capsuleOperationId,
        ]);
    });

    it('fails closed when drift archival does not arm the exact current source bytes', async () => {
        const seeded = armed_fixture({ old: {} });
        seeded.state.set('tableViewer.fileState', { changed: {} });
        install_companion({ sourceJson: seeded.sourceJson, active: true });
        (vscode as unknown as { __setCommand(command: string, handler: (...args: unknown[]) => unknown): void })
            .__setCommand(MIGRATION_COMPANION_COMMANDS.archiveDrift, () => ({}));
        vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);

        await expect(evaluate_sqlite_migration_cold_start(seeded.context)).resolves.toEqual({
            blocksStateWriters: true,
            phase: 'failedClosed',
        });
        expect(seeded.state.get(MIGRATION_ARMING_STATE_KEY)).toMatchObject({
            phase: 'armingInProgress',
            capsuleMutation: 'archiveDrift',
            sourceDigest: digest(JSON.stringify({ changed: {} })),
        });
    });

    it.each([
        ['profile database', { profileDatabaseId: 'profile-other' }],
        ['storage environment', { storageEnvironmentId: 'environment-other' }],
        ['capsule id', { capsuleId: 'capsule-other' }],
        ['source format', { sourceFormat: 'tableViewer.fileState.other' }],
        ['active source digest', { sourceJson: '{"different":{}}' }],
    ])('fails closed without drift or attestation when the %s identity differs', async (_label, override) => {
        const seeded = armed_fixture({});
        const companion = install_companion({ sourceJson: seeded.sourceJson, active: true, ...override });
        const attestation = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
        vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);

        await expect(evaluate_sqlite_migration_cold_start(seeded.context)).resolves.toEqual({
            blocksStateWriters: true,
            phase: 'failedClosed',
        });
        expect(companion.archive).not.toHaveBeenCalled();
        expect(attestation).not.toHaveBeenCalled();
    });

    it('routes a direct version upgrade through a fresh drift seed and another cold cycle', async () => {
        const seeded = armed_fixture({}, { extensionVersion: '0.6.9' });
        const companion = install_companion({ sourceJson: seeded.sourceJson, active: true });
        vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);

        await expect(evaluate_sqlite_migration_cold_start(seeded.context)).resolves.toEqual({
            blocksStateWriters: true,
            phase: 'awaitingColdStart',
        });
        expect(companion.archive).toHaveBeenCalledTimes(1);
        expect(seeded.state.get(MIGRATION_ARMING_STATE_KEY)).toMatchObject({ extensionVersion: '0.7.0' });
    });
});
