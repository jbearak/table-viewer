/**
 * Renders the pending-change notices (see `pending-change-notices.ts`) in a
 * strip docked under the grid. Under, not above: a notice that appears or
 * goes after a gesture shrinks or grows the grid from its bottom edge, so the
 * row under the pointer stays where it is.
 */
import React, { useState } from 'react';
import type {
    PendingChangeNotice,
    PendingChangeNoticeFormulas,
    PendingChangeNoticeIntent,
} from './pending-change-notices';

export interface PendingChangeNoticesProps {
    readonly notices: readonly PendingChangeNotice[];
    /** A line about the last action, such as a Go to cell that found no cell. */
    readonly status: string;
    readonly on_intent: (intent: PendingChangeNoticeIntent) => void;
}

export function PendingChangeNotices(props: PendingChangeNoticesProps): React.JSX.Element {
    return (
        <div className="pending-change-notices">
            {props.notices.map((notice) => (
                <section
                    key={notice.kind}
                    className={`pending-change-notice pending-change-notice-${notice.severity}`}
                    role={notice.role}
                    aria-label={notice.label}
                >
                    {notice.heading !== undefined && <h2>{notice.heading}</h2>}
                    {notice.sentences.map((sentence) => <p key={sentence}>{sentence}</p>)}
                    {notice.status !== undefined && <p role="status">{notice.status}</p>}
                    {notice.formulas !== undefined && (
                        <FormulaList
                            key={formula_list_key(notice.kind, notice.formulas)}
                            id={`pending-change-formulas-${notice.kind}`}
                            formulas={notice.formulas}
                            on_intent={props.on_intent}
                        />
                    )}
                    {notice.actions.length > 0 && (
                        <div className="pending-change-notice-actions">
                            {notice.actions.map((action) => (
                                <button
                                    key={action.label}
                                    disabled={action.disabled}
                                    aria-label={action.ariaLabel}
                                    onClick={() => props.on_intent(action.intent)}
                                >
                                    {action.label}
                                </button>
                            ))}
                        </div>
                    )}
                </section>
            ))}
            {props.status !== '' && (
                <p className="pending-change-notices-status" role="status">{props.status}</p>
            )}
        </div>
    );
}

/**
 * A list opened stays open while it lists the same formulas, though the
 * sentences above it change: going to a cell on another worksheet rewords
 * them ("on Data") and the person may go on to the next formula.
 */
function formula_list_key(kind: string, formulas: PendingChangeNoticeFormulas): string {
    return `${kind}:${JSON.stringify(formulas.items.map((item) => [item.location, item.formula, item.note ?? null]))}`;
}

function FormulaList(props: {
    readonly id: string;
    readonly formulas: PendingChangeNoticeFormulas;
    readonly on_intent: (intent: PendingChangeNoticeIntent) => void;
}): React.JSX.Element {
    const { formulas } = props;
    // Reset with the list's content: a new set of formulas starts as its length says.
    const [open, set_open] = useState(!formulas.collapsed);
    return (
        <>
            {formulas.collapsed && (
                <button
                    className="pending-change-disclosure"
                    aria-expanded={open}
                    aria-controls={props.id}
                    onClick={() => set_open((value) => !value)}
                >
                    {open ? 'Hide formulas' : formulas.disclosureLabel}
                </button>
            )}
            {(open || !formulas.collapsed) && (
                <ul className="pending-change-formulas" id={props.id}>
                    {formulas.items.map((item) => (
                        <li key={item.location}>
                            <span className="pending-change-formula-location">{item.location}</span>
                            <span className="pending-change-formula-text">
                                <code>{item.formula}</code>
                                {item.written !== undefined && (
                                    <span className="pending-change-formula-written">
                                        {' was '}
                                        <code>{item.written}</code>
                                    </span>
                                )}
                                {item.note !== undefined && (
                                    <span className="pending-change-formula-note">{item.note}</span>
                                )}
                            </span>
                            <button
                                aria-label={item.goTo.ariaLabel}
                                disabled={item.goTo.disabled}
                                onClick={() => props.on_intent(item.goTo.intent)}
                            >
                                {item.goTo.label}
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            {open && formulas.truncatedNote !== undefined && <p>{formulas.truncatedNote}</p>}
        </>
    );
}
