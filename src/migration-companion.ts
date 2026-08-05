import { createHash, randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { MigrationCompanionClient } from './state';

export const MIGRATION_COMPANION_EXTENSION_ID = 'jbearak.table-viewer-companion';
export const MIGRATION_ARMING_STATE_KEY = 'tableViewer.sqliteMigrationArming.v1';
export const MIGRATION_CAPSULE_MAX_UTF8_BYTES = 16 * 1_024 * 1_024;
export const MIGRATION_COMPANION_COMMAND_TIMEOUT_MS = 30_000;

export const MIGRATION_COMPANION_COMMANDS = {
    hostCapabilities: 'tableViewerCompanion.hostCapabilities.v1',
    namespace: 'tableViewerCompanion.namespace.v1',
    activeCapsule: 'tableViewerCompanion.activeCapsule.v1',
    submitCapsuleCandidate: 'tableViewerCompanion.submitCapsuleCandidate.v1',
    archiveDrift: 'tableViewerCompanion.archiveDrift.v1',
    beginEnvironmentImport: 'tableViewerCompanion.beginEnvironmentImport.v1',
    environmentImportStatus: 'tableViewerCompanion.environmentImportStatus.v1',
    abandonEnvironmentImport: 'tableViewerCompanion.abandonEnvironmentImport.v1',
    confirmEnvironment: 'tableViewerCompanion.confirmEnvironment.v1',
    confirmEnvironmentSourceRetirement: 'tableViewerCompanion.confirmEnvironmentSourceRetirement.v1',
    preparePendingEditRecovery: 'tableViewerCompanion.preparePendingEditRecovery.v1',
    confirmPendingEditRecovery: 'tableViewerCompanion.confirmPendingEditRecovery.v1',
} as const;

export interface MigrationArmingInProgressState {
    readonly version: 1;
    readonly phase: 'armingInProgress';
    readonly extensionVersion: string;
    readonly placementKeyDigest: string;
    readonly sourceDigest: string;
    readonly flushCompleted: boolean;
    readonly capsuleMutation: 'submit' | 'archiveDrift' | 'replaceAfterUpgrade';
    readonly namespaceOperationId: string;
    readonly capsuleOperationId: string;
    readonly armedAtMs: number;
    readonly expectedProfileDatabaseId?: string;
    readonly expectedStorageEnvironmentId?: string;
}

export interface FinalizedMigrationArmingState {
    readonly version: 1;
    readonly phase: 'awaitingColdStart' | 'coldConfirmed';
    readonly extensionVersion: string;
    readonly profileDatabaseId: string;
    readonly storageEnvironmentId: string;
    readonly capsuleId: string;
    readonly sourceFormat: string;
    readonly sourceDigest: string;
    readonly namespaceOperationId: string;
    readonly armedAtMs: number;
    readonly coldConfirmedAtMs?: number;
}

export type MigrationArmingState =
    | MigrationArmingInProgressState
    | FinalizedMigrationArmingState;

interface BridgeCapsule {
    readonly capsuleId: string;
    readonly sourceFormat: string;
    readonly sourceDigest: string;
    readonly meta: {
        readonly nextRevision: number;
        readonly absenceRevision: number;
        readonly nextRecencyOrder: string;
        readonly updatedAtMs?: number;
    };
    readonly entryCount: number;
    readonly status: 'armed' | 'cutover';
}

function record(value: unknown, name: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} returned an invalid response.`);
    return value as Record<string, unknown>;
}

function exact_record(value: unknown, name: string, keys: readonly string[]): Record<string, unknown> {
    const result = record(value, name);
    const actual = Object.keys(result).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        throw new Error(`${name} returned an invalid response schema.`);
    }
    return result;
}

function response_text(value: unknown, name: string): string {
    if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 1_024) {
        throw new Error(`${name} returned an invalid response.`);
    }
    return value;
}

function response_digest(value: unknown, name: string): string {
    const result = response_text(value, name);
    if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${name} returned an invalid response.`);
    return result;
}

