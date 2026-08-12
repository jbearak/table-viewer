// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount_state_inspector } from '../state-inspector/ui';
import type {
    StateInspectorRequest,
    StateInspectorResponse,
    StoredFileStateEntry,
} from '../state-inspector/protocol';

interface Harness {
    readonly root: HTMLElement;
    readonly requests: StateInspectorRequest[];
    readonly trimmed: () => StateInspectorRequest | undefined;
}

const ENTRIES: StoredFileStateEntry[] = [
    { path: '/files/plain.csv', sizeBytes: 400, hasPendingEdits: false, isLeased: false },
    { path: '/files/unsaved.csv', sizeBytes: 900, hasPendingEdits: true, isLeased: false },
    { path: '/files/open.csv', sizeBytes: 100, hasPendingEdits: false, isLeased: true },
];

/** Mount the inspector over a scripted host and wait for its first render. */
async function mount(entries: StoredFileStateEntry[] = ENTRIES): Promise<Harness> {
    const requests: StateInspectorRequest[] = [];
    let live = [...entries];

    const send = async (request: StateInspectorRequest): Promise<StateInspectorResponse> => {
        requests.push(request);
        switch (request.kind) {
            case 'inspect':
                return {
                    kind: 'inventory',
                    inventory: {
                        entries: live,
                        totalEntryCount: live.length,
                        databaseSizeBytes: 2048,
                        databasePath: '/state/file-state.sqlite3',
                    },
                };
            case 'preview': {
                const selection = request.selection;
                const matched = selection.kind === 'paths'
                    ? live.filter((entry) => selection.paths.includes(entry.path))
                    : live;
                const targets = matched.filter((entry) => !entry.isLeased);
                return {
                    kind: 'preview',
                    preview: {
                        selection,
                        targetPaths: targets.map((entry) => entry.path),
                        totalSizeBytes: targets.reduce((sum, entry) => sum + entry.sizeBytes, 0),
                        pendingEditPaths: targets
                            .filter((entry) => entry.hasPendingEdits)
                            .map((entry) => entry.path),
                        protectedPaths: matched
                            .filter((entry) => entry.isLeased)
                            .map((entry) => entry.path),
                    },
                };
            }
            case 'trim': {
                const removed = new Set(request.paths);
                live = live.filter((entry) => !removed.has(entry.path));
                return {
                    kind: 'trimmed',
                    summary: {
                        deletedCount: removed.size,
                        skippedProtectedCount: 0,
                        skippedUnconfirmedCount: 0,
                        vacuum: 'vacuumed',
                        reclaimedBytes: 1024,
                    },
                };
            }
        }
    };

    const root = document.createElement('div');
    document.body.append(root);
    mount_state_inspector(root, { send });
    await settle();
    return {
        root,
        requests,
        trimmed: () => requests.find((request) => request.kind === 'trim'),
    };
}

/** Let queued promise callbacks run. No timers, so nothing to wait on. */
async function settle(): Promise<void> {
    for (let index = 0; index < 8; index++) await Promise.resolve();
}

function rows(root: HTMLElement): HTMLTableRowElement[] {
    return Array.from(root.querySelectorAll('tbody tr'));
}

function button(root: HTMLElement, label: string): HTMLButtonElement {
    const all = Array.from(root.querySelectorAll('button'));
    const match = all.find((candidate) => candidate.textContent === label);
    if (!match) {
        throw new Error(`No button labelled ${label}. `
            + `Found: ${all.map((candidate) => candidate.textContent).join(', ')}`);
    }
    return match;
}

function dialog(root: HTMLElement): HTMLElement {
    const found = root.querySelector('.dialog');
    if (!found) throw new Error('No dialog is open.');
    return found as HTMLElement;
}

async function click(target: HTMLElement): Promise<void> {
    target.click();
    await settle();
}

beforeEach(() => {
    document.body.replaceChildren();
});

describe('the inspector listing', () => {
    it('shows every entry with its size and the database total', async () => {
        const { root } = await mount();

        expect(rows(root)).toHaveLength(3);
        expect(root.querySelector('.summary')?.textContent).toBe('3 files · 2.0 KB on disk');
        expect(root.querySelector('.database-path')?.textContent)
            .toBe('/state/file-state.sqlite3');
    });

    it('marks unsaved edits and open files, and defaults to largest first', async () => {
        const { root } = await mount();

        const listed = rows(root).map((row) => row.querySelector('.path')?.textContent);
        expect(listed).toEqual(['/files/unsaved.csv', '/files/plain.csv', '/files/open.csv']);
        expect(root.textContent).toContain('Unsaved edits');
        expect(root.textContent).toContain('Open');
    });

    it('will not let an open entry be selected', async () => {
        const { root } = await mount();

        const openRow = rows(root)
            .find((row) => row.querySelector('.path')?.textContent === '/files/open.csv')!;
        expect(openRow.querySelector<HTMLInputElement>('input')!.disabled).toBe(true);
    });

    it('filters by path without touching what is stored', async () => {
        const { root, requests } = await mount();

        const filter = root.querySelector<HTMLInputElement>('.filter-input')!;
        filter.value = 'unsaved';
        filter.dispatchEvent(new Event('input'));
        await settle();

        expect(rows(root)).toHaveLength(1);
        expect(requests.filter((request) => request.kind !== 'inspect')).toEqual([]);
    });
});

