/**
 * Test-only {@link AnchorAxisView} over a plain array model of one axis, with
 * the layout operations the spec defines, tombstone gluing included. Rows are
 * written as 1-based worksheet numbers for source members and strings for
 * pending ones.
 */

import type {
    AnchorAxisView,
    AnchorWorksheet,
    FormulaAnchorContext,
} from '../../formula-anchors';
import type { RowIdentity } from '../../pending-changes';
import type { ColumnIdentity } from '../../worksheet-layout';

export type AxisMember = number | string;

export interface AxisModel {
    /** H: fixed rows above the body; 0 for columns. */
    readonly fixed: number;
    /** Source members, numbered fixed + 1 .. fixed + source. */
    readonly source: number;
    /** Full order, tombstones included. */
    readonly order: readonly AxisMember[];
    /** Tombstones: removed source members and discarded pending ones. */
    readonly tombstones: ReadonlySet<AxisMember>;
    /** Live Pending Appended Rows in createdOrder. */
    readonly band: readonly string[];
}

export function axis_model(
    fixed: number,
    source: number,
    changes: Partial<Pick<AxisModel, 'order' | 'band'>> & { readonly tombstones?: readonly AxisMember[] } = {},
): AxisModel {
    return {
        fixed,
        source,
        order: changes.order ?? Array.from({ length: source }, (_, index) => fixed + index + 1),
        tombstones: new Set(changes.tombstones ?? []),
        band: changes.band ?? [],
    };
}

function live(model: AxisModel, member: AxisMember): boolean {
    return !model.tombstones.has(member);
}

/** A live member with the tombstones glued to it. */
function block(model: AxisModel, member: AxisMember): AxisMember[] {
    const index = model.order.indexOf(member);
    const out = [member];
    for (let at = index + 1; at < model.order.length && !live(model, model.order[at]); at++) {
        out.push(model.order[at]);
    }
    return out;
}

/** Remove a source member or discard a pending one: a tombstone in place. */
export function delete_member(model: AxisModel, member: AxisMember): AxisModel {
    if (model.band.includes(member as string)) {
        return { ...model, band: model.band.filter((id) => id !== member) };
    }
    return { ...model, tombstones: new Set([...model.tombstones, member]) };
}

/** Insert pending members before a live member, after the previous live member's glued tombstones. */
export function insert_before(
    model: AxisModel,
    before: AxisMember | undefined,
    ids: readonly string[],
): AxisModel {
    // Tombstones just before `before` are glued to the previous live member,
    // so new members land after them.
    const index = before === undefined ? model.order.length : model.order.indexOf(before);
    return {
        ...model,
        order: [...model.order.slice(0, index), ...ids, ...model.order.slice(index)],
    };
}

/** Move a live member, with its glued tombstones, before another live member (or to the end). */
export function move_before(
    model: AxisModel,
    member: AxisMember,
    before: AxisMember | undefined,
): AxisModel {
    const moved = block(model, member);
    const rest = model.order.filter((entry) => !moved.includes(entry));
    const index = before === undefined ? rest.length : rest.indexOf(before);
    return { ...model, order: [...rest.slice(0, index), ...moved, ...rest.slice(index)] };
}

/** Append a Pending Appended Row to the band. */
export function append(model: AxisModel, id: string): AxisModel {
    return { ...model, band: [...model.band, id] };
}

/** A stable key of the full layout, tombstones included, for path-independence checks. */
export function layout_key(model: AxisModel): string {
    return JSON.stringify([
        model.order.map((member) => `${live(model, member) ? '' : '~'}${member}`),
        model.band,
    ]);
}

class ArrayAnchorAxis<Identity> implements AnchorAxisView<Identity> {
    readonly fixedCount: number;
    readonly sourceCount: number;
    readonly liveCount: number;
    readonly fullCount: number;
    readonly bandCount: number;
    readonly hasLiveChange: boolean;
    readonly hasInsertOrOutOfOrderRun: boolean;
    private readonly live_members: readonly AxisMember[];
    private readonly runs: readonly { readonly start: number; readonly members: readonly AxisMember[] }[];

