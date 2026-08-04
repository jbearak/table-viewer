import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import {
    decode_memento_file_state_resource_keys,
    decode_memento_file_state_source,
} from '../../src/state';
import { MIGRATION_CAPSULE_MAX_UTF8_BYTES } from '../../src/migration-companion';
import { decode_stored_per_file_state } from '../../src/types';
import {
    assert_sqlite_directory_durability_supported,
    initialize_custom_sqlite_database_no_clobber,
    type SqliteOpenedDatabase,
} from '../../src/sqlite-open-recovery';
import {
    COMPANION_APPLICATION_ID,
    COMPANION_PROTOCOL_VERSION,
    initialize_companion_schema,
    validate_companion_schema,
} from './companion-schema';

const SOURCE_KEY = 'tableViewer.fileState';
const SOURCE_FORMAT = 'tableViewer.fileState.v1';
const MAX_COUNTER = Number.MAX_SAFE_INTEGER - 1;
export const COMPANION_MAX_ID_UTF8_BYTES = 1_024;
export const COMPANION_MAX_CAPSULE_JSON_UTF8_BYTES = MIGRATION_CAPSULE_MAX_UTF8_BYTES;
export const COMPANION_MAX_RECOVERY_JSON_UTF8_BYTES = 4 * 1_024 * 1_024;
export const COMPANION_MAX_RECEIPT_JSON_UTF8_BYTES = 64 * 1_024;

type OperationKind =
    | 'namespace'
    | 'submit_capsule_candidate'
    | 'archive_drift'
    | 'begin_environment_import'
    | 'abandon_environment_import'
    | 'confirm_environment'
    | 'confirm_environment_source_retirement'
    | 'retire_capsule'
    | 'prepare_pending_edit_recovery'
    | 'confirm_pending_edit_recovery';

export interface CapsuleMetadata {
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

export interface CapsuleRetirementCandidate {
    readonly capsuleId: string;
    readonly sourceDigest: string;
    readonly status: 'drifted' | 'cutover';
    readonly createdAtMs: number;
}

export interface CapsuleRecoveryRecord {
    readonly capsuleId: string;
    readonly sourceFormat: string;
    readonly sourceDigest: string;
    readonly status: 'armed' | 'cutover' | 'drifted';
    readonly orderedSourceJson: string;
    readonly sourceResourceKeys: readonly string[];
    readonly createdAtMs: number;
}

export interface RecoveryRecord {
    readonly recoveryRecordId: string;
    readonly storageEnvironmentId: string;
    readonly databaseId: string;
    readonly recoveryEntryId: string;
    readonly kind: 'snapshot' | 'clear';
    readonly resourceIdentity: Record<string, unknown>;
    readonly authorityRevision: number;
    readonly physicalRevision: number;
    readonly projectionRevision: number;
    readonly physicalDigest?: string;
    readonly pendingEdits?: Record<string, unknown>;
    readonly status: 'prepared' | 'committed';
    readonly preparedAtMs: number;
    readonly committedStateRevision?: number;
}

interface DecodedSource {
    readonly format: string;
    readonly digest: string;
    readonly entryCount: number;
    readonly nextRevision: number;
    readonly absenceRevision: number;
    readonly updatedAtMs?: number;
}

interface Row { [key: string]: unknown }

type ReceiptResults = {
    namespace: { profileDatabaseId: string; storageEnvironmentId: string; protocolVersion: number };
    submit_capsule_candidate: { capsuleId: string; sourceDigest: string };
    archive_drift: Record<string, never>;
    begin_environment_import: { importClaimId: string };
    abandon_environment_import: Record<string, never>;
    confirm_environment: Record<string, never>;
    confirm_environment_source_retirement: Record<string, never>;
    retire_capsule: Record<string, never>;
    prepare_pending_edit_recovery: { recoveryRecordId: string };
    confirm_pending_edit_recovery: Record<string, never>;
};

function sha256(value: string | Uint8Array): string {
    return createHash('sha256').update(value).digest('hex');
}

function stable_json(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stable_json).join(',')}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable_json(record[key])}`).join(',')}}`;
}

function request_digest(value: unknown): string {
    return sha256(stable_json(value));
}

function tuple_key(...values: readonly string[]): string {
    return JSON.stringify(values);
}

function object(value: unknown, name: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object.`);
    return value as Record<string, unknown>;
}

function text(value: unknown, name: string): string {
    if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} must be a nonempty string.`);
    return value;
}

function bounded_text(value: unknown, name: string, maximumBytes = COMPANION_MAX_ID_UTF8_BYTES): string {
    const decoded = text(value, name);
    if (Buffer.byteLength(decoded, 'utf8') > maximumBytes) {
        throw new TypeError(`${name} exceeds the ${maximumBytes}-byte UTF-8 limit.`);
    }
    return decoded;
}

function bounded_json_text(value: unknown, name: string, maximumBytes: number): string {
    return bounded_text(value, name, maximumBytes);
}

function sha256_digest_text(value: unknown, name: string): string {
    const decoded = bounded_text(value, name, 64);
    if (!/^[0-9a-f]{64}$/.test(decoded)) throw new TypeError(`${name} is not a SHA-256 digest.`);
    return decoded;
}

function request_digest_text(value: unknown, name: string): string {
    return sha256_digest_text(value, name);
}

function exact_keys(value: Record<string, unknown>, expected: readonly string[], name: string): void {
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
        throw new TypeError(`${name} has an invalid property set.`);
    }
}

function operation_kind(value: unknown, name = 'operation kind'): OperationKind {
    const decoded = bounded_text(value, name);
    const kinds: readonly OperationKind[] = [
        'namespace', 'submit_capsule_candidate', 'archive_drift', 'begin_environment_import',
        'abandon_environment_import', 'confirm_environment', 'confirm_environment_source_retirement',
        'retire_capsule', 'prepare_pending_edit_recovery', 'confirm_pending_edit_recovery',
    ];
    if (!kinds.includes(decoded as OperationKind)) throw new TypeError(`Invalid ${name}.`);
    return decoded as OperationKind;
}

function decode_receipt_result<K extends OperationKind>(kind: K, resultJson: unknown): ReceiptResults[K] {
    const encoded = bounded_json_text(resultJson, 'receipt result', COMPANION_MAX_RECEIPT_JSON_UTF8_BYTES);
    const result = object(JSON.parse(encoded), 'receipt result');
    switch (kind) {
        case 'namespace':
            exact_keys(result, ['profileDatabaseId', 'storageEnvironmentId', 'protocolVersion'], 'namespace receipt result');
            return {
                profileDatabaseId: bounded_text(result.profileDatabaseId, 'profileDatabaseId'),
                storageEnvironmentId: bounded_text(result.storageEnvironmentId, 'storageEnvironmentId'),
                protocolVersion: counter(result.protocolVersion, 'protocolVersion', COMPANION_PROTOCOL_VERSION, COMPANION_PROTOCOL_VERSION),
            } as ReceiptResults[K];
        case 'submit_capsule_candidate':
            exact_keys(result, ['capsuleId', 'sourceDigest'], 'capsule receipt result');
            return {
                capsuleId: bounded_text(result.capsuleId, 'capsuleId'),
                sourceDigest: sha256_digest_text(result.sourceDigest, 'sourceDigest'),
            } as ReceiptResults[K];
        case 'begin_environment_import':
            exact_keys(result, ['importClaimId'], 'import receipt result');
            return { importClaimId: bounded_text(result.importClaimId, 'importClaimId') } as ReceiptResults[K];
        case 'prepare_pending_edit_recovery':
            exact_keys(result, ['recoveryRecordId'], 'recovery receipt result');
            return { recoveryRecordId: bounded_text(result.recoveryRecordId, 'recoveryRecordId') } as ReceiptResults[K];
        default:
            exact_keys(result, [], `${kind} receipt result`);
            return {} as ReceiptResults[K];
    }
}

function encode_receipt_result<K extends OperationKind>(kind: K, result: ReceiptResults[K]): string {
    const encoded = JSON.stringify(result);
    decode_receipt_result(kind, encoded);
    return encoded;
}

