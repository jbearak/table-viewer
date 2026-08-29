import { describe, expect, it } from 'vitest';
import {
    dirty_keys_with_move_closure,
    dirty_move_component_sizes,
    latest_dirty_value_edit_order,
    latest_dirty_move_source_orders,
    type CsvDirtyEntry,
} from '../types';

describe('dirty move index', () => {
    const pending: readonly (readonly [string, CsvDirtyEntry])[] = [
        ['0:0', { value: 'refill', base: 'source', valueEditOrder: 3 }],
        ['0:1', {
            value: 'source',
            base: 'destination',
            movedFrom: { row: 0, col: 0, order: 2 },
            valueEditOrder: 2,
        }],
        ['9:9', { value: 'independent', base: '' }],
    ];

    it('indexes source orders and component sizes in one traversal each', () => {
        let source_iterations = 0;
        const source_entries = {
            *[Symbol.iterator]() {
                for (const entry of pending) {
                    source_iterations += 1;
                    yield entry;
                }
            },
        };
        expect(latest_dirty_move_source_orders(source_entries).get('0:0')).toBe(2);
        expect(source_iterations).toBe(pending.length);
        expect(latest_dirty_value_edit_order(pending)).toBe(3);

        let component_iterations = 0;
        const component_entries = {
            *[Symbol.iterator]() {
                for (const entry of pending) {
                    component_iterations += 1;
                    yield entry;
                }
            },
        };
        expect(dirty_move_component_sizes(component_entries)).toEqual(new Map([
            ['0:0', 2],
            ['0:1', 2],
            ['9:9', 1],
        ]));
        expect(component_iterations).toBe(pending.length);
    });

    it('returns only dirty cells while traversing move coordinates', () => {
        const entries: readonly (readonly [string, CsvDirtyEntry])[] = [[
            '0:1',
            {
                value: 'source',
                base: 'destination',
                movedFrom: { row: 0, col: 0, order: 2 },
                valueEditOrder: 2,
            },
        ]];

        expect(dirty_keys_with_move_closure(entries, new Set(['0:1'])))
            .toEqual(new Set(['0:1']));
        expect(dirty_move_component_sizes(entries).get('0:1')).toBe(1);
    });
});
