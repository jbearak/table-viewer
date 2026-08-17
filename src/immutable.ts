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