function counter(value: unknown, name: string, minimum = 0, maximum = MAX_COUNTER): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new TypeError(`${name} must be a safe integer in range.`);
    }
    return value;
}

function optional_counter(value: unknown, name: string): number | undefined {
    return value === undefined ? undefined : counter(value, name, 0, Number.MAX_SAFE_INTEGER);
}

function decode_source(orderedSourceJson: string): DecodedSource {
    const source: unknown = JSON.parse(orderedSourceJson);
    const metadata = decode_memento_file_state_source(source);
    const sourceFormat = source !== null
        && typeof source === 'object'
        && !Array.isArray(source)
        && (source as Record<string, unknown>).format === SOURCE_FORMAT
        ? SOURCE_FORMAT
        : 'tableViewer.fileState.legacy';
    return {
        format: sourceFormat,
        digest: sha256(orderedSourceJson),
        ...metadata,
    };
}

function as_row(value: unknown, name: string): Row {
    if (!value || typeof value !== 'object') throw new Error(`Missing ${name}.`);
    return value as Row;
}

function statement(database: DatabaseSync, sql: string): StatementSync {
    const prepared = database.prepare(sql);
    prepared.setReadBigInts(false);
    return prepared;
}

function nullable_counter(value: unknown, name: string): number | null {
    return value === null ? null : counter(value, name, 0, Number.MAX_SAFE_INTEGER);
}

function nullable_bounded_text(value: unknown, name: string): string | null {
    return value === null ? null : bounded_text(value, name);
}

function nullable_sha256_digest_text(value: unknown, name: string): string | null {
    return value === null ? null : sha256_digest_text(value, name);
}

function one_of<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
    const decoded = bounded_text(value, name);
    if (!allowed.includes(decoded as T)) throw new TypeError(`Invalid ${name}.`);
    return decoded as T;
}

function validate_recovery_payload(kind: 'snapshot' | 'clear', resourceIdentityJson: unknown, pendingEditsJson: unknown): void {
    const identityJson = bounded_json_text(resourceIdentityJson, 'resourceIdentityJson', COMPANION_MAX_RECOVERY_JSON_UTF8_BYTES);
    object(JSON.parse(identityJson), 'resourceIdentityJson');
    if (kind === 'snapshot') {
        const pendingJson = bounded_json_text(pendingEditsJson, 'pendingEditsJson', COMPANION_MAX_RECOVERY_JSON_UTF8_BYTES);
        const pending = object(JSON.parse(pendingJson), 'pendingEditsJson');
        const decoded = decode_stored_per_file_state({ pendingEdits: pending }) as { pendingEdits?: unknown };
        if (decoded.pendingEdits === undefined) throw new TypeError('Recovery snapshot pending edits must not be empty.');
    } else if (pendingEditsJson !== null && pendingEditsJson !== undefined) {
        throw new TypeError('A recovery clear cannot contain pending edits.');
    }
}

