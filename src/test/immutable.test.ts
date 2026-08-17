import { describe, expect, it } from 'vitest';
import { deep_clone_and_freeze } from '../immutable';

describe('immutable structured data', () => {
    it('clones nested records and arrays before recursively freezing them', () => {
        const source = {
            records: [{ values: ['a', 'b'] }],
            mapping: { key: { enabled: false } },
        };
        const copy = deep_clone_and_freeze(source);

        source.records[0].values[0] = 'changed';
        source.mapping.key.enabled = true;

        expect(copy).toEqual({
            records: [{ values: ['a', 'b'] }],
            mapping: { key: { enabled: false } },
        });
        expect(Object.isFrozen(copy)).toBe(true);
        expect(Object.isFrozen(copy.records[0].values)).toBe(true);
        expect(Object.isFrozen(copy.mapping.key)).toBe(true);
    });
});
