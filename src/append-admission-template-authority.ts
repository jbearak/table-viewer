import type { PendingRowFormatTemplate } from './pending-changes';

interface OwnedTemplate {
    readonly template: PendingRowFormatTemplate;
    readonly byteCost: number;
}

/**
 * Aggregate byte budget for format capabilities held by live append ledgers and
 * their not-yet-published reservations.
 */
export class AppendAdmissionTemplateAuthorityStore {
    private readonly owners = new Map<string, Map<string, OwnedTemplate>>();
    private retained_bytes = 0;

    public constructor(private readonly max_bytes: number) {}

    public get byte_count(): number {
        return this.retained_bytes;
    }

    public get(owner: string, template_id: string): PendingRowFormatTemplate | undefined {
        return this.owners.get(owner)?.get(template_id)?.template;
    }

    public remember(owner: string, template: PendingRowFormatTemplate): boolean {
        const current = this.owners.get(owner);
        const prior = current?.get(template.id);
        if (prior !== undefined && JSON.stringify(prior.template) === JSON.stringify(template)) {
            return true;
        }
        const next = this.owned(template);
        const projected = this.retained_bytes - (prior?.byteCost ?? 0) + next.byteCost;
        if (projected > this.max_bytes) return false;
        const templates = current ?? new Map<string, OwnedTemplate>();
        templates.set(template.id, next);
        this.owners.set(owner, templates);
        this.retained_bytes = projected;
        return true;
    }

    /** Replace several capabilities for one owner as a single budget decision. */
    public replace(
        owner: string,
        templates: readonly PendingRowFormatTemplate[],
    ): boolean {
        const current = this.owners.get(owner) ?? new Map<string, OwnedTemplate>();
        const next = new Map(current);
        for (const template of templates) next.set(template.id, this.owned(template));
        const projected = this.retained_bytes
            - this.owner_bytes(current)
            + this.owner_bytes(next);
        if (projected > this.max_bytes) return false;
        this.owners.set(owner, next);
        this.retained_bytes = projected;
        return true;
    }

    /** Reserve an exact request payload atomically. */
    public reserve(owner: string, templates: readonly PendingRowFormatTemplate[]): boolean {
        if (this.owners.has(owner)) return false;
        const owned = new Map<string, OwnedTemplate>();
        for (const template of templates) owned.set(template.id, this.owned(template));
        const added = [...owned.values()].reduce((total, entry) => total + entry.byteCost, 0);
        if (this.retained_bytes + added > this.max_bytes) return false;
        this.owners.set(owner, owned);
        this.retained_bytes += added;
        return true;
    }

    /** Move a reservation into its ledger without transiently double-counting it. */
    public commit(
        reservation_owner: string,
        ledger_owner: string,
        templates: readonly PendingRowFormatTemplate[],
    ): boolean {
        return this.commit_many([reservation_owner], ledger_owner, templates);
    }

    /**
     * Retire one publication's reservations and add its retained templates as
     * one budget decision. Nothing changes when the complete transition would
     * exceed the cap.
     */
    public commit_many(
        reservation_owners: readonly string[],
        ledger_owner: string,
        templates: readonly PendingRowFormatTemplate[],
    ): boolean {
        const transition = this.project_commit_many(
            reservation_owners,
            ledger_owner,
            templates,
        );
        if (transition.projectedBytes > this.max_bytes) return false;
        for (const owner of transition.retiredOwners) this.owners.delete(owner);
        this.owners.set(ledger_owner, transition.nextLedger);
        this.retained_bytes = transition.projectedBytes;
        return true;
    }

    /** Whether a serialized publication can commit without crossing the cap. */
    public can_commit_many(
        reservation_owners: readonly string[],
        ledger_owner: string,
        templates: readonly PendingRowFormatTemplate[],
    ): boolean {
        return this.project_commit_many(
            reservation_owners,
            ledger_owner,
            templates,
        ).projectedBytes <= this.max_bytes;
    }

    private project_commit_many(
        reservation_owners: readonly string[],
        ledger_owner: string,
        templates: readonly PendingRowFormatTemplate[],
    ): {
        readonly retiredOwners: ReadonlySet<string>;
        readonly nextLedger: Map<string, OwnedTemplate>;
        readonly projectedBytes: number;
    } {
        const ledger = this.owners.get(ledger_owner) ?? new Map<string, OwnedTemplate>();
        const next_ledger = new Map(ledger);
        for (const template of templates) next_ledger.set(template.id, this.owned(template));
        const retired_owners = new Set(reservation_owners);
        retired_owners.delete(ledger_owner);
        const reservation_bytes = [...retired_owners].reduce(
            (total, owner) => total + this.owner_bytes(this.owners.get(owner)),
            0,
        );
        const ledger_bytes = this.owner_bytes(ledger);
        const next_ledger_bytes = this.owner_bytes(next_ledger);
        const projected = this.retained_bytes
            - reservation_bytes
            - ledger_bytes
            + next_ledger_bytes;
        return {
            retiredOwners: retired_owners,
            nextLedger: next_ledger,
            projectedBytes: projected,
        };
    }

    public forget_owner(owner: string): void {
        const templates = this.owners.get(owner);
        if (templates === undefined) return;
        this.retained_bytes -= this.owner_bytes(templates);
        this.owners.delete(owner);
    }

    private owned(template: PendingRowFormatTemplate): OwnedTemplate {
        return Object.freeze({
            template,
            byteCost: Buffer.byteLength(JSON.stringify(template), 'utf8') + 256,
        });
    }

    private owner_bytes(templates: Map<string, OwnedTemplate> | undefined): number {
        if (templates === undefined) return 0;
        return [...templates.values()].reduce((total, entry) => total + entry.byteCost, 0);
    }
}