function validate_companion_contents(database: DatabaseSync): void {
    type Receipt = { kind: OperationKind; digest: string; result: ReceiptResults[OperationKind] };
    const receipts = new Map<string, Receipt>();
    for (const row of statement(database, `SELECT operation_id,operation_kind,request_digest,result_json,completed_at_ms FROM companion_rpc_operations`).all() as Row[]) {
        const operationId = bounded_text(row.operation_id, 'receipt operationId');
        const kind = operation_kind(row.operation_kind);
        const digest = request_digest_text(row.request_digest, 'receipt request digest');
        counter(row.completed_at_ms, 'receipt completion timestamp', 0, Number.MAX_SAFE_INTEGER);
        const result = decode_receipt_result(kind, row.result_json) as ReceiptResults[OperationKind];
        if (receipts.has(operationId)) throw new Error('Duplicate companion receipt operation id.');
        receipts.set(operationId, { kind, digest, result });
    }
    const requireReceipt = (operationIdValue: unknown, kind: OperationKind | readonly OperationKind[], digestValue: unknown, name: string): Receipt => {
        const operationId = bounded_text(operationIdValue, `${name} operationId`);
        const digest = request_digest_text(digestValue, `${name} request digest`);
        const receipt = receipts.get(operationId);
        const kinds = Array.isArray(kind) ? kind : [kind];
        if (!receipt || !kinds.includes(receipt.kind) || receipt.digest !== digest) {
            throw new Error(`${name} receipt relationship is invalid.`);
        }
        return receipt;
    };
    const relatedDigests = new Map<OperationKind, Set<string>>();
    const relate = (kind: OperationKind | readonly OperationKind[], digest: string): void => {
        for (const item of Array.isArray(kind) ? kind : [kind]) {
            let values = relatedDigests.get(item);
            if (!values) relatedDigests.set(item, values = new Set());
            values.add(digest);
        }
    };

    const meta = as_row(statement(database, `SELECT profile_database_id FROM companion_meta WHERE singleton=1`).get(), 'companion metadata');
    const profileDatabaseId = bounded_text(meta.profile_database_id, 'profileDatabaseId');
    const namespaceResultsByDigest = new Map<string, ReceiptResults['namespace']>();
    for (const row of statement(database, `SELECT * FROM environment_namespaces`).all() as Row[]) {
        const placementKeyDigest = sha256_digest_text(row.placement_key_digest, 'placement key digest');
        const storageEnvironmentId = bounded_text(row.storage_environment_id, 'storageEnvironmentId');
        counter(row.created_at_ms, 'namespace creation timestamp', 0, Number.MAX_SAFE_INTEGER);
        if (row.request_digest !== request_digest({ placementKeyDigest })) throw new Error('Namespace request digest is invalid.');
        const namespaceRequestDigest = request_digest_text(row.request_digest, 'namespace request digest');
        relate('namespace', namespaceRequestDigest);
        namespaceResultsByDigest.set(namespaceRequestDigest, {
            profileDatabaseId,
            storageEnvironmentId,
            protocolVersion: COMPANION_PROTOCOL_VERSION,
        });
        const receipt = requireReceipt(row.created_operation_id, 'namespace', row.request_digest, 'namespace');
        const result = receipt.result as ReceiptResults['namespace'];
        if (result.profileDatabaseId !== profileDatabaseId || result.storageEnvironmentId !== storageEnvironmentId
            || result.protocolVersion !== COMPANION_PROTOCOL_VERSION) {
            throw new Error('Namespace receipt result relationship is invalid.');
        }
    }

    const capsuleIds = new Map<string, { digest: string; status: string; createdAtMs: number; retiredAtMs: number | null }>();
    const submittedCapsulesByDigest = new Map<string, ReceiptResults['submit_capsule_candidate']>();
    for (const row of statement(database, `SELECT * FROM capsules`).all() as Row[]) {
        const capsuleId = bounded_text(row.capsule_id, 'capsuleId');
        if (row.source_key !== SOURCE_KEY) throw new Error('Capsule source key is invalid.');
        const sourceFormat = bounded_text(row.source_format, 'capsule source format');
        const sourceDigest = sha256_digest_text(row.source_digest, 'capsule source digest');
        const status = one_of(row.status, ['candidate', 'armed', 'cutover', 'drifted', 'retired'] as const, 'capsule status');
        counter(row.source_entry_count, 'capsule entry count');
        counter(row.source_next_revision, 'capsule next revision', 1, Number.MAX_SAFE_INTEGER);
        counter(row.source_absence_revision, 'capsule absence revision');
        nullable_counter(row.source_updated_at_ms, 'capsule updated timestamp');
        const createdAtMs = counter(row.created_at_ms, 'capsule creation timestamp', 0, Number.MAX_SAFE_INTEGER);
        const retiredAtMs = nullable_counter(row.retired_at_ms, 'capsule retirement timestamp');
        if (retiredAtMs !== null && retiredAtMs < createdAtMs) throw new Error('Capsule retirement precedes creation.');
        nullable_bounded_text(row.retirement_operation_id, 'capsule retirement operationId');
        const capsuleRequestDigest = request_digest_text(row.request_digest, 'capsule request digest');
        const createdReceipt = requireReceipt(row.created_operation_id, ['submit_capsule_candidate', 'archive_drift'], capsuleRequestDigest, 'capsule creation');
        relate(['submit_capsule_candidate', 'archive_drift'], capsuleRequestDigest);
        if (createdReceipt.kind === 'submit_capsule_candidate') {
            const result = createdReceipt.result as ReceiptResults['submit_capsule_candidate'];
            if (result.capsuleId !== capsuleId || result.sourceDigest !== sourceDigest) {
                throw new Error('Capsule creation receipt result relationship is invalid.');
            }
        }
        submittedCapsulesByDigest.set(capsuleRequestDigest, { capsuleId, sourceDigest });
        if (status === 'retired') {
            if (row.ordered_source_json !== null || row.retirement_operation_id === null) throw new Error('Retired capsule payload state is invalid.');
            const retirementDigest = request_digest({ capsuleId, noNeverClaimedEnvironmentAttested: true });
            relate('retire_capsule', retirementDigest);
            requireReceipt(row.retirement_operation_id, 'retire_capsule', retirementDigest, 'capsule retirement');
        } else {
            const orderedSourceJson = bounded_json_text(row.ordered_source_json, 'orderedSourceJson', COMPANION_MAX_CAPSULE_JSON_UTF8_BYTES);
            if (row.request_digest !== request_digest({ orderedSourceJson })) throw new Error('Capsule request digest is invalid.');
            const decoded = decode_source(orderedSourceJson);
            if (decoded.digest !== sourceDigest || decoded.format !== sourceFormat
                || decoded.entryCount !== row.source_entry_count || decoded.nextRevision !== row.source_next_revision
                || decoded.absenceRevision !== row.source_absence_revision || (decoded.updatedAtMs ?? null) !== row.source_updated_at_ms) {
                throw new Error('Capsule payload digest or metadata is invalid.');
            }
        }
        capsuleIds.set(capsuleId, { digest: sourceDigest, status, createdAtMs, retiredAtMs });
    }

    const claimIds = new Map<string, Row>();
    const importClaimIdsByDigest = new Map<string, string>();
    for (const row of statement(database, `SELECT * FROM environment_import_claims`).all() as Row[]) {
        const capsuleId = bounded_text(row.capsule_id, 'claim capsuleId');
        const sourceDigest = sha256_digest_text(row.source_digest, 'claim source digest');
        if (capsuleIds.get(capsuleId)?.digest !== sourceDigest) throw new Error('Import claim capsule relationship is invalid.');
        const storageEnvironmentId = bounded_text(row.storage_environment_id, 'claim storageEnvironmentId');
        const databaseId = bounded_text(row.database_id, 'claim databaseId');
        const importClaimId = bounded_text(row.import_claim_id, 'importClaimId');
        const status = one_of(row.status, ['preparing', 'confirmed', 'abandoned'] as const, 'import claim status');
        const preparedAtMs = counter(row.prepared_at_ms, 'claim preparation timestamp', 0, Number.MAX_SAFE_INTEGER);
        const confirmedAtMs = nullable_counter(row.confirmed_at_ms, 'claim confirmation timestamp');
        const abandonedAtMs = nullable_counter(row.abandoned_at_ms, 'claim abandonment timestamp');
        if ((confirmedAtMs !== null && confirmedAtMs < preparedAtMs)
            || (abandonedAtMs !== null && abandonedAtMs < preparedAtMs)) {
            throw new Error('Import claim lifecycle timestamp is invalid.');
        }
        if (capsuleIds.get(capsuleId)?.status === 'retired' && status === 'preparing') {
            throw new Error('A retired capsule has a preparing import claim.');
        }
        nullable_bounded_text(row.abandonment_operation_id, 'claim abandonment operationId');
        nullable_sha256_digest_text(row.abandonment_evidence_digest, 'claim abandonment evidence digest');
        const claimRequest = { capsuleId, sourceDigest, storageEnvironmentId, databaseId };
        if (row.request_digest !== request_digest(claimRequest)) throw new Error('Import claim request digest is invalid.');
        const claimRequestDigest = request_digest_text(row.request_digest, 'import claim request digest');
        relate('begin_environment_import', claimRequestDigest);
        importClaimIdsByDigest.set(claimRequestDigest, importClaimId);
        const receipt = requireReceipt(row.operation_id, 'begin_environment_import', row.request_digest, 'import claim');
        if ((receipt.result as ReceiptResults['begin_environment_import']).importClaimId !== importClaimId) {
            throw new Error('Import claim receipt result relationship is invalid.');
        }
        if (status === 'abandoned') {
            const abandonmentOperationId = bounded_text(row.abandonment_operation_id, 'claim abandonment operationId');
            const abandonmentReceipt = receipts.get(abandonmentOperationId);
            const abandonmentEvidenceDigest = sha256_digest_text(row.abandonment_evidence_digest, 'claim abandonment evidence digest');
            const expectedDigest = request_digest({ importClaimId, capsuleId, storageEnvironmentId, databaseId, abandonmentEvidenceDigest });
            relate('abandon_environment_import', expectedDigest);
            if (!abandonmentReceipt || abandonmentReceipt.kind !== 'abandon_environment_import' || abandonmentReceipt.digest !== expectedDigest) {
                throw new Error('Import abandonment receipt relationship is invalid.');
            }
        }
        claimIds.set(importClaimId, row);
    }

    const confirmedClaimIds = new Set<string>();
    const confirmationDomainKeys = new Set<string>();
    const confirmationCountsByCapsule = new Map<string, number>();
    for (const row of statement(database, `SELECT * FROM environment_confirmations`).all() as Row[]) {
        const importClaimId = bounded_text(row.import_claim_id, 'confirmation importClaimId');
        const claim = claimIds.get(importClaimId);
        if (!claim || claim.status !== 'confirmed' || claim.capsule_id !== row.capsule_id
            || claim.storage_environment_id !== row.storage_environment_id || claim.database_id !== row.database_id) {
            throw new Error('Environment confirmation claim relationship is invalid.');
        }
        const confirmedAtMs = counter(row.confirmed_at_ms, 'environment confirmation timestamp', 0, Number.MAX_SAFE_INTEGER);
        if (confirmedAtMs !== claim.confirmed_at_ms) throw new Error('Environment confirmation timestamp relationship is invalid.');
        confirmedClaimIds.add(importClaimId);
        const confirmationCapsuleId = bounded_text(row.capsule_id, 'confirmation capsuleId');
        confirmationDomainKeys.add(tuple_key(
            confirmationCapsuleId,
            bounded_text(row.storage_environment_id, 'confirmation storageEnvironmentId'),
            bounded_text(row.database_id, 'confirmation databaseId'),
        ));
        confirmationCountsByCapsule.set(confirmationCapsuleId, (confirmationCountsByCapsule.get(confirmationCapsuleId) ?? 0) + 1);
        const confirmationRequest = {
            importClaimId, capsuleId: claim.capsule_id, sourceDigest: claim.source_digest,
            storageEnvironmentId: claim.storage_environment_id, databaseId: claim.database_id,
        };
        if (row.request_digest !== request_digest(confirmationRequest)) throw new Error('Environment confirmation request digest is invalid.');
        relate('confirm_environment', request_digest_text(row.request_digest, 'environment confirmation request digest'));
        requireReceipt(row.operation_id, 'confirm_environment', row.request_digest, 'environment confirmation');
    }

    for (const [importClaimId, claim] of claimIds) {
        const hasConfirmation = confirmedClaimIds.has(importClaimId);
        if ((claim.status === 'confirmed') !== hasConfirmation) {
            throw new Error('Import claim confirmation lifecycle is invalid.');
        }
    }

    const retirementCountsByCapsule = new Map<string, number>();
    for (const row of statement(database, `SELECT * FROM environment_source_retirements`).all() as Row[]) {
        const capsuleId = bounded_text(row.capsule_id, 'retirement capsuleId');
        const storageEnvironmentId = bounded_text(row.storage_environment_id, 'retirement storageEnvironmentId');
        const databaseId = bounded_text(row.database_id, 'retirement databaseId');
        if (!confirmationDomainKeys.has(tuple_key(capsuleId, storageEnvironmentId, databaseId))) {
            throw new Error('Environment retirement confirmation relationship is invalid.');
        }
        retirementCountsByCapsule.set(capsuleId, (retirementCountsByCapsule.get(capsuleId) ?? 0) + 1);
        if (capsuleIds.get(capsuleId)?.digest !== sha256_digest_text(row.source_digest, 'retirement source digest')) {
            throw new Error('Environment retirement capsule relationship is invalid.');
        }
        const retirementKind = one_of(row.retirement_kind, ['naturally_complete', 'user_retired'] as const, 'retirement kind');
        const sourceStateDigest = sha256_digest_text(row.source_state_digest, 'retirement source state digest');
        counter(row.retired_at_ms, 'environment retirement timestamp', 0, Number.MAX_SAFE_INTEGER);
        const retirementRequest = {
            capsuleId, sourceDigest: row.source_digest, storageEnvironmentId,
            databaseId, retirementKind: retirementKind === 'naturally_complete' ? 'naturallyComplete' : 'userRetired',
            sourceStateDigest,
        };
        if (row.request_digest !== request_digest(retirementRequest)) throw new Error('Environment retirement request digest is invalid.');
        relate('confirm_environment_source_retirement', request_digest_text(row.request_digest, 'environment retirement request digest'));
        requireReceipt(row.operation_id, 'confirm_environment_source_retirement', row.request_digest, 'environment retirement');
    }

    for (const [capsuleId, capsule] of capsuleIds) {
        const confirmationCount = confirmationCountsByCapsule.get(capsuleId) ?? 0;
        const retirementCount = retirementCountsByCapsule.get(capsuleId) ?? 0;
        if ((capsule.status === 'cutover') !== (confirmationCount > 0 && capsule.status !== 'retired')) {
            throw new Error('Capsule cutover lifecycle is invalid.');
        }
        if (capsule.status === 'retired' && retirementCount !== confirmationCount) {
            throw new Error('Retired capsule has an unretired environment confirmation.');
        }
    }

    const recoveryRecordIdsByDigest = new Map<string, Set<string>>();
    for (const row of statement(database, `SELECT * FROM pending_edit_recovery_records`).all() as Row[]) {
        const recoveryRecordId = bounded_text(row.recovery_record_id, 'recoveryRecordId');
        const storageEnvironmentId = bounded_text(row.storage_environment_id, 'recovery storageEnvironmentId');
        const databaseId = bounded_text(row.database_id, 'recovery databaseId');
        const recoveryEntryId = bounded_text(row.recovery_entry_id, 'recoveryEntryId');
        const kind = one_of(row.kind, ['snapshot', 'clear'] as const, 'recovery kind');
        const status = one_of(row.status, ['prepared', 'committed'] as const, 'recovery status');
        const authorityRevision = counter(row.authority_revision, 'authorityRevision');
        const physicalRevision = counter(row.physical_revision, 'physicalRevision');
        const projectionRevision = counter(row.projection_revision, 'projectionRevision');
        const physicalDigest = nullable_sha256_digest_text(row.physical_digest, 'physicalDigest');
        const preparedAtMs = counter(row.prepared_at_ms, 'recovery preparation timestamp', 0, Number.MAX_SAFE_INTEGER);
        nullable_bounded_text(row.confirmation_operation_id, 'recovery confirmation operationId');
        if (row.confirmation_request_digest !== null) request_digest_text(row.confirmation_request_digest, 'recovery confirmation request digest');
        const committedStateRevision = nullable_counter(row.committed_state_revision, 'committedStateRevision');
        const committedAtMs = nullable_counter(row.committed_at_ms, 'recovery commit timestamp');
        if (committedAtMs !== null && committedAtMs < preparedAtMs) throw new Error('Recovery commit precedes preparation.');
        validate_recovery_payload(kind, row.resource_identity_json, row.pending_edits_json);
        const recoveryRequest = {
            storageEnvironmentId, databaseId, recoveryEntryId, kind,
            ...(row.pending_edits_json === null ? {} : { pendingEditsJson: row.pending_edits_json }),
            resourceIdentityJson: row.resource_identity_json,
            authorityRevision, physicalRevision, projectionRevision,
            ...(physicalDigest === null ? {} : { physicalDigest }),
        };
        if (row.request_digest !== request_digest(recoveryRequest)) throw new Error('Recovery preparation request digest is invalid.');
        const recoveryRequestDigest = request_digest_text(row.request_digest, 'recovery preparation request digest');
        relate('prepare_pending_edit_recovery', recoveryRequestDigest);
        const recoveryRecordIds = recoveryRecordIdsByDigest.get(recoveryRequestDigest) ?? new Set<string>();
        recoveryRecordIds.add(recoveryRecordId);
        recoveryRecordIdsByDigest.set(recoveryRequestDigest, recoveryRecordIds);
        const receipt = requireReceipt(row.operation_id, 'prepare_pending_edit_recovery', row.request_digest, 'recovery preparation');
        if ((receipt.result as ReceiptResults['prepare_pending_edit_recovery']).recoveryRecordId !== recoveryRecordId) {
            throw new Error('Recovery preparation receipt result relationship is invalid.');
        }
        if (status === 'committed') {
            const confirmationDigest = request_digest({ recoveryRecordId, committedStateRevision });
            if (row.confirmation_request_digest !== confirmationDigest) throw new Error('Recovery confirmation request digest is invalid.');
            relate('confirm_pending_edit_recovery', confirmationDigest);
            requireReceipt(row.confirmation_operation_id, 'confirm_pending_edit_recovery', row.confirmation_request_digest, 'recovery confirmation');
        }
    }

    for (const receipt of receipts.values()) {
        if (!relatedDigests.get(receipt.kind)?.has(receipt.digest)) {
            throw new Error(`${receipt.kind} receipt points to no matching domain request.`);
        }
        if (receipt.kind === 'namespace') {
            const result = receipt.result as ReceiptResults['namespace'];
            const expected = namespaceResultsByDigest.get(receipt.digest);
            if (!expected
                || result.profileDatabaseId !== expected.profileDatabaseId
                || result.storageEnvironmentId !== expected.storageEnvironmentId
                || result.protocolVersion !== expected.protocolVersion) {
                throw new Error('Namespace receipt result does not match its domain request.');
            }
        } else if (receipt.kind === 'submit_capsule_candidate') {
            const result = receipt.result as ReceiptResults['submit_capsule_candidate'];
            const expected = submittedCapsulesByDigest.get(receipt.digest);
            if (!expected || result.capsuleId !== expected.capsuleId || result.sourceDigest !== expected.sourceDigest) {
                throw new Error('Capsule receipt result does not match its domain request.');
            }
        } else if (receipt.kind === 'begin_environment_import') {
            const result = receipt.result as ReceiptResults['begin_environment_import'];
            if (result.importClaimId !== importClaimIdsByDigest.get(receipt.digest)) {
                throw new Error('Import receipt result does not match its domain request.');
            }
        } else if (receipt.kind === 'prepare_pending_edit_recovery') {
            const result = receipt.result as ReceiptResults['prepare_pending_edit_recovery'];
            if (!recoveryRecordIdsByDigest.get(receipt.digest)?.has(result.recoveryRecordId)) {
                throw new Error('Recovery receipt result does not match its domain request.');
            }
        }
    }
}

