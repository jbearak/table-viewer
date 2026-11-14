/**
 * The structure items a menu offers for rows or columns: Insert, Delete,
 * Restore, and Move, labelled for the selection, each enabled with its gesture
 * or disabled with the reason the gesture would give. The cell, row, and
 * column menus all take their structure items from here, so what they offer
 * and why they refuse can't differ between them or between the axes.
 *
 * Whether an item would succeed is the axis models' question
 * (`row_structure_menu_model`, `column_structure_menu_model`); the Move
 * shortcuts and drags ask those models too, through the move-item models.
 */

import type { PendingStructuralChanges, RowIdentity } from '../pending-changes';
import type { WorksheetStructuralSupport } from '../viewer-snapshot';
import type { ColumnIdentity, SourceInterval } from '../worksheet-layout';
import type { ActionMenuItem } from './context-menu';
import type { ProjectedColumn } from './column-projection';
import {
    column_structure_label,
    column_structure_menu_model,
    type ColumnStructureSelection,
} from './column-structure-model';
import type { RowSelectionRun, WorksheetStructureContext } from './pending-row-store';
import {
    row_structure_label,
    row_structure_menu_model,
    type RowStructureSelection,
} from './row-structure-model';

/** What a menu's structure items act on: rows or columns, resolved when the menu opened. */
export type StructureMenuTarget =
    | { readonly axis: 'rows'; readonly selection: RowStructureSelection }
    | { readonly axis: 'columns'; readonly selection: ColumnStructureSelection };

/** The worksheet's state as the grid renders it, the same for every menu. */
export interface StructureMenuState {
    readonly support: WorksheetStructuralSupport;
    /**
     * The grid accepts an edit now and structural admission is open: nothing
     * is being saved, replayed, or admitted by the host. While it is false,
     * every item on both axes says "Wait for the current change to finish."
     */
    readonly ready: boolean;
    readonly changes: PendingStructuralChanges;
    readonly context: WorksheetStructureContext;
    /** The display columns the grid shows now, for a column Move's displayed neighbor. */
    readonly columns: readonly ProjectedColumn[];
    /**
     * Why Append Row is unavailable now, for "Insert below" on the append
     * band's last row; absent when appending would be admitted.
     */
    readonly append_refusal?: string;
}

/**
 * The grid's structure gestures. Each re-checks admission and plans against
 * the store when it runs, so an item enabled when the menu opened still
 * refuses a gesture that has since become impossible.
 */
export interface StructureGestures {
    readonly insert_rows: (anchor: RowIdentity, side: 'before' | 'after', count: number) => unknown;
    /** "Insert below" on the append band's last row. */
    readonly append_rows: (count: number) => unknown;
    readonly delete_rows: (runs: readonly RowSelectionRun[]) => unknown;
    readonly restore_rows: (source_rows: readonly SourceInterval[]) => unknown;
    readonly move_rows: (identities: readonly RowIdentity[], before: RowIdentity | 'end') => unknown;
    readonly insert_columns: (anchor: ColumnIdentity, side: 'before' | 'after', count: number) => unknown;
    readonly delete_columns: (identities: readonly ColumnIdentity[]) => unknown;
    readonly restore_columns: (source_columns: readonly number[]) => unknown;
    readonly move_columns: (identities: readonly ColumnIdentity[], before: ColumnIdentity | 'end') => unknown;
}

/** One axis's structure items, in menu order. */
export interface StructureMenuItems {
    /** "Insert row above", "Insert row below"; or "Insert column left", "Insert column right". */
    readonly insert: readonly ActionMenuItem[];
    /** "Delete row(s)", then "Restore row(s)" when the selection includes a deleted one. */
    readonly delete: readonly ActionMenuItem[];
    /**
     * "Move rows up", "Move rows down"; or left and right. The cell menu
     * leaves these to the row numbers and column headers, where a drag moves too.
     */
    readonly move: readonly ActionMenuItem[];
}

