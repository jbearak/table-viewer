import { describe, expect, it } from 'vitest';
import { deep_clone_and_freeze, is_deeply_frozen } from '../immutable';

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

describe('is_deeply_frozen', () => {
    it('accepts what deep_clone_and_freeze produced', () => {
        expect(is_deeply_frozen(deep_clone_and_freeze({ a: [{ b: 'c' }] }))).toBe(true);
    });

    it('accepts primitives and null', () => {
        expect(is_deeply_frozen('text')).toBe(true);
        expect(is_deeply_frozen(0)).toBe(true);
        expect(is_deeply_frozen(null)).toBe(true);
        expect(is_deeply_frozen(undefined)).toBe(true);
    });

    it('rejects an unfrozen object', () => {
        expect(is_deeply_frozen({ a: 1 })).toBe(false);
    });

    it('rejects a frozen wrapper around mutable innards', () => {
        // The case a shallow Object.isFrozen would wave through, and the reason
        // this function exists: retaining it leaves the caller able to change
        // what the holder later reads.
        expect(is_deeply_frozen(Object.freeze({ inner: { a: 1 } }))).toBe(false);
        expect(is_deeply_frozen(Object.freeze({ items: [1, 2] }))).toBe(false);
    });

    it('rejects a frozen array holding an unfrozen element', () => {
        expect(is_deeply_frozen(Object.freeze([Object.freeze({ a: 1 }), { b: 2 }]))).toBe(false);
    });

    it('terminates on a frozen cycle', () => {
        const cyclic: { self?: unknown } = {};
        cyclic.self = cyclic;
        Object.freeze(cyclic);
        expect(is_deeply_frozen(cyclic)).toBe(true);
    });
});