function transition_timestamp(...priorValues: unknown[]): number {
    return Math.max(
        Date.now(),
        ...priorValues.map((value) => counter(value, 'prior lifecycle timestamp', 0, Number.MAX_SAFE_INTEGER)),
    );
}

function create_directory_durably(directoryPath: string): void {
    const missing: string[] = [];
    let existingAncestor = path.resolve(directoryPath);
    while (!fs.existsSync(existingAncestor)) {
        missing.push(existingAncestor);
        const parent = path.dirname(existingAncestor);
        if (parent === existingAncestor) throw new Error('Companion storage has no existing directory ancestor.');
        existingAncestor = parent;
    }
    if (!fs.statSync(existingAncestor).isDirectory()) {
        throw new Error('Companion storage ancestor is not a directory.');
    }
    assert_sqlite_directory_durability_supported(existingAncestor);
    for (const created of missing.reverse()) {
        try {
            fs.mkdirSync(created, { mode: 0o700 });
        } catch (error) {
            if (!(error instanceof Error)
                || !('code' in error)
                || error.code !== 'EEXIST'
                || !fs.lstatSync(created).isDirectory()) {
                throw error;
            }
        }
        fs.chmodSync(created, 0o700);
        assert_sqlite_directory_durability_supported(path.dirname(created));
    }
}

