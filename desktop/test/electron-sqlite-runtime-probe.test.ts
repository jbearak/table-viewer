import { existsSync } from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { SqliteFileStateError } from '../../src/sqlite-file-state-errors';

// The probe module is an Electron main-process entry point: importing it runs
// `main()`, which awaits `app.whenReady()`. A promise that never settles parks
// that entry point forever, so the module's exported helpers can be unit-tested
// without the probe itself running (and without any Electron runtime present).
vi.mock('electron', () => ({
    app: { whenReady: () => new Promise(() => {}), exit: vi.fn() },
}));

// The probe ships as untyped .mjs (it is a build entry point, not a module in the
// desktop tsconfig project), so the specifier is held in a variable: that keeps the
// import out of the typechecker's declaration lookup while still binding the real
// implementation the bundle runs.
const probe_specifier = '../electron-sqlite-runtime-probe.mjs';

type DurabilityAssertion = (
    directory: string,
    fsyncDirectory: ((descriptor: number) => void) | undefined,
    platform: string,
) => void;

let v1_contract_for_platform: (
    platform?: string,
    assert?: DurabilityAssertion,
) => string;
let assert_v1_refusal: (error: unknown, databaseCreated: boolean) => Record<string, unknown>;

beforeAll(async () => {
    ({ v1_contract_for_platform, assert_v1_refusal } = await import(probe_specifier));
});

const refusal = () => new SqliteFileStateError('unsupported', { operation: 'directory-durability' });

describe('electron sqlite runtime probe v1 contract', () => {
    it('requires an installed database on every platform, win32 included', () => {
        // win32 is in this list deliberately. It used to be the fail-closed case,
        // and the assertion below is driven through the real production enforcer —
        // so if the platform were refused again this would fail here rather than
        // letting the probe assert a stale contract in CI.
        for (const platform of ['darwin', 'linux', 'freebsd', 'win32']) {
            expect(v1_contract_for_platform(platform)).toBe('installed');
        }
    });

    it('follows the production rule rather than a copy of its platform test', () => {
        // The drift check, stated as a test: a stand-in enforcer that declines
        // every platform must flip the contract on a platform the real rule
        // supports. A probe that had kept its own `platform === 'win32'` literal
        // would answer 'installed' here and go on asserting an install that
        // production no longer performs.
        const declines: DurabilityAssertion = () => {
            throw new SqliteFileStateError('unsupported', { operation: 'directory-durability' });
        };
        expect(v1_contract_for_platform('darwin', declines)).toBe('fail-closed');

        const allows: DurabilityAssertion = () => {};
        expect(v1_contract_for_platform('win32', allows)).toBe('installed');
    });

    it('is called exactly as production calls itself, on a real directory', () => {
        // The injected-capability path is production's test-only door. A probe
        // that passed a working `fsyncDirectory` through it would report a
        // contract no shipped build can honor, so the middle argument must stay
        // undefined — and the directory must be one that really exists, or the
        // assertion would fail for a reason unrelated to durability.
        const seen: Array<Parameters<DurabilityAssertion>> = [];
        // Existence is recorded *at call time*, not afterwards: production removes
        // the probe directory in its `finally`, so a check after the call is always
        // false and would hold even if production passed a path it never created.
        const existedWhenCalled: boolean[] = [];
        const record: DurabilityAssertion = (...args) => {
            existedWhenCalled.push(existsSync(args[0]));
            seen.push(args);
        };

        expect(v1_contract_for_platform('linux', record)).toBe('installed');

        expect(seen).toHaveLength(1);
        expect(seen[0][1]).toBeUndefined();
        expect(seen[0][2]).toBe('linux');
        expect(existedWhenCalled).toEqual([true]);
        // And cleaned up afterwards, so the probe leaves nothing behind.
        expect(existsSync(seen[0][0])).toBe(false);
    });

    it('never swallows a failure that is not a durability refusal', () => {
        // A refusal is `unsupported`; anything else is a real fault and must not
        // be reported as a platform contract. Reporting an EIO as 'fail-closed'
        // would be the relabeling the failure policy forbids, one layer up.
        const io: DurabilityAssertion = () => {
            throw new SqliteFileStateError('io', { operation: 'directory-durability' });
        };
        expect(() => v1_contract_for_platform('linux', io)).toThrow(SqliteFileStateError);
    });
});

// These cases are the only local coverage the Windows branch can get: CI runs it
// for real, but the branch must not be first exercised there.
describe('electron sqlite runtime probe fail-closed assertion', () => {
    it('accepts the exact production refusal with no database left behind', () => {
        expect(assert_v1_refusal(refusal(), false)).toEqual({
            contract: 'fail-closed',
            installed: false,
            refusedCategory: 'unsupported',
            refusedOperation: 'directory-durability',
            databaseCreated: false,
        });
    });

    it('fails when initialization succeeded instead of refusing', () => {
        expect(() => assert_v1_refusal(undefined, true)).toThrow(/directory flush was refused/);
    });

    it('fails when the refusal is not a SqliteFileStateError', () => {
        expect(() => assert_v1_refusal(new Error('boom'), false))
            .toThrow(/not SqliteFileStateError/);
    });

    it('fails when a different file-state category was raised', () => {
        expect(() => assert_v1_refusal(
            new SqliteFileStateError('io', { operation: 'directory-durability' }),
            false,
        )).toThrow(/category is io/);
    });

    it('fails when the unsupported error names a different operation', () => {
        expect(() => assert_v1_refusal(
            new SqliteFileStateError('unsupported', { operation: 'gate-directory-flush' }),
            false,
        )).toThrow(/operation is gate-directory-flush/);
    });

    it('fails when the refusal still left a database file behind', () => {
        expect(() => assert_v1_refusal(refusal(), true))
            .toThrow(/left a database file behind/);
    });
});
