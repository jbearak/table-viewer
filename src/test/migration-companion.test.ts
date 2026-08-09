import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
    MIGRATION_ARMING_STATE_KEY,
    MIGRATION_COMPANION_COMMANDS,
    MIGRATION_COMPANION_COMMAND_TIMEOUT_MS,
    MIGRATION_COMPANION_EXTENSION_ID,
    migration_companion_directory_durability_supported,
    migration_placement_key_digest,
    read_migration_arming_state,
    require_migration_companion,
} from '../migration-companion';

function context(version = '0.7.0') {
    const values = new Map<string, unknown>();
    return {
        value: {
            extension: { packageJSON: { version }, extensionKind: vscode.ExtensionKind.Workspace },
            globalStorageUri: vscode.Uri.from({ scheme: 'file', path: '/profile/table-viewer' }),
            globalState: {
                get(key: string) { return values.get(key); },
                async update(key: string, value: unknown) { values.set(key, value); },
            },
        } as unknown as vscode.ExtensionContext,
        values,
    };
}

function set_command(command: string, handler: (...args: unknown[]) => unknown) {
    (vscode as unknown as { __setCommand(command: string, handler: (...args: unknown[]) => unknown): void })
        .__setCommand(command, handler);
}

function valid_capabilities(overrides: Record<string, unknown> = {}) {
    return {
        extensionId: MIGRATION_COMPANION_EXTENSION_ID,
        extensionVersion: '0.7.0',
        extensionKind: 'ui',
        protocolVersion: 1,
        directoryDurabilitySupported: true,
        ...overrides,
    };
}

beforeEach(() => {
    (vscode as unknown as { __reset(): void }).__reset();
    (vscode.env as unknown as { remoteName?: string }).remoteName = undefined;
    set_command(MIGRATION_COMPANION_COMMANDS.hostCapabilities, () => valid_capabilities());
});