export class CompanionStore {
    readonly #opened: SqliteOpenedDatabase;
    readonly #database: DatabaseSync;
    #pending: Promise<unknown> = Promise.resolve();
    #closed = false;
    #closePromise: Promise<void> | undefined;

    private constructor(opened: SqliteOpenedDatabase) {
        this.#opened = opened;
        this.#database = opened.database;
    }

    static async open(globalStoragePath: string, appVersion: string): Promise<CompanionStore> {
        const databasePath = path.join(globalStoragePath, 'state', 'namespace-recovery.sqlite3');
        create_directory_durably(path.dirname(databasePath));
        fs.chmodSync(path.dirname(databasePath), 0o700);
        const opened = await initialize_custom_sqlite_database_no_clobber(databasePath, {
            applicationId: COMPANION_APPLICATION_ID,
            initialize(database) {
                initialize_companion_schema(database, { appliedAtMs: Date.now(), appVersion });
            },
            validate: validate_companion_schema,
        }, {
            timeoutMs: 5_000,
        });
        try {
            const database = opened.database.database;
            database.exec('BEGIN');
            try {
                validate_companion_contents(database);
                database.exec('COMMIT');
            } catch (error) {
                try { database.exec('ROLLBACK'); } catch { /* Preserve the validation failure. */ }
                throw error;
            }
            return new CompanionStore(opened.database);
        } catch (error) {
            await opened.database.close();
            throw error;
        }
    }

    #enqueue<T>(body: () => T | Promise<T>): Promise<T> {
        if (this.#closed) return Promise.reject(new Error('Companion store is closed.'));
        const result = this.#pending.then(body, body);
        this.#pending = result.then(() => undefined, () => undefined);
        return result;
    }

