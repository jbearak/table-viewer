import { describe, expect, it } from 'vitest';
import {
    current_structural_basis,
    STRUCTURE_NOT_AVAILABLE_YET,
    structural_editing_capability,
} from '../structural-editing-capability';
import { TOO_WIDE_TO_RESTRUCTURE_MESSAGE } from '../worksheet-layout';

const observation = { digest: 'abc', byteLength: 12 };
const sheet = { sourceRowCount: 5, columnCount: 3 };

describe('current_structural_basis', () => {
    it('describes a delimited file by its bytes and the worksheet counts', () => {
        expect(current_structural_basis('csv', observation, sheet)).toEqual({
            kind: 'delimited',
            byteLength: 12,
            digest: 'abc',
            sourceRowCount: 5,
            sourceColumnCount: 3,
        });
        expect(current_structural_basis('tsv', observation, sheet)?.kind).toBe('delimited');
    });

    it('has none for .xlsx yet, or without a byte length', () => {
        expect(current_structural_basis('xlsx', observation, sheet)).toBeUndefined();
        expect(current_structural_basis('csv', { digest: 'abc' }, sheet)).toBeUndefined();
        expect(current_structural_basis('csv', undefined, sheet)).toBeUndefined();
    });
});

describe('structural_editing_capability', () => {
    it('reports every .xlsx worksheet unsupported on both axes with "Not available yet"', () => {
        const unsupported = { supported: false, reason: STRUCTURE_NOT_AVAILABLE_YET };
        expect(STRUCTURE_NOT_AVAILABLE_YET).toBe('Not available yet');
        expect(structural_editing_capability('xlsx', observation, [sheet, sheet])).toEqual({
            sheets: [
                { rows: unsupported, columns: unsupported },
                { rows: unsupported, columns: unsupported },
            ],
        });
    });

    it('refuses columns on a delimited source wider than Table Viewer can restructure', () => {
        const [wide] = structural_editing_capability('csv', observation, [{ sourceRowCount: 1, columnCount: 300 }]).sheets;
        expect(wide.rows).toEqual({ supported: true });
        expect(wide.columns).toEqual({ supported: false, reason: TOO_WIDE_TO_RESTRUCTURE_MESSAGE });
    });
});