    constructor(
        private readonly model: AxisModel,
        private readonly identity: (member: AxisMember) => Identity,
        private readonly member: (identity: Identity) => AxisMember,
    ) {
        this.fixedCount = model.fixed;
        this.sourceCount = model.source;
        this.live_members = model.order.filter((entry) => live(model, entry));
        this.liveCount = this.live_members.length;
        this.fullCount = model.order.length;
        this.bandCount = model.band.length;
        const source_order = Array.from({ length: model.source }, (_, index) => model.fixed + index + 1);
        this.hasLiveChange = this.live_members.length !== source_order.length
            || this.live_members.some((entry, index) => entry !== source_order[index]);
        const runs: { start: number; members: AxisMember[] }[] = [];
        let previous: AxisMember | undefined;
        for (const entry of model.order) {
            if (typeof entry === 'number') {
                if (typeof previous === 'number' && entry === previous + 1) {
                    runs[runs.length - 1].members.push(entry);
                } else {
                    runs.push({ start: entry, members: [entry] });
                }
            }
            previous = entry;
        }
        this.runs = runs;
        this.hasInsertOrOutOfOrderRun = this.live_members.some((entry) => typeof entry === 'string')
            || runs.some((run, index) => index > 0 && runs[index - 1].start > run.start);
    }

    position_of(identity: Identity): number | undefined {
        const member = this.member(identity);
        const index = this.model.order.indexOf(member);
        if (index >= 0) return index;
        const band = this.model.band.indexOf(member as string);
        return band >= 0 ? this.fullCount + band : undefined;
    }

    is_live(position: number): boolean {
        return position >= this.fullCount || live(this.model, this.model.order[position]);
    }

    prospective_number(position: number): number {
        if (position >= this.fullCount) {
            return this.fixedCount + this.liveCount + position - this.fullCount + 1;
        }
        return this.fixedCount + this.live_members.indexOf(this.model.order[position]) + 1;
    }

    first_live(first: number, last: number): number | undefined {
        for (let position = first; position <= last; position++) {
            if (this.is_live(position)) return position;
        }
        return undefined;
    }

    last_live(first: number, last: number): number | undefined {
        for (let position = last; position >= first; position--) {
            if (this.is_live(position)) return position;
        }
        return undefined;
    }

    identity_at(number: number): Identity | undefined {
        const index = number - this.fixedCount - 1;
        if (index < 0) return undefined;
        if (index < this.liveCount) return this.identity(this.live_members[index]);
        const band = index - this.liveCount;
        return band < this.bandCount ? this.identity(this.model.band[band]) : undefined;
    }

    in_displaced_run(identity: Identity): boolean {
        const member = this.member(identity);
        const index = this.runs.findIndex((run) => run.members.includes(member));
        if (index < 0) return false;
        const run = this.runs[index];
        return (index > 0 && this.runs[index - 1].start > run.start)
            || (index + 1 < this.runs.length && this.runs[index + 1].start < run.start);
    }
}

export function row_axis(model: AxisModel): AnchorAxisView<RowIdentity> {
    return new ArrayAnchorAxis<RowIdentity>(
        model,
        (member) => typeof member === 'number'
            ? { kind: 'source', sourceRow: member - 1 }
            : { kind: 'pending', pendingRowId: member },
        (identity) => identity.kind === 'source' ? identity.sourceRow + 1 : identity.pendingRowId,
    );
}

export function column_axis(model: AxisModel): AnchorAxisView<ColumnIdentity> {
    return new ArrayAnchorAxis<ColumnIdentity>(
        model,
        (member) => typeof member === 'number'
            ? { kind: 'source', sourceColumn: member - 1 }
            : { kind: 'pending', pendingColumnId: member },
        (identity) => identity.kind === 'source' ? identity.sourceColumn + 1 : identity.pendingColumnId,
    );
}

export interface SheetModel {
    readonly name: string;
    readonly rows: AxisModel;
    readonly columns: AxisModel;
}

export function sheet(
    name: string,
    rows: AxisModel,
    columns: AxisModel = axis_model(0, 26),
): SheetModel {
    return { name, rows, columns };
}

export function anchor_context(
    sheets: readonly SheetModel[],
    formula_worksheet = 0,
    format: FormulaAnchorContext['format'] = 'xlsx',
): FormulaAnchorContext {
    return {
        format,
        formulaWorksheet: formula_worksheet,
        worksheets: sheets.map((entry, index): AnchorWorksheet => ({
            target: { sheetIndex: index, sheetName: entry.name },
            name: entry.name,
            rows: row_axis(entry.rows),
            columns: column_axis(entry.columns),
        })),
    };
}
