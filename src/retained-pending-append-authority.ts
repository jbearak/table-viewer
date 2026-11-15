import type { PendingAppendBasis, PendingRowFormatTemplate } from './pending-changes';

export interface RetainedPendingAppendAuthorityInput {
    readonly formatTemplate: PendingRowFormatTemplate;
    readonly formatTemplateId: string;
    readonly appendBasis?: PendingAppendBasis;
    readonly sourceGeneration: number;
    /**
     * An insert minted this row, so its replay may carry origin `insert`
     * (a Pending Inserted Row or its discarded tombstone).
     */
    readonly insertMinted?: true;
}

export interface RetainedPendingAppendAuthority
    extends RetainedPendingAppendAuthorityInput {
    readonly byteCost: number;
}

/**
 * Bounded host authority for unsaved rows that are reachable only from history.
 *
 * Each row owns just the one format template named by its capability. Keeping
 * the cache here, rather than copying an admission ledger's complete template
 * map into every row, makes both that invariant and the aggregate byte bound
 * independently testable.
 */
export class RetainedPendingAppendAuthorityStore {
    private readonly authorities = new Map<
        string,
        Map<string, RetainedPendingAppendAuthority>
    >();
    private retained_bytes = 0;

    public constructor(private readonly max_bytes: number) {}

    public get byte_count(): number {
        return this.retained_bytes;
    }

    public get row_count(): number {
        let count = 0;
        for (const rows of this.authorities.values()) count += rows.size;
        return count;
    }

    public get(
        target_key: string,
        row_id: string,
    ): RetainedPendingAppendAuthority | undefined {
        return this.authorities.get(target_key)?.get(row_id);
    }

    public entries(): IterableIterator<[
        string,
        Map<string, RetainedPendingAppendAuthority>,
    ]> {
        return this.authorities.entries();
    }

    public forget(target_key: string, row_id: string): void {
        const rows = this.authorities.get(target_key);
        const prior = rows?.get(row_id);
        if (prior === undefined) return;
        rows!.delete(row_id);
        this.retained_bytes -= prior.byteCost;
        if (rows!.size === 0) this.authorities.delete(target_key);
    }

    /**
     * Move one worksheet's authorities from the schema fingerprint `from` to
     * `to`: the worksheet was re-projected (its Header Row moved, so its
     * column names and their fingerprint did) over the same file. Only an
     * authority that holds `from` moves; one already stale from a real schema
     * change stays stale. In place: neither the recency order nor the byte
     * total changes, so nothing is evicted.
     */
    public move_schema_fingerprint(target_key: string, from: string, to: string): void {
        const rows = this.authorities.get(target_key);
        if (rows === undefined || from === to) return;
        for (const [row_id, authority] of rows) {
            if (authority.appendBasis?.schemaFingerprint !== from) continue;
            // Same key, so the row keeps its place; same cost, a fingerprint
            // for a fingerprint.
            rows.set(row_id, Object.freeze({
                ...authority,
                appendBasis: Object.freeze({ ...authority.appendBasis, schemaFingerprint: to }),
            }));
        }
    }

    public remember(
        target_key: string,
        row_id: string,
        authority: RetainedPendingAppendAuthorityInput,
    ): boolean {
        const owned = Object.freeze({
            ...authority,
            byteCost: Buffer.byteLength(JSON.stringify({ row_id, ...authority }), 'utf8') + 256,
        });
        if (owned.byteCost > this.max_bytes) return false;

        const rows = this.authorities.get(target_key)
            ?? new Map<string, RetainedPendingAppendAuthority>();
        const prior = rows.get(row_id);
        if (prior !== undefined) {
            rows.delete(row_id);
            this.retained_bytes -= prior.byteCost;
        }
        // A successful re-remember is a fresh use of the target and row. Move
        // both map keys to the end so eviction remains recency-ordered.
        this.authorities.delete(target_key);
        rows.set(row_id, owned);
        this.authorities.set(target_key, rows);
        this.retained_bytes += owned.byteCost;

        while (this.retained_bytes > this.max_bytes) {
            const first_target = this.authorities.entries().next().value as
                | [string, Map<string, RetainedPendingAppendAuthority>]
                | undefined;
            const first_row = first_target?.[1].keys().next().value as string | undefined;
            if (first_target === undefined || first_row === undefined) break;
            this.forget(first_target[0], first_row);
        }
        return this.get(target_key, row_id) !== undefined;
    }
}
