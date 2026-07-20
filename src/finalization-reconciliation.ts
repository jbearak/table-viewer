import type {
    AuthorityFileStateStore,
    AuthorityTransactionKind,
    DurableFileAuthority,
    FileStateSnapshot,
} from './state';
import { same_authority } from './authority-order';
import type { StoredPerFileState } from './types';

export interface FinalizationDescriptor {
    transactionId: string;
    kind: AuthorityTransactionKind;
    basis: DurableFileAuthority;
    expectedStateRevision: number;
    previousState: StoredPerFileState;
    nextState?: StoredPerFileState;
    physicalDigest?: string;
}

export type FinalizationReconciliation =
    | { type: 'committed'; authority: DurableFileAuthority; snapshot: FileStateSnapshot }
    | { type: 'notCommitted' }
    | { type: 'advanced'; authority: DurableFileAuthority; snapshot: FileStateSnapshot };

function expected_authority(descriptor: FinalizationDescriptor): DurableFileAuthority {
    const next: DurableFileAuthority = {
        commitSequence: descriptor.basis.commitSequence + 1,
        authorityRevision: descriptor.basis.authorityRevision,
        physicalRevision: descriptor.basis.physicalRevision,
        projectionRevision: descriptor.basis.projectionRevision,
        ...(descriptor.basis.physicalDigest === undefined
            ? {}
            : { physicalDigest: descriptor.basis.physicalDigest }),
    };
    if (descriptor.kind === 'projection') {
        next.projectionRevision += 1;
        next.authorityRevision += 1;
    } else if (next.physicalDigest !== descriptor.physicalDigest) {
        next.physicalRevision += 1;
        next.authorityRevision += 1;
        next.physicalDigest = descriptor.physicalDigest;
    }
    return next;
}

function equal(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

export async function reconcile_finalization(
    store: AuthorityFileStateStore,
    path: string,
    descriptor: FinalizationDescriptor,
): Promise<FinalizationReconciliation> {
    const inspected = await store.inspect_authority_transaction(
        path,
        descriptor.transactionId,
    );
    const basisAuthority: DurableFileAuthority = {
        commitSequence: descriptor.basis.commitSequence,
        authorityRevision: descriptor.basis.authorityRevision,
        physicalRevision: descriptor.basis.physicalRevision,
        projectionRevision: descriptor.basis.projectionRevision,
        ...(descriptor.basis.physicalDigest === undefined
            ? {}
            : { physicalDigest: descriptor.basis.physicalDigest }),
    };
    const expectedAuthority = expected_authority(descriptor);
    const expectedState = descriptor.nextState ?? descriptor.previousState;
    const stateChanged = !equal(descriptor.previousState, expectedState);
    const revisionMatches = stateChanged
        ? inspected.snapshot.revision > descriptor.expectedStateRevision
        : inspected.snapshot.revision === descriptor.expectedStateRevision;
    if (
        !inspected.stagePresent
        && same_authority(inspected.authority, expectedAuthority)
        && revisionMatches
        && equal(inspected.snapshot.state, expectedState)
    ) {
        return {
            type: 'committed',
            authority: inspected.authority,
            snapshot: inspected.snapshot,
        };
    }
    if (
        inspected.stagePresent
        && same_authority(inspected.authority, basisAuthority)
        && inspected.snapshot.revision === descriptor.expectedStateRevision
        && equal(inspected.snapshot.state, descriptor.previousState)
    ) return { type: 'notCommitted' };
    return {
        type: 'advanced',
        authority: inspected.authority,
        snapshot: inspected.snapshot,
    };
}