function empty_response(value: unknown, name: string): void {
    exact_record(value, name, []);
}

function response_counter(value: unknown, name: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`${name} returned an invalid response.`);
    return value;
}

function response_boolean(value: unknown, name: string): boolean {
    if (typeof value !== 'boolean') throw new Error(`${name} returned an invalid response.`);
    return value;
}

async function execute(command: string, input?: unknown): Promise<unknown> {
    const invocation = input === undefined
        ? vscode.commands.executeCommand(command)
        : vscode.commands.executeCommand(command, input);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            invocation,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                    reject(new Error(`The Table Viewer companion command ${command} did not answer in time.`));
                }, MIGRATION_COMPANION_COMMAND_TIMEOUT_MS);
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

async function migration_companion_host_capabilities(
    context: vscode.ExtensionContext,
): Promise<{ readonly directoryDurabilitySupported: boolean }> {
    const value = exact_record(
        await execute(MIGRATION_COMPANION_COMMANDS.hostCapabilities),
        'companion host capabilities',
        ['directoryDurabilitySupported', 'extensionId', 'extensionKind', 'extensionVersion', 'protocolVersion'],
    );
    const expectedVersion = response_text(context.extension.packageJSON.version, 'Table Viewer manifest');
    const extensionId = response_text(value.extensionId, 'companion extension id');
    const extensionVersion = response_text(value.extensionVersion, 'companion extension version');
    const extensionKind = response_text(value.extensionKind, 'companion extension kind');
    const protocolVersion = response_counter(value.protocolVersion, 'companion host protocol');
    if (extensionId !== MIGRATION_COMPANION_EXTENSION_ID) {
        throw new Error('The Table Viewer companion bridge returned an incompatible extension identity.');
    }
    if (extensionVersion !== expectedVersion) {
        throw new Error(`Table Viewer ${expectedVersion} requires companion ${expectedVersion}; found ${extensionVersion}.`);
    }
    if (extensionKind !== 'ui') {
        throw new Error('The Table Viewer companion is not running in the required local UI extension host. Migration routing is unavailable.');
    }
    if (protocolVersion !== 1) {
        throw new Error('The Table Viewer companion host protocol version is incompatible.');
    }
    if (typeof value.directoryDurabilitySupported !== 'boolean') {
        throw new Error('companion host capabilities returned an invalid response.');
    }
    return { directoryDurabilitySupported: value.directoryDurabilitySupported };
}

export async function migration_companion_directory_durability_supported(
    context: vscode.ExtensionContext,
): Promise<boolean> {
    return (await migration_companion_host_capabilities(context)).directoryDurabilitySupported;
}

