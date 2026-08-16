import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CellHyperlink } from '../cell-content';
import { parse_http_external_url } from '../external-url';
import { use_dismiss } from './use-dismiss';

export interface HyperlinkDialogProps {
    /** The cell's effective link when the dialog opens (pending edit wins
     *  over the loaded cell), or null for a linkless cell. */
    initial: CellHyperlink | null;
    /** Save/Remove: the next whole-cell link, or null to clear it. */
    on_commit: (next: CellHyperlink | null) => void;
    on_cancel: () => void;
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
    if (kind === 'external') {
        const normalized = parse_http_external_url(target.trim());
        if (normalized === null) return null;
        return { kind: 'external', target: normalized, ...with_tooltip };
    }
    const location = target.trim();
    if (location === '') return null;
    return { kind: 'internal', location, ...with_tooltip };
}

/**
 * Whole-cell hyperlink editor, opened from the cell context menu in Edit
 * mode. Modal in behavior only (Escape / outside click cancel via
 * use_dismiss); one dialog exists at a time, owned by GridShell.
 */
export function HyperlinkDialog({
    initial,
    on_commit,
    on_cancel,
}: HyperlinkDialogProps): React.JSX.Element {
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

    const draft = draft_hyperlink(kind, target, tooltip);
    const commit = () => {
        if (draft !== null) on_commit(draft);
    };

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
                        {kind === 'external'
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
                    onChange={(event) => set_tooltip(event.target.value)}
                />
            </div>
            <div className="filter-popover-footer">
                {initial !== null && (
                    <button
                        type="button"
                        className="filter-popover-btn filter-popover-btn-danger"
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
                    disabled={draft === null}
                    onClick={commit}
                >
                    Save
                </button>
            </div>
        </div>
    );
}
