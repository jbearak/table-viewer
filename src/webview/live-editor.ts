/**
 * The single seam coupling us to Glide Data Grid's internal overlay DOM.
 *
 * Glide portals our custom CSV cell editor into its `.gdg-clip-region`, so the
 * only way to read the in-progress (uncommitted) editor text is to query that
 * element. Centralizing the selector + read here means a Glide upgrade that
 * renames the class is a one-line change instead of a hunt across call sites
 * (save-on-exit, uncommitted-change detection).
 */
export const GLIDE_OVERLAY_EDITOR_SELECTOR =
    '.gdg-clip-region textarea, .gdg-clip-region input';

/** The live value of the open overlay editor, or null when none is mounted. */
export function read_overlay_editor_value(root: ParentNode): string | null {
    const el = root.querySelector(GLIDE_OVERLAY_EDITOR_SELECTOR) as
        | HTMLInputElement
        | HTMLTextAreaElement
        | null;
    return el ? el.value : null;
}