export async function require_migration_companion(
    context: vscode.ExtensionContext,
): Promise<MigrationCompanionClient> {
    await migration_companion_host_capabilities(context);

    return {
        async namespace(input) {
            const value = exact_record(await execute(MIGRATION_COMPANION_COMMANDS.namespace, input), 'namespace', [
                'profileDatabaseId', 'storageEnvironmentId', 'protocolVersion',
            ]);
            const protocolVersion = response_counter(value.protocolVersion, 'namespace protocol');
            if (protocolVersion !== 1) throw new Error('The Table Viewer companion protocol version is incompatible.');
            return {
                profileDatabaseId: response_text(value.profileDatabaseId, 'profile database id'),
                storageEnvironmentId: response_text(value.storageEnvironmentId, 'storage environment id'),
                protocolVersion,
            };
        },
        async activeCapsule() {
            const value = exact_record(await execute(MIGRATION_COMPANION_COMMANDS.activeCapsule), 'active capsule', [
                'capsuleId', 'sourceFormat', 'sourceDigest', 'meta', 'entryCount', 'status',
            ]);
            const metaKeys = value.meta && typeof value.meta === 'object'
                && !Array.isArray(value.meta) && 'updatedAtMs' in value.meta
                ? ['nextRevision', 'absenceRevision', 'nextRecencyOrder', 'updatedAtMs']
                : ['nextRevision', 'absenceRevision', 'nextRecencyOrder'];
            const meta = exact_record(value.meta, 'active capsule metadata', metaKeys);
            const nextRecency = BigInt(response_text(meta.nextRecencyOrder, 'next recency order'));
            return {
                capsuleId: response_text(value.capsuleId, 'capsule id'),
                sourceFormat: response_text(value.sourceFormat, 'source format'),
                sourceDigest: response_digest(value.sourceDigest, 'source digest'),
                meta: {
                    nextRevision: response_counter(meta.nextRevision, 'next revision'),
                    absenceRevision: response_counter(meta.absenceRevision, 'absence revision'),
                    nextRecencyOrder: nextRecency,
                    ...(meta.updatedAtMs === undefined ? {} : {
                        updatedAtMs: response_counter(meta.updatedAtMs, 'source timestamp'),
                    }),
                },
                entryCount: response_counter(value.entryCount, 'entry count'),
                status: value.status === 'cutover' ? 'cutover' : value.status === 'armed' ? 'armed' : (() => { throw new Error('Invalid active capsule status.'); })(),
            };
        },
        async submitCapsuleCandidate(input) {
            const value = exact_record(
                await execute(MIGRATION_COMPANION_COMMANDS.submitCapsuleCandidate, input),
                'capsule submission',
                ['capsuleId', 'sourceDigest'],
            );
            return {
                capsuleId: response_text(value.capsuleId, 'capsule id'),
                sourceDigest: response_digest(value.sourceDigest, 'source digest'),
            };
        },
        async archiveDrift(input) {
            empty_response(await execute(MIGRATION_COMPANION_COMMANDS.archiveDrift, input), 'drift archival');
        },
        async beginEnvironmentImport(input) {
            const value = exact_record(
                await execute(MIGRATION_COMPANION_COMMANDS.beginEnvironmentImport, input),
                'import claim',
                ['importClaimId'],
            );
            return { importClaimId: response_text(value.importClaimId, 'import claim id') };
        },
        async environmentImportStatus(input) {
            const value = await execute(MIGRATION_COMPANION_COMMANDS.environmentImportStatus, input);
            if (value !== 'preparing' && value !== 'confirmed' && value !== 'abandoned') throw new Error('Invalid import claim status.');
            return value;
        },
        async abandonEnvironmentImport(input) {
            empty_response(await execute(MIGRATION_COMPANION_COMMANDS.abandonEnvironmentImport, input), 'import abandonment');
        },
        async confirmEnvironment(input) {
            empty_response(await execute(MIGRATION_COMPANION_COMMANDS.confirmEnvironment, input), 'environment confirmation');
        },
        async confirmEnvironmentSourceRetirement(input) {
            empty_response(await execute(MIGRATION_COMPANION_COMMANDS.confirmEnvironmentSourceRetirement, input), 'source retirement confirmation');
        },
        async preparePendingEditRecovery(input) {
            const value = exact_record(
                await execute(MIGRATION_COMPANION_COMMANDS.preparePendingEditRecovery, input),
                'recovery preparation',
                ['recoveryRecordId'],
            );
            return { recoveryRecordId: response_text(value.recoveryRecordId, 'recovery record id') };
        },
        async confirmPendingEditRecovery(input) {
            empty_response(await execute(MIGRATION_COMPANION_COMMANDS.confirmPendingEditRecovery, input), 'recovery confirmation');
        },
    };
}

