import { describe, expect, it, vi } from 'vitest';
import type { DataSource } from '../data-source/interface';
import {
    SourceCandidate,
    same_physical_observation,
    type PhysicalSourceObservation,
} from '../source-candidate';

function source(close = vi.fn()): DataSource {
    return {
        meta: () => ({ sheets: [], hasFormatting: false }),
        read_rows: () => ({ startRow: 0, rows: [] }),
        close,
    };
}

function candidate(ds: DataSource): SourceCandidate {
    return new SourceCandidate(ds, { fingerprint: '1:2', digest: 'digest' });
}

describe('SourceCandidate', () => {
    it('disposes an owned source exactly once', () => {
        const close = vi.fn();
        const owned = candidate(source(close));

        owned.dispose();
        owned.dispose();

        expect(close).toHaveBeenCalledTimes(1);
    });

    it('transfers ownership once and makes later disposal inert', () => {
        const close = vi.fn();
        const ds = source(close);
        const owned = candidate(ds);

        expect(owned.take()).toBe(ds);
        owned.dispose();

        expect(close).not.toHaveBeenCalled();
        expect(() => owned.take()).toThrow('Cannot take a transferred source candidate.');
    });

    it('keeps ownership when an installer refuses or throws before confirmation', () => {
        const close = vi.fn();
        const owned = candidate(source(close));

        expect(owned.transfer_to(() => {})).toBe(false);
        expect(owned.borrow()).toBeDefined();
        expect(() => owned.transfer_to(() => { throw new Error('install failed'); }))
            .toThrow('install failed');
        owned.dispose();

        expect(close).toHaveBeenCalledTimes(1);
    });

    it('transfers atomically and retains transfer when later cleanup throws', () => {
        const close = vi.fn();
        const owned = candidate(source(close));

        expect(() => owned.transfer_to((_source, confirm) => {
            expect(() => owned.borrow()).toThrow(
                'Cannot borrow a transferring source candidate.',
            );
            confirm();
            throw new Error('old source close failed');
        })).toThrow('old source close failed');
        owned.dispose();

        expect(close).not.toHaveBeenCalled();
        expect(() => owned.take()).toThrow('Cannot take a transferred source candidate.');
    });

    it('rejects duplicate transfer confirmation', () => {
        const owned = candidate(source());

        expect(() => owned.transfer_to((_source, confirm) => {
            confirm();
            confirm();
        })).toThrow('The source candidate transfer was already confirmed.');
        expect(() => owned.borrow()).toThrow(
            'Cannot borrow a transferred source candidate.',
        );
    });

    it('permits borrowing only while owned', () => {
        const first = candidate(source());
        expect(first.borrow()).toBeDefined();
        first.dispose();
        expect(() => first.borrow()).toThrow('Cannot borrow a disposed source candidate.');

        const second = candidate(source());
        second.take();
        expect(() => second.borrow()).toThrow('Cannot borrow a transferred source candidate.');
    });

    it('stays unambiguously disposed when close throws', () => {
        const close = vi.fn(() => { throw new Error('close failed'); });
        const owned = candidate(source(close));

        expect(() => owned.dispose()).toThrow('close failed');
        expect(() => owned.dispose()).not.toThrow();
        expect(() => owned.borrow()).toThrow('Cannot borrow a disposed source candidate.');
        expect(() => owned.take()).toThrow('Cannot take a disposed source candidate.');
        expect(close).toHaveBeenCalledTimes(1);
    });

    it('freezes a copied physical observation', () => {
        const observation = { fingerprint: '1:2', digest: 'digest' };
        const owned = new SourceCandidate(source(), observation);
        observation.digest = 'changed';

        expect(owned.observation).toEqual({ fingerprint: '1:2', digest: 'digest' });
        expect(Object.isFrozen(owned.observation)).toBe(true);
    });
});

describe('same_physical_observation', () => {
    const observation = (overrides: Partial<PhysicalSourceObservation> = {}): PhysicalSourceObservation => ({
        fingerprint: '1:2',
        digest: 'digest',
        byteLength: 2,
        verification: 'bracketedDigest',
        comparisonFingerprint: '3:4',
        comparisonDigest: 'comparison',
        ...overrides,
    });
    const structure = {} as NonNullable<PhysicalSourceObservation['xlsxStructure']>;

    it('is the same object', () => {
        const one = observation();
        expect(same_physical_observation(one, one)).toBe(true);
    });

    it('is another object that says the same of the same bytes', () => {
        expect(same_physical_observation(observation(), observation())).toBe(true);
        expect(same_physical_observation(
            { fingerprint: '1:2', digest: 'digest' },
            { fingerprint: '1:2', digest: 'digest' },
        )).toBe(true);
    });

    it.each([
        ['fingerprint', { fingerprint: '9:2' }],
        ['digest', { digest: 'other' }],
        ['byteLength', { byteLength: 3 }],
        ['verification', { verification: undefined }],
        ['comparisonFingerprint', { comparisonFingerprint: '9:4' }],
        ['comparisonDigest', { comparisonDigest: 'other' }],
    ] as const)('is not one whose %s differs', (_field, overrides) => {
        expect(same_physical_observation(observation(), observation(overrides))).toBe(false);
        expect(same_physical_observation(observation(overrides), observation())).toBe(false);
    });

    it('compares the structural scan by whether there is one', () => {
        expect(same_physical_observation(
            observation({ xlsxStructure: structure }),
            observation({ xlsxStructure: { ...structure } }),
        )).toBe(true);
        expect(same_physical_observation(observation({ xlsxStructure: structure }), observation())).toBe(false);
        expect(same_physical_observation(observation(), observation({ xlsxStructure: structure }))).toBe(false);
    });

    it('is none against one, and none against none', () => {
        expect(same_physical_observation(undefined, observation())).toBe(false);
        expect(same_physical_observation(observation(), undefined)).toBe(false);
        expect(same_physical_observation(undefined, undefined)).toBe(true);
    });
});
