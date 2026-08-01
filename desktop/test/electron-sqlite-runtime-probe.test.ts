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

let v1_contract_for_platform: (platform: string) => string;
let assert_v1_refusal: (error: unknown, databaseCreated: boolean) => Record<string, unknown>;

beforeAll(async () => {
    ({ v1_contract_for_platform, assert_v1_refusal } = await import(probe_specifier));
});

const refusal = () => new SqliteFileStateError('unsupported', { operation: 'directory-durability' });

describe('electron sqlite runtime probe v1 contract', () => {
    it('requires an installed database everywhere a directory flush is proven', () => {
        for (const platform of ['darwin', 'linux', 'freebsd']) {
            expect(v1_contract_for_platform(platform)).toBe('installed');
        }
    });

    it('requires the fail-closed refusal on win32', () => {
        expect(v1_contract_for_platform('win32')).toBe('fail-closed');
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
        expect(() => assert_v1_refusal(undefined, true)).toThrow(/no proven directory-flush/);
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