export function migration_placement_key_digest(
    context: vscode.ExtensionContext,
    resource?: vscode.Uri,
): string {
    let placement: Record<string, string> = { kind: 'local' };
    if (vscode.env.remoteName !== undefined) {
        if (context.extension.extensionKind !== vscode.ExtensionKind.Workspace) {
            throw new Error('Table Viewer cannot arm remote migration unless the main extension runs in the workspace extension host.');
        }
        const activeTabUri = (vscode.window as unknown as {
            tabGroups?: { activeTabGroup?: { activeTab?: { input?: { uri?: unknown } } } };
        }).tabGroups?.activeTabGroup?.activeTab?.input?.uri;
        const candidates = [
            resource,
            vscode.window.activeTextEditor?.document.uri,
            activeTabUri && typeof activeTabUri === 'object'
                && 'scheme' in activeTabUri && 'authority' in activeTabUri
                ? activeTabUri as vscode.Uri
                : undefined,
            vscode.workspace.workspaceFile,
            ...(vscode.workspace.workspaceFolders?.map((folder) => folder.uri) ?? []),
        ].filter((uri): uri is vscode.Uri => uri !== undefined && uri.authority.length > 0);
        const authorities = new Map(candidates.map((uri) => [
            JSON.stringify([uri.scheme, uri.authority]),
            { scheme: uri.scheme, authority: uri.authority },
        ]));
        if (authorities.size !== 1) {
            throw new Error('Table Viewer cannot prove one concrete remote storage authority for this extension host.');
        }
        const concrete = [...authorities.values()][0];
        placement = {
            kind: 'remote',
            remoteName: vscode.env.remoteName,
            uriScheme: concrete.scheme,
            uriAuthority: concrete.authority,
        };
    }
    const tuple = JSON.stringify({
        version: 1,
        product: vscode.env.appName,
        uriScheme: vscode.env.uriScheme,
        placement,
        workspaceStorageScheme: context.globalStorageUri.scheme,
        workspaceStorageAuthority: context.globalStorageUri.authority,
        workspaceStoragePath: context.globalStorageUri.path,
    });
    return createHash('sha256').update(tuple).digest('hex');
}

