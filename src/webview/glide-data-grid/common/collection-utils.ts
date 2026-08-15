// Local replacements for the handful of lodash functions upstream glide
// imported (lodash/clamp, range, uniq, flatten, debounce, throttle, groupBy,
// has). Semantics match the lodash call sites in this vendored tree; they are
// not general lodash re-implementations.

export function clamp(value: number, lower: number, upper: number): number {
    return Math.min(Math.max(value, lower), upper);
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

export function flatten<T>(values: readonly (T | readonly T[])[]): T[] {
    const result: T[] = [];
    for (const v of values) {
        if (Array.isArray(v)) {
            result.push(...v);
        } else {
            result.push(v as T);
        }
    }
    return result;
}

export function groupBy<T>(values: readonly T[], iteratee: (value: T) => string | number): Record<string, T[]> {
    const result: Record<string, T[]> = {};
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
// image-window-loader's sendLoaded batching.
export function throttle<Args extends unknown[]>(fn: (...args: Args) => void, wait: number): (...args: Args) => void {
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pendingArgs: Args | undefined;
    const invoke = (args: Args) => {
        last = Date.now();
        fn(...args);
    };
    return (...args: Args) => {
        const remaining = wait - (Date.now() - last);
        if (remaining <= 0) {
            if (timer !== undefined) {
                clearTimeout(timer);
                timer = undefined;
            }
            invoke(args);
        } else {
            pendingArgs = args;
            timer ??= setTimeout(() => {
                timer = undefined;
                if (pendingArgs !== undefined) {
                    const a = pendingArgs;
                    pendingArgs = undefined;
                    invoke(a);
                }
            }, remaining);
        }
    };
}
