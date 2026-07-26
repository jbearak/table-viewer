import type {
    FilterColumnKind,
    FilterEntry,
    FilterOperator,
    SheetTransformState,
    SortDirection,
    SortKey,
    TransformIntent,
} from '../types';
import { is_range_filter_operator, transform_read_columns } from '../types';

export { is_range_filter_operator };


export type FilterOption = { value: FilterOperator; label: string };

type KnownFilterColumnKind = Exclude<FilterColumnKind, 'unknown'>;
type FilterOperatorMetadata = FilterOption & {
    columnKinds: readonly KnownFilterColumnKind[];
    supportsCaseSensitive: boolean;
};

const FILTER_OPERATOR_METADATA: readonly FilterOperatorMetadata[] = [
    {
        value: 'contains', label: 'Contains',
        columnKinds: ['text', 'orderedText'], supportsCaseSensitive: true,
    },
    {
        value: 'isOneOf', label: 'Is one of',
        columnKinds: ['numeric', 'text', 'orderedText'], supportsCaseSensitive: false,
    },
    {
        value: 'notContains', label: 'Does not contain',
        columnKinds: ['text', 'orderedText'], supportsCaseSensitive: true,
    },
    {
        value: 'equals', label: 'Equals',
        columnKinds: ['numeric', 'text', 'orderedText'], supportsCaseSensitive: true,
    },
    {
        value: 'notEquals', label: 'Does not equal',
        columnKinds: ['numeric', 'text', 'orderedText'], supportsCaseSensitive: true,
    },
    {
        value: 'startsWith', label: 'Starts with',
        columnKinds: ['text', 'orderedText'], supportsCaseSensitive: true,
    },
    {
        value: 'endsWith', label: 'Ends with',
        columnKinds: ['text', 'orderedText'], supportsCaseSensitive: true,
    },
    {
        value: 'greaterThan', label: 'Greater than',
        columnKinds: ['numeric', 'orderedText'], supportsCaseSensitive: false,
    },
    {
        value: 'greaterThanOrEqual', label: 'Greater than or equal',
        columnKinds: ['numeric', 'orderedText'], supportsCaseSensitive: false,
    },
    {
        value: 'lessThan', label: 'Less than',
        columnKinds: ['numeric', 'orderedText'], supportsCaseSensitive: false,
    },
    {
        value: 'lessThanOrEqual', label: 'Less than or equal',
        columnKinds: ['numeric', 'orderedText'], supportsCaseSensitive: false,
    },
    {
        value: 'between', label: 'Between (inclusive)',
        columnKinds: ['numeric', 'orderedText'], supportsCaseSensitive: false,
    },
    {
        value: 'notBetween', label: 'Not between (inclusive bounds)',
        columnKinds: ['numeric', 'orderedText'], supportsCaseSensitive: false,
    },
    {
        value: 'isEmpty', label: 'Is empty',
        columnKinds: ['numeric', 'text', 'orderedText'], supportsCaseSensitive: false,
    },
    {
        value: 'isNotEmpty', label: 'Is not empty',
        columnKinds: ['numeric', 'text', 'orderedText'], supportsCaseSensitive: false,
    },
];

const FILTER_OPERATOR_METADATA_BY_VALUE = new Map(
    FILTER_OPERATOR_METADATA.map((metadata) => [metadata.value, metadata] as const),
);

export const FILTER_OPTIONS: readonly FilterOption[] = FILTER_OPERATOR_METADATA.map(
    ({ value, label }) => ({ value, label }),
);

export function filter_options_for_kind(
    kind: FilterColumnKind,
    value_list_available = false,
): readonly FilterOption[] {
    const options = kind === 'unknown'
        ? FILTER_OPTIONS
        : FILTER_OPTIONS.filter((option) =>
            FILTER_OPERATOR_METADATA_BY_VALUE.get(option.value)?.columnKinds.includes(kind));
    // "Is one of" is availability-gated: it needs a complete distinct-value
    // list, which loading/errored/over-cap columns cannot provide.
    return value_list_available
        ? options
        : options.filter((option) => option.value !== 'isOneOf');
}

