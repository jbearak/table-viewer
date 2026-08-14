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

type SortKey = 'path' | 'sizeBytes' | 'activity' | 'status';

/**
 * A cleanup suggestion the toolbar can offer.
 *
 * Clicking one never clears anything: it narrows the table to the matching
 * rows and ticks them, so the criterion is reviewed as a visible selection
 * rather than trusted as a label on a button. The one clearing action in the
 * whole window then acts on that selection, the same as a hand-picked one.
 */
type CleanupCriterion =
    | { readonly kind: 'missing' }
    | { readonly kind: 'stale'; readonly days: number };

interface UiState {
    inventory?: StateInspectorInventory;
    selected: Set<string>;
    filter: string;
    /** Which suggestion the table is currently narrowed to, if any. */
    review?: CleanupCriterion;
    /** The days threshold for the stale suggestion, edited in the toolbar. */
    staleDays: number;
    sortKey: SortKey;
    ascending: boolean;
    busy: boolean;
    status?: { readonly text: string; readonly isError: boolean };
}

const MS_PER_DAY = 86_400_000;

/**
 * The client-side mirror of the host's trim criteria, over the inventory the
 * host already sent. `missing` reads the same flag the row badge shows, and
 * `stale` uses the same activity timestamp and cutoff rule as the maintenance
 * layer, so what a chip highlights is what the criterion means everywhere
 * else. The host still re-resolves and re-checks everything before deleting.
 */