describe('deleting a selection', () => {
    async function selectPlain(root: HTMLElement): Promise<void> {
        const row = rows(root)
            .find((candidate) => candidate.querySelector('.path')?.textContent === '/files/plain.csv')!;
        await click(row.querySelector<HTMLInputElement>('input')!);
    }

    it('asks first, and does nothing if the user cancels', async () => {
        const harness = await mount();
        await selectPlain(harness.root);

        await click(button(harness.root, 'Delete Selected'));
        expect(dialog(harness.root).textContent).toContain('Delete stored state for 1 file?');

        await click(button(dialog(harness.root), 'Cancel'));

        expect(harness.trimmed()).toBeUndefined();
        expect(rows(harness.root)).toHaveLength(3);
    });

    it('deletes once confirmed, and reports what it reclaimed', async () => {
        const harness = await mount();
        await selectPlain(harness.root);

        await click(button(harness.root, 'Delete Selected'));
        await click(button(dialog(harness.root), 'Delete'));

        expect(harness.trimmed()).toMatchObject({
            kind: 'trim',
            paths: ['/files/plain.csv'],
            confirmedPendingEditPaths: [],
        });
        expect(rows(harness.root)).toHaveLength(2);
        expect(harness.root.querySelector('.status-bar')?.textContent)
            .toContain('Reclaimed 1.0 KB');
    });
});

describe('the unsaved-edits gate', () => {
    it('names the affected files in a second confirmation', async () => {
        const harness = await mount();

        await click(button(harness.root, 'Clear Everything'));
        await click(button(dialog(harness.root), 'Delete'));

        const second = dialog(harness.root);
        expect(second.textContent).toContain('Discard unsaved changes to 1 file?');
        expect(second.querySelector('.file-list')?.textContent).toContain('/files/unsaved.csv');
    });

    it('deletes nothing when the second confirmation is refused', async () => {
        const harness = await mount();

        await click(button(harness.root, 'Clear Everything'));
        await click(button(dialog(harness.root), 'Delete'));
        await click(button(dialog(harness.root), 'Cancel'));

        expect(harness.trimmed()).toBeUndefined();
        expect(rows(harness.root)).toHaveLength(3);
    });

    it('passes the confirmed paths through only after that second yes', async () => {
        const harness = await mount();

        await click(button(harness.root, 'Clear Everything'));
        await click(button(dialog(harness.root), 'Delete'));
        await click(button(dialog(harness.root), 'Discard Edits and Delete'));

        expect(harness.trimmed()).toMatchObject({
            confirmedPendingEditPaths: ['/files/unsaved.csv'],
        });
    });

    it('applies the same gate to a bulk action as to a hand-picked one', async () => {
        // The gate is decided by what the selection resolved to, so every route
        // to a delete has to pass through it.
        for (const label of ['Clear Everything', 'Delete Missing Files']) {
            document.body.replaceChildren();
            const harness = await mount();

            await click(button(harness.root, label));
            await click(button(dialog(harness.root), 'Delete'));

            expect(dialog(harness.root).textContent)
                .toContain('Discard unsaved changes to 1 file?');
        }
    });

    it('never shows the second step when no target holds unsaved work', async () => {
        const harness = await mount([ENTRIES[0]]);

        await click(button(harness.root, 'Clear Everything'));
        await click(button(dialog(harness.root), 'Delete'));

        expect(harness.root.querySelector('.dialog')).toBeNull();
        expect(harness.trimmed()).toMatchObject({ confirmedPendingEditPaths: [] });
    });

    it('cancels on Escape rather than deleting', async () => {
        const harness = await mount();

        await click(button(harness.root, 'Clear Everything'));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        await settle();

        expect(harness.root.querySelector('.dialog')).toBeNull();
        expect(harness.trimmed()).toBeUndefined();
    });
});

describe('when every match is in use', () => {
    it('says so instead of opening an empty confirmation', async () => {
        const harness = await mount([ENTRIES[2]]);

        await click(button(harness.root, 'Clear Everything'));

        expect(harness.root.querySelector('.dialog')).toBeNull();
        expect(harness.root.querySelector('.status-bar')?.textContent)
            .toContain('currently open');
    });
});

describe('host failures', () => {
    it('reports them in the status bar rather than throwing', async () => {
        const root = document.createElement('div');
        document.body.append(root);
        const send = vi.fn(async (): Promise<StateInspectorResponse> => ({
            kind: 'error',
            message: 'database is locked',
        }));

        mount_state_inspector(root, { send });
        await settle();

        const status = root.querySelector('.status-bar')!;
        expect(status.textContent).toBe('database is locked');
        expect(status.classList.contains('error')).toBe(true);
    });
});