/** Kind options plus the current operator when it falls outside the kind list. */
export function filter_options_for_draft(
    kind: FilterColumnKind,
    current_operator: FilterOperator,
    value_list_available = false,
): readonly FilterOption[] {
    const options = filter_options_for_kind(kind, value_list_available);
    if (options.some((option) => option.value === current_operator)) return options;
    const extra = FILTER_OPTIONS.find((option) => option.value === current_operator);
    return extra ? [...options, extra] : options;
}

/** Case sensitivity only applies to text comparisons; numeric equals ignores it. */
export function operator_supports_case_sensitive(
    operator: FilterOperator,
    kind: FilterColumnKind = 'text',
): boolean {
    return !(kind === 'numeric' && (operator === 'equals' || operator === 'notEquals'))
        && FILTER_OPERATOR_METADATA_BY_VALUE.get(operator)?.supportsCaseSensitive === true;
}

/** Settled per-column filter analysis: histogram bins plus the distinct
 *  value list backing the "Is one of" checklist. */
export interface FilterHistogramReady {
    bins: readonly { lo: number; hi: number; count: number }[];
    columnKind?: FilterColumnKind;
    distinctValues?: readonly (string | null)[];
    distinctValuesExceeded?: boolean;
}

export type FilterHistogramStatus =
    | { status: 'loading' }
    | ({ status: 'ready' } & FilterHistogramReady)
    | { status: 'error'; message: string };

/**
 * Infer column kind only once the histogram settles.
 * loading/error stay unknown so the full operator list remains available;
 * ready bins ⇒ numeric; ready empty ⇒ text.
 */
export function filter_column_kind_from_histogram(
    histogram: FilterHistogramStatus,
): FilterColumnKind {
    if (histogram.status === 'loading' || histogram.status === 'error') return 'unknown';
    return histogram.columnKind ?? (histogram.bins.length > 0 ? 'numeric' : 'text');
}