describe('exact-version local UI companion routing', () => {
    it('resets active editor state with the rest of the VS Code mock', () => {
        (vscode.window as unknown as { activeTextEditor?: { document: { uri: vscode.Uri } } })
            .activeTextEditor = { document: { uri: vscode.Uri.file('/workspace/leaked.csv') } };

        (vscode as unknown as { __reset(): void }).__reset();

        expect((vscode.window as unknown as { activeTextEditor?: unknown }).activeTextEditor)
            .toBeUndefined();
    });

    it('validates companion identity entirely through the cross-host command bridge', async () => {
        expect(vscode.extensions.getExtension(MIGRATION_COMPANION_EXTENSION_ID)).toBeUndefined();
        set_command(MIGRATION_COMPANION_COMMANDS.namespace, () => ({
            profileDatabaseId: 'profile-a', storageEnvironmentId: 'environment-a', protocolVersion: 1,
        }));

        const client = await require_migration_companion(context().value);

        await expect(client.namespace({ placementKeyDigest: 'placement', operationId: 'operation' }))
            .resolves.toEqual({ profileDatabaseId: 'profile-a', storageEnvironmentId: 'environment-a', protocolVersion: 1 });
    });

    it('rejects missing, mismatched, non-UI, and incompatible companion bridge identities', async () => {
        set_command(MIGRATION_COMPANION_COMMANDS.hostCapabilities, () => undefined);
        await expect(require_migration_companion(context().value)).rejects.toThrow(/invalid response/);

        set_command(MIGRATION_COMPANION_COMMANDS.hostCapabilities, () => valid_capabilities({ extensionVersion: '0.7.1' }));
        await expect(require_migration_companion(context().value)).rejects.toThrow(/requires companion 0\.7\.0/);

        set_command(MIGRATION_COMPANION_COMMANDS.hostCapabilities, () => valid_capabilities({ extensionKind: 'workspace' }));
        await expect(require_migration_companion(context().value)).rejects.toThrow(/local UI extension host/);

        set_command(MIGRATION_COMPANION_COMMANDS.hostCapabilities, () => valid_capabilities({ protocolVersion: 2 }));
        await expect(require_migration_companion(context().value)).rejects.toThrow(/host protocol version/);

        set_command(MIGRATION_COMPANION_COMMANDS.hostCapabilities, () => valid_capabilities({ extensionId: 'other.extension' }));
        await expect(require_migration_companion(context().value)).rejects.toThrow(/extension identity/);
    });

    it('queries directory durability from the local UI companion host with an exact response', async () => {
        set_command(MIGRATION_COMPANION_COMMANDS.hostCapabilities, () => valid_capabilities({
            directoryDurabilitySupported: false,
        }));

        await expect(migration_companion_directory_durability_supported(context().value))
            .resolves.toBe(false);
        set_command(MIGRATION_COMPANION_COMMANDS.hostCapabilities, () => valid_capabilities({
            platform: 'secret-extra',
        }));
        await expect(migration_companion_directory_durability_supported(context().value))
            .rejects.toThrow(/invalid response schema/);
    });

    it('enforces namespace protocol response shapes after the host handshake', async () => {
        set_command(MIGRATION_COMPANION_COMMANDS.namespace, () => ({
            profileDatabaseId: 'profile-a', storageEnvironmentId: 'environment-a', protocolVersion: 1,
        }));
        const client = await require_migration_companion(context().value);
        await expect(client.namespace({ placementKeyDigest: 'placement', operationId: 'operation' }))
            .resolves.toEqual({ profileDatabaseId: 'profile-a', storageEnvironmentId: 'environment-a', protocolVersion: 1 });

        set_command(MIGRATION_COMPANION_COMMANDS.namespace, () => ({
            profileDatabaseId: 'profile-a', storageEnvironmentId: 'environment-a', protocolVersion: 2,
        }));
        await expect(client.namespace({ placementKeyDigest: 'placement', operationId: 'operation-2' }))
            .rejects.toThrow(/protocol version/);
    });

    it('rejects response extras instead of silently discarding sensitive fields', async () => {
        set_command(MIGRATION_COMPANION_COMMANDS.namespace, () => ({
            profileDatabaseId: 'profile-a', storageEnvironmentId: 'environment-a', protocolVersion: 1,
            resourcePath: '/private/secret.csv',
        }));
        const client = await require_migration_companion(context().value);
        await expect(client.namespace({ placementKeyDigest: 'a'.repeat(64), operationId: 'operation' }))
            .rejects.toThrow(/response schema/);
    });

    it('rejects malformed capsule metadata rather than accepting a partial identity', async () => {
        set_command(MIGRATION_COMPANION_COMMANDS.activeCapsule, () => ({
            capsuleId: 'capsule-a', sourceFormat: 'format', sourceDigest: 'd'.repeat(64),
            meta: { nextRevision: 1, absenceRevision: 0, nextRecencyOrder: 'not-an-integer' },
            entryCount: 1, status: 'armed',
        }));
        const client = await require_migration_companion(context().value);
        await expect(client.activeCapsule()).rejects.toThrow();
    });
});

