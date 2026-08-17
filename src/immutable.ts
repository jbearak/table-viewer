function freeze_recursive<T>(value: T, seen: WeakSet<object>): T {
    if (value === null || typeof value !== 'object') return value;
    const object = value as object;
    if (seen.has(object)) return value;
    seen.add(object);
    for (const key of Reflect.ownKeys(object)) {
        freeze_recursive(Reflect.get(object, key), seen);
    }
    return Object.freeze(value);
}

/** Clone structured data and recursively freeze the isolated copy. */
export function deep_clone_and_freeze<T>(value: T): T {
    return freeze_recursive(structuredClone(value), new WeakSet<object>());
}

function is_frozen_recursive(value: unknown, seen: WeakSet<object>): boolean {
    if (value === null || typeof value !== 'object') return true;
    const object = value as object;
    if (seen.has(object)) return true;
    seen.add(object);
    if (!Object.isFrozen(object)) return false;
    return Reflect.ownKeys(object).every((key) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(object, key);
        if (descriptor === undefined) return false;
        // Freezing an accessor property freezes the descriptor, not whatever the
        // getter closes over, so reading it once proves nothing about what it
        // will return next time.
        if (!('value' in descriptor)) return false;
        return is_frozen_recursive(descriptor.value, seen);
    });
}

/**
 * Whether a graph is frozen all the way down, and so already safe to retain
 * without copying it.
 *
 * Walking the graph costs one visit per object, where cloning it costs a second
 * copy of every string it holds — so this is what lets a holder of large
 * structured data (session history) skip a redundant clone without trusting the
 * caller. A shallow `Object.isFrozen` cannot: it passes a frozen wrapper around
 * mutable innards, and retaining that leaves the caller able to change what the
 * holder later reads.
 */
export function is_deeply_frozen(value: unknown): boolean {
    return is_frozen_recursive(value, new WeakSet<object>());
}
