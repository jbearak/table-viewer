import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { activate, deactivate } from '../extension';
import { MIGRATION_ARMING_STATE_KEY } from '../migration-companion';
import * as physicalActivation from '../physical-edit-activation';
import * as sqliteArming from '../sqlite-migration-arming';

const ABSENT_ARMING_STATE = Symbol('absent arming state');
const vscodeMock = vscode as unknown as {
    __hasCommand(command: string): boolean;
    __setCommand(command: string, handler: (...args: unknown[]) => unknown): void;
};

async function poll_for(predicate: () => boolean, description: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}.`);
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
}

function mark_after_abort(signal: AbortSignal | undefined, mark: () => void): void {
    if (!signal) throw new Error('Expected lifecycle-owned work to receive an AbortSignal.');
    const mark_after_current_teardown_turn = () => { queueMicrotask(mark); };
    signal.addEventListener('abort', mark_after_current_teardown_turn, { once: true });
    if (signal.aborted) mark_after_current_teardown_turn();
}

function observe_owned_task_drain(): () => boolean {
    const allSettled = vi.spyOn(Promise, 'allSettled');
    return () => allSettled.mock.calls.some(
        ([tasks]) => Array.isArray(tasks) && tasks.length === 1,
    );
}

function context(
    armingState: unknown | typeof ABSENT_ARMING_STATE = { invalid: true },
): vscode.ExtensionContext {
    const values = new Map<string, unknown>([['tableViewer.fileState', {}]]);
    if (armingState !== ABSENT_ARMING_STATE) values.set(MIGRATION_ARMING_STATE_KEY, armingState);
    return {
        extension: {
            packageJSON: { version: '0.7.0' },
            extensionKind: vscode.ExtensionKind.Workspace,
        },
        extensionUri: vscode.Uri.file('/extension'),
        globalStorageUri: vscode.Uri.file('/profile/table-viewer'),
        globalState: {
            get(key: string, fallback?: unknown) {
                return values.has(key) ? values.get(key) : fallback;
            },
            async update(key: string, value: unknown) {
                values.set(key, value);
            },
        },
        subscriptions: [],
    } as unknown as vscode.ExtensionContext;
}

beforeEach(async () => {
    await deactivate();
    (vscode as unknown as { __reset(): void }).__reset();
    vi.restoreAllMocks();
});

describe('extension activation during SQLite cold-boundary recovery', () => {
    it('drains an initial boundary that resolves after deactivation without registering commands', async () => {
        let resolveBoundary!: (value: physicalActivation.PhysicalEditActivationBoundary) => void;
        const drain = vi.fn(async () => undefined);
        vi.spyOn(physicalActivation, 'create_physical_edit_activation_boundary').mockImplementation(() => (
            new Promise((resolve) => { resolveBoundary = resolve; })
        ));
        const activation = activate(context(ABSENT_ARMING_STATE));

        await deactivate();
        resolveBoundary({
            store: {} as never,
            viewOnly: false,
            markerStatus: 'unarmed',
            enter_view_only: vi.fn(async () => undefined),
            drain,
        });
        await activation;

        expect(drain).toHaveBeenCalledTimes(1);
        expect(vscodeMock.__hasCommand('tableViewer.openCsvTable')).toBe(false);
        const openWith = vi.fn();
        vscodeMock.__setCommand('vscode.openWith', openWith);
        await vscode.commands.executeCommand('tableViewer.openCsvTable', vscode.Uri.file('/workspace/stale.csv'));
        expect(openWith).not.toHaveBeenCalled();
    });

    it('awaits owned cold-start work before deactivation completes', async () => {
        let resolveCold!: (value: sqliteArming.ColdArmingResult) => void;
        const cold = new Promise<sqliteArming.ColdArmingResult>((resolve) => { resolveCold = resolve; });
        let teardownReachedCold = false;
        vi.spyOn(sqliteArming, 'evaluate_sqlite_migration_cold_start').mockImplementation(
            (_context, _isActive, signal) => {
                mark_after_abort(signal, () => { teardownReachedCold = true; });
                return cold;
            },
        );

        await activate(context(ABSENT_ARMING_STATE));
        const ownedTaskDrainReached = observe_owned_task_drain();
        let settled = false;
        const teardown = deactivate().then(() => { settled = true; });
        await poll_for(
            () => teardownReachedCold && ownedTaskDrainReached(),
            'cold-start owned-work drain',
        );
        expect(settled).toBe(false);

        resolveCold({ blocksStateWriters: false, phase: 'unarmed' });
        await teardown;
        expect(settled).toBe(true);
    });

    it('registers the viewer and commands without awaiting a cold-start modal', async () => {
        vi.spyOn(vscode.window, 'showErrorMessage').mockImplementation(() => new Promise(() => undefined));
        const openWith = vi.fn();
        vscodeMock.__setCommand('vscode.openWith', openWith);

        await activate(context());
        expect(vscodeMock.__hasCommand('tableViewer.openCsvTable')).toBe(true);
        const resource = vscode.Uri.file('/workspace/example.csv');
        await vscode.commands.executeCommand('tableViewer.openCsvTable', resource);

        expect(openWith).toHaveBeenCalledWith(resource, 'tableViewer.editor');
        await deactivate();
        expect(vscodeMock.__hasCommand('tableViewer.openCsvTable')).toBe(false);
    });

    it('awaits an owned arming operation before deactivation completes', async () => {
        let resolveArming!: (value: boolean) => void;
        const arming = new Promise<boolean>((resolve) => { resolveArming = resolve; });
        let teardownReachedArming = false;
        const prepare = vi.spyOn(sqliteArming, 'prepare_sqlite_migration_arming')
            .mockImplementation((_context, _boundary, _stopViewers, _isActive, signal) => {
                mark_after_abort(signal, () => { teardownReachedArming = true; });
                return arming;
            });
        await activate(context(ABSENT_ARMING_STATE));

        const command = vscode.commands.executeCommand('tableViewer.armSqliteMigration');
        await poll_for(
            () => prepare.mock.calls.length > 0,
            'arming command dispatch',
        );
        const ownedTaskDrainReached = observe_owned_task_drain();
        let settled = false;
        const teardown = deactivate().then(() => { settled = true; });
        await poll_for(
            () => teardownReachedArming && ownedTaskDrainReached(),
            'arming-operation owned-work drain',
        );
        expect(settled).toBe(false);

        resolveArming(false);
        await expect(Promise.all([command, teardown])).resolves.toEqual([undefined, undefined]);
        expect(settled).toBe(true);
    });

    it('awaits an owned physical-edit setup operation before deactivation completes', async () => {
        let resolveSetup!: (value: boolean) => void;
        const setup = new Promise<boolean>((resolve) => { resolveSetup = resolve; });
        let teardownReachedSetup = false;
        const runSetup = vi.spyOn(physicalActivation, 'run_physical_edit_protocol_setup')
            .mockImplementation((_marker, _boundary, _stopViewers, _isActive, signal) => {
                mark_after_abort(signal, () => { teardownReachedSetup = true; });
                return setup;
            });
        await activate(context(ABSENT_ARMING_STATE));

        const command = vscode.commands.executeCommand('tableViewer.setupPhysicalEditProtocol');
        await poll_for(
            () => runSetup.mock.calls.length > 0,
            'physical-edit setup command dispatch',
        );
        expect(runSetup.mock.calls[0]?.[4]).toBeInstanceOf(AbortSignal);
        const ownedTaskDrainReached = observe_owned_task_drain();
        let settled = false;
        const teardown = deactivate().then(() => { settled = true; });
        await poll_for(
            () => teardownReachedSetup && ownedTaskDrainReached(),
            'physical-edit setup owned-work drain',
        );
        expect(settled).toBe(false);

        resolveSetup(false);
        await expect(Promise.all([command, teardown])).resolves.toEqual([undefined, undefined]);
        expect(settled).toBe(true);
    });

    it('shares one arming transaction between concurrent migration commands', async () => {
        vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);
        let resolveWarning!: (value: undefined) => void;
        const warningResponse = new Promise<undefined>((resolve) => { resolveWarning = resolve; });
        const warning = vi.spyOn(vscode.window, 'showWarningMessage').mockReturnValue(warningResponse as never);
        const prepare = vi.spyOn(sqliteArming, 'prepare_sqlite_migration_arming');
        await activate(context(ABSENT_ARMING_STATE));

        const first = vscode.commands.executeCommand('tableViewer.armSqliteMigration');
        const second = vscode.commands.executeCommand('tableViewer.upgradeToSqlitePersistence');
        await poll_for(
            () => warning.mock.calls.length > 0,
            'shared arming warning dispatch',
        );
        expect(warning).toHaveBeenCalledTimes(1);
        resolveWarning(undefined);
        await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
        expect(warning).toHaveBeenCalledTimes(1);
        expect(prepare).toHaveBeenCalledTimes(1);
        await deactivate();
    });
});
