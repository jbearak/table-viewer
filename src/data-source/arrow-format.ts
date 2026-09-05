import {
    apply_display_format,
    is_missing_value_object,
    type ArrowCell,
    type ArrowVariable,
} from '@jbearak/dta-parser';
import type { RawCell } from './interface';
import { raw_stata_missing_cell } from './stata-missing-cell';

/** JSON-safe raw values retain the original integer and missing distinctions. */
export function raw_arrow_cell(
    value: ArrowCell,
    dictionaryLevel?: string | null,
): RawCell {
    if (value === null) {
        return { raw: null, rawType: 'empty' };
    }
    if (is_missing_value_object(value)) {
        return raw_stata_missing_cell(value.missing_type);
    }
    const raw = typeof value === 'number' && Object.is(value, -0)
        ? '-0' : String(value);
    const rawType = typeof value === 'bigint' || typeof value === 'number'
        ? 'number'
        : typeof value === 'boolean' ? 'boolean' : 'string';
    if (dictionaryLevel !== undefined) {
        return {
            raw,
            rawType,
            comparisonKey: `arrow:dictionary:${JSON.stringify([raw, dictionaryLevel])}`,
        };
    }
    if (typeof value === 'string' && value.trim() === '') {
        return { raw, rawType, comparisonKey: `arrow:string:${value}` };
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
        return { raw, rawType, comparisonKey: `arrow:number:${raw}` };
    }
    return { raw, rawType };
}

const NANOS_PER_UNIT = {
    second: 1_000_000_000n,
    millisecond: 1_000_000n,
    microsecond: 1_000n,
    nanosecond: 1n,
};
const DATE_LIMIT = 8_640_000_000_000_000n;

function timestamp(value: bigint, variable: ArrowVariable): string | undefined {
    if (!variable.unit || variable.unit === 'day') {
        return undefined;
    }
    const nanos = value * NANOS_PER_UNIT[variable.unit];
    let seconds = nanos / 1_000_000_000n;
    let fraction = nanos % 1_000_000_000n;
    if (fraction < 0) {
        seconds--;
        fraction += 1_000_000_000n;
    }
    const milliseconds = seconds * 1_000n;
    if (milliseconds < -DATE_LIMIT || milliseconds > DATE_LIMIT) {
        return undefined;
    }
    const date = new Date(Number(milliseconds));
    if (!Number.isFinite(date.getTime())) {
        return undefined;
    }
    const base = date.toISOString().replace(/\.000Z$/, '');
    const digits = fraction
        ? `.${fraction.toString().padStart(9, '0').replace(/0+$/, '')}`
        : '';
    // Timezone-free timestamps describe wall-clock values. Zoned timestamps
    // display the UTC instant, with their recorded timezone explicitly shown.
    const zone = variable.timezone ? 'Z' : '';
    const annotation = variable.timezone && variable.timezone !== 'UTC'
        ? ` [${variable.timezone}]` : '';
    return `${base}${digits}${zone}${annotation}`;
}

export function format_arrow_value(
    value: ArrowCell,
    variable: ArrowVariable,
    raw: string | null,
): string {
    if (raw === null) {
        return '';
    }
    if (
        is_missing_value_object(value)
        || typeof value === 'string' || typeof value === 'boolean'
    ) {
        return raw;
    }
    if (variable.type === 'date32' && typeof value === 'number') {
        const date = new Date(value * 86_400_000);
        return Number.isFinite(date.getTime())
            ? date.toISOString().split('T')[0]
            : `${raw} days since 1970-01-01`;
    }
    if (variable.type === 'timestamp' && typeof value === 'bigint') {
        return timestamp(value, variable)
            ?? `${raw} ${variable.unit ?? 'ticks'} since ${variable.epoch ?? '1970-01-01'}`;
    }
    if (variable.type === 'duration') {
        return `${raw} ${variable.unit ?? 'ticks'}`;
    }
    if (variable.type === 'float64' && variable.temporal_semantics) {
        const semantic = variable.temporal_semantics;
        return `${raw} ${semantic.unit}`
            + (semantic.epoch ? ` since ${semantic.epoch}` : '')
            + (semantic.timezone ? ` [${semantic.timezone}]` : '');
    }
    if (
        typeof value === 'number'
        && variable.profile?.storage && variable.profile.format
    ) {
        return apply_display_format(value, variable.profile.format) ?? raw;
    }
    return raw;
}