/** The items' wording: the undo labels' counts, and a side or direction. */
const WORDS = {
    rows: { label: row_structure_label, plural: 'rows', before: 'above', after: 'below', back: 'up', forward: 'down' },
    columns: { label: column_structure_label, plural: 'columns', before: 'left', after: 'right', back: 'left', forward: 'right' },
} as const;

interface ItemModel {
    readonly enabled: boolean;
    readonly reason?: string;
}

function menu_item(label: string, model: ItemModel, act: (() => unknown) | undefined): ActionMenuItem {
    if (model.enabled && act !== undefined) return { label, on_click: () => { void act(); } };
    return {
        label,
        on_click: () => {},
        disabled: true,
        ...(model.reason === undefined ? {} : { disabled_reason: model.reason }),
    };
}

/**
 * The structure items for `target`: each enabled only when its gesture would
 * succeed now, otherwise disabled with the refusal that gesture would give.
 */
export function structure_menu_items(
    target: StructureMenuTarget,
    state: StructureMenuState,
    gestures: StructureGestures,
): StructureMenuItems {
    const words = WORDS[target.axis];
    const counted = (verb: 'Insert' | 'Delete' | 'Restore', count: number) => words.label(verb, Math.max(1, count));
    const move_label = (direction: 'back' | 'forward') => `Move ${words.plural} ${words[direction]}`;
    const shared = {
        ready: state.ready,
        changes: state.changes,
        context: state.context,
    };
    if (target.axis === 'rows') {
        const { selection } = target;
        const model = row_structure_menu_model({
            ...shared,
            support: state.support.rows,
            selection,
            ...(state.append_refusal === undefined ? {} : { appendRefusal: state.append_refusal }),
        });
        const insert = (item: typeof model.insertAbove, side: 'before' | 'after') => menu_item(
            `${counted('Insert', item.count)} ${words[side]}`,
            item,
            item.action === 'append'
                ? () => gestures.append_rows(Math.max(1, item.count))
                : item.anchor === undefined
                    ? undefined
                    : () => gestures.insert_rows(item.anchor!, side, Math.max(1, item.count)),
        );
        const move = (item: typeof model.moveUp, direction: 'back' | 'forward') => menu_item(
            move_label(direction),
            item,
            item.before === undefined || selection.identities === undefined
                ? undefined
                : () => gestures.move_rows(selection.identities!, item.before!),
        );
        return {
            insert: [insert(model.insertAbove, 'before'), insert(model.insertBelow, 'after')],
            delete: [
                menu_item(counted('Delete', model.delete.count), model.delete,
                    selection.runs === undefined ? undefined : () => gestures.delete_rows(selection.runs!)),
                ...(model.restore === undefined ? [] : [menu_item(
                    counted('Restore', model.restore.count),
                    model.restore,
                    () => gestures.restore_rows(selection.removedSourceRuns),
                )]),
            ],
            move: [move(model.moveUp, 'back'), move(model.moveDown, 'forward')],
        };
    }
    const { selection } = target;
    const model = column_structure_menu_model({
        ...shared,
        support: state.support.columns,
        selection,
        columns: state.columns,
    });
    const insert = (item: typeof model.insertLeft, side: 'before' | 'after') => menu_item(
        `${counted('Insert', item.count)} ${words[side]}`,
        item,
        item.anchor === undefined
            ? undefined
            : () => gestures.insert_columns(item.anchor!, side, Math.max(1, item.count)),
    );
    const move = (item: typeof model.moveLeft, direction: 'back' | 'forward') => menu_item(
        move_label(direction),
        item,
        item.before === undefined ? undefined : () => gestures.move_columns(selection.identities, item.before!),
    );
    return {
        insert: [insert(model.insertLeft, 'before'), insert(model.insertRight, 'after')],
        delete: [
            menu_item(counted('Delete', model.delete.count), model.delete,
                () => gestures.delete_columns(selection.identities)),
            ...(model.restore === undefined ? [] : [menu_item(
                counted('Restore', model.restore.count),
                model.restore,
                () => gestures.restore_columns(selection.removedSourceColumns),
            )]),
        ],
        move: [move(model.moveLeft, 'back'), move(model.moveRight, 'forward')],
    };
}
