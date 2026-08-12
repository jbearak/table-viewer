/**
 * The stored-file-state inspector, as one implementation for both hosts.
 *
 * Plain DOM on purpose. This is a list, some checkboxes, and two dialogs; the
 * viewer's React and canvas-grid stack exists to make a million-row spreadsheet
 * scroll, and none of that helps here. Plain DOM also means the desktop
 * renderer bundle and the VS Code webview bundle are built from this same file
 * with no framework in either.
 *
 * It talks to its host only through a `StateInspectorTransport`, and it never
 * decides on its own that something is safe to delete: every deletion is
 * resolved by the host, previewed by the host, and re-checked by the host.
 */
import type {
    StateInspectorInventory,
    StateInspectorPreview,
    StateInspectorTransport,
    StoredFileStateEntry,
    StoredFileStateTrimSelection,
} from './protocol';
import { entry_activity_timestamp } from '../stored-file-state-entry';
import { STATE_INSPECTOR_CSS } from './styles';
import {
    format_bytes,
    pending_edit_confirmation,
    trim_confirmation,
    trim_outcome_message,
    type TrimConfirmation,
} from './trim-policy';

type SortKey = 'path' | 'sizeBytes' | 'activity';

interface UiState {
    inventory?: StateInspectorInventory;
    selected: Set<string>;
    filter: string;
    sortKey: SortKey;
    ascending: boolean;
    busy: boolean;
    status?: { readonly text: string; readonly isError: boolean };
}

function element<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    // Always textContent, never innerHTML: every string here is either a file
    // path or a host-supplied message, and neither is ours to trust as markup.
    if (text !== undefined) node.textContent = text;
    return node;
}

function format_date(value: number | undefined): string {
    if (value === undefined) return 'Unknown';
    return new Date(value).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
    });
}

/**
 * Install the stylesheet, once per document.
 *
 * Done from here rather than from each host's HTML so the two pages cannot drift
 * apart: whichever host loads this bundle gets exactly the styles it was built
 * with. Both host pages allow inline styles for this reason.
 */
function ensure_styles(): void {
    const marker = 'table-viewer-state-inspector-styles';
    if (document.getElementById(marker)) return;
    const style = document.createElement('style');
    style.id = marker;
    style.textContent = STATE_INSPECTOR_CSS;
    document.head.append(style);
}

