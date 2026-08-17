/** Leaf module for the one JSON-shape guard shared by the durable-state codec
 *  (types.ts) and the pending-change validators (pending-changes.ts) — a leaf
 *  so the two can both import it without importing each other. types.ts
 *  re-exports it, so existing importers are unaffected. */
export function is_plain_record(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
