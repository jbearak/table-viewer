// Text for Parquet dates, timestamps, and times. Values are counts of the
// column's unit (days, or s, ms, us, or ns) since 1970-01-01, or since
// midnight for a time; the text keeps every digit the unit has.

export type TemporalUnit = 'day' | 's' | 'ms' | 'us' | 'ns';

const PER_SECOND: Record<Exclude<TemporalUnit, 'day'>, bigint> = {
    s: 1n,
    ms: 1_000n,
    us: 1_000_000n,
    ns: 1_000_000_000n,
};
const FRACTION_DIGITS: Record<Exclude<TemporalUnit, 'day'>, number> = {
    s: 0,
    ms: 3,
    us: 6,
    ns: 9,
};
/** The largest time a JavaScript Date holds, in milliseconds either side of 1970. */
const MAX_DATE_MS = 8.64e15;
const SECONDS_PER_DAY = 86_400n;

/** How one Parquet date, timestamp, or time column is shown. */
export interface TemporalColumn {
    /** `date`, `timestamp`, or `time` (the reader's `type`). */
    readonly type: string;
    readonly unit: TemporalUnit;
    /** For a timestamp that is an instant: the zone it is shown in. */
    readonly timeZone?: string;
}

function whole(value: number | bigint): bigint | undefined {
    if (typeof value === 'bigint') return value;
    return Number.isSafeInteger(value) ? BigInt(value) : undefined;
}

/** `value` split into whole seconds and the non-negative rest, in units. */
function split(value: bigint, per_second: bigint): [bigint, bigint] {
    let seconds = value / per_second;
    let rest = value % per_second;
    if (rest < 0n) {
        rest += per_second;
        seconds -= 1n;
    }
    return [seconds, rest];
}

const MAX_DATE_SECONDS = 8_640_000_000_000n;

/**
 * `YYYY-MM-DDTHH:MM:SS` of a count of seconds since 1970 in UTC, or undefined
 * outside a Date's range (`rest` is the fraction past `seconds`, in any unit).
 */
function utc_seconds_text(seconds: bigint, rest = 0n): string | undefined {
    if (seconds > MAX_DATE_SECONDS || seconds < -MAX_DATE_SECONDS) return undefined;
    if (seconds === MAX_DATE_SECONDS && rest > 0n) return undefined;
    const ms = Number(seconds) * 1000;
    if (!(Math.abs(ms) <= MAX_DATE_MS)) return undefined;
    const iso = new Date(ms).toISOString();
    return iso.slice(0, iso.lastIndexOf('.'));
}

function fraction_text(rest: bigint, unit: Exclude<TemporalUnit, 'day'>): string {
    const digits = FRACTION_DIGITS[unit];
    return digits === 0 ? '' : `.${rest.toString().padStart(digits, '0')}`;
}

const zone_formats = new Map<string, Intl.DateTimeFormat | null>();

function zone_format(zone: string): Intl.DateTimeFormat | null {
    let format = zone_formats.get(zone);
    if (format === undefined) {
        try {
            format = new Intl.DateTimeFormat('en-US', {
                timeZone: zone,
                hourCycle: 'h23',
                era: 'short',
                year: 'numeric',
                month: 'numeric',
                day: 'numeric',
                hour: 'numeric',
                minute: 'numeric',
                second: 'numeric',
            });
        } catch {
            format = null;
        }
        zone_formats.set(zone, format);
    }
    return format;
}

/** The zone's offset from UTC, in seconds, at `seconds` since 1970. */
function zone_offset_seconds(format: Intl.DateTimeFormat, seconds: number): number {
    const fields: Record<string, string> = {};
    for (const part of format.formatToParts(new Date(seconds * 1000))) {
        fields[part.type] = part.value;
    }
    let year = Number(fields.year);
    if (fields.era === 'BC' || fields.era === 'B') year = 1 - year;
    const local = new Date(0);
    local.setUTCFullYear(year, Number(fields.month) - 1, Number(fields.day));
    local.setUTCHours(Number(fields.hour), Number(fields.minute), Number(fields.second), 0);
    return Math.round(local.getTime() / 1000) - seconds;
}

function offset_text(offset_seconds: number): string {
    const sign = offset_seconds < 0 ? '-' : '+';
    const minutes = Math.round(Math.abs(offset_seconds) / 60);
    const hours = Math.floor(minutes / 60);
    return `${sign}${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** A date: `2024-03-01`; the count itself outside a Date's range. */
function date_text(value: number | bigint): string {
    const days = whole(value);
    if (days === undefined) return String(value);
    const text = utc_seconds_text(days * SECONDS_PER_DAY);
    return text === undefined ? String(value) : text.slice(0, text.lastIndexOf('T'));
}

/** A time of day: `14:00:00.123456`; the count itself outside one day. */
function time_text(value: number | bigint, unit: Exclude<TemporalUnit, 'day'>): string {
    const count = whole(value);
    if (count === undefined) return String(value);
    const [seconds, rest] = split(count, PER_SECOND[unit]);
    if (seconds < 0n || seconds >= SECONDS_PER_DAY) return String(value);
    const s = Number(seconds);
    const clock = [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60]
        .map((part) => String(part).padStart(2, '0'))
        .join(':');
    return `${clock}${fraction_text(rest, unit)}`;
}

/**
 * A timestamp: a clock time without zone as `2024-03-01T14:00:00.123456`; an
 * instant as `2024-03-01T09:00:00.123456-05:00[America/New_York]`, or, in a
 * zone this runtime does not know, the UTC time with the zone's name and no
 * offset. The count itself outside a Date's range.
 */
function timestamp_text(
    value: number | bigint,
    unit: Exclude<TemporalUnit, 'day'>,
    zone: string | undefined,
): string {
    const count = whole(value);
    if (count === undefined) return String(value);
    const [seconds, rest] = split(count, PER_SECOND[unit]);
    const fraction = fraction_text(rest, unit);
    const utc = utc_seconds_text(seconds, rest);
    if (utc === undefined) return String(value);
    if (zone === undefined) return `${utc}${fraction}`;
    const format = zone_format(zone);
    if (format === null) return `${utc}${fraction}[${zone}]`;
    const offset = zone_offset_seconds(format, Number(seconds));
    const local = utc_seconds_text(seconds + BigInt(offset));
    return local === undefined
        ? String(value)
        : `${local}${fraction}${offset_text(offset)}[${zone}]`;
}

/** The text for one value of a Parquet date, timestamp, or time column. */
export function temporal_text(value: number | bigint, column: TemporalColumn): string {
    if (column.unit === 'day') return date_text(value);
    if (column.type === 'time') return time_text(value, column.unit);
    return timestamp_text(value, column.unit, column.timeZone);
}
