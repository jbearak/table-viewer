// Local replacements for the handful of lodash functions upstream glide
// imported (lodash/clamp, range, uniq, flatten, debounce, throttle, groupBy,
// has). Semantics match the lodash call sites in this vendored tree; they are
// not general lodash re-implementations.

export function clamp(value: number, lower: number, upper: number): number {
    // Upper bound first, lower bound last (lodash order): when the bounds
    // cross (e.g. rows === 0 → clamp(row, 0, -1)) the lower bound wins.
    return Math.max(Math.min(value, upper), lower);
}

export function range(end: number): number[];
export function range(start: number, end: number, step?: number): number[];
export function range(startOrEnd: number, end?: number, step?: number): number[] {
    let start = startOrEnd;
    if (end === undefined) {
        end = startOrEnd;
        start = 0;
    }
    if (step === undefined) {
        step = start > end ? -1 : 1;
    }
    const result: number[] = [];
    if (step === 0) return result;
    if (step > 0) {
        for (let i = start; i < end; i += step) result.push(i);
    } else {
        for (let i = start; i > end; i += step) result.push(i);
    }
    return result;
}

export function uniq<T>(values: readonly T[]): T[] {
    return [...new Set(values)];
}

// One level deep, arrays-of-arrays only (all this tree passes). Array#flat
// rather than push(...inner): spreading a huge inner array (e.g. a range over
// a very wide span) would overflow the call stack.
export function flatten<T>(values: readonly (readonly T[])[]): T[] {
    return values.flat() as T[];
}

export function groupBy<T>(values: readonly T[], iteratee: (value: T) => string | number): Record<string, T[]> {
    // Null prototype: keys are arbitrary strings (e.g. theme colors), and a
    // key like "constructor" must not resolve to an inherited member.
    const result: Record<string, T[]> = Object.create(null);
    for (const v of values) {
        const key = String(iteratee(v));
        (result[key] ??= []).push(v);
    }
    return result;
}

export function has(obj: unknown, key: string): boolean {
    return obj != null && Object.prototype.hasOwnProperty.call(obj, key);
}

// Trailing-edge debounce, matching how the vendored call sites use
// lodash/debounce (fire once, `wait` ms after the last call).
export function debounce<Args extends unknown[]>(fn: (...args: Args) => void, wait: number): (...args: Args) => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return (...args: Args) => {
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = undefined;
            fn(...args);
        }, wait);
    };
}

// Leading + trailing throttle, matching lodash/throttle defaults for the
// image-window-loader's sendLoaded batching. Zero-argument only — the sole
// call site takes no arguments, so no argument buffering.
export function throttle(fn: () => void, wait: number): () => void {
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const invoke = () => {
        last = Date.now();
        fn();
    };
    return () => {
        const remaining = wait - (Date.now() - last);
        if (remaining <= 0) {
            if (timer !== undefined) {
                clearTimeout(timer);
                timer = undefined;
            }
            invoke();
        } else {
            timer ??= setTimeout(() => {
                timer = undefined;
                invoke();
            }, remaining);
        }
    };
}