    #mutate<K extends OperationKind>(
        operationId: string,
        kind: K,
        request: unknown,
        body: () => ReceiptResults[K],
    ): Promise<ReceiptResults[K]> {
        bounded_text(operationId, 'operationId');
        const digest = request_digest(request);
        return this.#enqueue(() => {
            this.#database.exec('BEGIN IMMEDIATE');
            try {
                const receipt = statement(this.#database,
                    `SELECT operation_kind,request_digest,result_json FROM companion_rpc_operations WHERE operation_id=?`).get(operationId) as Row | undefined;
                if (receipt) {
                    if (receipt.operation_kind !== kind || receipt.request_digest !== digest) {
                        throw new Error('Companion operation id was reused for a different request or RPC kind.');
                    }
                    const result = decode_receipt_result(kind, receipt.result_json);
                    this.#database.exec('COMMIT');
                    return result;
                }
                const result = body();
                const resultJson = encode_receipt_result(kind, result);
                statement(this.#database, `INSERT INTO companion_rpc_operations(operation_id,operation_kind,request_digest,result_json,completed_at_ms) VALUES(?,?,?,?,?)`)
                    .run(operationId, kind, digest, resultJson, Date.now());
                this.#database.exec('COMMIT');
                return result;
            } catch (error) {
                try { this.#database.exec('ROLLBACK'); } catch { /* Preserve first failure. */ }
                throw error;
            }
        });
    }

    namespace(input: { placementKeyDigest: string; operationId: string }): Promise<{
        profileDatabaseId: string;
        storageEnvironmentId: string;
        protocolVersion: number;
    }> {
        const placementKeyDigest = sha256_digest_text(input.placementKeyDigest, 'placementKeyDigest');
        return this.#mutate(input.operationId, 'namespace', { placementKeyDigest }, () => {
            const meta = as_row(statement(this.#database, `SELECT profile_database_id FROM companion_meta WHERE singleton=1`).get(), 'companion metadata');
            let row = statement(this.#database, `SELECT storage_environment_id FROM environment_namespaces WHERE placement_key_digest=?`).get(placementKeyDigest) as Row | undefined;
            if (!row) {
                const storageEnvironmentId = randomUUID();
                statement(this.#database, `INSERT INTO environment_namespaces(placement_key_digest,storage_environment_id,created_operation_id,request_digest,created_at_ms) VALUES(?,?,?,?,?)`)
                    .run(placementKeyDigest, storageEnvironmentId, input.operationId, request_digest({ placementKeyDigest }), Date.now());
                row = { storage_environment_id: storageEnvironmentId };
            }
            return {
                profileDatabaseId: bounded_text(meta.profile_database_id, 'profileDatabaseId'),
                storageEnvironmentId: bounded_text(row.storage_environment_id, 'storageEnvironmentId'),
                protocolVersion: COMPANION_PROTOCOL_VERSION,
            };
        });
    }

    listCapsulesForRecovery(): Promise<CapsuleRecoveryRecord[]> {
        return this.#enqueue(() => (
            statement(this.#database, `
                SELECT capsule_id,source_format,source_digest,status,ordered_source_json,created_at_ms
                FROM capsules
                WHERE status IN ('armed','cutover','drifted') AND ordered_source_json IS NOT NULL
                ORDER BY created_at_ms DESC,capsule_id
            `).all() as Row[]
        ).map((row) => {
            const orderedSourceJson = bounded_json_text(
                row.ordered_source_json,
                'orderedSourceJson',
                COMPANION_MAX_CAPSULE_JSON_UTF8_BYTES,
            );
            return {
                capsuleId: bounded_text(row.capsule_id, 'capsuleId'),
                sourceFormat: bounded_text(row.source_format, 'sourceFormat'),
                sourceDigest: sha256_digest_text(row.source_digest, 'sourceDigest'),
                status: one_of(row.status, ['armed', 'cutover', 'drifted'] as const, 'capsule recovery status'),
                orderedSourceJson,
                sourceResourceKeys: decode_memento_file_state_resource_keys(JSON.parse(orderedSourceJson)),
                createdAtMs: counter(row.created_at_ms, 'capsule creation timestamp', 0, Number.MAX_SAFE_INTEGER),
            };
        }));
    }

    listCapsulesForRetirement(): Promise<CapsuleRetirementCandidate[]> {
        return this.#enqueue(() => (
            statement(this.#database, `
                SELECT capsule_id,source_digest,status,created_at_ms
                FROM capsules AS capsule
                WHERE status='drifted' OR (
                    status='cutover'
                    AND NOT EXISTS (
                        SELECT 1 FROM environment_import_claims
                        WHERE capsule_id=capsule.capsule_id AND status='preparing'
                    )
                    AND NOT EXISTS (
                        SELECT 1
                        FROM environment_confirmations AS confirmation
                        LEFT JOIN environment_source_retirements AS retirement
                          ON retirement.capsule_id=confirmation.capsule_id
                         AND retirement.storage_environment_id=confirmation.storage_environment_id
                         AND retirement.database_id=confirmation.database_id
                        WHERE confirmation.capsule_id=capsule.capsule_id
                          AND retirement.capsule_id IS NULL
                    )
                )
                ORDER BY created_at_ms,capsule_id
            `).all() as Row[]
        ).map((row) => ({
            capsuleId: bounded_text(row.capsule_id, 'capsuleId'),
            sourceDigest: sha256_digest_text(row.source_digest, 'sourceDigest'),
            status: one_of(row.status, ['drifted', 'cutover'] as const, 'capsule retirement status'),
            createdAtMs: counter(row.created_at_ms, 'capsule creation timestamp', 0, Number.MAX_SAFE_INTEGER),
        })));
    }

    activeCapsule(): Promise<CapsuleMetadata> {
        return this.#enqueue(() => {
            const row = statement(this.#database, `SELECT capsule_id,source_format,source_digest,source_entry_count,source_next_revision,source_absence_revision,source_updated_at_ms,status FROM capsules WHERE status IN ('armed','cutover')`).get() as Row | undefined;
            if (!row) throw new Error('No active migration capsule is armed.');
            const updatedAtMs = row.source_updated_at_ms === null ? undefined : optional_counter(row.source_updated_at_ms, 'source updated timestamp');
            return {
                capsuleId: bounded_text(row.capsule_id, 'capsuleId'),
                sourceFormat: bounded_text(row.source_format, 'sourceFormat'),
                sourceDigest: sha256_digest_text(row.source_digest, 'sourceDigest'),
                meta: {
                    nextRevision: counter(row.source_next_revision, 'source next revision', 1, Number.MAX_SAFE_INTEGER),
                    absenceRevision: counter(row.source_absence_revision, 'source absence revision'),
                    nextRecencyOrder: String(counter(row.source_entry_count, 'source entry count') + 1),
                    ...(updatedAtMs === undefined ? {} : { updatedAtMs }),
                },
                entryCount: counter(row.source_entry_count, 'source entry count'),
                status: one_of(row.status, ['armed', 'cutover'] as const, 'active capsule status'),
            };
        });
    }

    async submitCapsuleCandidate(input: { operationId: string; orderedSourceJson: string }): Promise<{
        capsuleId: string;
        sourceDigest: string;
    }> {
        const orderedSourceJson = bounded_json_text(input.orderedSourceJson, 'orderedSourceJson', COMPANION_MAX_CAPSULE_JSON_UTF8_BYTES);
        const decoded = decode_source(orderedSourceJson);
        return this.#mutate(input.operationId, 'submit_capsule_candidate', { orderedSourceJson }, () => {
            const same = statement(this.#database, `SELECT capsule_id,status FROM capsules WHERE source_key=? AND source_digest=?`).get(SOURCE_KEY, decoded.digest) as Row | undefined;
            if (same) {
                if (same.status === 'retired') throw new Error('A retired capsule digest cannot be re-armed.');
                if (same.status !== 'armed' && same.status !== 'cutover') throw new Error('The matching capsule is not the active source.');
                return { capsuleId: text(same.capsule_id, 'capsuleId'), sourceDigest: decoded.digest };
            }
            if (statement(this.#database, `SELECT 1 AS present FROM capsules WHERE source_key=? AND status IN ('armed','cutover')`).get(SOURCE_KEY)) {
                throw new Error('An active capsule already exists; archive source drift instead of switching it.');
            }
            const capsuleId = randomUUID();
            statement(this.#database, `INSERT INTO capsules(capsule_id,source_key,source_format,source_digest,created_operation_id,request_digest,ordered_source_json,source_entry_count,source_next_revision,source_absence_revision,source_updated_at_ms,status,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
                .run(capsuleId, SOURCE_KEY, decoded.format, decoded.digest, input.operationId,
                    request_digest({ orderedSourceJson }), orderedSourceJson, decoded.entryCount,
                    decoded.nextRevision, decoded.absenceRevision, decoded.updatedAtMs ?? null, 'armed', Date.now());
            return { capsuleId, sourceDigest: decoded.digest };
        });
    }

    archiveDrift(input: { operationId: string; orderedSourceJson: string }): Promise<Record<string, never>> {
        const orderedSourceJson = bounded_json_text(input.orderedSourceJson, 'orderedSourceJson', COMPANION_MAX_CAPSULE_JSON_UTF8_BYTES);
        const decoded = decode_source(orderedSourceJson);
        return this.#mutate(input.operationId, 'archive_drift', { orderedSourceJson }, () => {
            const active = statement(this.#database, `SELECT capsule_id,status,source_digest FROM capsules WHERE source_key=? AND status IN ('armed','cutover')`).get(SOURCE_KEY) as Row | undefined;
            if (active?.source_digest === decoded.digest) return {};
            let existing = statement(this.#database, `SELECT capsule_id,status FROM capsules WHERE source_key=? AND source_digest=?`).get(SOURCE_KEY, decoded.digest) as Row | undefined;
            if (existing?.status === 'retired') throw new Error('A retired capsule digest cannot be re-armed.');
            const activeCapsuleId = active === undefined ? undefined : bounded_text(active.capsule_id, 'active capsuleId');
            const activeHasPreparingImport = activeCapsuleId !== undefined
                && statement(this.#database, `SELECT 1 AS present FROM environment_import_claims WHERE capsule_id=? AND status='preparing'`).get(activeCapsuleId) !== undefined;
            const preserveActive = active?.status === 'cutover' || activeHasPreparingImport;
            if (activeCapsuleId !== undefined && !preserveActive) {
                statement(this.#database, `UPDATE capsules SET status='drifted' WHERE capsule_id=? AND status='armed'`).run(activeCapsuleId);
            }
            if (!existing) {
                const capsuleId = randomUUID();
                const status = preserveActive ? 'drifted' : 'armed';
                statement(this.#database, `INSERT INTO capsules(capsule_id,source_key,source_format,source_digest,created_operation_id,request_digest,ordered_source_json,source_entry_count,source_next_revision,source_absence_revision,source_updated_at_ms,status,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
                    .run(capsuleId, SOURCE_KEY, decoded.format, decoded.digest, input.operationId,
                        request_digest({ orderedSourceJson }), orderedSourceJson, decoded.entryCount,
                        decoded.nextRevision, decoded.absenceRevision, decoded.updatedAtMs ?? null, status, Date.now());
                existing = { capsule_id: capsuleId, status };
            } else if (!preserveActive) {
                statement(this.#database, `UPDATE capsules SET status='armed' WHERE capsule_id=? AND status IN ('candidate','drifted')`).run(bounded_text(existing.capsule_id, 'capsuleId'));
            }
            return {};
        });
    }

    beginEnvironmentImport(input: { operationId: string; capsuleId: string; sourceDigest: string; storageEnvironmentId: string; databaseId: string }): Promise<{ importClaimId: string }> {
        const request = { capsuleId: bounded_text(input.capsuleId, 'capsuleId'), sourceDigest: sha256_digest_text(input.sourceDigest, 'sourceDigest'), storageEnvironmentId: bounded_text(input.storageEnvironmentId, 'storageEnvironmentId'), databaseId: bounded_text(input.databaseId, 'databaseId') };
        return this.#mutate(input.operationId, 'begin_environment_import', request, () => {
            const capsule = statement(this.#database, `SELECT status FROM capsules WHERE capsule_id=? AND source_digest=?`).get(request.capsuleId, request.sourceDigest) as Row | undefined;
            if (!capsule || capsule.status === 'retired' || capsule.status === 'drifted') throw new Error('Import capsule is unavailable.');
            const existing = statement(this.#database, `SELECT import_claim_id,source_digest FROM environment_import_claims WHERE capsule_id=? AND storage_environment_id=? AND database_id=?`).get(request.capsuleId, request.storageEnvironmentId, request.databaseId) as Row | undefined;
            if (existing) {
                if (existing.source_digest !== request.sourceDigest) throw new Error('Import claim source digest mismatch.');
                return { importClaimId: text(existing.import_claim_id, 'importClaimId') };
            }
            const importClaimId = randomUUID();
            statement(this.#database, `INSERT INTO environment_import_claims(capsule_id,storage_environment_id,database_id,import_claim_id,source_digest,status,operation_id,request_digest,prepared_at_ms) VALUES(?,?,?,?,?,'preparing',?,?,?)`)
                .run(request.capsuleId, request.storageEnvironmentId, request.databaseId, importClaimId,
                    request.sourceDigest, input.operationId, request_digest(request), Date.now());
            return { importClaimId };
        });
    }

    environmentImportStatus(input: { importClaimId: string; capsuleId: string; storageEnvironmentId: string; databaseId: string }): Promise<'preparing' | 'confirmed' | 'abandoned'> {
        const importClaimId = bounded_text(input.importClaimId, 'importClaimId');
        const capsuleId = bounded_text(input.capsuleId, 'capsuleId');
        const storageEnvironmentId = bounded_text(input.storageEnvironmentId, 'storageEnvironmentId');
        const databaseId = bounded_text(input.databaseId, 'databaseId');
        return this.#enqueue(() => {
            const row = statement(this.#database, `SELECT status,import_claim_id FROM environment_import_claims WHERE capsule_id=? AND storage_environment_id=? AND database_id=?`).get(capsuleId, storageEnvironmentId, databaseId) as Row | undefined;
            if (!row || row.import_claim_id !== importClaimId) throw new Error('Import claim identity mismatch.');
            return one_of(row.status, ['preparing', 'confirmed', 'abandoned'] as const, 'import claim status');
        });
    }

    abandonEnvironmentImport(input: { operationId: string; importClaimId: string; capsuleId: string; storageEnvironmentId: string; databaseId: string; abandonmentEvidenceDigest: string }): Promise<Record<string, never>> {
        const request = { importClaimId: bounded_text(input.importClaimId, 'importClaimId'), capsuleId: bounded_text(input.capsuleId, 'capsuleId'), storageEnvironmentId: bounded_text(input.storageEnvironmentId, 'storageEnvironmentId'), databaseId: bounded_text(input.databaseId, 'databaseId'), abandonmentEvidenceDigest: sha256_digest_text(input.abandonmentEvidenceDigest, 'abandonmentEvidenceDigest') };
        return this.#mutate(input.operationId, 'abandon_environment_import', request, () => {
            const row = statement(this.#database, `SELECT status,import_claim_id,abandonment_evidence_digest,prepared_at_ms FROM environment_import_claims WHERE capsule_id=? AND storage_environment_id=? AND database_id=?`).get(request.capsuleId, request.storageEnvironmentId, request.databaseId) as Row | undefined;
            if (!row || row.import_claim_id !== request.importClaimId) throw new Error('Import claim identity mismatch.');
            if (row.status === 'confirmed') throw new Error('A confirmed import cannot be abandoned.');
            if (row.status === 'abandoned' && row.abandonment_evidence_digest !== request.abandonmentEvidenceDigest) {
                throw new Error('Abandoned import retry evidence mismatch.');
            }
            if (row.status === 'preparing') statement(this.#database, `UPDATE environment_import_claims SET status='abandoned',abandoned_at_ms=?,abandonment_operation_id=?,abandonment_evidence_digest=? WHERE capsule_id=? AND storage_environment_id=? AND database_id=?`).run(transition_timestamp(row.prepared_at_ms), input.operationId, request.abandonmentEvidenceDigest, request.capsuleId, request.storageEnvironmentId, request.databaseId);
            return {};
        });
    }

    confirmEnvironment(input: { operationId: string; importClaimId: string; capsuleId: string; sourceDigest: string; storageEnvironmentId: string; databaseId: string }): Promise<Record<string, never>> {
        const request = { importClaimId: bounded_text(input.importClaimId, 'importClaimId'), capsuleId: bounded_text(input.capsuleId, 'capsuleId'), sourceDigest: sha256_digest_text(input.sourceDigest, 'sourceDigest'), storageEnvironmentId: bounded_text(input.storageEnvironmentId, 'storageEnvironmentId'), databaseId: bounded_text(input.databaseId, 'databaseId') };
        return this.#mutate(input.operationId, 'confirm_environment', request, () => {
            const row = statement(this.#database, `SELECT status,import_claim_id,source_digest,prepared_at_ms,confirmed_at_ms FROM environment_import_claims WHERE capsule_id=? AND storage_environment_id=? AND database_id=?`).get(request.capsuleId, request.storageEnvironmentId, request.databaseId) as Row | undefined;
            if (!row || row.import_claim_id !== request.importClaimId || row.source_digest !== request.sourceDigest || row.status === 'abandoned') throw new Error('Import claim cannot be confirmed.');
            const now = row.status === 'confirmed'
                ? counter(row.confirmed_at_ms, 'claim confirmation timestamp', 0, Number.MAX_SAFE_INTEGER)
                : transition_timestamp(row.prepared_at_ms);
            if (row.status === 'preparing') statement(this.#database, `UPDATE environment_import_claims SET status='confirmed',confirmed_at_ms=? WHERE capsule_id=? AND storage_environment_id=? AND database_id=?`).run(now, request.capsuleId, request.storageEnvironmentId, request.databaseId);
            if (!statement(this.#database, `SELECT 1 AS present FROM environment_confirmations WHERE capsule_id=? AND storage_environment_id=? AND database_id=?`).get(request.capsuleId, request.storageEnvironmentId, request.databaseId)) {
                statement(this.#database, `INSERT INTO environment_confirmations(capsule_id,storage_environment_id,database_id,import_claim_id,operation_id,request_digest,confirmed_at_ms) VALUES(?,?,?,?,?,?,?)`).run(request.capsuleId, request.storageEnvironmentId, request.databaseId, request.importClaimId, input.operationId, request_digest(request), now);
            }
            statement(this.#database, `UPDATE capsules SET status='cutover' WHERE capsule_id=? AND status='armed'`).run(request.capsuleId);
            return {};
        });
    }

    confirmEnvironmentSourceRetirement(input: { operationId: string; capsuleId: string; sourceDigest: string; storageEnvironmentId: string; databaseId: string; retirementKind: 'naturallyComplete' | 'userRetired'; sourceStateDigest: string }): Promise<Record<string, never>> {
        const request = { capsuleId: bounded_text(input.capsuleId, 'capsuleId'), sourceDigest: sha256_digest_text(input.sourceDigest, 'sourceDigest'), storageEnvironmentId: bounded_text(input.storageEnvironmentId, 'storageEnvironmentId'), databaseId: bounded_text(input.databaseId, 'databaseId'), retirementKind: input.retirementKind, sourceStateDigest: sha256_digest_text(input.sourceStateDigest, 'sourceStateDigest') };
        if (request.retirementKind !== 'naturallyComplete' && request.retirementKind !== 'userRetired') throw new TypeError('Invalid retirement kind.');
        return this.#mutate(input.operationId, 'confirm_environment_source_retirement', request, () => {
            const confirmation = statement(this.#database, `SELECT confirmed_at_ms FROM environment_confirmations WHERE capsule_id=? AND storage_environment_id=? AND database_id=?`).get(request.capsuleId, request.storageEnvironmentId, request.databaseId) as Row | undefined;
            const capsule = statement(this.#database, `SELECT source_digest FROM capsules WHERE capsule_id=?`).get(request.capsuleId) as Row | undefined;
            if (!confirmation || capsule?.source_digest !== request.sourceDigest) throw new Error('Environment confirmation or capsule identity is missing.');
            const existing = statement(this.#database, `SELECT source_digest,retirement_kind,source_state_digest FROM environment_source_retirements WHERE capsule_id=? AND storage_environment_id=? AND database_id=?`).get(request.capsuleId, request.storageEnvironmentId, request.databaseId) as Row | undefined;
            const retirementKind = request.retirementKind === 'naturallyComplete' ? 'naturally_complete' : 'user_retired';
            if (existing) {
                if (existing.source_digest !== request.sourceDigest || existing.retirement_kind !== retirementKind || existing.source_state_digest !== request.sourceStateDigest) throw new Error('Environment retirement identity mismatch.');
                return {};
            }
            statement(this.#database, `INSERT INTO environment_source_retirements(capsule_id,storage_environment_id,database_id,source_digest,retirement_kind,source_state_digest,operation_id,request_digest,retired_at_ms) VALUES(?,?,?,?,?,?,?,?,?)`).run(request.capsuleId, request.storageEnvironmentId, request.databaseId, request.sourceDigest, retirementKind, request.sourceStateDigest, input.operationId, request_digest(request), transition_timestamp(confirmation.confirmed_at_ms));
            return {};
        });
    }

    retireCapsule(input: { operationId: string; capsuleId: string; noNeverClaimedEnvironmentAttested: true }): Promise<Record<string, never>> {
        const request = { capsuleId: bounded_text(input.capsuleId, 'capsuleId'), noNeverClaimedEnvironmentAttested: input.noNeverClaimedEnvironmentAttested };
        if (input.noNeverClaimedEnvironmentAttested !== true) throw new Error('Capsule retirement requires the never-claimed-environment attestation.');
        return this.#mutate(input.operationId, 'retire_capsule', request, () => {
            const capsule = statement(this.#database, `SELECT status,created_at_ms FROM capsules WHERE capsule_id=?`).get(request.capsuleId) as Row | undefined;
            if (!capsule) throw new Error('Capsule is missing.');
            if (capsule.status === 'retired') return {};
            if (statement(this.#database, `SELECT 1 AS present FROM environment_import_claims WHERE capsule_id=? AND status='preparing' LIMIT 1`).get(request.capsuleId)) throw new Error('Preparing imports block capsule retirement.');
            if (statement(this.#database, `SELECT 1 AS present FROM environment_confirmations c LEFT JOIN environment_source_retirements r ON r.capsule_id=c.capsule_id AND r.storage_environment_id=c.storage_environment_id AND r.database_id=c.database_id WHERE c.capsule_id=? AND r.capsule_id IS NULL LIMIT 1`).get(request.capsuleId)) throw new Error('Unretired environment incarnations block capsule retirement.');
            if (capsule.status !== 'drifted' && capsule.status !== 'cutover') {
                throw new Error('The capsule is no longer eligible for retirement.');
            }
            statement(this.#database, `UPDATE capsules SET status='retired',ordered_source_json=NULL,retired_at_ms=?,retirement_operation_id=? WHERE capsule_id=?`).run(transition_timestamp(capsule.created_at_ms), input.operationId, request.capsuleId);
            return {};
        });
    }

    async preparePendingEditRecovery(input: { storageEnvironmentId: string; databaseId: string; recoveryEntryId: string; operationId: string; kind: 'snapshot' | 'clear'; pendingEditsJson?: string; resourceIdentityJson: string; authorityRevision: number; physicalRevision: number; projectionRevision: number; physicalDigest?: string }): Promise<{ recoveryRecordId: string }> {
        const request = {
            storageEnvironmentId: bounded_text(input.storageEnvironmentId, 'storageEnvironmentId'), databaseId: bounded_text(input.databaseId, 'databaseId'), recoveryEntryId: bounded_text(input.recoveryEntryId, 'recoveryEntryId'), kind: input.kind,
            ...(input.pendingEditsJson === undefined ? {} : { pendingEditsJson: input.pendingEditsJson }), resourceIdentityJson: input.resourceIdentityJson,
            authorityRevision: counter(input.authorityRevision, 'authorityRevision'), physicalRevision: counter(input.physicalRevision, 'physicalRevision'), projectionRevision: counter(input.projectionRevision, 'projectionRevision'),
            ...(input.physicalDigest === undefined ? {} : { physicalDigest: sha256_digest_text(input.physicalDigest, 'physicalDigest') }),
        };
        if (request.kind !== 'snapshot' && request.kind !== 'clear') throw new TypeError('Invalid recovery kind.');
        const resourceIdentityJson = bounded_json_text(request.resourceIdentityJson, 'resourceIdentityJson', COMPANION_MAX_RECOVERY_JSON_UTF8_BYTES);
        object(JSON.parse(resourceIdentityJson), 'resourceIdentityJson');
        if (request.kind === 'snapshot') {
            const pendingEditsJson = bounded_json_text(request.pendingEditsJson, 'pendingEditsJson', COMPANION_MAX_RECOVERY_JSON_UTF8_BYTES);
            const pending = object(JSON.parse(pendingEditsJson), 'pendingEditsJson');
            const decoded = decode_stored_per_file_state({ pendingEdits: pending }) as { pendingEdits?: unknown };
            if (decoded.pendingEdits === undefined) throw new TypeError('Recovery snapshot pending edits must not be empty.');
        } else if (request.pendingEditsJson !== undefined) throw new TypeError('A recovery clear cannot contain pending edits.');
        return this.#mutate(input.operationId, 'prepare_pending_edit_recovery', request, () => {
            const digest = request_digest(request);
            const recoveryRecordId = randomUUID();
            statement(this.#database, `INSERT INTO pending_edit_recovery_records(recovery_record_id,storage_environment_id,database_id,recovery_entry_id,operation_id,request_digest,kind,resource_identity_json,authority_revision,physical_revision,projection_revision,physical_digest,pending_edits_json,status,prepared_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'prepared',?)`).run(recoveryRecordId, request.storageEnvironmentId, request.databaseId, request.recoveryEntryId, input.operationId, digest, request.kind, request.resourceIdentityJson, request.authorityRevision, request.physicalRevision, request.projectionRevision, request.physicalDigest ?? null, request.pendingEditsJson ?? null, Date.now());
            return { recoveryRecordId };
        });
    }

    confirmPendingEditRecovery(input: { operationId: string; recoveryRecordId: string; committedStateRevision: number }): Promise<Record<string, never>> {
        const request = { recoveryRecordId: bounded_text(input.recoveryRecordId, 'recoveryRecordId'), committedStateRevision: counter(input.committedStateRevision, 'committedStateRevision') };
        return this.#mutate(input.operationId, 'confirm_pending_edit_recovery', request, () => {
            const row = statement(this.#database, `SELECT status,committed_state_revision,prepared_at_ms FROM pending_edit_recovery_records WHERE recovery_record_id=?`).get(request.recoveryRecordId) as Row | undefined;
            if (!row) throw new Error('Recovery record is missing.');
            if (row.status === 'committed') {
                if (row.committed_state_revision !== request.committedStateRevision) throw new Error('Recovery confirmation revision mismatch.');
                return {};
            }
            statement(this.#database, `UPDATE pending_edit_recovery_records SET status='committed',confirmation_operation_id=?,confirmation_request_digest=?,committed_state_revision=?,committed_at_ms=? WHERE recovery_record_id=?`).run(input.operationId, request_digest(request), request.committedStateRevision, transition_timestamp(row.prepared_at_ms), request.recoveryRecordId);
            return {};
        });
    }

    listRecoveryRecords(): Promise<readonly RecoveryRecord[]> {
        return this.#enqueue(() => (statement(this.#database, `SELECT recovery_record_id,storage_environment_id,database_id,recovery_entry_id,kind,resource_identity_json,authority_revision,physical_revision,projection_revision,physical_digest,pending_edits_json,status,prepared_at_ms,committed_state_revision FROM pending_edit_recovery_records ORDER BY prepared_at_ms DESC,recovery_record_id`).all() as Row[]).map((row) => {
            const kind = one_of(row.kind, ['snapshot', 'clear'] as const, 'recovery kind');
            validate_recovery_payload(kind, row.resource_identity_json, row.pending_edits_json);
            const resourceIdentityJson = bounded_json_text(row.resource_identity_json, 'resourceIdentityJson', COMPANION_MAX_RECOVERY_JSON_UTF8_BYTES);
            const pendingEditsJson = row.pending_edits_json === null ? null
                : bounded_json_text(row.pending_edits_json, 'pendingEditsJson', COMPANION_MAX_RECOVERY_JSON_UTF8_BYTES);
            return {
                recoveryRecordId: bounded_text(row.recovery_record_id, 'recoveryRecordId'), storageEnvironmentId: bounded_text(row.storage_environment_id, 'storageEnvironmentId'), databaseId: bounded_text(row.database_id, 'databaseId'), recoveryEntryId: bounded_text(row.recovery_entry_id, 'recoveryEntryId'), kind,
                resourceIdentity: object(JSON.parse(resourceIdentityJson), 'resourceIdentityJson'), authorityRevision: counter(row.authority_revision, 'authorityRevision'), physicalRevision: counter(row.physical_revision, 'physicalRevision'), projectionRevision: counter(row.projection_revision, 'projectionRevision'),
                ...(row.physical_digest === null ? {} : { physicalDigest: sha256_digest_text(row.physical_digest, 'physicalDigest') }),
                ...(pendingEditsJson === null ? {} : { pendingEdits: object(JSON.parse(pendingEditsJson), 'pendingEditsJson') }),
                status: one_of(row.status, ['prepared', 'committed'] as const, 'recovery status'), preparedAtMs: counter(row.prepared_at_ms, 'preparedAtMs', 0, Number.MAX_SAFE_INTEGER),
                ...(row.committed_state_revision === null ? {} : { committedStateRevision: counter(row.committed_state_revision, 'committedStateRevision') }),
            };
        }));
    }

    async drain(): Promise<void> { await this.#pending; }

    close(): Promise<void> {
        if (this.#closePromise) return this.#closePromise;
        this.#closed = true;
        this.#closePromise = (async () => {
            await this.#pending;
            await this.#opened.close();
        })();
        return this.#closePromise;
    }
}

export const companion_crypto = { sha256, request_digest };