describe('cross-host command deadlines', () => {
    it('times out an unresponsive host-capability command without exposing inputs', async () => {
        vi.useFakeTimers();
        try {
            set_command(MIGRATION_COMPANION_COMMANDS.hostCapabilities, () => new Promise(() => undefined));
            const pending = migration_companion_directory_durability_supported(context().value);
            const rejection = expect(pending).rejects.toThrow(
                new RegExp(`${MIGRATION_COMPANION_COMMANDS.hostCapabilities}.*did not answer in time`),
            );
            await vi.advanceTimersByTimeAsync(MIGRATION_COMPANION_COMMAND_TIMEOUT_MS);
            await rejection;
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('bounds every stateful companion client call', async () => {
        vi.useFakeTimers();
        try {
            const client = await require_migration_companion(context().value);
            const cases: readonly [string, () => Promise<unknown>][] = [
                [MIGRATION_COMPANION_COMMANDS.namespace, () => client.namespace({ placementKeyDigest: 'placement', operationId: 'operation' })],
                [MIGRATION_COMPANION_COMMANDS.activeCapsule, () => client.activeCapsule()],
                [MIGRATION_COMPANION_COMMANDS.submitCapsuleCandidate, () => client.submitCapsuleCandidate({ operationId: 'operation', orderedSourceJson: '{}' })],
                [MIGRATION_COMPANION_COMMANDS.archiveDrift, () => client.archiveDrift({ operationId: 'operation', orderedSourceJson: '{}' })],
                [MIGRATION_COMPANION_COMMANDS.beginEnvironmentImport, () => client.beginEnvironmentImport({
                    operationId: 'operation', capsuleId: 'capsule', sourceDigest: 'd'.repeat(64),
                    storageEnvironmentId: 'environment', databaseId: 'database',
                })],
                [MIGRATION_COMPANION_COMMANDS.environmentImportStatus, () => client.environmentImportStatus({
                    importClaimId: 'claim', capsuleId: 'capsule', storageEnvironmentId: 'environment', databaseId: 'database',
                })],
                [MIGRATION_COMPANION_COMMANDS.abandonEnvironmentImport, () => client.abandonEnvironmentImport({
                    operationId: 'operation', importClaimId: 'claim', capsuleId: 'capsule',
                    storageEnvironmentId: 'environment', databaseId: 'database', abandonmentEvidenceDigest: 'e'.repeat(64),
                })],
                [MIGRATION_COMPANION_COMMANDS.confirmEnvironment, () => client.confirmEnvironment({
                    operationId: 'operation', importClaimId: 'claim', capsuleId: 'capsule', sourceDigest: 'd'.repeat(64),
                    storageEnvironmentId: 'environment', databaseId: 'database',
                })],
                [MIGRATION_COMPANION_COMMANDS.confirmEnvironmentSourceRetirement, () => client.confirmEnvironmentSourceRetirement({
                    operationId: 'operation', capsuleId: 'capsule', sourceDigest: 'd'.repeat(64),
                    storageEnvironmentId: 'environment', databaseId: 'database', retirementKind: 'naturallyComplete',
                    sourceStateDigest: 's'.repeat(64),
                })],
                [MIGRATION_COMPANION_COMMANDS.preparePendingEditRecovery, () => client.preparePendingEditRecovery({
                    operationId: 'operation', storageEnvironmentId: 'environment', databaseId: 'database',
                    recoveryEntryId: 'entry', kind: 'clear', resourceIdentityJson: '{}',
                    authorityRevision: 1, physicalRevision: 1, projectionRevision: 1,
                })],
                [MIGRATION_COMPANION_COMMANDS.confirmPendingEditRecovery, () => client.confirmPendingEditRecovery({
                    operationId: 'operation', recoveryRecordId: 'recovery', committedStateRevision: 2,
                })],
            ];
            for (const [command, invoke] of cases) {
                set_command(command, () => new Promise(() => undefined));
                const pending = invoke();
                const rejection = expect(pending).rejects.toThrow(new RegExp(`${command}.*did not answer in time`));
                await vi.advanceTimersByTimeAsync(MIGRATION_COMPANION_COMMAND_TIMEOUT_MS);
                await rejection;
                expect(vi.getTimerCount()).toBe(0);
            }
        } finally {
            vi.useRealTimers();
        }
    });

    it('returns a valid response before the deadline and clears its timer', async () => {
        vi.useFakeTimers();
        try {
            let resolveNamespace!: (value: unknown) => void;
            set_command(MIGRATION_COMPANION_COMMANDS.namespace, () => new Promise((resolve) => {
                resolveNamespace = resolve;
            }));
            const client = await require_migration_companion(context().value);
            const pending = client.namespace({ placementKeyDigest: 'placement', operationId: 'operation' });
            await vi.advanceTimersByTimeAsync(MIGRATION_COMPANION_COMMAND_TIMEOUT_MS - 1);
            resolveNamespace({
                profileDatabaseId: 'profile-a', storageEnvironmentId: 'environment-a', protocolVersion: 1,
            });
            await expect(pending).resolves.toMatchObject({ profileDatabaseId: 'profile-a' });
            expect(vi.getTimerCount()).toBe(0);
            await vi.advanceTimersByTimeAsync(1);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('bridge privacy', () => {
    it('returns only schema-limited metadata and discards payloads returned by write commands', async () => {
        const secret = '/private/workspace/secret.csv';
        set_command(MIGRATION_COMPANION_COMMANDS.namespace, () => ({
            profileDatabaseId: 'profile-a', storageEnvironmentId: 'environment-a', protocolVersion: 1,
        }));
        set_command(MIGRATION_COMPANION_COMMANDS.activeCapsule, () => ({
            capsuleId: 'capsule-a', sourceFormat: 'format', sourceDigest: 'd'.repeat(64),
            meta: { nextRevision: 1, absenceRevision: 0, nextRecencyOrder: '2' },
            entryCount: 1, status: 'armed',
        }));
        set_command(MIGRATION_COMPANION_COMMANDS.submitCapsuleCandidate, () => ({
            capsuleId: 'capsule-a', sourceDigest: 'd'.repeat(64),
            resourcePath: secret, pendingEdits: { '0:0': 'sensitive' }, orderedSourceJson: '{"sensitive":true}',
        }));
        set_command(MIGRATION_COMPANION_COMMANDS.preparePendingEditRecovery, () => ({
            recoveryRecordId: 'recovery-a',
        }));
        set_command(MIGRATION_COMPANION_COMMANDS.confirmPendingEditRecovery, () => ({}));

        const client = await require_migration_companion(context().value);
        await expect(client.submitCapsuleCandidate({
            operationId: 'sensitive-capsule-op', orderedSourceJson: '{}',
        })).rejects.toThrow(/response schema/);
        set_command(MIGRATION_COMPANION_COMMANDS.submitCapsuleCandidate, () => ({
            capsuleId: 'capsule-a', sourceDigest: 'd'.repeat(64),
        }));
        const outputs = [
            await client.namespace({ placementKeyDigest: 'placement', operationId: 'namespace-op' }),
            await client.activeCapsule(),
            await client.submitCapsuleCandidate({ operationId: 'capsule-op', orderedSourceJson: '{}' }),
            await client.preparePendingEditRecovery({
                storageEnvironmentId: 'environment-a', databaseId: 'database-a', recoveryEntryId: 'entry-a',
                operationId: 'recovery-op', kind: 'clear', resourceIdentityJson: '{}',
                authorityRevision: 1, physicalRevision: 1, projectionRevision: 1,
            }),
            await client.confirmPendingEditRecovery({ operationId: 'confirm-op', recoveryRecordId: 'recovery-a', committedStateRevision: 2 }),
        ];
        const serialized = JSON.stringify(outputs, (_key, value) => typeof value === 'bigint' ? value.toString() : value);
        expect(serialized).not.toContain(secret);
        expect(serialized).not.toContain('pendingEdits');
        expect(serialized).not.toContain('orderedSourceJson');
        expect(outputs.at(-1)).toBeUndefined();
    });
});

describe('placement and persisted arming guards', () => {
    it('creates a deterministic local placement digest and changes it for a remote authority', () => {
        const fixture = context().value;
        const local = migration_placement_key_digest(fixture);
        expect(migration_placement_key_digest(fixture)).toBe(local);
        expect(local).toMatch(/^[a-f0-9]{64}$/);
        (vscode.env as unknown as { remoteName?: string }).remoteName = 'ssh-remote';
        (vscode.workspace as unknown as { workspaceFolders?: readonly { uri: vscode.Uri }[] }).workspaceFolders = [{
            uri: vscode.Uri.from({ scheme: 'vscode-remote', authority: 'ssh-remote+host-a', path: '/workspace' }),
        }];
        const remoteA = migration_placement_key_digest(fixture);
        expect(remoteA).not.toBe(local);
        (vscode.workspace as unknown as { workspaceFolders?: readonly { uri: vscode.Uri }[] }).workspaceFolders = [{
            uri: vscode.Uri.from({ scheme: 'vscode-remote', authority: 'ssh-remote+host-b', path: '/workspace' }),
        }];
        expect(migration_placement_key_digest(fixture)).not.toBe(remoteA);
    });

    it('uses the concrete workspace-file or explicit-resource authority without hashing paths', () => {
        const fixture = context().value;
        (vscode.env as unknown as { remoteName?: string }).remoteName = 'ssh-remote';
        (vscode.workspace as unknown as { workspaceFile?: vscode.Uri }).workspaceFile = vscode.Uri.from({
            scheme: 'vscode-remote', authority: 'ssh-remote+host-a', path: '/first/workspace.code-workspace',
        });
        const workspaceFileDigest = migration_placement_key_digest(fixture);
        (vscode.workspace as unknown as { workspaceFile?: vscode.Uri }).workspaceFile = vscode.Uri.from({
            scheme: 'vscode-remote', authority: 'ssh-remote+host-a', path: '/other/workspace.code-workspace',
        });
        expect(migration_placement_key_digest(fixture)).toBe(workspaceFileDigest);
        (vscode.workspace as unknown as { workspaceFile?: vscode.Uri }).workspaceFile = undefined;
        (vscode.window as unknown as { activeTextEditor?: { document: { uri: vscode.Uri } } }).activeTextEditor = {
            document: {
                uri: vscode.Uri.from({ scheme: 'vscode-remote', authority: 'ssh-remote+host-c', path: '/single.csv' }),
            },
        };
        expect(migration_placement_key_digest(fixture)).toMatch(/^[a-f0-9]{64}$/);
        (vscode.window as unknown as { activeTextEditor?: unknown }).activeTextEditor = undefined;
        expect(migration_placement_key_digest(fixture, vscode.Uri.from({
            scheme: 'vscode-remote', authority: 'ssh-remote+host-b', path: '/resource-a',
        }))).not.toBe(workspaceFileDigest);
        expect(migration_placement_key_digest(fixture, vscode.Uri.from({
            scheme: 'vscode-remote', authority: 'ssh-remote+host-b', path: '/resource-b',
        }))).toBe(migration_placement_key_digest(fixture, vscode.Uri.from({
            scheme: 'vscode-remote', authority: 'ssh-remote+host-b', path: '/resource-a',
        })));
    });

    it('fails closed when remote configuration forces the workspace extension into the UI host', () => {
        const fixture = context().value;
        (vscode.env as unknown as { remoteName?: string }).remoteName = 'ssh-remote';
        (fixture.extension as unknown as { extensionKind: vscode.ExtensionKind }).extensionKind = vscode.ExtensionKind.UI;
        (vscode.workspace as unknown as { workspaceFolders?: readonly { uri: vscode.Uri }[] }).workspaceFolders = [{
            uri: vscode.Uri.from({ scheme: 'vscode-remote', authority: 'ssh-remote+host-a', path: '/workspace' }),
        }];

        expect(() => migration_placement_key_digest(fixture)).toThrow(/workspace extension host/);
    });

    it('fails closed for remote placement with no concrete authority or multiple authorities', () => {
        const fixture = context().value;
        (vscode.env as unknown as { remoteName?: string }).remoteName = 'ssh-remote';
        expect(() => migration_placement_key_digest(fixture)).toThrow(/one concrete remote storage authority/);
        (vscode.workspace as unknown as { workspaceFolders?: readonly { uri: unknown }[] }).workspaceFolders = [
            { uri: vscode.Uri.from({ scheme: 'vscode-remote', authority: 'ssh-remote+host-a', path: '/a' }) },
            { uri: vscode.Uri.from({ scheme: 'vscode-remote', authority: 'ssh-remote+host-b', path: '/b' }) },
        ];
        expect(() => migration_placement_key_digest(fixture)).toThrow(/one concrete remote storage authority/);
    });

    it('accepts a complete arming record and rejects malformed state fail-closed', () => {
        const fixture = context();
        fixture.values.set(MIGRATION_ARMING_STATE_KEY, {
            version: 1, phase: 'awaitingColdStart', extensionVersion: '0.7.0',
            profileDatabaseId: 'profile-a', storageEnvironmentId: 'environment-a', capsuleId: 'capsule-a',
            sourceFormat: 'format', sourceDigest: 'd'.repeat(64),
            namespaceOperationId: 'namespace-op', armedAtMs: 1,
        });
        expect(read_migration_arming_state(fixture.value)).toMatchObject({ phase: 'awaitingColdStart', capsuleId: 'capsule-a' });
        const complete = fixture.values.get(MIGRATION_ARMING_STATE_KEY) as Record<string, unknown>;
        fixture.values.set(MIGRATION_ARMING_STATE_KEY, { ...complete, coldConfirmedAtMs: 2 });
        expect(() => read_migration_arming_state(fixture.value)).toThrow(/invalid response schema/);
        fixture.values.set(MIGRATION_ARMING_STATE_KEY, { ...complete, phase: 'coldConfirmed' });
        expect(() => read_migration_arming_state(fixture.value)).toThrow(/invalid response schema/);
        fixture.values.set(MIGRATION_ARMING_STATE_KEY, { version: 1, phase: 'awaitingColdStart' });
        expect(() => read_migration_arming_state(fixture.value)).toThrow(/invalid response/);

        const inProgress = {
            version: 1, phase: 'armingInProgress', extensionVersion: '0.7.0',
            placementKeyDigest: 'a'.repeat(64), sourceDigest: 'b'.repeat(64),
            flushCompleted: true, capsuleMutation: 'submit', namespaceOperationId: 'namespace-op',
            capsuleOperationId: 'capsule-op', armedAtMs: 1,
        };
        fixture.values.set(MIGRATION_ARMING_STATE_KEY, inProgress);
        expect(read_migration_arming_state(fixture.value)).toEqual(inProgress);
        fixture.values.set(MIGRATION_ARMING_STATE_KEY, { ...inProgress, flushCompleted: false });
        expect(read_migration_arming_state(fixture.value)).toMatchObject({ flushCompleted: false });
        const { flushCompleted: _flushCompleted, ...missingFlushCompleted } = inProgress;
        void _flushCompleted;
        fixture.values.set(MIGRATION_ARMING_STATE_KEY, missingFlushCompleted);
        expect(() => read_migration_arming_state(fixture.value)).toThrow(/invalid response schema/);
        fixture.values.set(MIGRATION_ARMING_STATE_KEY, { ...inProgress, flushCompleted: 'yes' });
        expect(() => read_migration_arming_state(fixture.value)).toThrow(/invalid response/);
        fixture.values.set(MIGRATION_ARMING_STATE_KEY, { ...inProgress, capsuleOperationId: '' });
        expect(() => read_migration_arming_state(fixture.value)).toThrow(/invalid response/);
        fixture.values.set(MIGRATION_ARMING_STATE_KEY, { ...inProgress, capsuleMutation: 'replaceAfterUpgrade' });
        expect(read_migration_arming_state(fixture.value)).toMatchObject({ capsuleMutation: 'replaceAfterUpgrade' });
        fixture.values.set(MIGRATION_ARMING_STATE_KEY, {
            ...inProgress,
            capsuleMutation: 'replaceAfterUpgrade',
            expectedProfileDatabaseId: 'profile-a',
            expectedStorageEnvironmentId: 'environment-a',
        });
        expect(() => read_migration_arming_state(fixture.value)).toThrow(/invalid expected namespace identity/);
        fixture.values.set(MIGRATION_ARMING_STATE_KEY, { ...inProgress, capsuleMutation: 'replace' });
        expect(() => read_migration_arming_state(fixture.value)).toThrow(/invalid mutation kind/);
    });
});
