import type {
    FilterEntry,
    FilterOperator,
    SheetTransformState,
    SortDirection,
    SortKey,
    TransformIntent,
} from '../types';
import { is_range_filter_operator } from '../types';

export { is_range_filter_operator };

export type FilterColumnKind = 'numeric' | 'text' | 'unknown';

export type FilterOption = { value: FilterOperator; label: string };

export const FILTER_OPTIONS: readonly FilterOption[] = [
    { value: 'contains', label: 'Contains' },
    { value: 'notContains', label: 'Does not contain' },
    { value: 'equals', label: 'Equals' },
    { value: 'notEquals', label: 'Does not equal' },
    { value: 'startsWith', label: 'Starts with' },
    { value: 'endsWith', label: 'Ends with' },
    { value: 'greaterThan', label: 'Greater than' },
    { value: 'greaterThanOrEqual', label: 'Greater than or equal' },
    { value: 'lessThan', label: 'Less than' },
    { value: 'lessThanOrEqual', label: 'Less than or equal' },
    { value: 'between', label: 'Between (inclusive)' },
    { value: 'notBetween', label: 'Not between (inclusive bounds)' },
    { value: 'isEmpty', label: 'Is empty' },
    { value: 'isNotEmpty', label: 'Is not empty' },
] as const;

const NUMERIC_FILTER_OPERATORS: readonly FilterOperator[] = [
    'equals',
    'notEquals',
    'greaterThan',
    'greaterThanOrEqual',
    'lessThan',
    'lessThanOrEqual',
    'between',
    'notBetween',
    'isEmpty',
    'isNotEmpty',
];

const TEXT_FILTER_OPERATORS: readonly FilterOperator[] = [
    'contains',
    'notContains',
    'equals',
    'notEquals',
    'startsWith',
    'endsWith',
    'isEmpty',
    'isNotEmpty',
];

const CASE_SENSITIVE_OPERATORS: ReadonlySet<FilterOperator> = new Set([
    'contains',
    'notContains',
    'equals',
    'notEquals',
    'startsWith',
    'endsWith',
]);

export function filter_options_for_kind(kind: FilterColumnKind): readonly FilterOption[] {
    if (kind === 'unknown') return FILTER_OPTIONS;
    const allowed = new Set(kind === 'numeric' ? NUMERIC_FILTER_OPERATORS : TEXT_FILTER_OPERATORS);
    return FILTER_OPTIONS.filter((option) => allowed.has(option.value));
}

/** Kind options plus the current operator when it falls outside the kind list. */
export function filter_options_for_draft(
    kind: FilterColumnKind,
    current_operator: FilterOperator,
): readonly FilterOption[] {
    const options = filter_options_for_kind(kind);
    if (options.some((option) => option.value === current_operator)) return options;
    const extra = FILTER_OPTIONS.find((option) => option.value === current_operator);
    return extra ? [...options, extra] : options;
}

/** Case sensitivity only applies to text comparisons; numeric equals ignores it. */
export function operator_supports_case_sensitive(
    operator: FilterOperator,
    kind: FilterColumnKind = 'text',
): boolean {
    return kind !== 'numeric' && CASE_SENSITIVE_OPERATORS.has(operator);
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