function criterion_matches(
    entry: StoredFileStateEntry,
    criterion: CleanupCriterion,
    now: number,
): boolean {
    if (criterion.kind === 'missing') return entry.isMissing === true;
    const stamp = entry_activity_timestamp(entry);
    return stamp !== undefined && stamp < now - criterion.days * MS_PER_DAY;
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

/** A small current-colour refresh glyph, shared by both host renderers. */
function refresh_icon(): SVGSVGElement {
    const namespace = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(namespace, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(namespace, 'path');
    path.setAttribute('d', 'M20.49 15a9 9 0 1 1-2.12-9.36L23 10');
    const arrow = document.createElementNS(namespace, 'polyline');
    arrow.setAttribute('points', '23 4 23 10 17 10');
    svg.append(path, arrow);
    return svg;
}

/**
 * How notable an entry's status is, for sorting the Status column.
 *
 * A row can carry more than one badge, so this is a bitmask rather than a
 * category: it groups every unsaved-edits row together, then every not-on-disk
 * row, then the merely open ones, and stays stable for rows that are two of
 * those at once. Descending puts the rows worth a second look at the top —
 * unsaved work first, since that is the one thing clearing cannot give back.
 */
function status_rank(entry: StoredFileStateEntry): number {
    return (entry.hasPendingEdits ? 4 : 0)
        + (entry.isMissing ? 2 : 0)
        + (entry.isProtected ? 1 : 0);
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
        staleDays: 90,
        sortKey: 'sizeBytes',
        ascending: false,
        busy: false,
    };

    const header = element('header');
    const heading = element('h1', undefined, 'Stored File State');
    const refreshButton = element('button', 'header-refresh');
    refreshButton.type = 'button';
    refreshButton.title = 'Refresh stored file state';
    refreshButton.setAttribute('aria-label', 'Refresh stored file state');
    refreshButton.append(refresh_icon());
    const headingRow = element('div', 'heading-row');
    headingRow.append(heading, refreshButton);
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
    // The two byte figures in the summary never agree, and the gap is large on a
    // near-empty database — a hundred kilobytes of table definitions, indexes,
    // and reserved pages sit there whatever is stored. Reporting only the file
    // size, as this window first did, reads as "your view settings are eating
    // 132 KB"; reporting both without saying why reads as an accounting error.
    // So the header states both and this line accounts for the difference.
    const sizeNote = element(
        'p',
        'size-note',
        'The database file is always larger than the total stored: it also holds '
        + 'its own structure and space kept in reserve for future entries. '
        + 'Clearing frees the entries, so the file itself shrinks by less.',
    );
    const databasePath = element('p', 'database-path');
    header.append(headingRow, explanation, summary, sizeNote, databasePath);

    const toolbar = element('div', 'toolbars');
    const filterInput = element('input', 'filter-input');
    filterInput.type = 'text';
    filterInput.placeholder = 'Filter by path';
    filterInput.setAttribute('aria-label', 'Filter by path');

    // The suggestion chips. Nothing in this row clears anything: a chip only
    // narrows the table and ticks the matching rows, so every route to a
    // delete runs through the same visible selection and the same single
    // clear button below. The counts are computed from the inventory already
    // on hand, so a chip says what it would show before it is pressed.
    const chipMissing = element('button', 'chip chip-missing');
    const daysInput = element('input');
    daysInput.type = 'number';
    daysInput.min = '1';
    daysInput.value = '90';
    daysInput.setAttribute('aria-label', 'Days since last opened');
    const staleEditor = element('label', 'stale-editor');
    staleEditor.append(
        element('span', undefined, 'Unused for'),
        daysInput,
        element('span', undefined, 'days:'),
    );
    const chipStale = element('button', 'chip chip-stale');

    // No "Clean up:" prefix on this row: these chips select, they do not
    // clean anything, and a heading that says otherwise promises an action
    // the buttons deliberately do not perform. And no Refresh button: the
    // window loads a fresh inventory every time it opens, and closing and
    // reopening it is the natural way to ask again.
    const suggestions = element('div', 'toolbar suggestions');
    suggestions.append(chipMissing, staleEditor, chipStale);
    const viewControls = element('div', 'toolbar view-controls');
    viewControls.append(filterInput);

    // The review bar: the one place anything can be cleared from. It exists
    // only while there is a selection to act on, so the window never shows a
    // disabled destructive doorway — and it is not styled destructive either,
    // because clicking it only opens a confirmation. Red stays reserved for
    // the unsaved-edits step in that dialog, the one action that cannot be
    // undone.
    const reviewBar = element('div', 'review-bar');
    reviewBar.hidden = true;
    const reviewSummary = element('span', 'review-summary');
    const clearButton = element('button', 'review-clear');
    const dismiss = element('button', 'review-dismiss', 'Deselect');
    reviewBar.append(reviewSummary, element('span', 'spacer'), clearButton, dismiss);

    toolbar.append(suggestions, viewControls, reviewBar);

    const tableScroll = element('div', 'table-scroll');
    const statusBar = element('div', 'status-bar');
    statusBar.setAttribute('role', 'status');
    statusBar.setAttribute('aria-live', 'polite');

    root.replaceChildren(header, toolbar, tableScroll, statusBar);

    function visible_entries(): StoredFileStateEntry[] {
        let entries = state.inventory?.entries ?? [];
        if (state.review) {
            const criterion = state.review;
            const now = Date.now();
            entries = entries.filter((entry) => criterion_matches(entry, criterion, now));
        }
        const needle = state.filter.trim().toLowerCase();
        const filtered = needle === ''
            ? [...entries]
            : entries.filter((entry) => entry.path.toLowerCase().includes(needle));
        const direction = state.ascending ? 1 : -1;
        const rank = (entry: StoredFileStateEntry): number => {
            switch (state.sortKey) {
                case 'sizeBytes':
                    return entry.sizeBytes;
                case 'status':
                    return status_rank(entry);
                default:
                    // Entries with no timestamp sort as oldest rather than
                    // jumping to the top, matching the fact that they are never
                    // picked up by age trims.
                    return entry_activity_timestamp(entry) ?? 0;
            }
        };
        return filtered.sort((left, right) => {
            if (state.sortKey === 'path') return left.path.localeCompare(right.path) * direction;
            const difference = (rank(left) - rank(right)) * direction;
            // Ties fall back to the path, so equal sizes, dates, or statuses hold
            // one order instead of shuffling every time the column is clicked.
            return difference !== 0 ? difference : left.path.localeCompare(right.path);
        });
    }

    function set_status(text: string, isError = false): void {
        state.status = { text, isError };
        statusBar.textContent = text;
        statusBar.classList.toggle('error', isError);
    }

    function set_busy(busy: boolean): void {
        state.busy = busy;
        for (const button of [refreshButton, clearButton, chipMissing, chipStale, dismiss]) {
            button.disabled = busy;
        }
        if (!busy) render_toolbar();
    }

    function set_refreshing(refreshing: boolean): void {
        refreshButton.classList.toggle('loading', refreshing);
        refreshButton.setAttribute('aria-busy', refreshing ? 'true' : 'false');
    }

    function render_header(): void {
        const inventory = state.inventory;
        if (!inventory) return;
        const count = inventory.totalEntryCount;
        // Two figures, because the Size column sums to the first one and not to
        // the second, and one number in this spot invited exactly that
        // subtraction. "stored" is the total this window can actually free.
        const stored = inventory.entries.reduce((total, entry) => total + entry.sizeBytes, 0);
        summary.textContent = `${count === 1 ? '1 file' : `${count} files`} · ${
            format_bytes(stored)
        } stored · ${format_bytes(inventory.databaseSizeBytes)} database file`;
        databasePath.textContent = inventory.databasePath;
    }

    function matching_entries(criterion: CleanupCriterion): StoredFileStateEntry[] {
        const now = Date.now();
        return (state.inventory?.entries ?? [])
            .filter((entry) => criterion_matches(entry, criterion, now));
    }

    /** "7 · 312 KB", or "none", so a chip reports its yield before any click. */
    function chip_count(matches: readonly StoredFileStateEntry[]): string {
        if (matches.length === 0) return 'none';
        const size = matches.reduce((total, entry) => total + entry.sizeBytes, 0);
        return `${matches.length} · ${format_bytes(size)}`;
    }

    function render_toolbar(): void {
        const missing = matching_entries({ kind: 'missing' });
        chipMissing.textContent = `Not on disk · ${chip_count(missing)}`;
        chipMissing.disabled = state.busy || missing.length === 0;
        chipMissing.setAttribute(
            'aria-pressed',
            state.review?.kind === 'missing' ? 'true' : 'false',
        );

        const staleValid = Number.isFinite(state.staleDays) && state.staleDays >= 1;
        const stale = staleValid
            ? matching_entries({ kind: 'stale', days: state.staleDays })
            : [];
        chipStale.textContent = chip_count(stale);
        chipStale.disabled = state.busy || stale.length === 0;
        chipStale.setAttribute(
            'aria-pressed',
            state.review?.kind === 'stale' ? 'true' : 'false',
        );
        chipStale.setAttribute(
            'aria-label',
            `Review entries unused for ${staleValid ? state.staleDays : daysInput.value} days`,
        );

        // The review bar appears for any selection, however it was made — a
        // chip and a hand-ticked checkbox lead to the same bar and the same
        // single clear button.
        const selectedCount = state.selected.size;
        reviewBar.hidden = state.review === undefined && selectedCount === 0;
        const bySize = new Map(
            (state.inventory?.entries ?? []).map((entry) => [entry.path, entry.sizeBytes]),
        );
        const selectedBytes = [...state.selected]
            .reduce((total, path) => total + (bySize.get(path) ?? 0), 0);
        const selectedPhrase = `${selectedCount} selected · ${format_bytes(selectedBytes)}`;
        if (state.review === undefined) {
            reviewSummary.textContent = selectedPhrase;
        } else {
            const matched = matching_entries(state.review);
            const criterionPhrase = state.review.kind === 'missing'
                ? `${matched.length} not on disk`
                : `${matched.length} unused for ${state.review.days}+ days`;
            reviewSummary.textContent = `${criterionPhrase} — ${selectedPhrase}`;
        }
        clearButton.textContent = `Clear ${
            selectedCount === 1 ? '1 entry' : `${selectedCount} entries`
        }…`;
        clearButton.disabled = state.busy || selectedCount === 0;
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
        const selectable = entries.filter((entry) => !entry.isProtected);
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
            { key: 'status', label: 'Status' },
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
                    // Paths read best A–Z; sizes, dates, and statuses are asked
                    // about largest-, most-recent-, and most-notable-first.
                    state.ascending = column.key === 'path';
                }
                render();
            });
            headRow.append(cell);
        }
        head.append(headRow);

        const body = element('tbody');
        for (const entry of entries) {
            const row = element('tr', entry.isProtected ? 'protected' : undefined);

            const checkbox = element('input');
            checkbox.type = 'checkbox';
            checkbox.checked = state.selected.has(entry.path);
            checkbox.disabled = entry.isProtected;
            checkbox.setAttribute('aria-label', `Select ${entry.path}`);
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) state.selected.add(entry.path);
                else state.selected.delete(entry.path);
                // The toolbar re-renders but the table does not: rows must hold
                // still under a ticking finger, and the toolbar nodes are
                // static, so updating them cannot steal this checkbox's focus.
                render_toolbar();
                const shown = visible_entries().filter((candidate) => !candidate.isProtected);
                selectAll.checked = shown.length > 0
                    && shown.every((candidate) => state.selected.has(candidate.path));
            });
            const checkCell = element('td');
            checkCell.append(checkbox);

            const status = element('td');
            if (entry.hasPendingEdits) {
                status.append(element('span', 'badge unsaved', 'Unsaved edits'));
            }
            // Claimed only for our own session's lease, the one kind that proves
            // a window has the file open now.
            if (entry.openHere) status.append(element('span', 'badge open', 'Open'));
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
        render_toolbar();
        render_table();
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

    async function reload(): Promise<boolean> {
        const inventory = await request_or_report(
            { kind: 'inspect' },
            (response) => response.kind === 'inventory' ? response.inventory : undefined,
        );
        if (!inventory) return false;
        state.inventory = inventory;
        // Drop selections for entries that no longer exist, so a stale tick
        // cannot be carried into the next delete.
        const live = new Set(inventory.entries.map((entry) => entry.path));
        for (const path of [...state.selected]) if (!live.has(path)) state.selected.delete(path);
        render();
        return true;
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
            state.review = undefined;
            await reload();
            set_status(trim_outcome_message(summary));
        } finally {
            set_busy(false);
        }
    }

    /**
     * Enter review mode for one suggestion: narrow the table to what matched
     * and tick everything that could actually be cleared. Protected rows stay
     * visible and unticked, so "this matched but is in use" is something the
     * user sees rather than something a dialog apologises for later.
     */
    function apply_review(criterion: CleanupCriterion): void {
        state.review = criterion;
        const matched = matching_entries(criterion);
        state.selected = new Set(
            matched.filter((entry) => !entry.isProtected).map((entry) => entry.path),
        );
        set_status(
            state.selected.size === 0 && matched.some((entry) => entry.isProtected)
                ? 'Everything that matched is currently open, so nothing can be deleted.'
                : '',
        );
        render();
    }

    function exit_review(): void {
        state.review = undefined;
        state.selected.clear();
        set_status('');
        render();
    }

    filterInput.addEventListener('input', () => {
        state.filter = filterInput.value;
        render_table();
    });
    chipMissing.addEventListener('click', () => {
        if (state.review?.kind === 'missing') exit_review();
        else apply_review({ kind: 'missing' });
    });
    chipStale.addEventListener('click', () => {
        if (state.review?.kind === 'stale') {
            exit_review();
            return;
        }
        const days = Number(daysInput.value);
        if (!Number.isFinite(days) || days < 1) {
            set_status('Enter a number of days of at least 1.', true);
            return;
        }
        apply_review({ kind: 'stale', days });
    });
    daysInput.addEventListener('input', () => {
        state.staleDays = Number(daysInput.value);
        // An active stale review follows the edited threshold live; the rows it
        // highlights are re-derived, the same as pressing the chip again. An
        // invalid value leaves the current review where it was.
        if (
            state.review?.kind === 'stale'
            && Number.isFinite(state.staleDays) && state.staleDays >= 1
        ) {
            apply_review({ kind: 'stale', days: state.staleDays });
        } else {
            render_toolbar();
        }
    });
    clearButton.addEventListener('click', () => {
        void run_trim({ kind: 'paths', paths: [...state.selected] });
    });
    dismiss.addEventListener('click', exit_review);
    refreshButton.addEventListener('click', () => {
        set_busy(true);
        set_refreshing(true);
        void reload().then((refreshed) => {
            if (refreshed) set_status('Updated just now.');
        }).finally(() => {
            set_refreshing(false);
            set_busy(false);
        });
    });

    render();
    set_busy(true);
    set_refreshing(true);
    void reload().finally(() => {
        set_refreshing(false);
        set_busy(false);
        if (!state.status) set_status('');
    });
}