export function new_filter_id(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function filter_draft_for_column(
    col_index: number,
    filters: readonly FilterEntry[],
    preferred_operator: FilterOperator = 'contains',
): FilterEntry {
    const existing = filters.find((entry) => entry.colIndex === col_index);
    if (existing) {
        return {
            ...existing,
            value: existing.value ?? '',
            secondValue: existing.secondValue ?? '',
            excludedValues: existing.excludedValues
                ? [...existing.excludedValues]
                : undefined,
        };
    }
    return {
        id: new_filter_id(),
        colIndex: col_index,
        operator: preferred_operator,
        value: '',
        secondValue: '',
        caseSensitive: false,
        enabled: true,
    };
}

/** True while a brand-new draft is still the untouched default seed. */
export function is_pristine_default_filter_draft(entry: FilterEntry): boolean {
    return entry.operator === 'contains'
        && (entry.value ?? '') === ''
        && (entry.secondValue ?? '') === ''
        && entry.caseSensitive === false
        && entry.enabled === true;
}

/** Human-readable checklist entry label; `null` is the blank category. */
export function filter_value_label(value: string | null): string {
    return value === null ? '(Blanks)' : value;
}

function is_one_of_summary(name: string, entry: FilterEntry): string {
    const excluded = entry.excludedValues ?? [];
    if (excluded.length === 0) return `${name} includes all values`;
    if (excluded.length === 1) {
        const label = excluded[0] === null
            ? '(Blanks)'
            : `“${excluded[0]}”`;
        return `${name} excludes ${label}`;
    }
    return `${name} excludes ${excluded.length} values`;
}

export function filter_summary(
    entry: FilterEntry,
    column_names: readonly string[],
): string {
    const name = column_names[entry.colIndex] ?? `Column ${entry.colIndex + 1}`;
    switch (entry.operator) {
        case 'contains': return `${name} contains “${entry.value ?? ''}”`;
        case 'notContains': return `${name} does not contain “${entry.value ?? ''}”`;
        case 'equals': return `${name} = “${entry.value ?? ''}”`;
        case 'notEquals': return `${name} ≠ “${entry.value ?? ''}”`;
        case 'startsWith': return `${name} starts with “${entry.value ?? ''}”`;
        case 'endsWith': return `${name} ends with “${entry.value ?? ''}”`;
        case 'greaterThan': return `${name} > ${entry.value ?? ''}`;
        case 'greaterThanOrEqual': return `${name} ≥ ${entry.value ?? ''}`;
        case 'lessThan': return `${name} < ${entry.value ?? ''}`;
        case 'lessThanOrEqual': return `${name} ≤ ${entry.value ?? ''}`;
        case 'between': return `${name} ${entry.value ?? ''}–${entry.secondValue ?? ''}`;
        case 'notBetween': return `${name} not in ${entry.value ?? ''}–${entry.secondValue ?? ''}`;
        case 'isEmpty': return `${name} is empty`;
        case 'isNotEmpty': return `${name} is not empty`;
        case 'isOneOf': return is_one_of_summary(name, entry);
    }
}

export function replace_sort(
    col_index: number,
    direction: SortDirection,
): SortKey[] {
    return [{ colIndex: col_index, direction }];
}

export function append_sort(
    sort: readonly SortKey[],
    col_index: number,
    direction: SortDirection,
): SortKey[] {
    const existing = sort.findIndex((key) => key.colIndex === col_index);
    if (existing < 0) return [...sort, { colIndex: col_index, direction }];
    return sort.map((key, index) => index === existing
        ? { colIndex: col_index, direction }
        : key);
}

export function flip_sort(sort: readonly SortKey[], index: number): SortKey[] {
    return sort.map((key, candidate) => candidate === index
        ? { ...key, direction: key.direction === 'asc' ? 'desc' : 'asc' }
        : key);
}

export function remove_sort(sort: readonly SortKey[], index: number): SortKey[] {
    return sort.filter((_, candidate) => candidate !== index);
}

export function move_sort_first(sort: readonly SortKey[], index: number): SortKey[] {
    if (index <= 0 || index >= sort.length) return [...sort];
    const next = [...sort];
    const [key] = next.splice(index, 1);
    next.unshift(key);
    return next;
}

export function upsert_filter(
    filters: readonly FilterEntry[],
    entry: FilterEntry,
): FilterEntry[] {
    return [
        ...filters.filter((candidate) =>
            candidate.id !== entry.id && candidate.colIndex !== entry.colIndex),
        entry,
    ];
}

export function transform_progress_label(
    previous: SheetTransformState,
    next: SheetTransformState,
    intent: TransformIntent,
): string {
    if (intent === 'restore') return 'Applying saved…';
    const sort_changed = JSON.stringify(previous.sort) !== JSON.stringify(next.sort);
    const filters_changed = JSON.stringify(previous.filters) !== JSON.stringify(next.filters);
    if (sort_changed && filters_changed) return 'Applying sort & filters…';
    if (sort_changed) return 'Sorting…';
    if (filters_changed) return 'Filtering…';
    const has_sort = next.sort.length > 0;
    const has_filter = next.filters.some((entry) => entry.enabled);
    if (has_sort && has_filter) return 'Applying sort & filters…';
    if (has_sort) return 'Sorting…';
    return 'Filtering…';
}

/**
 * Signature of everything the stale-view notice is currently saying, or undefined
 * when it has nothing to say.
 *
 * There are two independent reasons to say something, and either alone is enough:
 *
 *  - A dirty cell sits in a column the installed order reads. An installed sort or
 *    filter deliberately does not recompute during a live edit session — rows stay
 *    where the user left them, which is the feature — so the displayed order can
 *    disagree with the current values, and that is worth saying.
 *  - The installed view does not show rows holding unsaved edits
 *    (`hidden_edited_cell_keys`). This one cannot be reduced to the first:
 *    hidden-ness is a property of the *row*, so an edit in a column no rule reads is
 *    hidden just the same, and the reopen case — durable edits plus a durable filter
 *    whose saved values exclude their rows — is exactly that shape. Gating it behind
 *    the column test would silence the notice in the case it exists for.
 *
 * The column half is derived from the *current* dirty map rather than latched, so
 * reverting or discarding the last relevant edit clears it for free. The
 * transform's own signature is folded in so changing the installed sort is a new
 * fact rather than a previously acknowledged one.
 *
 * The hidden half is *not* computable here, which is why it is a parameter: view
 * membership never reaches the webview. `transformInstalled` carries basis, rules,
 * row count and `permuted` — no index list — and display-to-source identity
 * arrives only per fetched page, as `rowData.sourceRows`, behind RowLoader's page
 * LRU, so a webview-side answer would move with the scrollbar. Recomputing
 * membership instead of observing it is worse still: it needs every filtered
 * column's *saved* value for every dirty row, non-resident ones included, plus the
 * host's filter compiler. The host has both halves — see
 * `SheetViewRecord.hiddenEditedCellKeys` — so it sends the keys, on the install and
 * again on every delivery after it, the caller intersects them with the live dirty
 * map, and this reads the result.
 *
 * Keys and not a count, here as on the wire, because this signature is the identity
 * of *what the notice is saying* and a count cannot express that. Two views can hide
 * one edited cell each and be entirely different news; a dismissal of the first must
 * not silence the second. Folding the keys in also makes the rules half below
 * complete without `state.hiddenRows`: hiding a different row changes which keys are
 * out of sight, so the change arrives through the keys rather than needing a rule
 * field someone must remember to serialize. When hiding a row changes no key, the
 * notice says the same two things it already said and the dismissal correctly holds.
 * (`transform_read_columns` excludes `hiddenRows` for an unrelated reason — it
 * answers whether an *edit* can change membership, which hiding by row identity
 * cannot. Neither exclusion licenses the other; see its doc.)
 *
 * @param dirty_keys `"sourceRow:sourceColumn"` keys, as PR 2 rekeyed them.
 * @param hidden_edited_cell_keys the installed view's
 *   `hiddenEditedCellKeys` already narrowed to entries the dirty map still holds.
 */
export function stale_view_signature(
    state: SheetTransformState | undefined,
    dirty_keys: readonly string[],
    hidden_edited_cell_keys: readonly string[],
): string | undefined {
    // No installed rules is no view to be stale about, and nothing can be hidden by
    // one either — so this also makes the rules serialization below total.
    if (!state) return undefined;
    const columns = transform_read_columns(state);
    const affected = columns.size === 0
        ? []
        : dirty_keys
            .filter((key) => {
                const separator = key.indexOf(':');
                if (separator < 0) return false;
                const text = key.slice(separator + 1);
                const column = Number(text);
                // Number('') is 0, so an empty tail would otherwise read as column 0.
                return text.length > 0
                    && Number.isInteger(column)
                    && columns.has(column);
            })
            .sort();
    if (affected.length === 0 && hidden_edited_cell_keys.length === 0) {
        return undefined;
    }
    // The transform half changes whenever the installed rules do — including a
    // filter's operator or value, not just which columns it names — so an
    // acknowledgement cannot carry over to a different view.
    const rules = JSON.stringify([
        state.sort,
        state.filters.filter((entry) => entry.enabled),
    ]);
    // Sorted, because the host's key order follows `Object.keys` on the durable map
    // and an echo of the same view must be the same signature.
    const hidden = [...hidden_edited_cell_keys].sort();
    return `${rules}|${affected.join(',')}|${hidden.join(',')}`;
}

export type TransformShortcut =
    | { kind: 'sort'; direction: SortDirection }
    | { kind: 'clearSorts' }
    | { kind: 'editFilter' }
    | { kind: 'clearFilter' }
    | { kind: 'clearFilters' };

export function transform_shortcut(
    event: Pick<KeyboardEvent, 'shiftKey' | 'altKey' | 'metaKey' | 'ctrlKey' | 'key' | 'code'>,
): TransformShortcut | null {
    if (!event.shiftKey || !event.altKey || event.metaKey || event.ctrlKey) return null;
    if (event.key === 'A' || event.key === 'a' || event.code === 'KeyA') {
        return { kind: 'sort', direction: 'asc' };
    }
    if (event.key === 'D' || event.key === 'd' || event.code === 'KeyD') {
        return { kind: 'sort', direction: 'desc' };
    }
    if (event.key === ')' || event.key === '0' || event.code === 'Digit0') {
        return { kind: 'clearSorts' };
    }
    if (event.key === 'F' || event.key === 'f' || event.code === 'KeyF') {
        return { kind: 'editFilter' };
    }
    if (event.key === 'X' || event.key === 'x' || event.code === 'KeyX') {
        return { kind: 'clearFilter' };
    }
    if (event.key === '(' || event.key === '9' || event.code === 'Digit9') {
        return { kind: 'clearFilters' };
    }
    return null;
}

export function is_editable_target(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    if (target instanceof HTMLInputElement) return true;
    if (target instanceof HTMLTextAreaElement) return true;
    if (target instanceof HTMLSelectElement) return true;
    return target instanceof HTMLElement && target.isContentEditable === true;
}