export function mount_state_inspector(
    root: HTMLElement,
    transport: StateInspectorTransport,
): void {
    ensure_styles();
    const state: UiState = {
        selected: new Set(),
        filter: '',
        sortKey: 'sizeBytes',
        ascending: false,
        busy: false,
    };

    const header = element('header');
    const heading = element('h1', undefined, 'Stored File State');
    // Standing text, not just dialog copy. The buttons below say "Clear", and
    // someone reading them cold has no way to know whether that reaches their
    // spreadsheets — so the answer is on screen before they press anything.
    const explanation = element(
        'p',
        'explanation',
        'Table Viewer remembers how you were viewing each file: sorts, filters, '
        + 'column widths, scroll positions, and any unsaved edits. This window '
        + 'shows that record and lets you prune it. Clearing an entry never '
        + 'deletes, moves, or changes the file on disk.',
    );
    const summary = element('p', 'summary', 'Loading…');
    const databasePath = element('p', 'database-path');
    header.append(heading, explanation, summary, databasePath);

    const toolbar = element('div', 'toolbars');
    const filterInput = element('input', 'filter-input');
    filterInput.type = 'text';
    filterInput.placeholder = 'Filter by path';
    filterInput.setAttribute('aria-label', 'Filter by path');

    // No toolbar button is styled destructive, including this one. None of them
    // clear anything on click — every one opens a confirmation first. Red is
    // reserved for the point of no return, which is the unsaved-edits step in
    // that dialog; spending it on three doorways would leave nothing to mark the
    // one action that actually cannot be undone.
    const clearSelected = element('button', undefined, 'Clear Selected');
    const daysInput = element('input');
    daysInput.type = 'number';
    daysInput.min = '1';
    daysInput.value = '90';
    daysInput.setAttribute('aria-label', 'Days since last opened');
    const trimOldLabel = element('label');
    const trimOld = element('button', undefined, 'Clear Older Than');
    trimOldLabel.append(trimOld, daysInput, element('span', undefined, 'days'));
    const trimMissing = element('button', undefined, 'Clear Files Not on Disk');
    const refresh = element('button', undefined, 'Refresh');

    // Two rows, because these are two different kinds of control: the top row
    // changes what is stored, the bottom row only changes what you are looking
    // at. Mixing them put a harmless text field between two clearing actions.
    const actions = element('div', 'toolbar actions');
    actions.append(clearSelected, trimOldLabel, trimMissing);
    const viewControls = element('div', 'toolbar view-controls');
    viewControls.append(filterInput, element('span', 'spacer'), refresh);
    toolbar.append(actions, viewControls);

    const tableScroll = element('div', 'table-scroll');
    const statusBar = element('div', 'status-bar');
    statusBar.setAttribute('role', 'status');
    statusBar.setAttribute('aria-live', 'polite');

    root.replaceChildren(header, toolbar, tableScroll, statusBar);

    function visible_entries(): StoredFileStateEntry[] {
        const entries = state.inventory?.entries ?? [];
        const needle = state.filter.trim().toLowerCase();
        const filtered = needle === ''
            ? [...entries]
            : entries.filter((entry) => entry.path.toLowerCase().includes(needle));
        const direction = state.ascending ? 1 : -1;
        return filtered.sort((left, right) => {
            if (state.sortKey === 'path') return left.path.localeCompare(right.path) * direction;
            if (state.sortKey === 'sizeBytes') {
                return (left.sizeBytes - right.sizeBytes) * direction;
            }
            // Entries with no timestamp sort as oldest rather than jumping to the
            // top, matching the fact that they are never picked up by age trims.
            return ((entry_activity_timestamp(left) ?? 0)
                - (entry_activity_timestamp(right) ?? 0)) * direction;
        });
    }

    function set_status(text: string, isError = false): void {
        state.status = { text, isError };
        statusBar.textContent = text;
        statusBar.classList.toggle('error', isError);
    }

    function set_busy(busy: boolean): void {
        state.busy = busy;
        for (const button of [clearSelected, trimOld, trimMissing, refresh]) {
            button.disabled = busy;
        }
        if (!busy) clearSelected.disabled = state.selected.size === 0;
    }

    function render_header(): void {
        const inventory = state.inventory;
        if (!inventory) return;
        const count = inventory.totalEntryCount;
        summary.textContent = `${count === 1 ? '1 file' : `${count} files`} · ${
            format_bytes(inventory.databaseSizeBytes)
        } on disk`;
        databasePath.textContent = inventory.databasePath;
    }

    function render_table(): void {
        const entries = visible_entries();
        if (entries.length === 0) {
            tableScroll.replaceChildren(element(
                'div',
                'empty',
                state.inventory === undefined
                    ? 'Loading…'
                    : state.inventory.totalEntryCount === 0
                        ? 'Table Viewer has not stored state for any files yet.'
                        : 'No entries match this filter.',
            ));
            return;
        }

        const table = element('table');
        const head = element('thead');
        const headRow = element('tr');

        const selectAll = element('input');
        selectAll.type = 'checkbox';
        selectAll.setAttribute('aria-label', 'Select all shown entries');
        const selectable = entries.filter((entry) => !entry.isLeased);
        selectAll.checked = selectable.length > 0
            && selectable.every((entry) => state.selected.has(entry.path));
        selectAll.disabled = selectable.length === 0;
        selectAll.addEventListener('change', () => {
            for (const entry of selectable) {
                if (selectAll.checked) state.selected.add(entry.path);
                else state.selected.delete(entry.path);
            }
            render();
        });
        const selectCell = element('th');
        selectCell.append(selectAll);
        headRow.append(selectCell);

        const columns: { key: SortKey; label: string; numeric?: boolean }[] = [
            { key: 'path', label: 'File' },
            { key: 'sizeBytes', label: 'Size', numeric: true },
            { key: 'activity', label: 'Last used' },
        ];
        for (const column of columns) {
            const cell = element('th', column.numeric ? 'numeric' : undefined, column.label);
            if (state.sortKey === column.key) {
                cell.setAttribute('aria-sort', state.ascending ? 'ascending' : 'descending');
            }
            cell.addEventListener('click', () => {
                if (state.sortKey === column.key) state.ascending = !state.ascending;
                else {
                    state.sortKey = column.key;
                    // Paths read best A–Z; sizes and dates are asked about
                    // largest-first and most-recent-first.
                    state.ascending = column.key === 'path';
                }
                render();
            });
            headRow.append(cell);
        }
        headRow.append(element('th', undefined, 'Status'));
        head.append(headRow);

        const body = element('tbody');
        for (const entry of entries) {
            const row = element('tr', entry.isLeased ? 'protected' : undefined);

            const checkbox = element('input');
            checkbox.type = 'checkbox';
            checkbox.checked = state.selected.has(entry.path);
            checkbox.disabled = entry.isLeased;
            checkbox.setAttribute('aria-label', `Select ${entry.path}`);
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) state.selected.add(entry.path);
                else state.selected.delete(entry.path);
                clearSelected.disabled = state.selected.size === 0;
                const shown = visible_entries().filter((candidate) => !candidate.isLeased);
                selectAll.checked = shown.length > 0
                    && shown.every((candidate) => state.selected.has(candidate.path));
            });
            const checkCell = element('td');
            checkCell.append(checkbox);

            const status = element('td');
            if (entry.hasPendingEdits) {
                status.append(element('span', 'badge unsaved', 'Unsaved edits'));
            }
            if (entry.isLeased) status.append(element('span', 'badge open', 'Open'));
            // Named on the row, so the bulk action acts on something the user
            // can already see rather than on an invisible criterion. "Not on
            // disk" rather than "missing" because that is exactly what was
            // checked — a stat that found nothing — and it does not imply Table
            // Viewer lost anything or that the file was deleted rather than
            // moved or on an unmounted volume.
            if (entry.isMissing) status.append(element('span', 'badge absent', 'Not on disk'));

            row.append(
                checkCell,
                element('td', 'path', entry.path),
                element('td', 'numeric', format_bytes(entry.sizeBytes)),
                element('td', undefined, format_date(entry_activity_timestamp(entry))),
                status,
            );
            body.append(row);
        }

        table.append(head, body);
        tableScroll.replaceChildren(table);
    }

    function render(): void {
        render_header();
        render_table();
        clearSelected.disabled = state.busy || state.selected.size === 0;
    }

    /** Show one confirmation and resolve to whether it was accepted. */
    function confirm(details: TrimConfirmation): Promise<boolean> {
        return new Promise((resolve) => {
            const scrim = element('div', 'scrim');
            const dialog = element('div', 'dialog');
            dialog.setAttribute('role', 'alertdialog');
            dialog.setAttribute('aria-modal', 'true');

            const title = element('h2', undefined, details.title);
            dialog.append(title);
            for (const paragraph of details.message.split('\n\n')) {
                dialog.append(element('p', undefined, paragraph));
            }
            if (details.affectedFiles.length > 0) {
                const list = element('div', 'file-list');
                for (const file of details.affectedFiles) {
                    list.append(element('div', undefined, file));
                }
                dialog.append(list);
            }

            const cancel = element('button', undefined, 'Cancel');
            const accept = element(
                'button',
                details.destructive ? 'danger' : 'primary',
                details.confirmLabel,
            );
            const actions = element('div', 'actions');
            actions.append(cancel, accept);
            dialog.append(actions);
            scrim.append(dialog);
            root.append(scrim);

            const close = (accepted: boolean): void => {
                scrim.remove();
                document.removeEventListener('keydown', onKey, true);
                resolve(accepted);
            };
            function onKey(event: KeyboardEvent): void {
                // Escape always cancels. The destructive step deliberately has no
                // Enter shortcut: confirming the loss of unsaved work should take
                // a deliberate click, not a keypress aimed at something else.
                if (event.key === 'Escape') {
                    event.preventDefault();
                    close(false);
                }
            }
            document.addEventListener('keydown', onKey, true);
            cancel.addEventListener('click', () => close(false));
            accept.addEventListener('click', () => close(true));
            // Focus lands on Cancel so a stray Enter or Space cannot delete.
            cancel.focus();
        });
    }

    async function request_or_report<T>(
        request: Parameters<StateInspectorTransport['send']>[0],
        expect: (response: Awaited<ReturnType<StateInspectorTransport['send']>>) => T | undefined,
    ): Promise<T | undefined> {
        try {
            const response = await transport.send(request);
            if (response.kind === 'error') {
                set_status(response.message, true);
                return undefined;
            }
            return expect(response);
        } catch (error) {
            set_status(error instanceof Error ? error.message : 'Request failed.', true);
            return undefined;
        }
    }

    async function reload(): Promise<void> {
        const inventory = await request_or_report(
            { kind: 'inspect' },
            (response) => response.kind === 'inventory' ? response.inventory : undefined,
        );
        if (!inventory) return;
        state.inventory = inventory;
        // Drop selections for entries that no longer exist, so a stale tick
        // cannot be carried into the next delete.
        const live = new Set(inventory.entries.map((entry) => entry.path));
        for (const path of [...state.selected]) if (!live.has(path)) state.selected.delete(path);
        render();
    }

    async function run_trim(selection: StoredFileStateTrimSelection): Promise<void> {
        set_busy(true);
        try {
            const preview = await request_or_report<StateInspectorPreview>(
                { kind: 'preview', selection },
                (response) => response.kind === 'preview' ? response.preview : undefined,
            );
            if (!preview) return;

            const first = trim_confirmation(preview);
            if (!first) {
                set_status(
                    preview.protectedPaths.length > 0
                        ? 'Everything that matched is currently open, so nothing can be deleted.'
                        : 'Nothing matched.',
                );
                return;
            }
            if (!await confirm(first)) return;

            // The second gate depends on the resolved targets, not on which
            // button started this, so bulk actions cannot slip past it.
            const second = pending_edit_confirmation(preview);
            if (second && !await confirm(second)) return;

            const summary = await request_or_report(
                {
                    kind: 'trim',
                    paths: preview.targetPaths,
                    confirmedPendingEditPaths: second ? preview.pendingEditPaths : [],
                },
                (response) => response.kind === 'trimmed' ? response.summary : undefined,
            );
            if (!summary) return;
            state.selected.clear();
            await reload();
            set_status(trim_outcome_message(summary));
        } finally {
            set_busy(false);
        }
    }

    filterInput.addEventListener('input', () => {
        state.filter = filterInput.value;
        render_table();
    });
    clearSelected.addEventListener('click', () => {
        void run_trim({ kind: 'paths', paths: [...state.selected] });
    });
    trimOld.addEventListener('click', () => {
        const days = Number(daysInput.value);
        if (!Number.isFinite(days) || days < 1) {
            set_status('Enter a number of days of at least 1.', true);
            return;
        }
        void run_trim({ kind: 'olderThanDays', days });
    });
    trimMissing.addEventListener('click', () => {
        void run_trim({ kind: 'missingOnDisk' });
    });
    refresh.addEventListener('click', () => {
        set_busy(true);
        void reload().finally(() => set_busy(false));
    });

    render();
    set_busy(true);
    void reload().finally(() => {
        set_busy(false);
        if (!state.status) set_status('');
    });
}