export function read_migration_arming_state(context: vscode.ExtensionContext): MigrationArmingState | undefined {
    const value = context.globalState.get<unknown>(MIGRATION_ARMING_STATE_KEY);
    if (value === undefined) return undefined;
    const source = record(value, 'migration arming state');
    if (source.version !== 1) throw new Error('The persisted SQLite migration arming state is invalid.');
    if (source.phase === 'armingInProgress') {
        if (source.capsuleMutation !== 'submit'
            && source.capsuleMutation !== 'archiveDrift'
            && source.capsuleMutation !== 'replaceAfterUpgrade') {
            throw new Error('The persisted SQLite migration checkpoint has an invalid mutation kind.');
        }
        if (source.coldConfirmedAtMs !== undefined) {
            throw new Error('The persisted SQLite migration checkpoint has an invalid confirmation timestamp.');
        }
        const hasExpectedIdentity = source.expectedProfileDatabaseId !== undefined
            || source.expectedStorageEnvironmentId !== undefined;
        if ((source.capsuleMutation === 'archiveDrift'
            && (source.expectedProfileDatabaseId === undefined || source.expectedStorageEnvironmentId === undefined))
            || (source.capsuleMutation !== 'archiveDrift' && hasExpectedIdentity)) {
            throw new Error('The persisted SQLite migration checkpoint has an invalid expected namespace identity.');
        }
        exact_record(value, 'migration arming checkpoint', [
            'version', 'phase', 'extensionVersion', 'placementKeyDigest', 'sourceDigest',
            'flushCompleted', 'capsuleMutation', 'namespaceOperationId', 'capsuleOperationId', 'armedAtMs',
            ...(hasExpectedIdentity ? ['expectedProfileDatabaseId', 'expectedStorageEnvironmentId'] : []),
        ]);
        return {
            version: 1,
            phase: 'armingInProgress',
            extensionVersion: response_text(source.extensionVersion, 'arming extension version'),
            placementKeyDigest: response_digest(source.placementKeyDigest, 'arming placement digest'),
            sourceDigest: response_digest(source.sourceDigest, 'arming source digest'),
            flushCompleted: response_boolean(source.flushCompleted, 'arming flush completion'),
            capsuleMutation: source.capsuleMutation,
            namespaceOperationId: response_text(source.namespaceOperationId, 'arming namespace operation id'),
            capsuleOperationId: response_text(source.capsuleOperationId, 'arming capsule operation id'),
            armedAtMs: response_counter(source.armedAtMs, 'arming timestamp'),
            ...(source.expectedProfileDatabaseId === undefined ? {} : {
                expectedProfileDatabaseId: response_text(source.expectedProfileDatabaseId, 'expected arming profile id'),
            }),
            ...(source.expectedStorageEnvironmentId === undefined ? {} : {
                expectedStorageEnvironmentId: response_text(source.expectedStorageEnvironmentId, 'expected arming environment id'),
            }),
        };
    }
    if (source.phase !== 'awaitingColdStart' && source.phase !== 'coldConfirmed') {
        throw new Error('The persisted SQLite migration arming state is invalid.');
    }
    exact_record(value, 'migration arming state', [
        'version', 'phase', 'extensionVersion', 'profileDatabaseId', 'storageEnvironmentId',
        'capsuleId', 'sourceFormat', 'sourceDigest', 'namespaceOperationId', 'armedAtMs',
        ...(source.phase === 'coldConfirmed' ? ['coldConfirmedAtMs'] : []),
    ]);
    const state: FinalizedMigrationArmingState = {
        version: 1,
        phase: source.phase,
        extensionVersion: response_text(source.extensionVersion, 'arming extension version'),
        profileDatabaseId: response_text(source.profileDatabaseId, 'arming profile id'),
        storageEnvironmentId: response_text(source.storageEnvironmentId, 'arming environment id'),
        capsuleId: response_text(source.capsuleId, 'arming capsule id'),
        sourceFormat: response_text(source.sourceFormat, 'arming source format'),
        sourceDigest: response_digest(source.sourceDigest, 'arming source digest'),
        namespaceOperationId: response_text(source.namespaceOperationId, 'arming namespace operation id'),
        armedAtMs: response_counter(source.armedAtMs, 'arming timestamp'),
    };
    if (source.phase === 'coldConfirmed') {
        if (source.coldConfirmedAtMs === undefined) {
            throw new Error('The persisted cold-confirmed SQLite migration state has no confirmation timestamp.');
        }
        (state as { coldConfirmedAtMs?: number }).coldConfirmedAtMs = response_counter(
            source.coldConfirmedAtMs,
            'cold confirmation timestamp',
        );
    } else if (source.coldConfirmedAtMs !== undefined) {
        throw new Error('The persisted awaiting-cold-start SQLite migration state has an invalid confirmation timestamp.');
    }
    return state;
}

export async function write_migration_arming_state(
    context: vscode.ExtensionContext,
    state: MigrationArmingState,
): Promise<void> {
    await context.globalState.update(MIGRATION_ARMING_STATE_KEY, state);
}

export async function clear_migration_arming_state(
    context: vscode.ExtensionContext,
): Promise<void> {
    await context.globalState.update(MIGRATION_ARMING_STATE_KEY, undefined);
}

export function new_operation_id(): string { return randomUUID(); }

export function bridge_capsule_identity(capsule: Awaited<ReturnType<MigrationCompanionClient['activeCapsule']>>): BridgeCapsule {
    return {
        capsuleId: capsule.capsuleId,
        sourceFormat: capsule.sourceFormat,
        sourceDigest: capsule.sourceDigest,
        meta: {
            nextRevision: capsule.meta.nextRevision,
            absenceRevision: capsule.meta.absenceRevision,
            nextRecencyOrder: capsule.meta.nextRecencyOrder.toString(),
            ...(capsule.meta.updatedAtMs === undefined ? {} : { updatedAtMs: capsule.meta.updatedAtMs }),
        },
        entryCount: capsule.entryCount,
        status: capsule.status,
    };
}
