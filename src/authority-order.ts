import type { DurableFileAuthority } from './state';

export type AuthorityRelation =
    | 'equal'
    | 'dominates'
    | 'dominated'
    | 'divergent';

function equal(left: DurableFileAuthority, right: DurableFileAuthority): boolean {
    return left.commitSequence === right.commitSequence
        && left.authorityRevision === right.authorityRevision
        && left.physicalRevision === right.physicalRevision
        && left.projectionRevision === right.projectionRevision
        && left.physicalDigest === right.physicalDigest;
}

function dominates(left: DurableFileAuthority, right: DurableFileAuthority): boolean {
    return left.commitSequence > right.commitSequence
        && left.authorityRevision >= right.authorityRevision
        && left.physicalRevision >= right.physicalRevision
        && left.projectionRevision >= right.projectionRevision
        && (
            left.physicalRevision !== right.physicalRevision
            || left.physicalDigest === right.physicalDigest
        );
}

/** Compare two complete durable authority vectors. */
export function compare_authority(
    left: DurableFileAuthority,
    right: DurableFileAuthority,
): AuthorityRelation {
    if (equal(left, right)) return 'equal';
    if (dominates(left, right)) return 'dominates';
    if (dominates(right, left)) return 'dominated';
    return 'divergent';
}

export function same_authority(
    left: DurableFileAuthority,
    right: DurableFileAuthority,
): boolean {
    return compare_authority(left, right) === 'equal';
}
