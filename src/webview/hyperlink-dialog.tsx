import React, {
    forwardRef,
    useCallback,
    useEffect,
    useImperativeHandle,
    useLayoutEffect,
    useRef,
    useState,
} from 'react';
import type { CellHyperlink } from '../cell-content';
import { parse_http_external_url } from '../external-url';
import { MAX_HYPERLINK_LENGTH, is_valid_hyperlink } from '../pending-changes';
import { use_dismiss } from './use-dismiss';

export interface HyperlinkDialogProps {
    /** The cell's effective link when the dialog opens (pending edit wins
     *  over the loaded cell), or null for a linkless cell. */
    initial: CellHyperlink | null;
    /** Save/Remove: the next whole-cell link, or null to clear it. */
    on_commit: (next: CellHyperlink | null) => boolean | void;
    on_cancel: () => void;
    /** Temporarily suspend the draft while another edit gesture is in flight. */
    disabled?: boolean;
    /** Hand focus off when this dialog is removed while one of its controls owns it. */
    on_focused_unmount?: () => void;
}

export interface HyperlinkDialogHandle {
    /** Commit the current valid draft; false leaves an invalid draft open. */
    commit: () => boolean;
}

type LinkKind = CellHyperlink['kind'];

function initial_target(link: CellHyperlink | null): string {
    if (!link) return '';
    return link.kind === 'external' ? link.target : link.location;
}

/**
 * The committed link for the current draft, or null when the draft is not a
 * valid link. External targets go through the same normalizer the host
 * re-applies at save time (parse_http_external_url), so what the dialog
 * accepts is exactly what the save will not reject; internal locations only
 * need to be non-empty.
 */
export function draft_hyperlink(
    kind: LinkKind,
    target: string,
    tooltip: string,
): CellHyperlink | null {
    const tip = tooltip.trim();
    const with_tooltip = tip === '' ? {} : { tooltip: tip };
    let draft: CellHyperlink;
    if (kind === 'external') {
        const normalized = parse_http_external_url(target.trim());
        if (normalized === null) return null;
        draft = { kind: 'external', target: normalized, ...with_tooltip };
    } else {
        const location = target.trim();
        if (location === '') return null;
        draft = { kind: 'internal', location, ...with_tooltip };
    }
    // The same predicate the durable validator and the save sanitizer apply.
    // Accepting a draft they would reject means offering a Save that silently
    // drops the link somewhere downstream, which is worse than refusing it in
    // the field where the user can still see what they typed.
    return is_valid_hyperlink(draft) ? draft : null;
}

/**
 * Whole-cell hyperlink editor, opened from the cell context menu in Edit
 * mode. Modal in behavior only (Escape / outside click cancel via
 * use_dismiss); one dialog exists at a time, owned by GridShell.
 */
export const HyperlinkDialog = forwardRef<HyperlinkDialogHandle, HyperlinkDialogProps>(
function HyperlinkDialog({
    initial,
    on_commit,
    on_cancel,
    disabled = false,
    on_focused_unmount,
}, ref): React.JSX.Element {
    const [kind, set_kind] = useState<LinkKind>(initial?.kind ?? 'external');
    const [target, set_target] = useState(() => initial_target(initial));
    const [tooltip, set_tooltip] = useState(initial?.tooltip ?? '');
    const dialog_ref = useRef<HTMLDivElement>(null);
    const target_ref = useRef<HTMLInputElement>(null);

    const dismiss = useCallback(() => on_cancel(), [on_cancel]);
    use_dismiss(dialog_ref, dismiss);

    // Focus the target field once mounted. Deliberately a macrotask, not a
    // layout effect: the context menu that opened this dialog restores focus
    // to the grid in its own setTimeout(0) on dismiss, and that timer was
    // queued before this effect ran — queueing ours after it is what makes
    // the dialog win the race.
    useEffect(() => {
        const timer = window.setTimeout(() => target_ref.current?.focus(), 0);
        return () => window.clearTimeout(timer);
    }, []);
    useLayoutEffect(() => () => {
        const active = document.activeElement;
        if (active && dialog_ref.current?.contains(active)) on_focused_unmount?.();
    }, [on_focused_unmount]);

    const draft = draft_hyperlink(kind, target, tooltip);
    const commit = useCallback((): boolean => {
        if (disabled) return false;
        if (draft === null) {
            const untouched = kind === (initial?.kind ?? 'external')
                && target === initial_target(initial)
                && tooltip === (initial?.tooltip ?? '');
            if (!untouched) return false;
            on_cancel();
            return true;
        }
        return on_commit(draft) !== false;
    }, [disabled, draft, initial, kind, on_cancel, on_commit, target, tooltip]);
    useImperativeHandle(ref, () => ({ commit }), [commit]);

    return (
        <div
            ref={dialog_ref}
            className="filter-popover hyperlink-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Edit hyperlink"
        >
            <div className="filter-popover-header">
                <span className="filter-popover-colname">Hyperlink</span>
            </div>
            <div className="filter-popover-body">
                <label className="filter-popover-field-label" htmlFor="hyperlink-kind">
                    Link to
                </label>
                <select
                    id="hyperlink-kind"
                    className="filter-popover-select"
                    value={kind}
                    disabled={disabled}
                    onChange={(event) => set_kind(event.target.value as LinkKind)}
                >
                    <option value="external">Web address</option>
                    <option value="internal">Place in this workbook</option>
                </select>
                <label className="filter-popover-field-label" htmlFor="hyperlink-target">
                    {kind === 'external' ? 'URL' : 'Location'}
                </label>
                <input
                    id="hyperlink-target"
                    ref={target_ref}
                    className="filter-popover-input"
                    type="text"
                    value={target}
                    placeholder={kind === 'external' ? 'https://example.com' : "'Sheet2'!A1"}
                    spellCheck={false}
                    disabled={disabled}
                    onChange={(event) => set_target(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                            event.preventDefault();
                            commit();
                        }
                    }}
                />
                {target.trim() !== '' && draft === null && (
                    <div className="hyperlink-dialog-hint">
                        {target.trim().length > MAX_HYPERLINK_LENGTH
                            || tooltip.trim().length > MAX_HYPERLINK_LENGTH
                            ? `Too long — keep it under ${MAX_HYPERLINK_LENGTH} characters.`
                            : kind === 'external'
                                ? 'Enter a valid http(s) URL.'
                                : 'Enter a workbook location.'}
                    </div>
                )}
                <label className="filter-popover-field-label" htmlFor="hyperlink-tooltip">
                    ScreenTip (optional)
                </label>
                <input
                    id="hyperlink-tooltip"
                    className="filter-popover-input"
                    type="text"
                    value={tooltip}
                    spellCheck={false}
                    disabled={disabled}
                    onChange={(event) => set_tooltip(event.target.value)}
                />
            </div>
            <div className="filter-popover-footer">
                {initial !== null && (
                    <button
                        type="button"
                        className="filter-popover-btn filter-popover-btn-danger"
                        disabled={disabled}
                        onClick={() => on_commit(null)}
                    >
                        Remove link
                    </button>
                )}
                <button
                    type="button"
                    className="filter-popover-btn"
                    onClick={() => on_cancel()}
                >
                    Cancel
                </button>
                <button
                    type="button"
                    className="filter-popover-btn filter-popover-btn-primary"
                    disabled={disabled || draft === null}
                    onClick={commit}
                >
                    Save
                </button>
            </div>
        </div>
    );
});
