import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
    create_physical_edit_activation_boundary,
    PhysicalEditProtocolMarker,
    run_physical_edit_protocol_setup,
    type PhysicalEditProtocolStatus,
} from '../physical-edit-activation';

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

function marker(status: PhysicalEditProtocolStatus) {
    return {
        status: async () => status,
        install: async () => {},
    } as never;
}

function context() {
    let envelope: unknown = {};
    const update = vi.fn(async (_key: string, value: unknown) => { envelope = value; });
    return {
        context: {
            globalState: {
                get: (_key: string, fallback: unknown) => envelope ?? fallback,
                update,
            },
        } as unknown as vscode.ExtensionContext,
        update,
    };
}

describe('physical edit activation boundary', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('uses only ephemeral state after an armed marker', async () => {
        const fixture = context();
        const boundary = await create_physical_edit_activation_boundary(
            fixture.context,
            marker('armed'),
        );

        const current = await boundary.store.read('/tmp/table.csv');
        const result = await boundary.store.compare_and_set(
            '/tmp/table.csv',
            current.revision,
            { columnWidths: [{ 0: 120 }] },
        );
        await boundary.drain();

        expect(result.type).toBe('committed');
        expect(boundary.viewOnly).toBe(true);
        expect(fixture.update).not.toHaveBeenCalled();
    });

    it.skipIf(process.getuid?.() === 0)(
        'preserves Memento editing without creating an absent coordination root', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-activation-missing-'));
        const parent = path.join(directory, 'unwritable-parent');
        const root = path.join(parent, 'missing', 'physical-locks');
        fs.mkdirSync(parent, { mode: 0o500 });
        try {
            const fixture = context();
            const boundary = await create_physical_edit_activation_boundary(
                fixture.context,
                new PhysicalEditProtocolMarker(root),
            );

            expect(boundary.markerStatus).toBe('unarmed');
            expect(boundary.viewOnly).toBe(false);
            const current = await boundary.store.read('/tmp/pre-marker.csv');
            await boundary.store.compare_and_set(
                '/tmp/pre-marker.csv',
                current.revision,
                { columnWidths: [{ 0: 120 }] },
            );

            expect(fixture.update).toHaveBeenCalledTimes(1);
            expect(fs.existsSync(root)).toBe(false);
        } finally {
            fs.chmodSync(parent, 0o700);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('drains durable work before switching later writes to ephemeral state', async () => {
        const fixture = context();
        const boundary = await create_physical_edit_activation_boundary(
            fixture.context,
            marker('unarmed'),
        );

        let current = await boundary.store.read('/tmp/table.csv');
        await boundary.store.compare_and_set(
            '/tmp/table.csv', current.revision, { columnWidths: [{ 0: 120 }] });
        expect(fixture.update).toHaveBeenCalledTimes(1);

        await boundary.enter_view_only();
        current = await boundary.store.read('/tmp/table.csv');
        await boundary.store.compare_and_set(
            '/tmp/table.csv', current.revision, { columnWidths: [{ 0: 240 }] });
        await boundary.drain();

        expect(boundary.viewOnly).toBe(true);
        expect(fixture.update).toHaveBeenCalledTimes(1);
    });

    it('keeps selecting durable state until the transition drain has settled', async () => {
        let envelope: unknown = {};
        const write_started = deferred();
        const write_gate = deferred();
        const update = vi.fn(async (_key: string, value: unknown) => {
            write_started.resolve();
            await write_gate.promise;
            envelope = value;
        });
        const boundary = await create_physical_edit_activation_boundary({
            globalState: {
                get: (_key: string, fallback: unknown) => envelope ?? fallback,
                update,
            },
        } as unknown as vscode.ExtensionContext, marker('unarmed'));

        const first = await boundary.store.read('/tmp/first.csv');
        const second = await boundary.store.read('/tmp/second.csv');
        const first_write = boundary.store.compare_and_set(
            '/tmp/first.csv', first.revision, { columnWidths: [{ 0: 120 }] });
        await write_started.promise;

        const transition = boundary.enter_view_only();
        expect(boundary.viewOnly).toBe(false);
        const second_write = boundary.store.compare_and_set(
            '/tmp/second.csv', second.revision, { columnWidths: [{ 0: 240 }] });
        expect(update).toHaveBeenCalledTimes(1);

        write_gate.resolve();
        await Promise.all([first_write, second_write, transition]);
        expect(boundary.viewOnly).toBe(true);
        expect(update).toHaveBeenCalledTimes(2);
    });

    it('drains into the same fail-closed state when the marker is already armed', async () => {
        const events: string[] = [];
        vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
        const boundary = {
            store: {} as never,
            viewOnly: true,
            markerStatus: 'armed' as const,
            enter_view_only: async () => { events.push('view-only'); },
            drain: async () => { events.push('drain'); },
        };

        await expect(run_physical_edit_protocol_setup(
            marker('armed') as never,
            boundary,
            () => { events.push('stop-viewers'); },
        )).resolves.toBe(true);

        expect(events).toEqual(['stop-viewers', 'drain', 'view-only']);
    });

    it('drains renderer-only pending edits durably for a runtime-invalid marker', async () => {
        let envelope: unknown = {};
        const flush_started = deferred();
        const release_renderer_flush = deferred();
        const phases_at_memento_write: boolean[] = [];
        let boundary!: Awaited<ReturnType<typeof create_physical_edit_activation_boundary>>;
        const update = vi.fn(async (_key: string, value: unknown) => {
            phases_at_memento_write.push(boundary.viewOnly);
            envelope = value;
        });
        boundary = await create_physical_edit_activation_boundary({
            globalState: {
                get: (_key: string, fallback: unknown) => envelope ?? fallback,
                update,
            },
        } as unknown as vscode.ExtensionContext, marker('unarmed'));
        vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);

        const setup = run_physical_edit_protocol_setup(
            marker('invalid') as never,
            boundary,
            async () => {
                // This models an edit that exists only in the renderer when admission
                // is fenced and reaches the controller during the close handshake.
                flush_started.resolve();
                await release_renderer_flush.promise;
                const current = await boundary.store.read('/tmp/renderer-only.csv');
                await boundary.store.compare_and_set(
                    '/tmp/renderer-only.csv',
                    current.revision,
                    { columnWidths: [{ 0: 180 }] },
                );
            },
        );
        await flush_started.promise;

        expect(boundary.viewOnly).toBe(false);
        expect(update).not.toHaveBeenCalled();
        release_renderer_flush.resolve();
        await expect(setup).resolves.toBe(false);

        expect(update).toHaveBeenCalledTimes(1);
        expect(phases_at_memento_write).toEqual([false]);
        expect(boundary.viewOnly).toBe(true);
    });

    it('keeps durable storage selected and does not install when viewer flush fails', async () => {
        const fixture = context();
        const boundary = await create_physical_edit_activation_boundary(
            fixture.context,
            marker('unarmed'),
        );
        const install = vi.fn(async () => {});
        vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(
            'I Attest All Other Products Are Closed and Updated' as never,
        );

        await expect(run_physical_edit_protocol_setup(
            {
                status: async () => 'unarmed' as const,
                install,
            } as never,
            boundary,
            async () => { throw new Error('renderer flush failed'); },
        )).rejects.toThrow('renderer flush failed');

        expect(boundary.viewOnly).toBe(false);
        expect(install).not.toHaveBeenCalled();
        const current = await boundary.store.read('/tmp/still-durable.csv');
        await boundary.store.compare_and_set(
            '/tmp/still-durable.csv',
            current.revision,
            { columnWidths: [{ 0: 120 }] },
        );
        expect(fixture.update).toHaveBeenCalledTimes(1);
    });

    it('fails closed without aborting boundary creation for an invalid marker', async () => {
        const fixture = context();
        const boundary = await create_physical_edit_activation_boundary(
            fixture.context,
            marker('invalid'),
        );

        expect(boundary.markerStatus).toBe('invalid');
        expect(boundary.viewOnly).toBe(true);
        const current = await boundary.store.read('/tmp/table.csv');
        await boundary.store.compare_and_set(
            '/tmp/table.csv', current.revision, { columnWidths: [{ 0: 120 }] });
        await boundary.drain();
        expect(fixture.update).not.toHaveBeenCalled();
    });

    it('refuses protocol arming in a remote extension host before draining', async () => {
        const events: string[] = [];
        const previous_remote = vscode.env.remoteName;
        (vscode.env as { remoteName?: string }).remoteName = 'ssh-remote';
        vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);
        try {
            const result = await run_physical_edit_protocol_setup(
                marker('unarmed') as never,
                {
                    store: {} as never,
                    viewOnly: false,
                    markerStatus: 'unarmed',
                    enter_view_only: async () => { events.push('view-only'); },
                    drain: async () => { events.push('drain'); },
                },
                () => { events.push('stop-viewers'); },
            );
            expect(result).toBe(false);
            expect(events).toEqual([]);
            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
                expect.stringContaining('local VS Code window'),
            );
        } finally {
            (vscode.env as { remoteName?: string }).remoteName = previous_remote;
        }
    });

    it('keeps an invalid marker view-only and provides recovery guidance', async () => {
        vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);
        const events: string[] = [];
        const result = await run_physical_edit_protocol_setup(
            marker('invalid') as never,
            {
                store: {} as never,
                viewOnly: true,
                markerStatus: 'invalid',
                enter_view_only: async () => { events.push('view-only'); },
                drain: async () => { events.push('drain'); },
            },
            () => { events.push('stop-viewers'); },
        );
        expect(result).toBe(false);
        expect(events).toEqual(['stop-viewers', 'drain', 'view-only']);
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining('repair or remove'),
        );
    });

    it('installs only after the other-product/update attestation and current-process drain', async () => {
        const events: string[] = [];
        vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(
            'I Attest All Other Products Are Closed and Updated' as never,
        );
        vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
        const setup_marker = {
            status: async () => 'unarmed' as const,
            install: async () => { events.push('install'); },
        };
        const boundary = {
            store: {} as never,
            viewOnly: false,
            markerStatus: 'unarmed' as const,
            enter_view_only: async () => { events.push('view-only'); },
            drain: async () => { events.push('drain'); },
        };

        const installed = await run_physical_edit_protocol_setup(
            setup_marker as never,
            boundary,
            () => { events.push('stop-viewers'); },
        );

        expect(installed).toBe(true);
        expect(events).toEqual(['stop-viewers', 'drain', 'view-only', 'install']);
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
            expect.stringMatching(/every other Table Viewer[\s\S]+current VS Code process[\s\S]+old or downgraded editor/),
            { modal: true },
            'I Attest All Other Products Are Closed and Updated',
        );
    });
});
