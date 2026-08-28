import { describe, expect, it } from 'vitest';
import {
    build_formula_dependency_index,
    transitive_formula_dependents,
} from '../formula-dependencies';

describe('transitive_formula_dependents', () => {
    it('walks direct references, ranges, and recursive chains', () => {
        const index = build_formula_dependency_index([
            [0, 1, 0, 0, 0, 0],
            [0, 2, 0, 1, 0, 1],
            [0, 3, 4, 0, 8, 2],
            [0, 4, 0, 9, 0, 9],
        ]);

        expect(transitive_formula_dependents(index, ['0:0']))
            .toEqual(new Set(['0:1', '0:2']));
        expect(transitive_formula_dependents(index, ['6:1']))
            .toEqual(new Set(['0:3']));
        expect(transitive_formula_dependents(index, ['0:8'])).toEqual(new Set());
    });

    it('terminates formula cycles', () => {
        const index = build_formula_dependency_index([
            [0, 0, 0, 1, 0, 1],
            [0, 1, 0, 0, 0, 0],
        ]);
        expect(transitive_formula_dependents(index, ['0:0']))
            .toEqual(new Set(['0:1', '0:0']));
    });
});
